import type { PoAssignment, PoProjectTeamMember, PoTask } from '../../models/projectOnline.types'
import type { ImportError } from '../../models/plannerPremium.types'
import { listRecords, performUnboundAction } from './dataverseClient'
import { chunks, cleanGuid, getRecordId, nowError } from './importHelpers'
import { classifyDataverseError } from './errorClassifier'
import { executeOperationSetWithRetry } from './scheduleApi'
import { buildAssignmentContour, serializePlannedWork, type ContourResult } from './assignmentContour'
import type { ProjectCalendar } from './calendarReader'
import { debugSchedule } from './scheduleDebug'

export interface AssignmentWriteResult {
  poAssignmentId: string
  dvAssignmentId?: string
  success: boolean
  error?: ImportError
}

/**
 * Creates msdyn_projectteam records through CreateTeamMemberV1.
 */
export async function writeTeamMembers(
  teamMembers: PoProjectTeamMember[],
  projectIdMap: Record<string, string>,
  resourceIdMap: Record<string, string>,
  onProgress?: (result: AssignmentWriteResult) => void,
): Promise<AssignmentWriteResult[]> {
  const results: AssignmentWriteResult[] = []
  const existingRows = await listRecords('msdyn_projectteams', 'msdyn_projectteamid,_msdyn_project_value,_msdyn_bookableresourceid_value', undefined, 5000)

  for (const teamMember of teamMembers) {
    const resourceKeys = getResourceKeys(teamMember)
    const resourceUid = resourceKeys[0] ?? ''
    const sourceId = `${teamMember.ProjectId}:${resourceUid}`
    try {
      const projectId = projectIdMap[teamMember.ProjectId]
      const resourceId = resolveMappedId(resourceIdMap, resourceKeys)

      if (!projectId || !resourceId) {
        const message = !resourceUid
          ? 'Team member has no resource id'
          : 'Project or bookable resource was not imported'
        const result = { poAssignmentId: sourceId, success: false, error: nowError('TeamMember', sourceId, message, undefined, teamMember.ProjectId) }
        results.push(result)
        onProgress?.(result)
        continue
      }

      const existing = existingRows.find(row =>
        String(row['_msdyn_project_value']).toLowerCase() === projectId.toLowerCase() &&
        String(row['_msdyn_bookableresourceid_value']).toLowerCase() === resourceId.toLowerCase()
      )
      const existingId = cleanGuid(getRecordId(existing ?? {}, 'msdyn_projectteamid'))
      if (existingId) {
        const result = { poAssignmentId: sourceId, dvAssignmentId: existingId, success: true }
        results.push(result)
        onProgress?.(result)
        continue
      }

      const response = await performUnboundAction('msdyn_CreateTeamMemberV1', {
        TeamMember: {
          '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_projectteam',
          msdyn_name: teamMember.ResourceName ?? sourceId,
          'msdyn_project@odata.bind': `/msdyn_projects(${projectId})`,
          'msdyn_bookableresourceid@odata.bind': `/bookableresources(${resourceId})`,
        },
      })
      const teamMemberId = cleanGuid((response.TeamMemberId ?? response.teamMemberId ?? response.msdyn_projectteamid) as string | undefined)
      const result = {
        poAssignmentId: sourceId,
        dvAssignmentId: teamMemberId,
        success: !!teamMemberId,
        error: teamMemberId ? undefined : nowError('TeamMember', sourceId, 'CreateTeamMemberV1 did not return a TeamMemberId'),
      }
      results.push(result)
      onProgress?.(result)
    } catch (e) {
      const errorClass = classifyDataverseError(e)
      const result = { poAssignmentId: sourceId, success: false, error: nowError('TeamMember', sourceId, String(e), errorClass !== 'Other' ? errorClass : undefined, teamMember.ProjectId) }
      results.push(result)
      onProgress?.(result)
    }
  }

  return results
}

