import type { MappingConfiguration, MultiLookupMapping, OptionSetMapping } from '../../models/mapping.types'
import type { DvSolution } from '../../models/plannerPremium.types'
import type { PoLookupTable } from '../../models/projectOnline.types'
import type { SchemaCreationResults } from '../../models/dataOnly.types'
import { createColumns, createMigrationColumns } from './columnManager'
import { createOptionSets } from './choiceSetManager'
import {
  ensureLookupEntity,
  ensureLookupParentRelationship,
  hasHierarchicalEntries,
  insertLookupEntries,
  lookupEntityLogicalName,
  type LookupEntityResult,
  type LookupParentConfig,
} from './lookupEntityManager'
import { classifyDataverseError } from './errorClassifier'
import { createManyToManyRelationship, fetchEntityDefinition, getEntityManyToManyRelationships } from '../dataverseService'

export interface SchemaOrchestrationInput {
  mappingConfig: MappingConfiguration
  poLookupTables: PoLookupTable[]
  selectedSolution: DvSolution
  publisherPrefix: string
  onProgress: (msg: string, level?: 'info' | 'success' | 'warning' | 'error') => void
}

export type SchemaOrchestrationResult = SchemaCreationResults & {
  optionSetMappings: OptionSetMapping[]
  multiLookupMappings: MultiLookupMapping[]
}

function emptyResults(): SchemaCreationResults {
  return {
    startedAt: new Date(),
    completedAt: null,
    columns: { created: [], skipped: [], failed: [] },
    optionSets: { created: [], skipped: [], failed: [] },
    lookupEntities: { created: [], skipped: [], failed: [] },
    lookupEntries: { inserted: [], skipped: [], failed: [] },
    nnRelationships: { created: [], skipped: [], failed: [] },
  }
}

function isLookupBackedMapping(mappingConfig: MappingConfiguration, lookupTableUID: string): boolean {
  return mappingConfig.fieldMappings.some(m =>
    !m.skip &&
    m.targetColumnType === 'Lookup' &&
    m.lookupTable?.LookupTableUID === lookupTableUID
  )
}

function isNNMultiLookupField(mappingConfig: MappingConfiguration, poFieldName: string): boolean {
  const mlMapping = mappingConfig.multiLookups?.find(ml => ml.poFieldName === poFieldName)
  return !mlMapping || mlMapping.targetShape === 'N:N' || mlMapping.targetShape === undefined
}

function isMultiLookupBackedMapping(mappingConfig: MappingConfiguration, lookupTableUID: string): boolean {
  return mappingConfig.fieldMappings.some(m => {
    if (m.skip || m.customField.CustomFieldType !== 'LookupMulti' || m.lookupTable?.LookupTableUID !== lookupTableUID) return false
    const poFieldName = m.customField.ODataFieldName || m.customField.CustomFieldName
    return isNNMultiLookupField(mappingConfig, poFieldName)
  })
}

function lookupSeedKey(lookupTableUID: string, targetEntityLogicalName: string): string {
  return `${lookupTableUID}:${targetEntityLogicalName}`
}

async function existingLookupEntityResult(
  lookupTableUID: string,
  logicalName: string,
  fallbackCollectionName: string | undefined,
): Promise<LookupEntityResult> {
  const entity = await fetchEntityDefinition(logicalName)
  return {
    lookupTableUID,
    logicalName,
    displayName: logicalName,
    entitySetName: entity?.entitySetName ?? fallbackCollectionName ?? `${logicalName}s`,
    primaryNameField: entity?.primaryNameField ?? 'name',
    status: entity ? 'already_exists' : 'failed',
    error: entity ? undefined : `Existing lookup entity "${logicalName}" could not be loaded.`,
  }
}

