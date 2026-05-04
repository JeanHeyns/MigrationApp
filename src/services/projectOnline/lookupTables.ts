import { odataGetAll } from './odataClient'
import type { PoLookupTable, PoLookupEntry } from '../../models/projectOnline.types'

export async function fetchLookupTables(siteUrl: string): Promise<PoLookupTable[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await odataGetAll<any>(
    siteUrl,
    '_api/ProjectServer/LookupTables?$expand=Entries',
  )

  return raw.map(lt => {
    const tableUid: string = lt.Id ?? lt.LookupTableUID ?? ''
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawEntries: any[] =
      lt.Entries?.value ?? lt.Entries?.results ??
      lt.LookupEntries?.value ?? lt.LookupEntries?.results ?? []

    const entries: PoLookupEntry[] = rawEntries.map(e => ({
      LookupTableUID:       tableUid,
      LookupEntryUID:       e.Id ?? e.LookupEntryUID ?? '',
      LookupEntryFullValue: e.FullValue ?? e.Value ?? e.LookupEntryFullValue ?? '',
      LookupEntryValue:     e.Value ?? e.LookupEntryValue,
      SortIndex:            e.SortIndex,
    }))

    return {
      LookupTableUID:  tableUid,
      LookupTableName: lt.Name ?? lt.LookupTableName ?? '',
      entries,
    }
  })
}
