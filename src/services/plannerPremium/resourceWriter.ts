import type { PoResource } from '../../models/projectOnline.types'
import type { ImportError } from '../../models/plannerPremium.types'
import { createRecord, fetchSystemUsers, listRecords } from './dataverseClient'
import { cleanGuid, getRecordId, nowError } from './importHelpers'

export interface ResourceWriteResult {
  poResourceUid: string
  dvBookableResourceId?: string
  dvSystemUserId?: string
  success: boolean
  error?: ImportError
}

/**
 * Matches Project Online resources to Dataverse systemusers by email first, then name.
 * Creates/uses bookable resources for matched users. Unmatched resources are skipped.
 */
export async function writeResources(
  resources: PoResource[],
  onProgress?: (result: ResourceWriteResult) => void,
): Promise<ResourceWriteResult[]> {
  const users = await fetchSystemUsers()
  const existingResources = await listRecords('bookableresources', 'bookableresourceid,name,_userid_value', undefined, 5000)
  const results: ResourceWriteResult[] = []

  for (const resource of resources) {
    const sourceId = resource.ResourceUID ?? resource.ResourceId ?? resource.ResourceName
    try {
      const email = resource.ResourceEmailAddress?.toLowerCase()
      const user = users.find(u =>
        (email && u.internalemailaddress?.toLowerCase() === email) ||
        u.fullname?.toLowerCase() === resource.ResourceName.toLowerCase() ||
        (resource.ResourceNTAccount && u.domainname?.toLowerCase() === resource.ResourceNTAccount.toLowerCase())
      )

      const existingByUser = user
        ? existingResources.find(r => String(r['_userid_value']).toLowerCase() === user.systemuserid.toLowerCase())
        : undefined
      const existingByName = existingResources.find(r =>
        String(r.name ?? '').toLowerCase() === resource.ResourceName.toLowerCase()
      )
      const existing = existingByUser ?? existingByName
      const existingId = cleanGuid(getRecordId(existing ?? {}, 'bookableresourceid'))

      if (existingId) {
        const result = {
          poResourceUid: sourceId,
          dvBookableResourceId: existingId,
          dvSystemUserId: user?.systemuserid,
          success: true,
        }
        results.push(result)
        onProgress?.(result)
        continue
      }

      if (!user) {
        const result = {
          poResourceUid: sourceId,
          success: false,
          error: nowError('Resource', sourceId, `No Dataverse user or bookable resource found for "${resource.ResourceName}"`),
        }
        results.push(result)
        onProgress?.(result)
        continue
      }

      const created = await createRecord('bookableresources', {
        name: resource.ResourceName,
        resourcetype: 3,
        'UserId@odata.bind': `/systemusers(${user.systemuserid})`,
      })
      const createdId = cleanGuid(getRecordId(created, 'bookableresourceid'))
      const result = {
        poResourceUid: sourceId,
        dvBookableResourceId: createdId,
        dvSystemUserId: user.systemuserid,
        success: !!createdId,
        error: createdId ? undefined : nowError('Resource', sourceId, 'Bookable resource was created but no ID was returned'),
      }
      results.push(result)
      onProgress?.(result)
    } catch (e) {
      const result = {
        poResourceUid: sourceId,
        success: false,
        error: nowError('Resource', sourceId, String(e)),
      }
      results.push(result)
      onProgress?.(result)
    }
  }

  return results
}
