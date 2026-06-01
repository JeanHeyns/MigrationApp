import type { SchemaSnapshot, EntitySchema, ColumnMeta, ColumnMetaType } from '../../models/dataOnly.types'
import {
  fetchAttributeOptionSetMetadata,
  fetchCustomMultiPicklistAttributes,
  fetchCustomPicklistAttributes,
  fetchEntityWithCustomAttributes,
  fetchGlobalOptionSetFull,
  getEntityManyToManyRelationships,
  parseOptionSetOptions,
} from '../dataverseService'

const DEFAULT_TARGET_ENTITIES = ['msdyn_project', 'msdyn_projecttask', 'msdyn_projectteam']

function isDebug(): boolean {
  try { return localStorage.getItem('DEBUG_DATAONLY_WRITER') === '1' } catch { return false }
}

export async function inspectSolution(
  solutionId: string,
  targetEntities: string[] = DEFAULT_TARGET_ENTITIES,
): Promise<SchemaSnapshot> {
  const entitySchemas = await Promise.all(
    targetEntities.map(e => inspectEntity(e))
  )

  const entities: Record<string, EntitySchema> = {}
  for (const schema of entitySchemas) {
    entities[schema.logicalName] = schema
  }

  return {
    scannedAt: new Date(),
    solutionId,
    entities,
    globalOptionSets: [],
  }
}

