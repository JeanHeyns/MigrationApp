import type { PoDependencyType, PoTaskDependency } from '../../models/projectOnline.types'
import type { ImportError } from '../../models/plannerPremium.types'
import { chunks, nowError } from './importHelpers'
import { executeOperationSetWithRetry } from './scheduleApi'

export interface DependencyWriteResult {
  poDependencyId: string
  dvDependencyId?: string
  success: boolean
  error?: ImportError
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
): Promise<DependencyWriteResult[]> {
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
          const result = {
            poDependencyId: dependency.DependencyId,
            success: false,
            error: nowError('Dependency', dependency.DependencyId, 'Predecessor or successor task was not imported', 'PredecessorMissing', poProjectId),
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
        return {
          id: dependency.DependencyId,
          dvId: dependencyId,
          entity: {
            '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_projecttaskdependency',
            msdyn_projecttaskdependencyid: dependencyId,
            msdyn_projecttaskdependencylinktype: LINK_TYPE_VALUES[dependency.DependencyType ?? 'FS'],
            ...(dependency.Lag != null ? { msdyn_projecttaskdependencylinklag: dependency.Lag * 60 } : {}),
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

function groupByProject(dependencies: PoTaskDependency[]): Map<string, PoTaskDependency[]> {
  const grouped = new Map<string, PoTaskDependency[]>()
  for (const dependency of dependencies) {
    const current = grouped.get(dependency.ProjectId) ?? []
    current.push(dependency)
    grouped.set(dependency.ProjectId, current)
  }
  return grouped
}
