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

export async function fetchAssignmentsForProjects(siteUrl: string, projects: PoProject[]): Promise<PoAssignment[]> {
  const rows = await Promise.all(projects.map(project =>
    fetchPositiveAssignmentsForProject(siteUrl, cleanGuid(project.ProjectId))
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

async function fetchPositiveAssignmentsForProject(siteUrl: string, projectId: string): Promise<PoAssignment[]> {
  const guidProjectFilter = `ProjectId eq guid'${projectId}'`
  const stringProjectFilter = `ProjectId eq '${projectId}'`

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

function filterPositiveAssignments(assignments: PoAssignment[]): PoAssignment[] {
  return assignments.filter(assignment => {
    const hours = workValueToHours(assignment.AssignmentWork ?? assignment.AssignmentRemainingWork)
    return hours != null && hours > 0
  })
}
