import type { FieldMapping, MappingConfiguration, OptionSetMapping } from '../../models/mapping.types'
import type { ImportError } from '../../models/plannerPremium.types'

export function escapeODataString(value: string): string {
  return value.replace(/'/g, "''")
}

export function nowError(entity: string, sourceId: string, message: string): ImportError {
  return { entity, sourceId, message, timestamp: new Date().toISOString() }
}

export function getRecordId(row: Record<string, unknown>, primaryKey: string): string | undefined {
  const value = row[primaryKey] ?? row[primaryKey.toLowerCase()]
  return typeof value === 'string' ? value : undefined
}

export function cleanGuid(id: string | undefined): string | undefined {
  return id?.replace(/[{}]/g, '')
}

function getSourceValue(source: Record<string, unknown>, mapping: FieldMapping): unknown {
  const fieldName = mapping.customField.ODataFieldName
  if (fieldName && source[fieldName] !== undefined) return source[fieldName]
  return source[mapping.customField.CustomFieldName]
}

function asLookupValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(v => String(v)).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(/[;,]/)
      .map(v => v.trim())
      .filter(Boolean)
  }
  return value == null ? [] : [String(value)]
}

export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function customFieldPayload(
  source: Record<string, unknown>,
  entityType: 'Project' | 'Task' | 'Resource',
  mappingConfig: MappingConfiguration,
  optionSetMappings: OptionSetMapping[] = [],
  includeDefaults = false,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {}

  for (const mapping of mappingConfig.fieldMappings) {
    if (mapping.skip || mapping.customField.CustomFieldEntityType !== entityType) continue

    const sourceValue = getSourceValue(source, mapping)
    const isMissing = sourceValue === undefined || sourceValue === null || sourceValue === ''
    const value = isMissing ? (mapping.manualDefault ?? defaultValue(mapping, optionSetMappings)) : sourceValue
    if (isMissing && !includeDefaults && !mapping.manualDefault) continue
    if (value === undefined || value === null || value === '') continue

    switch (mapping.targetColumnType) {
      case 'Boolean':
        payload[mapping.targetLogicalName] = value === true || value === 'true' || value === 'Yes' || value === 1
        break
      case 'Integer':
        payload[mapping.targetLogicalName] = Number.parseInt(String(value), 10)
        break
      case 'Decimal':
      case 'Currency':
        payload[mapping.targetLogicalName] = Number(value)
        break
      case 'OptionSet': {
        const osm = optionSetMappings.find(m => m.lookupTableUID === mapping.lookupTable?.LookupTableUID)
        const optionValue = osm?.valueMap[String(value)]
        const fallbackValue = optionValue === undefined && mapping.manualDefault
          ? osm?.valueMap[mapping.manualDefault]
          : undefined
        const resolved = optionValue ?? fallbackValue
        if (resolved !== undefined) {
          payload[mapping.targetLogicalName] = resolved
        } else if (includeDefaults) {
          payload[mapping.targetLogicalName] = defaultValue(mapping, optionSetMappings)
        }
        break
      }
      case 'MultiSelectOptionSet': {
        const osm = optionSetMappings.find(m => m.lookupTableUID === mapping.lookupTable?.LookupTableUID)
        const values = asLookupValues(value)
          .map(v => osm?.valueMap[v])
          .filter((v): v is number => v !== undefined)
        if (values.length > 0 || includeDefaults) payload[mapping.targetLogicalName] = values.join(',')
        break
      }
      default:
        payload[mapping.targetLogicalName] = value
        break
    }
  }

  return payload
}

function defaultValue(mapping: FieldMapping, optionSetMappings: OptionSetMapping[]): unknown {
  switch (mapping.targetColumnType) {
    case 'Boolean':
      return false
    case 'Integer':
    case 'Decimal':
    case 'Currency':
      return 0
    case 'Text':
    case 'Memo':
      return '-'
    case 'OptionSet': {
      const osm = optionSetMappings.find(m => m.lookupTableUID === mapping.lookupTable?.LookupTableUID)
      return Object.values(osm?.valueMap ?? {})[0] ?? 1
    }
    case 'MultiSelectOptionSet':
      return ''
    default:
      return undefined
  }
}
