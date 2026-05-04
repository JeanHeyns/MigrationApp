import { odataGetAll } from './odataClient'
import type { PoTask } from '../../models/projectOnline.types'

export async function fetchTasks(siteUrl: string): Promise<PoTask[]> {
  return odataGetAll<PoTask>(siteUrl, '_api/ProjectData/Tasks?$format=json')
}
