import { odataGetAll } from './odataClient'
import type { PoAssignment, PoProject, PoProjectTeamMember } from '../../models/projectOnline.types'

export async function fetchAssignments(siteUrl: string): Promise<PoAssignment[]> {
  return odataGetAll<PoAssignment>(siteUrl, '_api/ProjectData/Assignments?$format=json')
}

export async function fetchAssignmentsForProjects(siteUrl: string, projects: PoProject[]): Promise<PoAssignment[]> {
  const rows = await Promise.all(projects.map(project =>
    odataGetAll<PoAssignment>(siteUrl, `_api/ProjectData/Assignments?$format=json&$filter=ProjectId eq guid'${cleanGuid(project.ProjectId)}'`)
      .catch(() => odataGetAll<PoAssignment>(siteUrl, `_api/ProjectData/Assignments?$format=json&$filter=ProjectId eq '${cleanGuid(project.ProjectId)}'`))
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
