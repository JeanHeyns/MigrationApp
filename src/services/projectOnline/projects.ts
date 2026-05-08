import { odataGetAll } from './odataClient'
import type { PoProject } from '../../models/projectOnline.types'

export async function fetchProjects(siteUrl: string): Promise<PoProject[]> {
  const projects = await odataGetAll<PoProject>(siteUrl, '_api/ProjectData/Projects?$format=json')
  return projects.filter(isMigratableProject)
}

export function isMigratableProject(project: PoProject): boolean {
  return project.ProjectType !== 7 && project.ProjectIsAdministrative !== true
}
