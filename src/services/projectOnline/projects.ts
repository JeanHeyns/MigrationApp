import { odataGetAll } from './odataClient'
import type { PoProject } from '../../models/projectOnline.types'

export async function fetchProjects(siteUrl: string): Promise<PoProject[]> {
  return odataGetAll<PoProject>(siteUrl, '_api/ProjectData/Projects?$format=json')
}
