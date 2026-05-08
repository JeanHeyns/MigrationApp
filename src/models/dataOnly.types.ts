export type MigrationMode = 'full' | 'dataOnly' | 'schemaOnly'

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
  optionSetName?: string       // Picklist / MultiSelectPicklist — global option set name when shared
  optionSetMetadataId?: string
  optionSetIsGlobal?: boolean  // false means local/bound to the attribute
  isGlobalOptionSet?: boolean
  optionSetOptions?: GlobalOptionSetMeta['options'] // local option set labels/values from attribute metadata
  inlineOptions?: GlobalOptionSetMeta['options'] // direct attribute response options for global or local choices
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
  options: Array<{ value: number; label: string; labels?: string[] }>
}

export interface ResolverChoiceSourceOption {
  id: string
  labels: string[]
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
  optionSetMetadataId?: string
  optionSetIsGlobal?: boolean
  isGlobalOptionSet?: boolean
  optionSetOptions?: GlobalOptionSetMeta['options']
  inlineOptions?: GlobalOptionSetMeta['options']
  sourceOptions?: ResolverChoiceSourceOption[]
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

export interface SchemaCreationResults {
  startedAt: Date
  completedAt: Date | null
  columns: {
    created: Array<{ entity: string; logicalName: string; type: string }>
    skipped: Array<{ entity: string; logicalName: string; reason: string }>
    failed: Array<{ entity: string; logicalName: string; error: string }>
  }
  optionSets: {
    created: Array<{ name: string; optionCount: number }>
    skipped: Array<{ name: string; reason: string }>
    failed: Array<{ name: string; error: string }>
  }
  lookupEntities: {
    created: Array<{ logicalName: string; displayName: string }>
    skipped: Array<{ logicalName: string; reason: string }>
    failed: Array<{ logicalName: string; error: string }>
  }
  lookupEntries: {
    inserted: Array<{ entity: string; name: string }>
    skipped: Array<{ entity: string; name: string; reason: string }>
    failed: Array<{ entity: string; name: string; error: string }>
  }
}