async function inspectEntity(entityLogicalName: string): Promise<EntitySchema> {
  const [data, nnRelationships] = await Promise.all([
    fetchEntityWithCustomAttributes(entityLogicalName),
    getEntityManyToManyRelationships(entityLogicalName).catch(() => []),
  ])

  const attributes: ColumnMeta[] = []
  const [picklists, multiPicklists] = await Promise.all([
    fetchCustomPicklistAttributes(entityLogicalName).catch(() => []),
    fetchCustomMultiPicklistAttributes(entityLogicalName).catch(() => []),
  ])
  const optionSets = new Map<string, Pick<ColumnMeta, 'optionSetName' | 'optionSetMetadataId' | 'optionSetIsGlobal' | 'isGlobalOptionSet' | 'optionSetOptions' | 'inlineOptions'>>()
  for (const attr of [...picklists, ...multiPicklists]) {
    const optionSetName = attr.GlobalOptionSet?.Name
      ?? (attr.OptionSet?.IsGlobal ? attr.OptionSet.Name : attr.OptionSet?.Name)
    const isGlobal = attr.GlobalOptionSet?.Name ? true : attr.OptionSet?.IsGlobal
    const optionSetMetadataId = attr.GlobalOptionSet?.MetadataId ?? attr.OptionSet?.MetadataId
    const inlineOptions = parseOptionSetOptions(attr.GlobalOptionSet?.Options ?? attr.OptionSet?.Options ?? [])

    optionSets.set(attr.LogicalName, {
      optionSetName,
      optionSetMetadataId,
      optionSetIsGlobal: isGlobal,
      isGlobalOptionSet: isGlobal,
      optionSetOptions: inlineOptions.length ? inlineOptions : undefined,
      inlineOptions: inlineOptions.length ? inlineOptions : undefined,
    })

    if (isDebug()) {
      console.info('[dataOnly] option set metadata', {
        entityLogicalName,
        logicalName: attr.LogicalName,
        optionSetName,
        optionSetMetadataId,
        isGlobal,
        inlineOptionCount: inlineOptions.length,
        raw: attr,
      })
    }
  }

  await Promise.all(data.rawAttrs.map(async raw => {
    const type = mapAttributeType(raw.AttributeType, raw.AttributeTypeName?.Value)
    if (type !== 'Picklist' && type !== 'MultiSelectPicklist') return

    const current = optionSets.get(raw.LogicalName)
    if (current?.inlineOptions?.length || current?.optionSetOptions?.length) return
    if (!raw.MetadataId) {
      const byLogicalName = await fetchGlobalOptionSetFull(raw.LogicalName)
      if (!byLogicalName || byLogicalName.options.length === 0) return
      optionSets.set(raw.LogicalName, {
        optionSetName: byLogicalName.name,
        optionSetIsGlobal: true,
        isGlobalOptionSet: true,
        inlineOptions: byLogicalName.options,
        optionSetOptions: byLogicalName.options,
      })
      return
    }

    const fallback = await fetchAttributeOptionSetMetadata(
      entityLogicalName,
      raw.MetadataId,
      type,
      raw.LogicalName,
    )
    if (!fallback || fallback.options.length === 0) {
      const byLogicalName = await fetchGlobalOptionSetFull(raw.LogicalName)
      if (!byLogicalName || byLogicalName.options.length === 0) return

      optionSets.set(raw.LogicalName, {
        optionSetName: byLogicalName.name,
        optionSetIsGlobal: true,
        isGlobalOptionSet: true,
        inlineOptions: byLogicalName.options,
        optionSetOptions: byLogicalName.options,
      })

      if (isDebug()) {
        console.info('[dataOnly] option set metadata global-name fallback', {
          entityLogicalName,
          logicalName: raw.LogicalName,
          optionSetName: byLogicalName.name,
          optionCount: byLogicalName.options.length,
        })
      }
      return
    }

    optionSets.set(raw.LogicalName, {
      optionSetName: fallback.name,
      optionSetMetadataId: fallback.metadataId,
      optionSetIsGlobal: fallback.isGlobal === true && fallback.name ? true : false,
      isGlobalOptionSet: fallback.isGlobal === true && fallback.name ? true : false,
      optionSetOptions: fallback.options,
      inlineOptions: fallback.options,
    })

    if (isDebug()) {
      console.info('[dataOnly] option set metadata fallback', {
        entityLogicalName,
        logicalName: raw.LogicalName,
        metadataId: raw.MetadataId,
        optionSetName: fallback.name,
        optionSetMetadataId: fallback.metadataId,
        isGlobal: fallback.isGlobal,
        optionCount: fallback.options.length,
        raw: fallback.raw,
      })
    }
  }))

  for (const raw of data.rawAttrs) {
    const type = mapAttributeType(raw.AttributeType, raw.AttributeTypeName?.Value)
    if (!type) continue
    const optionSet = optionSets.get(raw.LogicalName)
    attributes.push({
      logicalName:  raw.LogicalName,
      displayName:  raw.DisplayName?.UserLocalizedLabel?.Label ?? raw.LogicalName,
      type,
      isCustom:     true,
      optionSetName: optionSet?.optionSetName,
      optionSetMetadataId: optionSet?.optionSetMetadataId,
      optionSetIsGlobal: optionSet?.optionSetIsGlobal,
      isGlobalOptionSet: optionSet?.isGlobalOptionSet,
      optionSetOptions: optionSet?.optionSetOptions,
      inlineOptions: optionSet?.inlineOptions,
      // Lookup navigation metadata is filled later when lookup migration is enabled.
    })
  }

  return {
    logicalName:      data.logicalName,
    entitySetName:    data.entitySetName,
    primaryNameField: data.primaryNameField,
    attributes,
    ...(nnRelationships.length > 0 ? { nnRelationships } : {}),
  }
}

function mapAttributeType(type: string, typeName?: string): ColumnMetaType | null {
  switch (type) {
    case 'String':              return 'String'
    case 'Memo':                return 'Memo'
    case 'Integer':             return 'Integer'
    case 'Decimal':             return 'Decimal'
    case 'Money':               return 'Money'
    case 'DateTime':            return 'DateTime'
    case 'Boolean':             return 'Boolean'
    case 'Picklist':            return 'Picklist'
    case 'Lookup':              return 'Lookup'
    case 'MultiSelectPicklist': return 'MultiSelectPicklist'
    case 'Virtual':
      return typeName === 'MultiSelectPicklistType' ? 'MultiSelectPicklist' : null
    default:                    return null
  }
}
