import type { PoCustomField, PoLookupTable } from './projectOnline.types'
import type { MigrationMode } from './dataOnly.types'

export interface OptionSetMapping {
  lookupTableUID: string
  optionSetName: string
  metadataId?: string
  valueMap: Record<string, number>
}

export type DataverseColumnType =
  | 'Text'
  | 'Memo'
  | 'Decimal'
  | 'Integer'
  | 'Currency'
  | 'Date'
  | 'DateTime'
  | 'Boolean'
  | 'OptionSet'
  | 'MultiSelectOptionSet'
  | 'Lookup'

export interface FieldMapping {
  customField: PoCustomField
  targetColumnType: DataverseColumnType
  targetLogicalName: string
  targetDisplayName?: string
  lookupTable?: PoLookupTable
  skip: boolean
  migrateValue: boolean       // write the PO value to Dataverse when importing
  useExistingField: boolean   // map to existing DV field - skip column creation
  useExistingLookupEntity?: boolean
  relatedEntity?: { logicalName: string; logicalCollectionName: string }  // required when targetColumnType === 'Lookup'
  optionSetName?: string      // existing global choice name for OptionSet/MultiSelectOptionSet
  manualDefault?: string      // LookupEntryUID for OptionSet; raw string for other types
  matchSource?: 'auto' | 'manual'  // dataOnly mode: how targetLogicalName was set
}

export type MultiLookupTargetShape = 'MultiChoice' | 'N:N'

export interface MultiLookupMapping {
  poFieldName: string
  targetShape?: MultiLookupTargetShape     // undefined = legacy N:N

  // N:N only
  targetEntityLogicalName?: string
  targetEntitySetName?: string
  matchFieldLogicalName?: string
  relationshipSchemaName?: string
  navigationPropertyName?: string
  relationshipType?: 'pure-nn'

  // MultiChoice only
  targetColumnLogicalName?: string
}

export interface OwnerMapping {
  poResourceUid: string
  poOwnerName: string
  poOwnerEmail?: string
  dataverseSystemUserId?: string
  dataverseSystemUserName?: string
  matched: boolean
}

export interface MappingConfiguration {
  siteUrl: string
  publisherPrefix: string
  skipColumnCreation: boolean
  migrationMode?: MigrationMode
  fieldMappings: FieldMapping[]
  ownerMappings: OwnerMapping[]
  multiLookups?: MultiLookupMapping[]
  savedAt: string
}
