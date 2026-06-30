import type { PoDependencyType, PoTask, PoTaskDependency } from '../../models/projectOnline.types'
import type { ImportError } from '../../models/plannerPremium.types'
import { chunks, nowError } from './importHelpers'
import { executeOperationSetWithRetry } from './scheduleApi'

export interface DependencyWriteResult {
  poDependencyId: string
  dvDependencyId?: string
  dependencyType?: PoDependencyType
  sourceLagTenthsOfMinute?: number
  lagSeconds?: number
  writtenDependencyType?: PoDependencyType
  writtenLagSeconds?: number
  fallbackApplied?: 'withoutLag' | 'asFs' | 'withoutLagAndAsFs'
  fallbackReason?: string
  success: boolean
  warning?: string
  error?: ImportError
}

export interface DependencyLagContext {
  tasks: PoTask[]
  skipSummaryTaskDependencies?: boolean
  includeSourceLag?: boolean
}

const LINK_TYPE_VALUES: Record<PoDependencyType, number> = {
  FF: 0,
  FS: 1,
  SF: 2,
  SS: 3,
}

export function dependencyLinkTypeValue(type: PoDependencyType | undefined): number {
  return LINK_TYPE_VALUES[type ?? 'FS']
}

export function dependencyLagTenthsOfMinute(dependency: PoTaskDependency, includeSourceLag: boolean | undefined): number | null {
  if (!includeSourceLag || dependency.Lag == null || dependency.Lag === 0) return null
  return dependency.Lag
}

