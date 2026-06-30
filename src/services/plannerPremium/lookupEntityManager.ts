import type { PoLookupEntry, PoLookupTable } from '../../models/projectOnline.types'
import { createEntityDefinition, createOneToManyRelationship, createRecord, fetchEntityDefinition, fetchEntityManyToOneRelationships, listAllRecords, performUnboundAction } from '../dataverseService'

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

export interface LookupParentConfig {
  lookupLogicalName: string
  navigationPropertyName?: string
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

function entryPath(entry: PoLookupEntry): string[] {
  const full = (entry.LookupEntryFullValue || '').trim()
  const leaf = (entry.LookupEntryValue || '').trim()
  const value = full || leaf || entry.LookupEntryUID
  if (full.includes('.')) {
    return full.split('.').map(part => part.trim()).filter(Boolean)
  }
  return [leaf || value]
}

export function hasHierarchicalEntries(poLookupTable: PoLookupTable): boolean {
  return poLookupTable.entries.some(entry => entryPath(entry).length > 1)
}

function hierarchyKey(path: string[]): string {
  return path.map(part => normalizedName(part)).join('\u001f')
}

function lookupRecordId(record: Record<string, unknown>, entityLogicalName: string): string {
  return String(
    record[`${entityLogicalName}id`] ??
    record[`${entityLogicalName}Id`] ??
    record.id ??
    record.Id ??
    ''
  ).replace(/[{}]/g, '')
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

export async function ensureLookupParentRelationship(
  entityResult: LookupEntityResult,
  publisherPrefix: string,
  solutionUniqueName: string,
): Promise<LookupParentConfig | null> {
  if (entityResult.status === 'failed') return null

  const lookupSchemaName = `${publisherPrefix}_parent`.slice(0, 47)
  const relationshipSchemaName = `${publisherPrefix}_${entityResult.logicalName.replace(/_/g, '')}_parent`.slice(0, 100)

  try {
    const relationship = await createOneToManyRelationship({
      referencedEntity: entityResult.logicalName,
      referencingEntity: entityResult.logicalName,
      lookupSchemaName,
      lookupDisplayName: 'Parent',
      relationshipSchemaName,
      solutionUniqueName,
    })
    return {
      lookupLogicalName: relationship.lookupLogicalName,
      navigationPropertyName: relationship.navigationProperty,
    }
  } catch {
    try {
      const rels = await fetchEntityManyToOneRelationships(entityResult.logicalName)
      const rel = rels.find(r =>
        r.ReferencedEntity === entityResult.logicalName &&
        r.ReferencingAttribute === lookupSchemaName.toLowerCase()
      ) ?? rels.find(r => r.ReferencedEntity === entityResult.logicalName)
      return rel
        ? {
            lookupLogicalName: rel.ReferencingAttribute,
            navigationPropertyName: rel.ReferencingEntityNavigationPropertyName,
          }
        : null
    } catch {
      return null
    }
  }
}

export async function insertLookupEntries(
  entityResult: LookupEntityResult,
  poLookupEntries: PoLookupEntry[],
  options?: { parentLookup?: LookupParentConfig | null },
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
  const parentLookup = options?.parentLookup ?? null
  const hierarchical = !!parentLookup && poLookupEntries.some(entry => entryPath(entry).length > 1)
  const idField = `${entityResult.logicalName}id`
  const parentValueField = parentLookup ? `_${parentLookup.lookupLogicalName}_value` : null
  const recordsByPath = new Map<string, string>()
  try {
    const selectFields = [idField, entityResult.primaryNameField]
    if (parentValueField) selectFields.push(parentValueField)
    const existing = await listAllRecords(entityResult.entitySetName, selectFields, { pageSize: 5000 })
    if (hierarchical && parentValueField) {
      const nodes = new Map<string, { name: string; parentId: string }>()
      for (const row of existing) {
        const id = lookupRecordId(row, entityResult.logicalName)
        const name = String(row[entityResult.primaryNameField] ?? '')
        const parentId = String(row[parentValueField] ?? '').replace(/[{}]/g, '')
        if (id && name) nodes.set(id, { name, parentId })
      }
      const pathForId = (id: string, seenIds = new Set<string>()): string[] => {
        const node = nodes.get(id)
        if (!node || seenIds.has(id)) return []
        seenIds.add(id)
        const parentPath = node.parentId ? pathForId(node.parentId, seenIds) : []
        return [...parentPath, node.name]
      }
      for (const id of nodes.keys()) {
        const path = pathForId(id)
        if (path.length > 0) recordsByPath.set(hierarchyKey(path), id)
      }
    } else {
      for (const row of existing) {
        const name = String(row[entityResult.primaryNameField] ?? '')
        const id = lookupRecordId(row, entityResult.logicalName)
        if (name && id) recordsByPath.set(hierarchyKey([name]), id)
      }
    }
  } catch (e) {
    return poLookupEntries.map(entry => ({
      entity: entityResult.logicalName,
      name: entryName(entry),
      status: 'failed',
      error: `Could not read existing lookup entries: ${String(e)}`,
    }))
  }

  const entries = [...poLookupEntries].sort((a, b) => entryPath(a).length - entryPath(b).length)
  for (const entry of entries) {
    const path = hierarchical ? entryPath(entry) : [entryName(entry)]
    const name = hierarchical ? path[path.length - 1] : entryName(entry)
    const key = hierarchyKey(path)
    if (!key) {
      results.push({ entity: entityResult.logicalName, name, status: 'already_exists', error: 'Blank source value skipped.' })
      continue
    }
    if (recordsByPath.has(key)) {
      results.push({ entity: entityResult.logicalName, name, status: 'already_exists' })
      continue
    }

    try {
      const item: Record<string, unknown> = { [entityResult.primaryNameField]: name }
      if (hierarchical && parentLookup && path.length > 1) {
        const parentId = recordsByPath.get(hierarchyKey(path.slice(0, -1)))
        if (parentId && parentLookup.navigationPropertyName) {
          item[`${parentLookup.navigationPropertyName}@odata.bind`] = `/${entityResult.entitySetName}(${parentId})`
        } else {
          results.push({
            entity: entityResult.logicalName,
            name,
            status: 'failed',
            error: `Parent lookup value "${path.slice(0, -1).join('.')}" was not found.`,
          })
          continue
        }
      }
      const created = await createRecord(entityResult.entitySetName, item)
      const createdId = lookupRecordId(created, entityResult.logicalName)
      if (createdId) recordsByPath.set(key, createdId)
      results.push({ entity: entityResult.logicalName, name, status: 'inserted' })
    } catch (e) {
      results.push({ entity: entityResult.logicalName, name, status: 'failed', error: String(e) })
    }
  }

  return results
}
