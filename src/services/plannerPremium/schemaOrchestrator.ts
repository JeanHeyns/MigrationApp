import type { MappingConfiguration, OptionSetMapping } from '../../models/mapping.types'
import type { DvSolution } from '../../models/plannerPremium.types'
import type { PoLookupTable } from '../../models/projectOnline.types'
import type { SchemaCreationResults } from '../../models/dataOnly.types'
import { createColumns, createMigrationColumns } from './columnManager'
import { createOptionSets } from './choiceSetManager'
import { ensureLookupEntity, insertLookupEntries, lookupEntityLogicalName, type LookupEntityResult } from './lookupEntityManager'

export interface SchemaOrchestrationInput {
  mappingConfig: MappingConfiguration
  poLookupTables: PoLookupTable[]
  selectedSolution: DvSolution
  publisherPrefix: string
  onProgress: (msg: string, level?: 'info' | 'success' | 'warning' | 'error') => void
}

export type SchemaOrchestrationResult = SchemaCreationResults & {
  optionSetMappings: OptionSetMapping[]
}

function emptyResults(): SchemaCreationResults {
  return {
    startedAt: new Date(),
    completedAt: null,
    columns: { created: [], skipped: [], failed: [] },
    optionSets: { created: [], skipped: [], failed: [] },
    lookupEntities: { created: [], skipped: [], failed: [] },
    lookupEntries: { inserted: [], skipped: [], failed: [] },
  }
}

function isLookupBackedMapping(mappingConfig: MappingConfiguration, lookupTableUID: string): boolean {
  return mappingConfig.fieldMappings.some(m =>
    !m.skip &&
    m.targetColumnType === 'Lookup' &&
    !m.useExistingLookupEntity &&
    m.lookupTable?.LookupTableUID === lookupTableUID
  )
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

  const lookupTables = poLookupTables.filter(table => isLookupBackedMapping(mappingConfig, table.LookupTableUID))
  const lookupEntities = new Map<string, LookupEntityResult>()

  for (const table of lookupTables) {
    onProgress(`Ensuring lookup entity "${table.LookupTableName}"...`)
    const entityResult = await ensureLookupEntity(table, publisherPrefix, selectedSolution.uniquename)
    lookupEntities.set(table.LookupTableUID, entityResult)
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

    onProgress(`Inserting lookup entries for "${table.LookupTableName}"...`)
    const entryResults = await insertLookupEntries(entityResult, table.entries)
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
  return { ...results, optionSetMappings }
}
