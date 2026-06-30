import { odataGetAll } from './odataClient'
import type { PoProject, PoTaskDependency, PoDependencyType } from '../../models/projectOnline.types'

const DEFAULT_DEPENDENCY_FETCH_CONCURRENCY = 6
const MAX_DEPENDENCY_FETCH_CONCURRENCY = 12

const DEPENDENCY_TYPES: Record<number, PoDependencyType> = {
  0: 'FF',
  1: 'FS',
  2: 'SF',
  3: 'SS',
}

export async function fetchDependencies(siteUrl: string, projects: PoProject[]): Promise<PoTaskDependency[]> {
  const projectRows = await runWithConcurrency(
    projects,
    project => fetchProjectTaskLinks(siteUrl, project),
    getDependencyFetchConcurrency(),
  )

  return projectRows
    .flatMap((rows, projectIndex) => {
      const projectId = stringValue(projects[projectIndex]?.ProjectId)
      return rows.map((row, rowIndex) => normalizeDependency(projectId, row, rowIndex))
    })
    .filter(dep => dep.PredecessorTaskId && dep.SuccessorTaskId)
}

async function fetchProjectTaskLinks(siteUrl: string, project: PoProject): Promise<Record<string, unknown>[]> {
  const projectId = stringValue(project.ProjectId)
  if (!projectId) return []

  const uris = [
    `_api/ProjectServer/Projects('${projectId}')/TaskLinks?$expand=Start,End`,
    `_api/ProjectServer/Projects(guid'${projectId}')/TaskLinks?$expand=Start,End`,
  ]

  let lastError: unknown
  for (const uri of uris) {
    try {
      return await odataGetAll<Record<string, unknown>>(siteUrl, uri)
    } catch (e) {
      lastError = e
    }
  }

  console.warn(`Skipping dependency read for project ${project.ProjectName ?? projectId}: ${String(lastError)}`)
  return []
}

function normalizeDependency(projectId: string, row: Record<string, unknown>, index: number): PoTaskDependency {
  const predecessor = objectValue(row.Start) ?? objectValue(row.start)
  const successor = objectValue(row.End) ?? objectValue(row.end)
  const dependencyType = dependencyTypeValue(
    firstDefined(
      row.DependencyType,
      row.dependencyType,
      row.LinkType,
      row.linkType,
      row.TaskLinkType,
      row.taskLinkType,
      row.LINK_TYPE,
      row.link_type,
    ),
  )

  return {
    DependencyId: stringValue(row.Id ?? row.LinkId ?? row.linkId) || `${projectId}:dependency:${index}`,
    ProjectId: projectId,
    PredecessorTaskId: extractTaskId(predecessor, row.StartId ?? row.startId ?? row.StartTaskId ?? row.startTaskId),
    SuccessorTaskId: extractTaskId(successor, row.EndId ?? row.endId ?? row.EndTaskId ?? row.endTaskId),
    DependencyType: dependencyType,
    Lag: numberValue(firstDefined(
      row.Lag,
      row.lag,
      row.LinkLag,
      row.linkLag,
      row.TaskLinkLag,
      row.taskLinkLag,
      row.LINK_LAG,
      row.link_lag,
    )),
  }
}

function extractTaskId(task: Record<string, unknown> | undefined, fallback: unknown): string {
  return stringValue(
    task?.Id ??
    task?.id ??
    task?.TaskId ??
    task?.taskId ??
    task?.TaskGuid ??
    task?.taskGuid ??
    fallback,
  )
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown): string {
  return value == null ? '' : String(value).replace(/[{}]/g, '').trim()
}

function firstDefined(...values: unknown[]): unknown {
  return values.find(value => value != null && value !== '')
}

function numberValue(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function dependencyTypeValue(value: unknown): PoDependencyType | undefined {
  if (typeof value === 'string') {
    const text = value.trim().toUpperCase().replace(/[\s_-]/g, '')
    if (text === 'FS' || text === 'FINISHTOSTART') return 'FS'
    if (text === 'SS' || text === 'STARTTOSTART') return 'SS'
    if (text === 'FF' || text === 'FINISHTOFINISH') return 'FF'
    if (text === 'SF' || text === 'STARTTOFINISH') return 'SF'
  }

  const numeric = numberValue(value)
  return numeric == null ? undefined : DEPENDENCY_TYPES[numeric]
}

function getDependencyFetchConcurrency(): number {
  if (typeof window === 'undefined') return DEFAULT_DEPENDENCY_FETCH_CONCURRENCY

  const override = window.localStorage.getItem('PROJECT_ONLINE_DEPENDENCY_FETCH_CONCURRENCY')
  if (!override) return DEFAULT_DEPENDENCY_FETCH_CONCURRENCY

  const parsed = parseInt(override, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_DEPENDENCY_FETCH_CONCURRENCY

  return Math.min(parsed, MAX_DEPENDENCY_FETCH_CONCURRENCY)
}

async function runWithConcurrency<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0

  const runOne = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runOne()),
  )

  return results
}
