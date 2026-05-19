import type { PoAssignment, PoProjectTeamMember } from '../../models/projectOnline.types'
import type { ImportError } from '../../models/plannerPremium.types'
import { listRecords, performUnboundAction } from './dataverseClient'
import { chunks, cleanGuid, getRecordId, nowError } from './importHelpers'
import { classifyDataverseError } from './errorClassifier'
import { createOperationSet, executeOperationSet, queueScheduleCreate } from './scheduleApi'

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
    const resourceUid = getResourceUid(teamMember)
    const sourceId = `${teamMember.ProjectId}:${resourceUid}`
    try {
      const projectId = projectIdMap[teamMember.ProjectId]
      const resourceId = resourceIdMap[resourceUid]

      if (!projectId || !resourceId) {
        const result = { poAssignmentId: sourceId, success: false, error: nowError('TeamMember', sourceId, 'Project or bookable resource was not imported', undefined, teamMember.ProjectId) }
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
): Promise<AssignmentWriteResult[]> {
  const results: AssignmentWriteResult[] = []
  const assignmentsByProject = groupAssignmentsByProject(assignments)

  for (const [poProjectId, projectAssignments] of assignmentsByProject) {
    const projectId = projectIdMap[poProjectId]
    if (!projectId) {
      for (const assignment of projectAssignments) {
        const sourceId = assignment.AssignmentId ?? `${assignment.TaskId}:${getResourceUid(assignment)}`
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

    for (const chunk of chunks(projectAssignments, 180)) {
      const creatable = chunk.filter(assignment => {
        const resourceUid = getResourceUid(assignment)
        const sourceId = assignment.AssignmentId ?? `${assignment.TaskId}:${resourceUid}`
        const taskId = taskIdMap[assignment.TaskId]
        const teamMemberId = teamMemberIdMap[`${assignment.ProjectId}:${resourceUid}`]
        const existingRow = existingRows.find(row =>
          String(row['_msdyn_taskid_value']).toLowerCase() === String(taskId).toLowerCase() &&
          String(row['_msdyn_projectteamid_value']).toLowerCase() === String(teamMemberId).toLowerCase()
        )

        if (!taskId || !teamMemberId || existingRow) {
          const result = {
            poAssignmentId: sourceId,
            dvAssignmentId: existingRow ? cleanGuid(getRecordId(existingRow, 'msdyn_resourceassignmentid')) : undefined,
            success: !!existingRow,
            error: existingRow ? undefined : nowError('Assignment', sourceId, 'Task or project team member was not imported'),
          }
          results.push(result)
          onProgress?.(result)
          return false
        }
        return true
      })

      if (creatable.length === 0) continue
      const operationSetId = await createOperationSet(projectId, `Project Online assignment import ${new Date().toISOString()}`)
      let queued = 0
      const queuedResults: AssignmentWriteResult[] = []

      for (const assignment of creatable) {
        const resourceUid = getResourceUid(assignment)
        const sourceId = assignment.AssignmentId ?? `${assignment.TaskId}:${resourceUid}`
        try {
          const assignmentId = crypto.randomUUID()
          await queueScheduleCreate(operationSetId, {
            '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_resourceassignment',
            msdyn_resourceassignmentid: assignmentId,
            msdyn_name: sourceId,
            'msdyn_projectid@odata.bind': `/msdyn_projects(${projectId})`,
            'msdyn_taskid@odata.bind': `/msdyn_projecttasks(${taskIdMap[assignment.TaskId]})`,
            'msdyn_projectteamid@odata.bind': `/msdyn_projectteams(${teamMemberIdMap[`${assignment.ProjectId}:${resourceUid}`]})`,
          })
          queued += 1
          queuedResults.push({ poAssignmentId: sourceId, dvAssignmentId: assignmentId, success: true })
        } catch (e) {
          const errorClass = classifyDataverseError(e)
          const result = { poAssignmentId: sourceId, success: false, error: nowError('Assignment', sourceId, String(e), errorClass !== 'Other' ? errorClass : undefined, poProjectId) }
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
          const errorClass = classifyDataverseError(e)
          for (const result of queuedResults) {
            const failed = {
              poAssignmentId: result.poAssignmentId,
              success: false,
              error: nowError('Assignment', result.poAssignmentId, String(e), errorClass !== 'Other' ? errorClass : undefined, poProjectId),
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

function getResourceUid(row: { ResourceUID?: string; ResourceId?: string }): string {
  return row.ResourceUID ?? row.ResourceId ?? ''
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