export async function writeAssignments(
  assignments: PoAssignment[],
  projectIdMap: Record<string, string>,
  taskIdMap: Record<string, string>,
  teamMemberIdMap: Record<string, string>,
  tasks: PoTask[],
  calendar: ProjectCalendar,
  onProgress?: (result: AssignmentWriteResult) => void,
): Promise<AssignmentWriteResult[]> {
  const results: AssignmentWriteResult[] = []
  const tasksById = new Map<string, PoTask>(tasks.map(t => [t.TaskId, t]))
  const assignmentsByProject = groupAssignmentsByProject(assignments)

  for (const [poProjectId, projectAssignments] of assignmentsByProject) {
    const projectId = projectIdMap[poProjectId]
    if (!projectId) {
      for (const assignment of projectAssignments) {
        const resourceUid = getResourceKeys(assignment)[0] ?? ''
        const sourceId = assignment.AssignmentId ?? `${assignment.TaskId}:${resourceUid}`
        const result = { poAssignmentId: sourceId, success: false, error: nowError('Assignment', sourceId, 'Project was not imported', undefined, poProjectId) }
        results.push(result)
        onProgress?.(result)
      }
      continue
    }

    const existingRows = await listRecords(
      'msdyn_resourceassignments',
      'msdyn_resourceassignmentid,_msdyn_taskid_value,_msdyn_projectteamid_value,_msdyn_projectid_value',
      `_msdyn_projectid_value eq ${projectId}`,
      5000,
    )
    const existingByAssignmentKey = new Map<string, Record<string, unknown>>()
    const seenAssignmentKeys = new Set<string>()
    for (const row of existingRows) {
      const key = assignmentKey(row['_msdyn_taskid_value'], row['_msdyn_projectteamid_value'])
      if (!key) continue
      existingByAssignmentKey.set(key, row)
      seenAssignmentKeys.add(key)
    }

    for (const chunk of chunks(projectAssignments, 180)) {
      const creatable = chunk.filter(assignment => {
        const resourceKeys = getResourceKeys(assignment)
        const resourceUid = resourceKeys[0] ?? ''
        const sourceId = assignment.AssignmentId ?? `${assignment.TaskId}:${resourceUid}`
        const taskId = taskIdMap[assignment.TaskId]
        const teamMemberId = resolveMappedId(
          teamMemberIdMap,
          resourceKeys.map(key => `${assignment.ProjectId}:${key}`),
        )
        const key = assignmentKey(taskId, teamMemberId)
        const existingRow = key ? existingByAssignmentKey.get(key) : undefined

        if (!resourceUid || !taskId || !teamMemberId || existingRow || (key && seenAssignmentKeys.has(key))) {
          const isDuplicate = key && seenAssignmentKeys.has(key) && !existingRow
          const missingReason = [
            !resourceUid ? 'resource id is missing' : null,
            resourceUid && !taskId ? `task ${assignment.TaskId} was not imported or did not return a Dataverse task ID` : null,
            resourceUid && !teamMemberId ? `project team member for resource ${resourceUid} was not imported` : null,
          ].filter(Boolean).join('; ')
          const result = {
            poAssignmentId: sourceId,
            dvAssignmentId: existingRow ? cleanGuid(getRecordId(existingRow, 'msdyn_resourceassignmentid')) : undefined,
            success: !!existingRow,
            error: existingRow
              ? undefined
              : nowError(
                'Assignment',
                sourceId,
                isDuplicate
                  ? 'Duplicate assignment for the same task and project team member in source data'
                  : `Cannot create assignment: ${missingReason}`,
                isDuplicate ? 'AlreadyExists' : undefined,
                poProjectId,
              ),
          }
          results.push(result)
          onProgress?.(result)
          return false
        }
        if (key) seenAssignmentKeys.add(key)
        return true
      })

      if (creatable.length === 0) continue

      const ops = creatable.map(assignment => {
        const resourceKeys = getResourceKeys(assignment)
        const resourceUid = resourceKeys[0] ?? ''
        const sourceId = assignment.AssignmentId ?? `${assignment.TaskId}:${resourceUid}`
        const assignmentId = crypto.randomUUID()
        const taskId = taskIdMap[assignment.TaskId]
        const teamMemberId = resolveMappedId(
          teamMemberIdMap,
          resourceKeys.map(key => `${assignment.ProjectId}:${key}`),
        )

        // Build the planned-work contour so PSS schedules the resource across the
        // imported task dates (rather than re-deriving duration under Fixed Effort).
        const task = tasksById.get(assignment.TaskId)
        const contour: ContourResult = task ? buildAssignmentContour(task, assignment, calendar) : { slices: [] }
        if (contour.warning) {
          console.warn(`[assignmentWriter] ${sourceId}: ${contour.warning}`)
        }
        if (contour.slices.length > 0) {
          debugSchedule(`assignment ${sourceId} contour`, {
            taskId: assignment.TaskId,
            units: assignment.AssignmentUnits,
            slices: contour.slices.length,
            totalHours: contour.slices.reduce((sum, s) => sum + s.Hours, 0),
            firstSlice: contour.slices[0],
            lastSlice: contour.slices[contour.slices.length - 1],
          })
        }

        return {
          id: sourceId,
          dvId: assignmentId,
          entity: {
            '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_resourceassignment',
            msdyn_resourceassignmentid: assignmentId,
            msdyn_name: sourceId,
            'msdyn_projectid@odata.bind': `/msdyn_projects(${projectId})`,
            'msdyn_taskid@odata.bind': `/msdyn_projecttasks(${taskId})`,
            'msdyn_projectteamid@odata.bind': `/msdyn_projectteams(${teamMemberId})`,
            ...(contour.slices.length > 0 ? { msdyn_plannedwork: serializePlannedWork(contour.slices) } : {}),
          } as Record<string, unknown>,
        }
      })
      const dvIdByPoId = Object.fromEntries(ops.map(op => [op.id, op.dvId]))

      const batchResult = await executeOperationSetWithRetry(
        projectId,
        ops.map(op => ({ id: op.id, entity: op.entity })),
        `Project Online assignment import ${new Date().toISOString()}`,
      )

      // msdyn_plannedwork may be rejected (field unwriteable on some tenants, or a
      // contour the engine refuses). Retry failed ops once without the contour — a
      // bare assignment beats no assignment, and correctTaskSchedule still re-pins dates.
      const retryable = batchResult.failed.filter(f =>
        f.errorClass !== 'AlreadyExists' &&
        'msdyn_plannedwork' in f.op.entity
      )
      if (retryable.length > 0) {
        console.warn(`[assignmentWriter] ${retryable.length} assignment op(s) failed with plannedwork set — retrying once without contour`)
        const strippedOps = retryable.map(f => {
          const entity = { ...f.op.entity }
          delete entity['msdyn_plannedwork']
          return { id: f.op.id, entity }
        })
        const retryResult = await executeOperationSetWithRetry(
          projectId,
          strippedOps,
          `Project Online assignment import (no contour) ${new Date().toISOString()}`,
        )
        const retriedIds = new Set(strippedOps.map(o => o.id))
        batchResult.failed = batchResult.failed.filter(f => !retriedIds.has(f.op.id))
        batchResult.succeeded.push(...retryResult.succeeded)
        batchResult.failed.push(...retryResult.failed)
        if (retryResult.succeeded.length > 0) {
          console.warn(`[assignmentWriter] ${retryResult.succeeded.length} assignment(s) created without contour — task dates rely on correctTaskSchedule`)
        }
      }

      for (const op of batchResult.succeeded) {
        const result: AssignmentWriteResult = {
          poAssignmentId: op.id,
          dvAssignmentId: dvIdByPoId[op.id],
          success: true,
        }
        results.push(result)
        onProgress?.(result)
      }

      for (const { op, reason, errorClass } of batchResult.failed) {
        const result: AssignmentWriteResult = {
          poAssignmentId: op.id,
          dvAssignmentId: errorClass === 'AlreadyExists' ? dvIdByPoId[op.id] : undefined,
          success: false,
          error: nowError('Assignment', op.id, reason, errorClass !== 'Other' ? errorClass : undefined, poProjectId),
        }
        results.push(result)
        onProgress?.(result)
      }
    }
  }

  return results
}

function getResourceKeys(row: { ResourceUID?: string; ResourceId?: string }): string[] {
  return [...new Set([row.ResourceUID, row.ResourceId].map(value => value?.trim()).filter((value): value is string => !!value))]
}

function resolveMappedId(map: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = map[key]
    if (value) return value
  }
  return undefined
}

function assignmentKey(taskId: unknown, teamMemberId: unknown): string | undefined {
  if (!taskId || !teamMemberId) return undefined
  return `${String(taskId).toLowerCase()}:${String(teamMemberId).toLowerCase()}`
}

function groupAssignmentsByProject(assignments: PoAssignment[]): Map<string, PoAssignment[]> {
  const grouped = new Map<string, PoAssignment[]>()
  for (const assignment of assignments) {
    const current = grouped.get(assignment.ProjectId) ?? []
    current.push(assignment)
    grouped.set(assignment.ProjectId, current)
  }
  return grouped
}
