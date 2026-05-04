import { odataGetAll } from './odataClient'
import type { PoResource } from '../../models/projectOnline.types'

export async function fetchResources(siteUrl: string): Promise<PoResource[]> {
  return odataGetAll<PoResource>(siteUrl, '_api/ProjectData/Resources?$format=json')
}

export async function fetchResourcesByIds(siteUrl: string, resourceIds: string[]): Promise<PoResource[]> {
  if (resourceIds.length === 0) return []
  const filter = resourceIds.map(id => `ResourceId eq guid'${id}'`).join(' or ')
  return odataGetAll<PoResource>(siteUrl, `_api/ProjectData/Resources?$filter=${encodeURIComponent(filter)}&$format=json`)
}
