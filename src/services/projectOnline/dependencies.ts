import { odataGetAll } from './odataClient'
import type { PoProject, PoTaskDependency, PoDependencyType } from '../../models/projectOnline.types'

const DEPENDENCY_TYPES: Record<number, PoDependencyType> = {
  0: 'FF',
  1: 'FS',
  2: 'SF',
  3: 'SS',
}

export async function fetchDependencies(siteUrl: string, projects: PoProject[]): Promise<PoTaskDependency[]> {
  const dependencies: PoTaskDependency[] = []

  for (const project of projects) {
    const rows = await fetchProjectTaskLinks(siteUrl, project)
    dependencies.push(...rows.map((row, index) => normalizeDependency(project.ProjectId, row, index)))
  }

  return dependencies.filter(dep => dep.PredecessorTaskId && dep.SuccessorTaskId)
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
  const dependencyTypeValue = numberValue(row.DependencyType ?? row.dependencyType)

  return {
    DependencyId: stringValue(row.Id ?? row.LinkId ?? row.linkId) || `${projectId}:dependency:${index}`,
    ProjectId: projectId,
    PredecessorTaskId: extractTaskId(predecessor, row.StartId ?? row.startId ?? row.StartTaskId ?? row.startTaskId),
    SuccessorTaskId: extractTaskId(successor, row.EndId ?? row.endId ?? row.EndTaskId ?? row.endTaskId),
    DependencyType: dependencyTypeValue == null ? undefined : DEPENDENCY_TYPES[dependencyTypeValue],
    Lag: numberValue(row.Lag ?? row.lag),
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

function numberValue(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}
