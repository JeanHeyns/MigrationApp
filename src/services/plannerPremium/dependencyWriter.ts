import type { PoDependencyType, PoTask, PoTaskDependency } from '../../models/projectOnline.types'
import type { ImportError } from '../../models/plannerPremium.types'
import { chunks, nowError } from './importHelpers'
import { executeOperationSetWithRetry } from './scheduleApi'

export interface DependencyWriteResult {
  poDependencyId: string
  dvDependencyId?: string
  success: boolean
  error?: ImportError
}

/**
 * Context for date-preserving lag compensation. The P4W scheduling engine
 * recalculates a successor's start to `predecessor.finish + lag` the moment a
 * dependency is created, discarding imported dates. By deriving the lag from
 * the actual imported dates instead of the source lag value, the engine's
 * recalculation lands exactly on the original schedule.
 */
export interface DependencyLagContext {
  tasks: PoTask[]
  hoursPerDay: number
}

const LINK_TYPE_VALUES: Record<PoDependencyType, number> = {
  FS: 1,
  SS: 2,
  FF: 3,
  SF: 4,
}

export async function writeDependencies(
  dependencies: PoTaskDependency[],
  projectIdMap: Record<string, string>,
  taskIdMap: Record<string, string>,
  onProgress?: (result: DependencyWriteResult) => void,
  lagContext?: DependencyLagContext,
): Promise<DependencyWriteResult[]> {
  const tasksById = new Map<string, PoTask>((lagContext?.tasks ?? []).map(t => [t.TaskId, t]))
  const results: DependencyWriteResult[] = []
  const dependenciesByProject = groupByProject(dependencies)

  for (const [poProjectId, projectDependencies] of dependenciesByProject) {
    const projectId = projectIdMap[poProjectId]
    if (!projectId) {
      for (const dependency of projectDependencies) {
        const result = {
          poDependencyId: dependency.DependencyId,
          success: false,
          error: nowError('Dependency', dependency.DependencyId, 'Project was not imported', undefined, poProjectId),
        }
        results.push(result)
        onProgress?.(result)
      }
      continue
    }

    for (const chunk of chunks(projectDependencies, 180)) {
      const creatable = chunk.filter(dependency => {
        const predecessorTaskId = taskIdMap[dependency.PredecessorTaskId]
        const successorTaskId = taskIdMap[dependency.SuccessorTaskId]

        if (!predecessorTaskId || !successorTaskId) {
          const missing = [
            !predecessorTaskId ? `predecessor task ${dependency.PredecessorTaskId}` : null,
            !successorTaskId ? `successor task ${dependency.SuccessorTaskId}` : null,
          ].filter(Boolean).join(' and ')
          const result = {
            poDependencyId: dependency.DependencyId,
            success: false,
            error: nowError('Dependency', dependency.DependencyId, `Cannot create dependency: ${missing} was not imported or did not return a Dataverse task ID`, 'PredecessorMissing', poProjectId),
          }
          results.push(result)
          onProgress?.(result)
          return false
        }

        if (dependency.DependencyType && dependency.DependencyType !== 'FS') {
          const result = {
            poDependencyId: dependency.DependencyId,
            success: false,
            error: nowError(
              'Dependency',
              dependency.DependencyId,
              `Dependency type '${dependency.DependencyType}' is not supported — Planner Premium only allows Finish-to-Start (FS). A Microsoft Project Plan P3 or higher license is required to use other dependency types.`,
              'NonFSDependency',
              poProjectId,
            ),
          }
          results.push(result)
          onProgress?.(result)
          return false
        }

        return true
      })

      if (creatable.length === 0) continue

      const ops = creatable.map(dependency => {
        const dependencyId = crypto.randomUUID()
        const compensatedLag = lagContext
          ? computeCompensatedLagMinutes(dependency, tasksById, lagContext.hoursPerDay)
          : null
        const lagMinutes = compensatedLag ?? (dependency.Lag != null ? dependency.Lag * 60 : null)
        return {
          id: dependency.DependencyId,
          dvId: dependencyId,
          entity: {
            '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_projecttaskdependency',
            msdyn_projecttaskdependencyid: dependencyId,
            msdyn_projecttaskdependencylinktype: LINK_TYPE_VALUES[dependency.DependencyType ?? 'FS'],
            ...(lagMinutes != null && lagMinutes !== 0 ? { msdyn_projecttaskdependencylinklag: lagMinutes } : {}),
            msdyn_description: '',
            'msdyn_Project@odata.bind': `/msdyn_projects(${projectId})`,
            'msdyn_PredecessorTask@odata.bind': `/msdyn_projecttasks(${taskIdMap[dependency.PredecessorTaskId]})`,
            'msdyn_SuccessorTask@odata.bind': `/msdyn_projecttasks(${taskIdMap[dependency.SuccessorTaskId]})`,
          } as Record<string, unknown>,
        }
      })

      const dvIdByPoId = Object.fromEntries(ops.map(o => [o.id, o.dvId]))

      const batchResult = await executeOperationSetWithRetry(
        projectId,
        ops.map(o => ({ id: o.id, entity: o.entity })),
        `Project Online dependency import ${new Date().toISOString()}`,
      )

      // Lag may be rejected (e.g. negative lag unsupported in this environment).
      // Retry failed ops once without the lag field — a dependency without exact
      // date preservation beats no dependency at all.
      const retryable = batchResult.failed.filter(f =>
        f.errorClass !== 'AlreadyExists' &&
        'msdyn_projecttaskdependencylinklag' in f.op.entity
      )
      if (retryable.length > 0) {
        console.warn(`[dependencyWriter] ${retryable.length} dependency op(s) failed with lag set — retrying once without lag`)
        const strippedOps = retryable.map(f => {
          const entity = { ...f.op.entity }
          delete entity['msdyn_projecttaskdependencylinklag']
          return { id: f.op.id, entity }
        })
        const retryResult = await executeOperationSetWithRetry(
          projectId,
          strippedOps,
          `Project Online dependency import (no lag) ${new Date().toISOString()}`,
        )
        const retriedIds = new Set(strippedOps.map(o => o.id))
        batchResult.failed = batchResult.failed.filter(f => !retriedIds.has(f.op.id))
        batchResult.succeeded.push(...retryResult.succeeded)
        batchResult.failed.push(...retryResult.failed)
        if (retryResult.succeeded.length > 0) {
          console.warn(`[dependencyWriter] ${retryResult.succeeded.length} dependency(ies) created without lag — dates of those successors may shift`)
        }
      }

      for (const op of batchResult.succeeded) {
        const result: DependencyWriteResult = {
          poDependencyId: op.id,
          dvDependencyId: dvIdByPoId[op.id],
          success: true,
        }
        results.push(result)
        onProgress?.(result)
      }

      for (const { op, reason, errorClass } of batchResult.failed) {
        const result: DependencyWriteResult = {
          poDependencyId: op.id,
          success: false,
          error: nowError('Dependency', op.id, reason, errorClass, poProjectId),
        }
        results.push(result)
        onProgress?.(result)
      }
    }
  }

  return results
}

