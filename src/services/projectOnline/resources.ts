import { odataGetAll } from './odataClient'
import type { PoResource } from '../../models/projectOnline.types'

export async function fetchResources(siteUrl: string): Promise<PoResource[]> {
  return odataGetAll<PoResource>(siteUrl, '_api/ProjectData/Resources?$format=json')
}
