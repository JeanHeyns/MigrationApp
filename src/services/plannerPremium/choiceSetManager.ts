import type { FieldMapping, OptionSetMapping } from '../../models/mapping.types'
import { createGlobalOptionSet, getGlobalOptionSetMetadataId } from '../dataverseService'

function dvLabel(text: string) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.Label',
    LocalizedLabels: [{
      '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel',
      Label: text,
      LanguageCode: 1033,
    }],
    UserLocalizedLabel: {
      '@odata.type': 'Microsoft.Dynamics.CRM.LocalizedLabel',
      Label: text,
      LanguageCode: 1033,
    },
  }
}

function isAlreadyExistsError(msg: string): boolean {
  return (
    msg.includes('0x80060891') ||
    msg.toLowerCase().includes('already exists') ||
    msg.toLowerCase().includes('duplicate') ||
    msg.includes('already been defined')
  )
}

export async function createOptionSets(
  fieldMappings: FieldMapping[],
  solutionUniqueName: string,
  onProgress: (name: string, success: boolean, alreadyExisted: boolean, error?: string) => void,
): Promise<OptionSetMapping[]> {
  // Deduplicate lookup tables: one global OptionSet per unique LookupTableUID.
  // The first active OptionSet/MultiSelectOptionSet mapping for each lookup table
  // determines the OptionSet name (its targetLogicalName).
  const seen = new Map<string, { lookupTableUID: string; optionSetName: string; table: FieldMapping['lookupTable'] }>()

  for (const fm of fieldMappings) {
    if (fm.skip) continue
    if (fm.targetColumnType !== 'OptionSet' && fm.targetColumnType !== 'MultiSelectOptionSet') continue
    if (!fm.lookupTable) continue
    const uid = fm.lookupTable.LookupTableUID
    if (!seen.has(uid)) {
      seen.set(uid, { lookupTableUID: uid, optionSetName: fm.optionSetName ?? fm.targetLogicalName, table: fm.lookupTable })
    }
  }

  const results: OptionSetMapping[] = []

  for (const { lookupTableUID, optionSetName, table } of seen.values()) {
    if (!table) continue

    const valueMap: Record<string, number> = {}
    const options = table.entries.map((entry, idx) => {
      const val = idx + 1
      valueMap[entry.LookupEntryUID] = val
      if (entry.LookupEntryFullValue) valueMap[entry.LookupEntryFullValue] = val
      if (entry.LookupEntryValue) valueMap[entry.LookupEntryValue] = val
      return {
        '@odata.type': 'Microsoft.Dynamics.CRM.OptionMetadata',
        Value: val,
        Label: dvLabel(entry.LookupEntryFullValue || entry.LookupEntryValue || `Option ${val}`),
        IsManaged: false,
      }
    })

    const body = {
      '@odata.type': 'Microsoft.Dynamics.CRM.OptionSetMetadata',
      Name: optionSetName,
      DisplayName: dvLabel(table.LookupTableName),
      Description: dvLabel(`Migrated from Project Online lookup table: ${table.LookupTableName}`),
      IsGlobal: true,
      OptionSetType: 'Picklist',
      Options: options,
    }

    try {
      const existingMetadataId = await getGlobalOptionSetMetadataId(optionSetName)
      if (existingMetadataId) {
        results.push({ lookupTableUID, optionSetName, metadataId: existingMetadataId, valueMap })
        onProgress(optionSetName, true, true)
        continue
      }

      const created = await createGlobalOptionSet(body, solutionUniqueName)
      const metadataId =
        ((created['MetadataId'] ?? created['metadataid']) as string | undefined) ??
        (await getGlobalOptionSetMetadataId(optionSetName) ?? undefined)
      results.push({ lookupTableUID, optionSetName, metadataId, valueMap })
      onProgress(optionSetName, true, false)
    } catch (e) {
      const msg = String(e)
      if (isAlreadyExistsError(msg)) {
        const metadataId = await getGlobalOptionSetMetadataId(optionSetName) ?? undefined
        results.push({ lookupTableUID, optionSetName, metadataId, valueMap })
        onProgress(optionSetName, true, true)
      } else {
        onProgress(optionSetName, false, false, msg)
      }
    }
  }

  return results
}
