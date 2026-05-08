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
  lookupTable?: PoLookupTable
  skip: boolean
  migrateValue: boolean       // write the PO value to Dataverse when importing
  useExistingField: boolean   // map to existing DV field — skip column creation
  relatedEntity?: { logicalName: string; logicalCollectionName: string }  // required when targetColumnType === 'Lookup'
  manualDefault?: string      // LookupEntryUID for OptionSet; raw string for other types
  matchSource?: 'auto' | 'manual'  // dataOnly mode: how targetLogicalName was set
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
  savedAt: string
}
