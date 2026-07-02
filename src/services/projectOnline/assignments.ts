import { odataGetAll } from './odataClient'
import type { PoAssignment, PoProject, PoProjectTeamMember } from '../../models/projectOnline.types'
import { workValueToHours } from '../plannerPremium/scheduleMath'

const POSITIVE_ASSIGNMENT_WORK_FILTER = '(AssignmentWork gt 0 or AssignmentRemainingWork gt 0)'

export async function fetchAssignments(siteUrl: string): Promise<PoAssignment[]> {
  try {
    return filterPositiveAssignments(await odataGetAll<PoAssignment>(
      siteUrl,
      `_api/ProjectData/Assignments?$format=json&$filter=${POSITIVE_ASSIGNMENT_WORK_FILTER}`,
    ))
  } catch {
    return filterPositiveAssignments(await odataGetAll<PoAssignment>(siteUrl, '_api/ProjectData/Assignments?$format=json'))
  }
}

export interface AssignmentFetchOptions {
  /** When true, assignments with 0 source work are fetched too (no server or client work filter). */
  includeZeroWork?: boolean
}

export async function fetchAssignmentsForProjects(
  siteUrl: string,
  projects: PoProject[],
  options?: AssignmentFetchOptions,
): Promise<PoAssignment[]> {
  const rows = await Promise.all(projects.map(project =>
    fetchAssignmentsForProject(siteUrl, cleanGuid(project.ProjectId), options?.includeZeroWork ?? false)
  ))
  return rows.flat()
}

export async function fetchTeamMembers(siteUrl: string): Promise<PoProjectTeamMember[]> {
  return odataGetAll<PoProjectTeamMember>(
    siteUrl,
    '_api/ProjectData/ProjectTeamMembers?$format=json',
  )
}

export async function fetchTeamMembersForProjects(siteUrl: string, projects: PoProject[]): Promise<PoProjectTeamMember[]> {
  const rows = await Promise.all(projects.map(project =>
    odataGetAll<PoProjectTeamMember>(siteUrl, `_api/ProjectData/ProjectTeamMembers?$format=json&$filter=ProjectId eq guid'${cleanGuid(project.ProjectId)}'`)
      .catch(() => odataGetAll<PoProjectTeamMember>(siteUrl, `_api/ProjectData/ProjectTeamMembers?$format=json&$filter=ProjectId eq '${cleanGuid(project.ProjectId)}'`))
  ))
  return rows.flat()
}

function cleanGuid(id: string): string {
  return id.replace(/[{}]/g, '').trim()
}

async function fetchAssignmentsForProject(siteUrl: string, projectId: string, includeZeroWork: boolean): Promise<PoAssignment[]> {
  const guidProjectFilter = `ProjectId eq guid'${projectId}'`
  const stringProjectFilter = `ProjectId eq '${projectId}'`

  if (includeZeroWork) {
    return odataGetAll<PoAssignment>(
      siteUrl,
      assignmentUri(guidProjectFilter),
    ).catch(() => odataGetAll<PoAssignment>(
      siteUrl,
      assignmentUri(stringProjectFilter),
    ))
  }

  try {
    return filterPositiveAssignments(await odataGetAll<PoAssignment>(
      siteUrl,
      assignmentUri(`${guidProjectFilter} and ${POSITIVE_ASSIGNMENT_WORK_FILTER}`),
    ))
  } catch {
    try {
      return filterPositiveAssignments(await odataGetAll<PoAssignment>(
        siteUrl,
        assignmentUri(`${stringProjectFilter} and ${POSITIVE_ASSIGNMENT_WORK_FILTER}`),
      ))
    } catch {
      return filterPositiveAssignments(await odataGetAll<PoAssignment>(
        siteUrl,
        assignmentUri(guidProjectFilter),
      ).catch(() => odataGetAll<PoAssignment>(
        siteUrl,
        assignmentUri(stringProjectFilter),
      )))
    }
  }
}

function assignmentUri(filter: string): string {
  return `_api/ProjectData/Assignments?$format=json&$filter=${filter}`
}

/**
 * Client-side mirror of POSITIVE_ASSIGNMENT_WORK_FILTER: keep an assignment when
 * EITHER work field is positive. Checking both fields matters — `Work ?? RemainingWork`
 * would stop at Work=0 and drop rows the server filter deliberately keeps.
 */
function filterPositiveAssignments(assignments: PoAssignment[]): PoAssignment[] {
  return assignments.filter(assignment => {
    const work = workValueToHours(assignment.AssignmentWork) ?? 0
    const remaining = workValueToHours(assignment.AssignmentRemainingWork) ?? 0
    return work > 0 || remaining > 0
  })
}
