import type { SchemaSnapshot, EntitySchema, ColumnMeta, ColumnMetaType } from '../../models/dataOnly.types'
import {
  fetchCustomMultiPicklistAttributes,
  fetchCustomPicklistAttributes,
  fetchEntityWithCustomAttributes,
} from '../dataverseService'

const DEFAULT_TARGET_ENTITIES = ['msdyn_project', 'msdyn_projecttask', 'msdyn_projectteam']

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

  // optionSetName is undefined at this stage — populated when resolvers are built (phase 5+)
  return {
    scannedAt: new Date(),
    solutionId,
    entities,
    globalOptionSets: [],
  }
}

async function inspectEntity(entityLogicalName: string): Promise<EntitySchema> {
  // Single call via existing GetEntityDefinition (confirmed working in this codebase).
  // The new sub-collection operations (GetEntityAttributes, ManyToOneRelationships) are not
  // accessible via the commondataserviceforapps connector GET routing — deferred to phase 5.
  const data = await fetchEntityWithCustomAttributes(entityLogicalName)

  const attributes: ColumnMeta[] = []
  const [picklists, multiPicklists] = await Promise.all([
    fetchCustomPicklistAttributes(entityLogicalName).catch(() => []),
    fetchCustomMultiPicklistAttributes(entityLogicalName).catch(() => []),
  ])
  const optionSetNames = new Map<string, string>()
  for (const attr of [...picklists, ...multiPicklists]) {
    const globalName = attr.GlobalOptionSet?.Name
      ?? (attr.OptionSet?.IsGlobal ? attr.OptionSet.Name : undefined)
    if (globalName) {
      optionSetNames.set(attr.LogicalName, globalName)
    }
  }

  for (const raw of data.rawAttrs) {
    const type = mapAttributeType(raw.AttributeType, raw.AttributeTypeName?.Value)
    if (!type) continue
    attributes.push({
      logicalName:  raw.LogicalName,
      displayName:  raw.DisplayName?.UserLocalizedLabel?.Label ?? raw.LogicalName,
      type,
      isCustom:     true,
      optionSetName: optionSetNames.get(raw.LogicalName),
      // Lookup navigation metadata is filled later when lookup migration is enabled.
    })
  }

  return {
    logicalName:      data.logicalName,
    entitySetName:    data.entitySetName,
    primaryNameField: data.primaryNameField,
    attributes,
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
