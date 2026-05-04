import type { PoCustomField, PoLookupTable } from './projectOnline.types'

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
  manualDefault?: string      // LookupEntryUID for OptionSet; raw string for other types
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
  fieldMappings: FieldMapping[]
  ownerMappings: OwnerMapping[]
  savedAt: string
}
