import { listRecords, createRecord, updateRecord, performUnboundAction } from '../dataverseService'
import type { DvSolution, DvSystemUser } from '../../models/plannerPremium.types'

export { listRecords, createRecord, updateRecord, performUnboundAction }

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

export async function deleteRecord(entityName: string, id: string): Promise<void> {
  // TODO: implement via Dataverse Web API DELETE
  void entityName; void id
  throw new Error('deleteRecord not yet implemented')
}
