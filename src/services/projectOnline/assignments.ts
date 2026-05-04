import { odataGetAll } from './odataClient'
import type { PoAssignment, PoProjectTeamMember } from '../../models/projectOnline.types'

export async function fetchAssignments(siteUrl: string): Promise<PoAssignment[]> {
  return odataGetAll<PoAssignment>(siteUrl, '_api/ProjectData/Assignments?$format=json')
}

export async function fetchTeamMembers(siteUrl: string): Promise<PoProjectTeamMember[]> {
  return odataGetAll<PoProjectTeamMember>(
    siteUrl,
    '_api/ProjectData/ProjectTeamMembers?$format=json',
  )
}
