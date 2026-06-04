import { odataGetAll } from './odataClient'
import type { PoProject, PoTask } from '../../models/projectOnline.types'

export async function fetchTasks(siteUrl: string): Promise<PoTask[]> {
  return odataGetAll<PoTask>(siteUrl, '_api/ProjectData/Tasks?$format=json')
}

export async function fetchTasksForProjects(siteUrl: string, projects: PoProject[]): Promise<PoTask[]> {
  const rows = await Promise.all(projects.map(project =>
    odataGetAll<PoTask>(siteUrl, `_api/ProjectData/Tasks?$format=json&$filter=ProjectId eq guid'${cleanGuid(project.ProjectId)}'`)
      .catch(() => odataGetAll<PoTask>(siteUrl, `_api/ProjectData/Tasks?$format=json&$filter=ProjectId eq '${cleanGuid(project.ProjectId)}'`))
  ))
  return rows.flat()
}

function cleanGuid(id: string): string {
  return id.replace(/[{}]/g, '').trim()
}
