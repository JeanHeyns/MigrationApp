import type { PoResource } from '../../models/projectOnline.types'
import type { ImportError } from '../../models/plannerPremium.types'
import { createRecord, fetchSystemUsers, listRecords } from './dataverseClient'
import { cleanGuid, getRecordId, nowError } from './importHelpers'

const FALLBACK_TIMEZONE_CODE = 105

export interface ResourceWriteResult {
  poResourceUid: string
  dvBookableResourceId?: string
  dvSystemUserId?: string
  dvAccountId?: string
  success: boolean
  error?: ImportError
}

export type ResourceImportMode = 'user' | 'account' | 'skip'

export interface ResourceImportOption {
  mode?: ResourceImportMode
  nameOverride?: string
}

/**
 * Matches Project Online resources to Dataverse systemusers by email first, then name.
 * Creates/uses user bookable resources for matched users.
 * Unmatched resources are represented as account bookable resources.
 */
export async function writeResources(
  resources: PoResource[],
  options: Record<string, ResourceImportOption> = {},
  onProgress?: (result: ResourceWriteResult) => void,
): Promise<ResourceWriteResult[]> {
  const users = await fetchSystemUsers()
  const existingResources = await listRecords('bookableresources', 'bookableresourceid,name,resourcetype,_userid_value,_accountid_value', undefined, 5000)
  const existingAccounts = await listRecords('accounts', 'accountid,name', undefined, 5000)
  const timezone = await resolveBookableResourceTimeZone()
  const results: ResourceWriteResult[] = []

  for (const resource of resources) {
    const sourceId = resource.ResourceUID ?? resource.ResourceId ?? resource.ResourceName
    const option = options[sourceId] ?? {}
    const resourceName = option.nameOverride?.trim() || resource.ResourceName
    try {
      const email = resource.ResourceEmailAddress?.toLowerCase()
      const user = users.find(u =>
        (email && u.internalemailaddress?.toLowerCase() === email) ||
        u.fullname?.toLowerCase() === resource.ResourceName.toLowerCase() ||
        (resource.ResourceNTAccount && u.domainname?.toLowerCase() === resource.ResourceNTAccount.toLowerCase())
      )
      const mode: ResourceImportMode = option.mode ?? (user ? 'user' : 'account')

      const existing = findExistingBookableResource(existingResources, resourceName, user, mode)
      const existingId = cleanGuid(getRecordId(existing ?? {}, 'bookableresourceid'))

      if (existingId) {
        const result = {
          poResourceUid: sourceId,
          dvBookableResourceId: existingId,
          dvSystemUserId: user?.systemuserid,
          dvAccountId: cleanGuid(String(existing?.['_accountid_value'] ?? '') || undefined),
          success: true,
        }
        results.push(result)
        onProgress?.(result)
        continue
      }

      if (mode === 'skip') {
        const result = {
          poResourceUid: sourceId,
          success: false,
          error: nowError('Resource', sourceId, 'Resource creation skipped and no existing bookable resource was found', 'Skipped'),
        }
        results.push(result)
        onProgress?.(result)
        continue
      }

      if (mode === 'account' || !user) {
        const account = await findOrCreateAccount(resourceName, existingAccounts)
        const accountId = cleanGuid(getRecordId(account, 'accountid'))
        if (!accountId) {
          const result = {
            poResourceUid: sourceId,
            success: false,
            error: nowError('Resource', sourceId, `Account was created or found for "${resourceName}" but no account ID was returned`),
          }
          results.push(result)
          onProgress?.(result)
          continue
        }

        const created = await createRecord('bookableresources', {
          name: resourceName,
          resourcetype: 5,
          timezone,
          'AccountId@odata.bind': `/accounts(${accountId})`,
        })
        const createdId = cleanGuid(getRecordId(created, 'bookableresourceid'))
        const result = {
          poResourceUid: sourceId,
          dvBookableResourceId: createdId,
          dvAccountId: accountId,
          success: !!createdId,
          error: createdId ? undefined : nowError('Resource', sourceId, 'Account bookable resource was created but no ID was returned'),
        }
        if (createdId) existingResources.push({ ...created, bookableresourceid: createdId, name: resourceName, resourcetype: 5, _accountid_value: accountId })
        results.push(result)
        onProgress?.(result)
        continue
      }

      const created = await createRecord('bookableresources', {
        name: resourceName,
        resourcetype: 3,
        timezone,
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
      if (createdId) existingResources.push({ ...created, bookableresourceid: createdId, name: resourceName, resourcetype: 3, _userid_value: user.systemuserid })
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

async function resolveBookableResourceTimeZone(): Promise<number> {
  try {
    const rows = await listRecords('timezonedefinitions', 'timezonecode,standardname,userinterfacename,retiredorder', 'retiredorder eq 0', 5000)
    const preferred = rows.find(row => {
      const standardName = String(row.standardname ?? '').toLowerCase()
      const uiName = String(row.userinterfacename ?? '').toLowerCase()
      return standardName === 'romance standard time' ||
        standardName === 'w. europe standard time' ||
        uiName.includes('brussels') ||
        uiName.includes('paris') ||
        uiName.includes('amsterdam') ||
        uiName.includes('berlin')
    }) ?? rows.find(row => String(row.standardname ?? '').toLowerCase() === 'utc')

    const code = Number(preferred?.timezonecode)
    return Number.isFinite(code) ? code : FALLBACK_TIMEZONE_CODE
  } catch {
    return FALLBACK_TIMEZONE_CODE
  }
}

function findBookableResourceByName(rows: Record<string, unknown>[], name: string): Record<string, unknown> | undefined {
  const wanted = name.trim().toLowerCase()
  return rows.find(r => String(r.name ?? '').trim().toLowerCase() === wanted)
}

function findExistingBookableResource(
  rows: Record<string, unknown>[],
  name: string,
  user: { systemuserid: string } | undefined,
  mode: ResourceImportMode,
): Record<string, unknown> | undefined {
  const existingByUser = user
    ? rows.find(r => String(r['_userid_value']).toLowerCase() === user.systemuserid.toLowerCase())
    : undefined
  if (mode === 'user') return existingByUser
  return existingByUser ?? findBookableResourceByName(rows, name)
}

async function findOrCreateAccount(
  name: string,
  existingAccounts: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  const wanted = name.trim().toLowerCase()
  const existing = existingAccounts.find(account => String(account.name ?? '').trim().toLowerCase() === wanted)
  if (existing) return existing

  const created = await createRecord('accounts', { name })
  existingAccounts.push(created)
  return created
}
