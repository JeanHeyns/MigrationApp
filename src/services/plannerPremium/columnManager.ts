import type { FieldMapping, OptionSetMapping } from '../../models/mapping.types'
import type { DataverseColumnType } from '../../models/mapping.types'
import { createEntityAttribute, createOneToManyRelationship } from '../dataverseService'

export interface ColumnCreateResult {
  fieldMapping: FieldMapping
  logicalName: string
  entityLogicalName: string
  success: boolean
  alreadyExisted?: boolean
  error?: string
}

const ENTITY_MAP: Partial<Record<string, string>> = {
  Project:  'msdyn_project',
  Task:     'msdyn_projecttask',
}

export function projectOnlineIdColumnName(prefix: string): string {
  return `${prefix}_projectonlineid`.slice(0, 47)
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

function requiredLevel() {
  return { Value: 'None', CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' }
}

function managedBoolean(value: boolean) {
  return { Value: value, CanBeChanged: true }
}

function globalOptionSetBind(osm: OptionSetMapping | undefined, fallbackName: string): string {
  if (!osm?.metadataId) {
    throw new Error(`Global OptionSet "${osm?.optionSetName ?? fallbackName}" metadata ID could not be resolved`)
  }

  return `/GlobalOptionSetDefinitions(${osm.metadataId})`
}

function buildAttributeBody(
  fm: FieldMapping,
  optionSetMappings: OptionSetMapping[],
): Record<string, unknown> {
  const base = {
    SchemaName: fm.targetLogicalName,
    LogicalName: fm.targetLogicalName,
    DisplayName: dvLabel(fm.customField.CustomFieldName),
    Description: dvLabel(`Migrated from Project Online: ${fm.customField.CustomFieldName}`),
    RequiredLevel: requiredLevel(),
    IsValidForAdvancedFind: managedBoolean(true),
  }

  const type: DataverseColumnType = fm.targetColumnType

  switch (type) {
    case 'Text':
      return { ...base, '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata', MaxLength: 4000, FormatName: { Value: 'Text' } }

    case 'Memo':
      return { ...base, '@odata.type': 'Microsoft.Dynamics.CRM.MemoAttributeMetadata', MaxLength: 10000, Format: 'TextArea' }

    case 'Decimal':
      return { ...base, '@odata.type': 'Microsoft.Dynamics.CRM.DecimalAttributeMetadata', Precision: 2 }

    case 'Integer':
      return { ...base, '@odata.type': 'Microsoft.Dynamics.CRM.IntegerAttributeMetadata', Format: 'None' }

    case 'Currency':
      return { ...base, '@odata.type': 'Microsoft.Dynamics.CRM.MoneyAttributeMetadata', Precision: 2 }

    case 'Date':
      return {
        ...base,
        '@odata.type': 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata',
        Format: 'DateOnly',
        DateTimeBehavior: { Value: 'DateOnly' },
      }

    case 'DateTime':
      return {
        ...base,
        '@odata.type': 'Microsoft.Dynamics.CRM.DateTimeAttributeMetadata',
        Format: 'DateAndTime',
        DateTimeBehavior: { Value: 'TimeZoneIndependent' },
      }

    case 'Boolean':
      return {
        ...base,
        '@odata.type': 'Microsoft.Dynamics.CRM.BooleanAttributeMetadata',
        OptionSet: {
          '@odata.type': 'Microsoft.Dynamics.CRM.BooleanOptionSetMetadata',
          TrueOption:  { Value: 1, Label: dvLabel('Yes') },
          FalseOption: { Value: 0, Label: dvLabel('No') },
        },
      }

    case 'OptionSet': {
      const osm = optionSetMappings.find(m => m.lookupTableUID === fm.lookupTable?.LookupTableUID)
      return {
        ...base,
        '@odata.type': 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata',
        'GlobalOptionSet@odata.bind': globalOptionSetBind(osm, fm.targetLogicalName),
      }
    }

    case 'MultiSelectOptionSet': {
      const osm = optionSetMappings.find(m => m.lookupTableUID === fm.lookupTable?.LookupTableUID)
      return {
        ...base,
        '@odata.type': 'Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata',
        'GlobalOptionSet@odata.bind': globalOptionSetBind(osm, fm.targetLogicalName),
      }
    }

    default:
      throw new Error(`Unsupported column type: ${type}`)
  }
}

function isAlreadyExistsError(msg: string): boolean {
  const lower = msg.toLowerCase()
  return (
    msg.includes('0x80044331') ||
    msg.includes('0x80060891') ||
    msg.includes('0x8004F049') ||
    msg.includes('0x80048408') ||
    lower.includes('already exists') ||
    lower.includes('attribute with the specified name') ||
    lower.includes('duplicate') ||
    lower.includes('schemaname is already in use')
  )
}

function migrationIdColumnBody(logicalName: string, displayName: string): Record<string, unknown> {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: logicalName,
    LogicalName: logicalName,
    DisplayName: dvLabel(displayName),
    Description: dvLabel('Source Project Online identifier used by the migration tool'),
    RequiredLevel: requiredLevel(),
    IsValidForAdvancedFind: managedBoolean(true),
    MaxLength: 100,
    FormatName: { Value: 'Text' },
  }
}

export async function createMigrationColumns(
  publisherPrefix: string,
  solutionUniqueName: string,
): Promise<ColumnCreateResult[]> {
  const logicalName = projectOnlineIdColumnName(publisherPrefix)
  const syntheticMapping = {
    customField: {
      CustomFieldId: logicalName,
      CustomFieldName: 'Project Online ID',
      CustomFieldEntityType: 'Project' as const,
      CustomFieldType: 'Text' as const,
      CustomFieldTypeValue: 21,
    },
    targetColumnType: 'Text' as const,
    targetLogicalName: logicalName,
    skip: false,
    migrateValue: false,
    useExistingField: false,
  }

  try {
    await createEntityAttribute('msdyn_project', migrationIdColumnBody(logicalName, 'Project Online ID'), solutionUniqueName)
    return [{
      fieldMapping: syntheticMapping,
      logicalName,
      entityLogicalName: 'msdyn_project',
      success: true,
    }]
  } catch (e) {
    const msg = String(e)
    const alreadyExisted = isAlreadyExistsError(msg)
    return [{
      fieldMapping: syntheticMapping,
      logicalName,
      entityLogicalName: 'msdyn_project',
      success: alreadyExisted,
      alreadyExisted,
      error: alreadyExisted ? undefined : msg,
    }]
  }
}

export async function createColumns(
  fieldMappings: FieldMapping[],
  optionSetMappings: OptionSetMapping[],
  solutionUniqueName: string,
  onProgress: (result: ColumnCreateResult) => void,
): Promise<ColumnCreateResult[]> {
  // LookupMulti fields are handled via N:N relationships (schemaOrchestrator), not as columns
  const active = fieldMappings.filter(fm => !fm.skip && !fm.useExistingField && fm.customField.CustomFieldType !== 'LookupMulti')
  const results: ColumnCreateResult[] = []

  for (const fm of active) {
    const entityLogicalName = ENTITY_MAP[fm.customField.CustomFieldEntityType]

    if (!entityLogicalName) {
      const result: ColumnCreateResult = {
        fieldMapping: fm,
        logicalName: fm.targetLogicalName,
        entityLogicalName: fm.customField.CustomFieldEntityType,
        success: false,
        error: `Entity type "${fm.customField.CustomFieldEntityType}" is not supported (only Project and Task)`,
      }
      results.push(result)
      onProgress(result)
      continue
    }

    if (fm.targetColumnType === 'Lookup') {
      if (!fm.relatedEntity?.logicalName) {
        const result: ColumnCreateResult = {
          fieldMapping: fm,
          logicalName: fm.targetLogicalName,
          entityLogicalName,
          success: false,
          error: `Cannot create lookup column "${fm.targetLogicalName}": target entity is missing. Create the lookup table first.`,
        }
        results.push(result)
        onProgress(result)
        continue
      }

      try {
        const prefix = fm.targetLogicalName.split('_')[0]
        const lookupFieldPart = fm.targetLogicalName.split('_').slice(1).join('').slice(0, 20)
        const referencedShort = fm.relatedEntity.logicalName.replace(/_/g, '').slice(0, 20)
        const referencingShort = entityLogicalName.replace(/_/g, '').slice(0, 15)
        const relationshipSchemaName = `${prefix}_${referencedShort}_${referencingShort}_${lookupFieldPart}`

        await createOneToManyRelationship({
          referencedEntity: fm.relatedEntity.logicalName,
          referencingEntity: entityLogicalName,
          lookupSchemaName: fm.targetLogicalName,
          lookupDisplayName: fm.customField.CustomFieldName,
          relationshipSchemaName,
          solutionUniqueName,
        })

        const result: ColumnCreateResult = {
          fieldMapping: fm,
          logicalName: fm.targetLogicalName,
          entityLogicalName,
          success: true,
        }
        results.push(result)
        onProgress(result)
      } catch (e) {
        const msg = String(e)
        const alreadyExisted = isAlreadyExistsError(msg)
        const result: ColumnCreateResult = {
          fieldMapping: fm,
          logicalName: fm.targetLogicalName,
          entityLogicalName,
          success: alreadyExisted,
          alreadyExisted,
          error: alreadyExisted ? undefined : msg,
        }
        results.push(result)
        onProgress(result)
      }
      continue
    }

    try {
      const body = buildAttributeBody(fm, optionSetMappings)
      await createEntityAttribute(entityLogicalName, body, solutionUniqueName)
      const result: ColumnCreateResult = {
        fieldMapping: fm,
        logicalName: fm.targetLogicalName,
        entityLogicalName,
        success: true,
      }
      results.push(result)
      onProgress(result)
    } catch (e) {
      const msg = String(e)
      const alreadyExisted = isAlreadyExistsError(msg)
      const result: ColumnCreateResult = {
        fieldMapping: fm,
        logicalName: fm.targetLogicalName,
        entityLogicalName,
        success: alreadyExisted,
        alreadyExisted,
        error: alreadyExisted ? undefined : msg,
      }
      results.push(result)
      onProgress(result)
    }
  }

  return results
}