export async function orchestrateSchemaCreation(input: SchemaOrchestrationInput): Promise<SchemaOrchestrationResult> {
  const { mappingConfig, poLookupTables, selectedSolution, publisherPrefix, onProgress } = input
  const results = emptyResults()

  onProgress(`Creating global option sets for solution "${selectedSolution.uniquename}"...`)
  const optionSetMappings = await createOptionSets(
    mappingConfig.fieldMappings,
    selectedSolution.uniquename,
    (name, success, alreadyExisted, error) => {
      const optionCount = mappingConfig.fieldMappings.find(m => m.targetLogicalName === name)?.lookupTable?.entries.length ?? 0
      if (!success) {
        results.optionSets.failed.push({ name, error: error ?? 'Unknown error' })
        onProgress(`Option set "${name}" failed: ${error}`, 'error')
      } else if (alreadyExisted) {
        results.optionSets.skipped.push({ name, reason: 'already exists' })
        onProgress(`Option set "${name}" already exists; skipped`, 'warning')
      } else {
        results.optionSets.created.push({ name, optionCount })
        onProgress(`Option set "${name}" created`, 'success')
      }
    },
  )

  const lookupTables = poLookupTables.filter(table =>
    isLookupBackedMapping(mappingConfig, table.LookupTableUID) ||
    isMultiLookupBackedMapping(mappingConfig, table.LookupTableUID)
  )
  const lookupEntities = new Map<string, LookupEntityResult>()
  const seededLookupEntities = new Map<string, LookupEntityResult>()

  for (const table of lookupTables) {
    const singleLookupMappings = mappingConfig.fieldMappings.filter(m =>
      !m.skip &&
      m.targetColumnType === 'Lookup' &&
      m.lookupTable?.LookupTableUID === table.LookupTableUID
    )
    const hasNNLookupMulti = isMultiLookupBackedMapping(mappingConfig, table.LookupTableUID)
    const shouldEnsurePoLookupEntity = hasNNLookupMulti || singleLookupMappings.some(m => !m.useExistingLookupEntity)

    if (shouldEnsurePoLookupEntity) {
      onProgress(`Ensuring lookup entity "${table.LookupTableName}"...`)
      const entityResult = await ensureLookupEntity(table, publisherPrefix, selectedSolution.uniquename)
      lookupEntities.set(table.LookupTableUID, entityResult)
      seededLookupEntities.set(lookupSeedKey(table.LookupTableUID, entityResult.logicalName), entityResult)
      if (entityResult.status === 'created') {
        results.lookupEntities.created.push({ logicalName: entityResult.logicalName, displayName: entityResult.displayName })
        onProgress(`Lookup entity "${entityResult.logicalName}" created`, 'success')
      } else if (entityResult.status === 'already_exists') {
        results.lookupEntities.skipped.push({ logicalName: entityResult.logicalName, reason: 'already exists' })
        onProgress(`Lookup entity "${entityResult.logicalName}" already exists; reusing`, 'warning')
      } else {
        results.lookupEntities.failed.push({ logicalName: entityResult.logicalName, error: entityResult.error ?? 'Unknown error' })
        onProgress(`Lookup entity "${entityResult.logicalName}" failed: ${entityResult.error}`, 'error')
      }
    }

    for (const mapping of singleLookupMappings.filter(m => m.useExistingLookupEntity && m.relatedEntity?.logicalName)) {
      const logicalName = mapping.relatedEntity!.logicalName
      const key = lookupSeedKey(table.LookupTableUID, logicalName)
      if (seededLookupEntities.has(key)) continue
      const entityResult = await existingLookupEntityResult(table.LookupTableUID, logicalName, mapping.relatedEntity?.logicalCollectionName)
      seededLookupEntities.set(key, entityResult)
      if (entityResult.status === 'failed') {
        results.lookupEntities.failed.push({ logicalName: entityResult.logicalName, error: entityResult.error ?? 'Unknown error' })
        onProgress(`Existing lookup entity "${logicalName}" failed: ${entityResult.error}`, 'error')
      } else {
        results.lookupEntities.skipped.push({ logicalName: entityResult.logicalName, reason: 'existing target selected' })
        onProgress(`Existing lookup entity "${logicalName}" selected; seeding missing entries`, 'info')
      }
    }

    for (const entityResult of seededLookupEntities.values()) {
      if (entityResult.lookupTableUID !== table.LookupTableUID) continue
      let parentLookup: LookupParentConfig | null = null
      if (hasHierarchicalEntries(table)) {
        const existingMapping = singleLookupMappings.find(m => m.relatedEntity?.logicalName === entityResult.logicalName)
        parentLookup = existingMapping?.lookupParent ?? null
        if (!parentLookup && shouldEnsurePoLookupEntity && lookupEntities.get(table.LookupTableUID)?.logicalName === entityResult.logicalName) {
          parentLookup = await ensureLookupParentRelationship(entityResult, publisherPrefix, selectedSolution.uniquename)
        }
        if (parentLookup) {
          onProgress(`Using parent lookup "${parentLookup.lookupLogicalName}" for "${entityResult.logicalName}" hierarchy`, 'info')
        } else {
          onProgress(`Lookup table "${table.LookupTableName}" is hierarchical, but no parent lookup is configured; seeding flat values`, 'warning')
        }
      }

      onProgress(`Seeding lookup entries for "${table.LookupTableName}" into "${entityResult.logicalName}"...`)
      const entryResults = await insertLookupEntries(entityResult, table.entries, { parentLookup })
      for (const entryResult of entryResults) {
        if (entryResult.status === 'inserted') {
          results.lookupEntries.inserted.push({ entity: entryResult.entity, name: entryResult.name })
        } else if (entryResult.status === 'already_exists') {
          results.lookupEntries.skipped.push({
            entity: entryResult.entity,
            name: entryResult.name,
            reason: entryResult.error ?? 'already exists',
          })
        } else {
          results.lookupEntries.failed.push({
            entity: entryResult.entity,
            name: entryResult.name,
            error: entryResult.error ?? 'Unknown error',
          })
        }
      }
    }
  }

  // Process LookupMulti fields: create N:N relationships
  const multiLookupMappings: MultiLookupMapping[] = []
  const multiLookupFields = mappingConfig.fieldMappings.filter(m => {
    if (m.skip || m.customField.CustomFieldType !== 'LookupMulti' || m.customField.CustomFieldEntityType !== 'Project') return false
    const poFieldName = m.customField.ODataFieldName || m.customField.CustomFieldName
    return isNNMultiLookupField(mappingConfig, poFieldName)
  })

  if (multiLookupFields.length > 0) {
    onProgress('Creating N:N relationships for multi-value lookup fields...')

    for (const mlField of multiLookupFields) {
      const lookupTableUID = mlField.lookupTable?.LookupTableUID
      if (!lookupTableUID) {
        onProgress(`LookupMulti "${mlField.customField.CustomFieldName}": no lookup table — skipped`, 'warning')
        continue
      }

      const entityResult = lookupEntities.get(lookupTableUID)
      if (!entityResult || entityResult.status === 'failed') {
        onProgress(`LookupMulti "${mlField.customField.CustomFieldName}": lookup entity not available — skipped`, 'warning')
        continue
      }

      const targetLogicalName = entityResult.logicalName
      const targetEntitySetName = entityResult.entitySetName
      const nnSchemaName = `${publisherPrefix}_msdyn_project_${targetLogicalName}`.slice(0, 100)
      const poFieldName = mlField.customField.ODataFieldName || mlField.customField.CustomFieldName

      try {
        await createManyToManyRelationship({
          schemaName: nnSchemaName,
          entity1LogicalName: 'msdyn_project',
          entity2LogicalName: targetLogicalName,
          entity1Label: 'Projects',
          entity2Label: entityResult.displayName,
          solutionUniqueName: selectedSolution.uniquename,
        })
        results.nnRelationships!.created.push({ schemaName: nnSchemaName, poField: poFieldName })
        onProgress(`N:N relationship "${nnSchemaName}" created`, 'success')
      } catch (err) {
        const cls = classifyDataverseError(err)
        if (cls === 'AlreadyExists') {
          results.nnRelationships!.skipped.push({ schemaName: nnSchemaName, poField: poFieldName, reason: 'already exists' })
          onProgress(`N:N relationship "${nnSchemaName}" already exists; reusing`, 'warning')
        } else {
          const errMsg = String(err)
          results.nnRelationships!.failed.push({ schemaName: nnSchemaName, poField: poFieldName, error: errMsg })
          onProgress(`N:N relationship "${nnSchemaName}" failed: ${errMsg}`, 'error')
          continue
        }
      }

      // Resolve the actual navigation property name from DV
      let navigationPropertyName = nnSchemaName
      try {
        const nnRels = await getEntityManyToManyRelationships('msdyn_project')
        const nnRel = nnRels.find(r => r.schemaName === nnSchemaName)
        if (nnRel) {
          navigationPropertyName = nnRel.entity1LogicalName === 'msdyn_project'
            ? nnRel.entity2NavigationPropertyName
            : nnRel.entity1NavigationPropertyName
        }
      } catch { /* fallback to schemaName */ }

      multiLookupMappings.push({
        poFieldName,
        targetShape: 'N:N',
        targetEntityLogicalName: targetLogicalName,
        targetEntitySetName,
        matchFieldLogicalName: entityResult.primaryNameField,
        relationshipSchemaName: nnSchemaName,
        navigationPropertyName,
        relationshipType: 'pure-nn',
      })
    }
  }

  const fieldMappings = mappingConfig.fieldMappings.map(mapping => {
    if (mapping.targetColumnType !== 'Lookup' || !mapping.lookupTable || mapping.useExistingLookupEntity) return mapping
    const ensured = lookupEntities.get(mapping.lookupTable.LookupTableUID)
    return {
      ...mapping,
      relatedEntity: ensured && ensured.status !== 'failed'
        ? { logicalName: ensured.logicalName, logicalCollectionName: ensured.entitySetName }
        : { logicalName: lookupEntityLogicalName(mapping.lookupTable, publisherPrefix), logicalCollectionName: '' },
    }
  })

  onProgress('Creating migration tracking column...')
  const migrationColumns = await createMigrationColumns(publisherPrefix, selectedSolution.uniquename)
  for (const column of migrationColumns) {
    if (!column.success) {
      results.columns.failed.push({ entity: column.entityLogicalName, logicalName: column.logicalName, error: column.error ?? 'Unknown error' })
      onProgress(`${column.entityLogicalName}.${column.logicalName} failed: ${column.error}`, 'error')
    } else if (column.alreadyExisted) {
      results.columns.skipped.push({ entity: column.entityLogicalName, logicalName: column.logicalName, reason: 'already exists' })
      onProgress(`${column.entityLogicalName}.${column.logicalName} already exists; skipped`, 'warning')
    } else {
      results.columns.created.push({ entity: column.entityLogicalName, logicalName: column.logicalName, type: column.fieldMapping.targetColumnType })
      onProgress(`${column.entityLogicalName}.${column.logicalName} created`, 'success')
    }
  }

  onProgress('Creating mapped columns...')
  await createColumns(
    fieldMappings,
    optionSetMappings,
    selectedSolution.uniquename,
    column => {
      if (!column.success) {
        results.columns.failed.push({ entity: column.entityLogicalName, logicalName: column.logicalName, error: column.error ?? 'Unknown error' })
        onProgress(`${column.entityLogicalName}.${column.logicalName} failed: ${column.error}`, 'error')
      } else if (column.alreadyExisted) {
        results.columns.skipped.push({ entity: column.entityLogicalName, logicalName: column.logicalName, reason: 'already exists' })
        onProgress(`${column.entityLogicalName}.${column.logicalName} already exists; skipped`, 'warning')
      } else {
        results.columns.created.push({ entity: column.entityLogicalName, logicalName: column.logicalName, type: column.fieldMapping.targetColumnType })
        onProgress(`${column.entityLogicalName}.${column.logicalName} created`, 'success')
      }
    },
  )

  results.completedAt = new Date()
  return { ...results, optionSetMappings, multiLookupMappings }
}
