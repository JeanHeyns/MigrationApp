import { odataGetAll } from './odataClient'
import type { PoCustomField, PoCustomFieldType } from '../../models/projectOnline.types'

// _api/ProjectServer/CustomFields Microsoft.ProjectServer.CustomFieldType enum.
const PS_TYPE_MAP: Record<number, PoCustomFieldType> = {
  4:  'Date',
  6:  'Duration',
  9:  'Cost',
  15: 'Number',
  17: 'Flag',
  21: 'Text',
}

const PS_TYPE_NAME_MAP: Record<string, PoCustomFieldType> = {
  cost: 'Cost',
  date: 'Date',
  duration: 'Duration',
  flag: 'Flag',
  boolean: 'Flag',
  number: 'Number',
  text: 'Text',
  lookup: 'Lookup',
  multivalue: 'LookupMulti',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readLookupTableId(cf: any): string | undefined {
  return (
    cf.LookupTable?.Id ??
    cf.LookupTable?.id ??
    cf.LookupTableId ??
    cf.LookupTableID ??
    cf.CustomFieldLookupTableUID ??
    cf.lookupTable?.id
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readFieldTypeCode(cf: any): number | undefined {
  const raw = cf.FieldType ?? cf.fieldType ?? cf.CustomFieldType ?? cf.customFieldType
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw)
  if (raw && typeof raw === 'object') {
    const value = raw.Value ?? raw.value ?? raw.Id ?? raw.id
    if (typeof value === 'number') return value
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  }
  return undefined
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readFieldTypeName(cf: any): string {
  const raw = cf.FieldType ?? cf.fieldType ?? cf.CustomFieldType ?? cf.customFieldType
  const name = typeof raw === 'string'
    ? raw
    : raw?.Name ?? raw?.name ?? raw?.StringValue ?? raw?.stringValue ?? cf.TypeDescription ?? cf.typeDescription ?? ''
  return String(name).toLowerCase()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveFieldType(cf: any): PoCustomFieldType {
  if (readLookupTableId(cf)) {
    return (cf.IsMultiValue ?? cf.LookupAllowMultiSelect ?? cf.lookupAllowMultiSelect)
      ? 'LookupMulti'
      : 'Lookup'
  }

  const byCode = PS_TYPE_MAP[readFieldTypeCode(cf) ?? -1]
  if (byCode) return byCode

  const typeName = readFieldTypeName(cf)
  const byName = Object.entries(PS_TYPE_NAME_MAP).find(([key]) => typeName.includes(key))?.[1]
  return byName ?? 'Text'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveEntityType(cf: any): 'Project' | 'Task' | 'Resource' {
  const et = cf.EntityType ?? cf.entityType
  if (!et) return 'Project'
  // EntityType can be a string name or an object with a Name property
  const name = (typeof et === 'string' ? et : (et?.Name ?? '')).toLowerCase()
  if (name.includes('task')) return 'Task'
  if (name.includes('resource')) return 'Resource'
  return 'Project'
}

export function toLogicalName(name: string, prefix = 'cr9a1'): string {
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  return `${prefix}_${clean}`.slice(0, 47) // Dataverse max 47 chars for custom columns
}

export async function fetchCustomFields(siteUrl: string): Promise<PoCustomField[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await odataGetAll<any>(
    siteUrl,
    '_api/ProjectServer/CustomFields?$expand=LookupTable',
  )

  return raw.map(cf => ({
    CustomFieldId:           cf.Id ?? cf.CustomFieldId ?? '',
    CustomFieldName:         cf.Name ?? cf.CustomFieldName ?? '',
    CustomFieldEntityType:   resolveEntityType(cf),
    CustomFieldType:         resolveFieldType(cf),
    CustomFieldTypeValue:    readFieldTypeCode(cf) ?? 0,
    CustomFieldLookupTableUID: readLookupTableId(cf),
    ODataFieldName:          (cf.Name ?? cf.CustomFieldName ?? '').replace(/[^a-zA-Z0-9]/g, ''),
  })) satisfies PoCustomField[]
}
