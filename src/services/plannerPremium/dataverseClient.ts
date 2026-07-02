import {
  listRecords,
  createRecord,
  updateRecord,
  performUnboundAction as _performUnboundAction,
  associateNNRecord as _associateNNRecord,
  disassociateNNRecord as _disassociateNNRecord,
  listAssociatedNNRecords,
  fetchEntityAttributes,
} from '../dataverseService'
import type { DvSolution, DvSystemUser } from '../../models/plannerPremium.types'
import { classifyDataverseError } from './errorClassifier'

export { listRecords, createRecord, updateRecord, listAssociatedNNRecords, fetchEntityAttributes }

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3, retryOnTimeout = true): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const cls = classifyDataverseError(err)
      const retryable = cls === 'Throttled' || (retryOnTimeout && cls === 'Timeout')
      if (!retryable || attempt === maxAttempts) throw err
      const baseDelay = cls === 'Throttled' ? 10000 : 2000
      const delay = baseDelay * Math.pow(2.5, attempt - 1)
      await sleep(delay + Math.random() * 500)
    }
  }
  throw lastErr
}

/**
 * PSS actions that mutate operation-set or record state. A timed-out call may
 * have SUCCEEDED server-side, so replaying it double-queues ops, re-executes an
 * operation set, or creates duplicate records. Throttled (429) is different:
 * the server rejected before executing, so retrying stays safe for every action.
 */
const TIMEOUT_RETRY_UNSAFE_ACTIONS = new Set([
  'msdyn_ExecuteOperationSetV1',
  'msdyn_PssCreateV1',
  'msdyn_PssUpdateV1',
  'msdyn_PssDeleteV1',
  'msdyn_PssUpdateResourceAssignmentContourV1',
  'msdyn_PssUpdateResourceAssignmentV1',
  'msdyn_CreateTeamMemberV1',
])

export async function performUnboundAction(
  actionName: string,
  item?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return withRetry(() => _performUnboundAction(actionName, item), 3, !TIMEOUT_RETRY_UNSAFE_ACTIONS.has(actionName))
}

export async function fetchSystemUsers(): Promise<DvSystemUser[]> {
  const rows = await listRecords(
    'systemusers',
    'systemuserid,fullname,internalemailaddress,domainname',
    'islicensed eq true',
    500,
  )
  return rows as unknown as DvSystemUser[]
}

export async function fetchSolutions(): Promise<DvSolution[]> {
  const [solutions, publishers] = await Promise.all([
    listRecords('solutions', 'solutionid,uniquename,friendlyname,_publisherid_value', 'ismanaged eq false', 200),
    listRecords('publishers', 'publisherid,uniquename,customizationprefix', undefined, 200),
  ])

  const prefixMap = new Map(
    publishers.map(p => [p['publisherid'] as string, p['customizationprefix'] as string])
  )

  return solutions
    .map(s => ({
      solutionid:     s['solutionid'] as string,
      uniquename:     s['uniquename'] as string,
      friendlyname:   s['friendlyname'] as string,
      publisherId:    s['_publisherid_value'] as string,
      publisherPrefix: prefixMap.get(s['_publisherid_value'] as string) ?? '',
    }))
    .filter(s => s.publisherPrefix)
    .sort((a, b) => a.friendlyname.localeCompare(b.friendlyname))
}

export async function patchRecord(
  entityName: string,
  id: string,
  item: Record<string, unknown>,
): Promise<void> {
  await updateRecord(entityName, id, item)
}

export async function associateNNRecord(
  entitySetName: string,
  recordId: string,
  navigationPropertyName: string,
  targetEntitySetName: string,
  targetId: string,
): Promise<void> {
  return withRetry(() => _associateNNRecord(entitySetName, recordId, navigationPropertyName, targetEntitySetName, targetId))
}

export async function disassociateNNRecord(
  entitySetName: string,
  recordId: string,
  navigationPropertyName: string,
  targetId: string,
): Promise<void> {
  return withRetry(() => _disassociateNNRecord(entitySetName, recordId, navigationPropertyName, targetId))
}

export async function deleteRecord(entityName: string, id: string): Promise<void> {
  // TODO: implement via Dataverse Web API DELETE
  void entityName; void id
  throw new Error('deleteRecord not yet implemented')
}