/**
 * Derives the FS lag (in working minutes) that makes the scheduling engine's
 * recalculation reproduce the imported dates: the number of working days
 * strictly between the predecessor's finish and the successor's start.
 * Successor starting the next working day → 0 (natural FS, no lag needed).
 * Successor starting on/before the predecessor's finish → negative lag (lead).
 * Returns null when either task or date is unknown (caller falls back to the
 * source lag value). Working days approximated as Mon–Fri; deviations from the
 * project's actual work-hour template can shift dates by a day.
 */
function computeCompensatedLagMinutes(
  dependency: PoTaskDependency,
  tasksById: Map<string, PoTask>,
  hoursPerDay: number,
): number | null {
  if (dependency.DependencyType && dependency.DependencyType !== 'FS') return null
  const predFinish = parseDateOnly(tasksById.get(dependency.PredecessorTaskId)?.TaskFinishDate)
  const succStart = parseDateOnly(tasksById.get(dependency.SuccessorTaskId)?.TaskStartDate)
  if (!predFinish || !succStart) return null

  const gapWorkingDays = signedWorkingDayDiff(predFinish, succStart) - 1
  return Math.round(gapWorkingDays * hoursPerDay * 60)
}

function parseDateOnly(value: string | undefined): Date | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

/** Signed count of working days (Mon–Fri) stepping from `from` to `to`; equal dates → 0. */
function signedWorkingDayDiff(from: Date, to: Date): number {
  const step = from.getTime() < to.getTime() ? 1 : -1
  let count = 0
  const cursor = new Date(from)
  let guard = 0
  while (cursor.getTime() !== to.getTime() && guard < 36500) {
    cursor.setDate(cursor.getDate() + step)
    const day = cursor.getDay()
    if (day !== 0 && day !== 6) count += step
    guard++
  }
  return count
}

function groupByProject(dependencies: PoTaskDependency[]): Map<string, PoTaskDependency[]> {
  const grouped = new Map<string, PoTaskDependency[]>()
  for (const dependency of dependencies) {
    const current = grouped.get(dependency.ProjectId) ?? []
    current.push(dependency)
    grouped.set(dependency.ProjectId, current)
  }
  return grouped
}
