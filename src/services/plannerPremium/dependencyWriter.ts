import type { PoDependencyType, PoTaskDependency } from '../../models/projectOnline.types'
import type { ImportError } from '../../models/plannerPremium.types'
import { chunks, nowError } from './importHelpers'
import { createOperationSet, executeOperationSet, queueScheduleCreate } from './scheduleApi'

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
          error: nowError('Dependency', dependency.DependencyId, 'Project was not imported'),
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
            error: nowError('Dependency', dependency.DependencyId, 'Predecessor or successor task was not imported'),
          }
          results.push(result)
          onProgress?.(result)
          return false
        }

        return true
      })

      if (creatable.length === 0) continue

      const operationSetId = await createOperationSet(projectId, `Project Online dependency import ${new Date().toISOString()}`)
      let queued = 0
      const queuedResults: DependencyWriteResult[] = []

      for (const dependency of creatable) {
        try {
          const dependencyId = crypto.randomUUID()
          await queueScheduleCreate(operationSetId, {
            '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_projecttaskdependency',
            msdyn_projecttaskdependencyid: dependencyId,
            msdyn_projecttaskdependencylinktype: LINK_TYPE_VALUES[dependency.DependencyType ?? 'FS'],
            ...(dependency.Lag != null ? { msdyn_projecttaskdependencylinklag: dependency.Lag * 60 } : {}),
            msdyn_description: '',
            'msdyn_Project@odata.bind': `/msdyn_projects(${projectId})`,
            'msdyn_PredecessorTask@odata.bind': `/msdyn_projecttasks(${taskIdMap[dependency.PredecessorTaskId]})`,
            'msdyn_SuccessorTask@odata.bind': `/msdyn_projecttasks(${taskIdMap[dependency.SuccessorTaskId]})`,
          })
          queued += 1
          queuedResults.push({ poDependencyId: dependency.DependencyId, dvDependencyId: dependencyId, success: true })
        } catch (e) {
          const result = { poDependencyId: dependency.DependencyId, success: false, error: nowError('Dependency', dependency.DependencyId, String(e)) }
          results.push(result)
          onProgress?.(result)
        }
      }

      if (queued > 0) {
        try {
          await executeOperationSet(operationSetId)
          for (const result of queuedResults) {
            results.push(result)
            onProgress?.(result)
          }
        } catch (e) {
          for (const result of queuedResults) {
            const failed = {
              poDependencyId: result.poDependencyId,
              success: false,
              error: nowError('Dependency', result.poDependencyId, String(e)),
            }
            results.push(failed)
            onProgress?.(failed)
          }
        }
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
