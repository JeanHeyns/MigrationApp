import type { PoAssignment, PoProjectTeamMember, PoTask } from '../../models/projectOnline.types'
import type { ImportError } from '../../models/plannerPremium.types'
import { listRecords, performUnboundAction } from './dataverseClient'
import { chunks, cleanGuid, getRecordId, nowError } from './importHelpers'
import { classifyDataverseError } from './errorClassifier'
import { abandonOperationSet, createOperationSet, executeOperationSet, executeOperationSetWithRetry, isMissingResourceAssignmentContourAction, queueResourceAssignmentContourUpdate } from './scheduleApi'
import { workValueToHours, type ProjectCalendar } from './scheduleMath'
import { buildAssignmentContourUpdates, serializeUpdatedContours } from './assignmentContour'
import type { UpdatedContourResult } from './assignmentContour'
import { debugSchedule } from './scheduleDebug'

export interface AssignmentWriteResult {
  poAssignmentId: string
  dvAssignmentId?: string
  success: boolean
  warning?: string
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
  onProgress?: (result: AssignmentWriteResult) => void,
  tasks: PoTask[] = [],
  calendar?: ProjectCalendar,
): Promise<AssignmentWriteResult[]> {
  const results: AssignmentWriteResult[] = []
  const assignmentsByProject = groupAssignmentsByProject(assignments)
  const taskById = new Map(tasks.map(task => [task.TaskId, task]))

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
        const sourceHours = getAssignmentSourceHours(assignment)
        if (sourceHours <= 0) {
          const result: AssignmentWriteResult = {
            poAssignmentId: sourceId,
            success: false,
            error: nowError('Assignment', sourceId, 'Assignment has 0 source effort and was not created', 'Skipped', poProjectId),
          }
          results.push(result)
          onProgress?.(result)
          return false
        }

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

        // NOTE: msdyn_plannedwork (and Effort) are NOT writeable on resource
        // assignment CREATE — PssCreateV1 rejects them ("ScheduleAPI-AV-0001 …
        // niet toegestaan"). The work contour is set after create via the
        // dedicated msdyn_PssUpdateResourceAssignmentContourV1 action.
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
          } as Record<string, unknown>,
        }
      })
      const dvIdByPoId = Object.fromEntries(ops.map(op => [op.id, op.dvId]))
      const assignmentBySourceId = new Map(creatable.map(assignment => {
        const resourceUid = getResourceKeys(assignment)[0] ?? ''
        const sourceId = assignment.AssignmentId ?? `${assignment.TaskId}:${resourceUid}`
        return [sourceId, assignment]
      }))

      const batchResult = await executeOperationSetWithRetry(
        projectId,
        ops.map(op => ({ id: op.id, entity: op.entity })),
        `Project Online assignment import ${new Date().toISOString()}`,
      )

      const contourFailures = calendar
        ? await updateAssignmentContours(
          projectId,
          batchResult.succeeded
            .map(op => assignmentBySourceId.get(op.id))
            .filter((assignment): assignment is PoAssignment => !!assignment),
          taskById,
          dvIdByPoId,
          calendar,
        )
        : new Map<string, string>()

      for (const op of batchResult.succeeded) {
        const contourFailure = contourFailures.get(op.id)
        if (contourFailure) {
          console.warn(`[assignmentWriter] assignment ${op.id} was created, but contour update failed: ${contourFailure}`)
        }
        const result: AssignmentWriteResult = {
          poAssignmentId: op.id,
          dvAssignmentId: dvIdByPoId[op.id],
          success: true,
          warning: contourFailure ? `Assignment contour update failed: ${contourFailure}` : undefined,
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

async function updateAssignmentContours(
  projectId: string,
  assignments: PoAssignment[],
  taskById: Map<string, PoTask>,
  assignmentIdBySourceId: Record<string, string>,
  calendar: ProjectCalendar,
): Promise<Map<string, string>> {
  const failures = new Map<string, string>()
  const updates = assignments.flatMap(assignment => {
    const resourceUid = getResourceKeys(assignment)[0] ?? ''
    const sourceId = assignment.AssignmentId ?? `${assignment.TaskId}:${resourceUid}`
    const resourceAssignmentId = assignmentIdBySourceId[sourceId]
    const task = taskById.get(assignment.TaskId)
    if (!resourceAssignmentId || !task) {
      failures.set(sourceId, !resourceAssignmentId ? 'Dataverse assignment id was not returned' : `Task ${assignment.TaskId} was not found for contour generation`)
      return []
    }

    const sourceHours = getAssignmentSourceHours(assignment)
    const contour: UpdatedContourResult = buildAssignmentContourUpdates(task, assignment, calendar)
    if (contour.warning) console.warn(`[assignmentWriter] ${sourceId}: ${contour.warning}`)
    if (contour.contours.length === 0) {
      if (contour.warning) failures.set(sourceId, contour.warning)
      return []
    }

    debugSchedule(`assignment ${sourceId} contour update`, {
      resourceAssignmentId,
      contours: contour.contours.length,
      totalMinutes: contour.contours.reduce((sum, c) => sum + c.minutes, 0),
      firstContour: contour.contours[0],
      lastContour: contour.contours[contour.contours.length - 1],
      source_work: assignment.AssignmentWork,
      source_remaining_work: assignment.AssignmentRemainingWork,
      clear_work: sourceHours <= 0,
      source_start: assignment.AssignmentStartDate,
      source_finish: assignment.AssignmentFinishDate,
    })

    return [{
      sourceId,
      resourceAssignmentId,
      payload: serializeUpdatedContours(contour.contours),
    }]
  })

  for (const chunk of chunks(updates, 180)) {
    if (chunk.length === 0) continue
    let opSetId: string | undefined
    try {
      opSetId = await createOperationSet(projectId, `Update assignment contours ${new Date().toISOString()}`)
      for (const update of chunk) {
        await queueResourceAssignmentContourUpdate(opSetId, update.resourceAssignmentId, update.payload)
      }
      await executeOperationSet(opSetId)
    } catch (e) {
      if (opSetId) await abandonOperationSet(opSetId)
      console.warn(`[assignmentWriter] contour update batch failed (${chunk.length} assignment(s)), retrying individually: ${String(e).slice(0, 500)}`)
      if (isMissingResourceAssignmentContourAction(e)) {
        for (const update of chunk) {
          failures.set(update.sourceId, String(e).slice(0, 500))
        }
        continue
      }
      for (const update of chunk) {
        let singleOpSetId: string | undefined
        try {
          singleOpSetId = await createOperationSet(projectId, `Update assignment contour ${new Date().toISOString()}`)
          await queueResourceAssignmentContourUpdate(singleOpSetId, update.resourceAssignmentId, update.payload)
          await executeOperationSet(singleOpSetId)
        } catch (singleError) {
          if (singleOpSetId) await abandonOperationSet(singleOpSetId)
          failures.set(update.sourceId, String(singleError).slice(0, 500))
        }
      }
    }
  }
  return failures
}

function getAssignmentSourceHours(assignment: PoAssignment): number {
  const hours = workValueToHours(assignment.AssignmentWork ?? assignment.AssignmentRemainingWork)
  return hours != null && Number.isFinite(hours) ? hours : 0
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