export function dependencyLagSeconds(dependency: PoTaskDependency, includeSourceLag: boolean | undefined): number | null {
  const lagTenthsOfMinute = dependencyLagTenthsOfMinute(dependency, includeSourceLag)
  return lagTenthsOfMinute == null ? null : Math.round(lagTenthsOfMinute * 6)
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
        const predecessorTask = tasksById.get(dependency.PredecessorTaskId)
        const successorTask = tasksById.get(dependency.SuccessorTaskId)
        if (lagContext?.skipSummaryTaskDependencies && (isSummaryTask(predecessorTask) || isSummaryTask(successorTask))) {
          const result = {
            poDependencyId: dependency.DependencyId,
            success: false,
            error: nowError(
              'Dependency',
              dependency.DependencyId,
              'Dependency references a summary task and was not created',
              'Skipped',
              poProjectId,
            ),
          }
          results.push(result)
          onProgress?.(result)
          return false
        }

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

        return true
      })

      if (creatable.length === 0) continue

      const ops = creatable.map(dependency => {
        const dependencyId = crypto.randomUUID()
        const lagSeconds = dependencyLagSeconds(dependency, lagContext?.includeSourceLag)
        return {
          id: dependency.DependencyId,
          dvId: dependencyId,
          dependencyType: dependency.DependencyType ?? 'FS',
          sourceLagTenthsOfMinute: dependency.Lag,
          lagSeconds,
          entity: {
            '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_projecttaskdependency',
            msdyn_projecttaskdependencyid: dependencyId,
            msdyn_projecttaskdependencylinktype: dependencyLinkTypeValue(dependency.DependencyType),
            ...(lagSeconds != null ? { msdyn_projecttaskdependencylinklag: lagSeconds } : {}),
            msdyn_description: '',
            'msdyn_Project@odata.bind': `/msdyn_projects(${projectId})`,
            'msdyn_PredecessorTask@odata.bind': `/msdyn_projecttasks(${taskIdMap[dependency.PredecessorTaskId]})`,
            'msdyn_SuccessorTask@odata.bind': `/msdyn_projecttasks(${taskIdMap[dependency.SuccessorTaskId]})`,
          } as Record<string, unknown>,
        }
      })

      const dvIdByPoId = Object.fromEntries(ops.map(o => [o.id, o.dvId]))
      const opMetadataByPoId = new Map(ops.map(o => [o.id, {
        dependencyType: o.dependencyType,
        sourceLagTenthsOfMinute: o.sourceLagTenthsOfMinute,
        lagSeconds: o.lagSeconds,
      }]))
      const dependencyById = new Map(creatable.map(dependency => [dependency.DependencyId, dependency]))
      const fallbackAuditByPoId = new Map<string, DependencyFallbackAudit>()
      const writtenByPoId = new Map<string, { dependencyType: PoDependencyType; lagSeconds: number | null }>()

      const batchResult = await executeOperationSetWithRetry(
        projectId,
        ops.map(o => ({ id: o.id, entity: o.entity })),
        `Project Online dependency import ${new Date().toISOString()}`,
      )

      const retryWithoutLag = batchResult.failed.filter(f =>
        f.errorClass !== 'AlreadyExists' &&
        'msdyn_projecttaskdependencylinklag' in f.op.entity
      )
      if (retryWithoutLag.length > 0) {
        console.warn(`[dependencyWriter] ${retryWithoutLag.length} dependency op(s) failed with source lag set - retrying without lag`)
        for (const failure of retryWithoutLag) {
          fallbackAuditFor(fallbackAuditByPoId, failure.op.id).messages.push(
            `source lag rejected (${failure.errorClass}): ${compactFailureReason(failure.reason)}`,
          )
        }

        const strippedOps = retryWithoutLag.map(f => {
          const entity = { ...f.op.entity }
          delete entity['msdyn_projecttaskdependencylinklag']
          return { id: f.op.id, entity }
        })
        const retryResult = await executeOperationSetWithRetry(
          projectId,
          strippedOps,
          `Project Online dependency import (no lag fallback) ${new Date().toISOString()}`,
        )
        const retriedIds = new Set(strippedOps.map(o => o.id))
        batchResult.failed = batchResult.failed.filter(f => !retriedIds.has(f.op.id))
        batchResult.succeeded.push(...retryResult.succeeded)
        batchResult.failed.push(...retryResult.failed)

        for (const op of retryResult.succeeded) {
          const metadata = opMetadataByPoId.get(op.id)
          fallbackAuditFor(fallbackAuditByPoId, op.id).withoutLag = true
          fallbackAuditFor(fallbackAuditByPoId, op.id).messages.push('fallback applied: created without source lag')
          writtenByPoId.set(op.id, { dependencyType: metadata?.dependencyType ?? 'FS', lagSeconds: null })
        }
        for (const failure of retryResult.failed) {
          fallbackAuditFor(fallbackAuditByPoId, failure.op.id).messages.push(
            `without-lag fallback failed (${failure.errorClass}): ${compactFailureReason(failure.reason)}`,
          )
        }
      }

      const retryAsFs = batchResult.failed.filter(f => {
        const source = dependencyById.get(f.op.id)
        return f.errorClass !== 'AlreadyExists' && source?.DependencyType && source.DependencyType !== 'FS'
      })
      if (retryAsFs.length > 0) {
        console.warn(`[dependencyWriter] ${retryAsFs.length} non-FS dependency op(s) failed - retrying as FS with fallback warning`)
        for (const failure of retryAsFs) {
          const source = dependencyById.get(failure.op.id)
          fallbackAuditFor(fallbackAuditByPoId, failure.op.id).messages.push(
            `source type ${source?.DependencyType ?? 'unknown'} rejected before FS fallback (${failure.errorClass}): ${compactFailureReason(failure.reason)}`,
          )
        }

        const fallbackOps = retryAsFs.map(f => {
          const entity = { ...f.op.entity, msdyn_projecttaskdependencylinktype: LINK_TYPE_VALUES.FS }
          return { id: f.op.id, entity }
        })
        const fallbackResult = await executeOperationSetWithRetry(
          projectId,
          fallbackOps,
          `Project Online dependency import (FS fallback) ${new Date().toISOString()}`,
        )
        const fallbackIds = new Set(fallbackOps.map(o => o.id))
        batchResult.failed = batchResult.failed.filter(f => !fallbackIds.has(f.op.id))
        batchResult.succeeded.push(...fallbackResult.succeeded)
        batchResult.failed.push(...fallbackResult.failed)

        for (const op of fallbackResult.succeeded) {
          const lag = typeof op.entity.msdyn_projecttaskdependencylinklag === 'number'
            ? op.entity.msdyn_projecttaskdependencylinklag
            : null
          fallbackAuditFor(fallbackAuditByPoId, op.id).asFs = true
          fallbackAuditFor(fallbackAuditByPoId, op.id).messages.push('fallback applied: created as FS')
          writtenByPoId.set(op.id, { dependencyType: 'FS', lagSeconds: lag })
        }
        for (const failure of fallbackResult.failed) {
          fallbackAuditFor(fallbackAuditByPoId, failure.op.id).messages.push(
            `FS fallback failed (${failure.errorClass}): ${compactFailureReason(failure.reason)}`,
          )
        }
      }

      for (const op of batchResult.succeeded) {
        const metadata = opMetadataByPoId.get(op.id)
        const audit = fallbackAuditByPoId.get(op.id)
        const written = writtenByPoId.get(op.id)
        const fallbackReason = audit?.messages.join('; ')
        const result: DependencyWriteResult = {
          poDependencyId: op.id,
          dvDependencyId: dvIdByPoId[op.id],
          dependencyType: metadata?.dependencyType,
          sourceLagTenthsOfMinute: metadata?.sourceLagTenthsOfMinute,
          lagSeconds: metadata?.lagSeconds ?? undefined,
          writtenDependencyType: written?.dependencyType ?? metadata?.dependencyType,
          writtenLagSeconds: written ? written.lagSeconds ?? undefined : metadata?.lagSeconds ?? undefined,
          fallbackApplied: audit ? fallbackApplied(audit) : undefined,
          fallbackReason,
          success: true,
          warning: fallbackReason,
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

function isSummaryTask(task: PoTask | undefined): boolean {
  return !!task?.TaskIsSummary
}

interface DependencyFallbackAudit {
  messages: string[]
  withoutLag?: boolean
  asFs?: boolean
}

function fallbackAuditFor(map: Map<string, DependencyFallbackAudit>, id: string): DependencyFallbackAudit {
  const existing = map.get(id)
  if (existing) return existing
  const created = { messages: [] }
  map.set(id, created)
  return created
}

function fallbackApplied(audit: DependencyFallbackAudit): DependencyWriteResult['fallbackApplied'] {
  if (audit.withoutLag && audit.asFs) return 'withoutLagAndAsFs'
  if (audit.withoutLag) return 'withoutLag'
  if (audit.asFs) return 'asFs'
  return undefined
}

function compactFailureReason(reason: string): string {
  const compact = reason.replace(/\s+/g, ' ').trim()
  return compact.length > 500 ? `${compact.slice(0, 500)}...` : compact
}
