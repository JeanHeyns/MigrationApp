import type { PoLookupEntry, PoLookupTable } from '../../models/projectOnline.types'
import { createEntityDefinition, createRecord, fetchEntityDefinition, listAllRecords, performUnboundAction } from '../dataverseService'

export interface LookupEntityResult {
  lookupTableUID: string
  logicalName: string
  displayName: string
  entitySetName: string
  primaryNameField: string
  status: 'created' | 'already_exists' | 'failed'
  error?: string
}

export interface LookupEntryResult {
  entity: string
  name: string
  status: 'inserted' | 'already_exists' | 'failed'
  error?: string
}

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

function cleanName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    || 'lookup'
}

function pascalName(name: string): string {
  return cleanName(name)
    .split('_')
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('')
}

export function lookupEntityLogicalName(poLookupTable: PoLookupTable, publisherPrefix: string): string {
  return `${publisherPrefix}_${cleanName(poLookupTable.LookupTableName)}`.slice(0, 64)
}

function primaryNameField(publisherPrefix: string): string {
  return `${publisherPrefix}_name`.slice(0, 47)
}

function normalizedName(name: string): string {
  return name.trim().toLowerCase()
}

function entryName(entry: PoLookupEntry): string {
  const value = entry.LookupEntryFullValue || entry.LookupEntryValue || entry.LookupEntryUID
  return value.length > 200 ? `${value.slice(0, 197)}...` : value
}

async function addEntityToSolution(metadataId: string | undefined, solutionUniqueName: string): Promise<void> {
  if (!metadataId) return
  await performUnboundAction('AddSolutionComponent', {
    ComponentId: metadataId,
    ComponentType: 1,
    SolutionUniqueName: solutionUniqueName,
    AddRequiredComponents: true,
    DoNotIncludeSubcomponents: false,
  })
}

export async function ensureLookupEntity(
  poLookupTable: PoLookupTable,
  publisherPrefix: string,
  solutionUniqueName: string,
): Promise<LookupEntityResult> {
  const logicalName = lookupEntityLogicalName(poLookupTable, publisherPrefix)
  const primaryField = primaryNameField(publisherPrefix)
  const displayName = poLookupTable.LookupTableName || logicalName

  try {
    const existing = await fetchEntityDefinition(logicalName)
    if (existing) {
      try {
        await addEntityToSolution(existing.metadataId, solutionUniqueName)
      } catch {
        // Non-fatal: the entity can still be reused and later calls remain idempotent.
      }
      return {
        lookupTableUID: poLookupTable.LookupTableUID,
        logicalName,
        displayName,
        entitySetName: existing.entitySetName,
        primaryNameField: existing.primaryNameField || primaryField,
        status: 'already_exists',
      }
    }

    const schemaBase = `${publisherPrefix}_${pascalName(displayName)}`.slice(0, 64)
    const body = {
      '@odata.type': 'Microsoft.Dynamics.CRM.EntityMetadata',
      SchemaName: schemaBase,
      LogicalName: logicalName,
      DisplayName: dvLabel(displayName),
      DisplayCollectionName: dvLabel(`${displayName} Values`),
      Description: dvLabel(`Migrated from Project Online lookup table: ${displayName}`),
      OwnershipType: 'UserOwned',
      HasActivities: false,
      HasNotes: false,
      PrimaryNameAttribute: {
        '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
        SchemaName: `${publisherPrefix}_Name`.slice(0, 47),
        LogicalName: primaryField,
        RequiredLevel: { Value: 'ApplicationRequired' },
        MaxLength: 200,
        DisplayName: dvLabel('Name'),
      },
    }

    const created = await createEntityDefinition(body, solutionUniqueName)
    const metadataId = (created.MetadataId ?? created.metadataid) as string | undefined
    try {
      await addEntityToSolution(metadataId, solutionUniqueName)
    } catch {
      // The SolutionUniqueName header usually adds the table; this action is best effort.
    }
    const fetched = await fetchEntityDefinition(logicalName)

    return {
      lookupTableUID: poLookupTable.LookupTableUID,
      logicalName,
      displayName,
      entitySetName: fetched?.entitySetName ?? `${logicalName}s`,
      primaryNameField: fetched?.primaryNameField ?? primaryField,
      status: 'created',
    }
  } catch (e) {
    return {
      lookupTableUID: poLookupTable.LookupTableUID,
      logicalName,
      displayName,
      entitySetName: `${logicalName}s`,
      primaryNameField: primaryField,
      status: 'failed',
      error: String(e),
    }
  }
}

export async function insertLookupEntries(
  entityResult: LookupEntityResult,
  poLookupEntries: PoLookupEntry[],
): Promise<LookupEntryResult[]> {
  if (entityResult.status === 'failed') {
    return poLookupEntries.map(entry => ({
      entity: entityResult.logicalName,
      name: entryName(entry),
      status: 'failed',
      error: entityResult.error ?? 'Lookup entity could not be created or loaded.',
    }))
  }

  const results: LookupEntryResult[] = []
  const seen = new Set<string>()
  try {
    const existing = await listAllRecords(entityResult.entitySetName, [entityResult.primaryNameField], { pageSize: 5000 })
    for (const row of existing) {
      const name = String(row[entityResult.primaryNameField] ?? '')
      if (name) seen.add(normalizedName(name))
    }
  } catch (e) {
    return poLookupEntries.map(entry => ({
      entity: entityResult.logicalName,
      name: entryName(entry),
      status: 'failed',
      error: `Could not read existing lookup entries: ${String(e)}`,
    }))
  }

  for (const entry of poLookupEntries) {
    const name = entryName(entry)
    const key = normalizedName(name)
    if (!key) {
      results.push({ entity: entityResult.logicalName, name, status: 'already_exists', error: 'Blank source value skipped.' })
      continue
    }
    if (seen.has(key)) {
      results.push({ entity: entityResult.logicalName, name, status: 'already_exists' })
      continue
    }

    try {
      await createRecord(entityResult.entitySetName, { [entityResult.primaryNameField]: name })
      seen.add(key)
      results.push({ entity: entityResult.logicalName, name, status: 'inserted' })
    } catch (e) {
      results.push({ entity: entityResult.logicalName, name, status: 'failed', error: String(e) })
    }
  }

  return results
}
