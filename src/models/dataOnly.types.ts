export type MigrationMode = 'full' | 'dataOnly'

export type ColumnMetaType =
  | 'String'
  | 'Memo'
  | 'Integer'
  | 'Decimal'
  | 'Money'
  | 'DateTime'
  | 'Boolean'
  | 'Picklist'
  | 'MultiSelectPicklist'
  | 'Lookup'

export interface ColumnMeta {
  logicalName: string
  displayName: string
  type: ColumnMetaType
  isCustom: boolean
  optionSetName?: string       // Picklist / MultiSelectPicklist — global option set only
  targets?: string[]           // Lookup — target entity logical names
  navigationProperty?: string  // Lookup — odata.bind property name
}

export interface EntitySchema {
  logicalName: string
  entitySetName: string        // plural, for OData URLs
  primaryNameField: string
  attributes: ColumnMeta[]
}

export interface GlobalOptionSetMeta {
  name: string
  displayName: string
  options: Array<{ value: number; label: string }>
}

export interface SchemaSnapshot {
  scannedAt: Date
  solutionId: string
  entities: Record<string, EntitySchema>  // key = logical name
  globalOptionSets: GlobalOptionSetMeta[]
}

export interface ResolverEntry {
  poFieldName: string
  dvLogicalName: string
  dvType: ColumnMetaType
  optionSetName?: string
  targetEntity?: string
  targetEntitySet?: string
  primaryNameField?: string
  navigationProperty?: string
}

export interface ResolverPlan {
  fields: ResolverEntry[]
}

export interface SkippedFieldInstance {
  poField: string
  dvField: string
  reason: string
  originalValue: unknown
  partialResolution?: { resolvedLabels: string[]; failedLabels: string[] }
  sourceId: string  // poProjectId (or future: taskId, resourceId)
}
