import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Checkbox,
  Input,
  MessageBar,
  MessageBarBody,
  Select,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { useMigration } from '../../app/MigrationContext'
import {
  fetchEntityAttributes,
  fetchEntityDefinitions,
  fetchEntityManyToOneRelationships,
  fetchEntityWithCustomAttributes,
  fetchGlobalOptionSetDefinitions,
  fetchSolutionComponentIds,
  fetchSolutionEntityIds,
  type RawRelationshipMeta,
  type DvEntityAttribute,
  type DvEntityDefinition,
  type DvGlobalOptionSetDefinition,
} from '../../services/dataverseService'
import { toLogicalName } from '../../services/projectOnline/customFields'
import { hasHierarchicalEntries, lookupEntityLogicalName } from '../../services/plannerPremium/lookupEntityManager'
import type { PoCustomField, PoCustomFieldType, PoFetchedData, PoLookupTable } from '../../models/projectOnline.types'
import type { DataverseColumnType, FieldMapping, MappingConfiguration, MultiLookupMapping, MultiLookupTargetShape } from '../../models/mapping.types'
import type { ColumnMeta, ColumnMetaType, EntitySchema, NNRelationshipMeta, ResolverEntry, ResolverPlan, SchemaSnapshot } from '../../models/dataOnly.types'

// ─── Type mappings ────────────────────────────────────────────────────────────

const DV_ATTR_TYPE_MAP: Record<string, DataverseColumnType> = {
  String:               'Text',
  Memo:                 'Memo',
  Integer:              'Integer',
  BigInt:               'Integer',
  Decimal:              'Decimal',
  Double:               'Decimal',
  Money:                'Currency',
  DateTime:             'DateTime',
  Boolean:              'Boolean',
  Picklist:             'OptionSet',
  MultiSelectPicklist:  'MultiSelectOptionSet',
  Lookup:               'Lookup',
  Owner:                'Lookup',
}

const PO_COMPATIBLE_ATTR_TYPES: Record<PoCustomFieldType, string[]> = {
  Text:        ['String', 'Memo'],
  Memo:        ['Memo', 'String'],
  Number:      ['Integer', 'Decimal', 'Double', 'Money'],
  Cost:        ['Money', 'Decimal'],
  Duration:    ['Integer', 'Decimal'],
  Date:        ['DateTime'],
  Flag:        ['Boolean'],
  Boolean:     ['Boolean'],
  Choice:      ['Picklist'],
  MultiChoice: ['MultiSelectPicklist'],
  Lookup:      ['Picklist', 'Lookup', 'Owner'],
  LookupMulti: ['MultiSelectPicklist'],
}

const SUGGESTED_DV_TYPE: Record<PoCustomFieldType, DataverseColumnType> = {
  Text:        'Text',
  Memo:        'Memo',
  Number:      'Decimal',
  Cost:        'Currency',
  Duration:    'Integer',
  Date:        'Date',
  Flag:        'Boolean',
  Boolean:     'Boolean',
  Choice:      'OptionSet',
  MultiChoice: 'MultiSelectOptionSet',
  Lookup:      'OptionSet',
  LookupMulti: 'MultiSelectOptionSet',
}

const DV_TYPE_ALTERNATIVES: Record<PoCustomFieldType, DataverseColumnType[]> = {
  Text:        ['Text', 'Memo'],
  Memo:        ['Memo', 'Text'],
  Number:      ['Decimal', 'Integer'],
  Cost:        ['Currency'],
  Duration:    ['Integer', 'Decimal'],
  Date:        ['Date', 'DateTime'],
  Flag:        ['Boolean'],
  Boolean:     ['Boolean'],
  Choice:      ['OptionSet'],
  MultiChoice: ['MultiSelectOptionSet'],
  Lookup:      ['OptionSet', 'Lookup'],
  LookupMulti: ['MultiSelectOptionSet'],
}

const DV_TYPE_LABELS: Record<DataverseColumnType, string> = {
  Text:                 'Text',
  Memo:                 'Memo (Long Text)',
  Decimal:              'Decimal Number',
  Integer:              'Whole Number',
  Currency:             'Currency',
  Date:                 'Date Only',
  DateTime:             'Date & Time',
  Boolean:              'Two Options',
  OptionSet:            'Choice (OptionSet)',
  MultiSelectOptionSet: 'Multi-Select Choice',
  Lookup:               'Lookup',
}

const ENTITY_COLORS: Record<string, string> = {
  Project:  '#0078d4',
  Task:     '#498205',
  Resource: '#7719aa',
}

// ─── dataOnly mode constants ───────────────────────────────────────────────────

const PO_ENTITY_TO_DV: Record<string, string> = {
  Project:  'msdyn_project',
  Task:     'msdyn_projecttask',
  Resource: 'msdyn_projectteam',
}

const PO_TO_SCHEMA_TYPES: Record<string, ColumnMetaType[]> = {
  Text:        ['String', 'Memo'],
  Memo:        ['Memo', 'String'],
  Number:      ['Integer', 'Decimal', 'Money'],
  Cost:        ['Money', 'Decimal'],
  Duration:    ['Integer', 'Decimal'],
  Date:        ['DateTime'],
  Flag:        ['Boolean'],
  Boolean:     ['Boolean'],
  Choice:      ['Picklist'],
  MultiChoice: ['MultiSelectPicklist'],
  Lookup:      ['Picklist', 'Lookup'],
  LookupMulti: ['MultiSelectPicklist'],
}

const SCHEMA_TYPE_TO_DV_TYPE: Partial<Record<ColumnMetaType, DataverseColumnType>> = {
  String:               'Text',
  Memo:                 'Memo',
  Integer:              'Integer',
  Decimal:              'Decimal',
  Money:                'Currency',
  DateTime:             'DateTime',
  Boolean:              'Boolean',
  Picklist:             'OptionSet',
  MultiSelectPicklist:  'MultiSelectOptionSet',
  Lookup:               'Lookup',
}

type FieldFilter = 'all' | 'active' | 'skipped' | 'project' | 'task' | 'resource'
type SelfLookupOption = { lookupLogicalName: string; navigationPropertyName: string; label: string }

// ─── dataOnly helpers ─────────────────────────────────────────────────────────

function getCompatibleColumns(dvEntity: EntitySchema, poType: string): ColumnMeta[] {
  const compatible = PO_TO_SCHEMA_TYPES[poType] ?? []
  return dvEntity.attributes.filter(a => compatible.includes(a.type))
}

function autoMatchColumn(cf: PoCustomField, compatible: ColumnMeta[], prefix: string): ColumnMeta | null {
  if (cf.DataverseLogicalName) {
    const explicit = compatible.find(c => c.logicalName === cf.DataverseLogicalName)
    if (explicit) return explicit
  }
  const logicalName = toLogicalName(cf.CustomFieldName, prefix)
  const byLogical = compatible.find(c => c.logicalName === logicalName)
  if (byLogical) return byLogical
  const displayLower = cf.CustomFieldName.toLowerCase()
  return compatible.find(c => c.displayName.toLowerCase() === displayLower) ?? null
}

function findMultiChoiceColumn(mapping: FieldMapping, snapshot: SchemaSnapshot | null, prefix: string): ColumnMeta | null {
  const projectEntity = snapshot?.entities['msdyn_project']
  if (!projectEntity) return null
  const compatible = getCompatibleColumns(projectEntity, 'LookupMulti')
  return autoMatchColumn(mapping.customField, compatible, prefix)
    ?? compatible.find(c => c.logicalName === mapping.targetLogicalName)
    ?? null
}

function buildDataOnlyMappings(data: PoFetchedData, snapshot: SchemaSnapshot, prefix: string): FieldMapping[] {
  const lookupMap = new Map(data.lookupTables.map(lt => [lt.LookupTableUID, lt]))
  return data.customFields.map(cf => {
    const dvEntityKey = PO_ENTITY_TO_DV[cf.CustomFieldEntityType]
    const dvEntity = dvEntityKey ? snapshot.entities[dvEntityKey] : undefined
    const compatible = dvEntity ? getCompatibleColumns(dvEntity, cf.CustomFieldType) : []
    const lookupTable = cf.CustomFieldLookupTableUID
      ? lookupMap.get(cf.CustomFieldLookupTableUID)
      : undefined

    if (compatible.length === 0) {
      // LookupMulti N:N fields have no MultiSelectPicklist column — keep active (handled via multiLookups)
      const skipField = cf.CustomFieldType !== 'LookupMulti'
      return {
        customField: cf,
        targetColumnType: SUGGESTED_DV_TYPE[cf.CustomFieldType],
        targetLogicalName: toLogicalName(cf.CustomFieldName, prefix),
        lookupTable,
        skip: skipField,
        migrateValue: false,
        useExistingField: false,
      }
    }

    const matched = autoMatchColumn(cf, compatible, prefix)
    if (matched) {
      return {
        customField: cf,
        targetColumnType: SCHEMA_TYPE_TO_DV_TYPE[matched.type] ?? SUGGESTED_DV_TYPE[cf.CustomFieldType],
        targetLogicalName: matched.logicalName,
        lookupTable,
        skip: false,
        migrateValue: true,
        useExistingField: true,
        matchSource: 'auto' as const,
      }
    }

    return {
      customField: cf,
      targetColumnType: SUGGESTED_DV_TYPE[cf.CustomFieldType],
      targetLogicalName: toLogicalName(cf.CustomFieldName, prefix),
      lookupTable,
      skip: false,
      migrateValue: false,
      useExistingField: false,
    }
  })
}

function sourceOptionsForMapping(
  mapping: FieldMapping,
  lookupTables: Map<string, PoLookupTable>,
): ResolverEntry['sourceOptions'] {
  const lookupTable = mapping.lookupTable
    ?? (mapping.customField.CustomFieldLookupTableUID
      ? lookupTables.get(mapping.customField.CustomFieldLookupTableUID)
      : undefined)

  if (!lookupTable) return undefined

  return lookupTable.entries.map(entry => ({
    id: entry.LookupEntryUID,
    labels: Array.from(new Set([
      entry.LookupEntryFullValue,
      entry.LookupEntryValue,
    ].filter((label): label is string => typeof label === 'string' && label.length > 0))),
  }))
}

function buildResolverPlanFromMappings(
  mappings: FieldMapping[],
  snapshot: SchemaSnapshot,
  lookupTables: PoLookupTable[] = [],
): ResolverPlan {
  const fields: ResolverEntry[] = []
  const lookupTableMap = new Map(lookupTables.map(lt => [lt.LookupTableUID, lt]))
  for (const m of mappings) {
    if (m.skip || !m.useExistingField || !m.targetLogicalName) continue
    const dvEntityKey = PO_ENTITY_TO_DV[m.customField.CustomFieldEntityType]
    const dvEntity = dvEntityKey ? snapshot.entities[dvEntityKey] : undefined
    if (!dvEntity) continue
    const col = dvEntity.attributes.find(a => a.logicalName === m.targetLogicalName)
    if (!col) continue
    const targetEntity = col.targets?.[0]
    const targetEntityObj = targetEntity ? snapshot.entities[targetEntity] : undefined
    const isChoice = col.type === 'Picklist' || col.type === 'MultiSelectPicklist'
    const usesLookupTableSource = isChoice || col.type === 'Lookup'
    fields.push({
      poFieldName:      m.customField.ODataFieldName ?? m.customField.CustomFieldName,
      dvLogicalName:    m.targetLogicalName,
      dvType:           col.type,
      optionSetName:    isChoice ? col.optionSetName : undefined,
      optionSetMetadataId: isChoice ? col.optionSetMetadataId : undefined,
      optionSetIsGlobal: isChoice ? col.optionSetIsGlobal : undefined,
      isGlobalOptionSet: isChoice ? col.isGlobalOptionSet : undefined,
      optionSetOptions: isChoice ? col.optionSetOptions : undefined,
      inlineOptions:    isChoice ? col.inlineOptions : undefined,
      sourceOptions:    usesLookupTableSource ? sourceOptionsForMapping(m, lookupTableMap) : undefined,
      targetEntity,
      targetEntitySet:  targetEntityObj?.entitySetName,
      primaryNameField: targetEntityObj?.primaryNameField,
      navigationProperty: col.navigationProperty,
    })
  }
  return { fields }
}

// ─── Multi-lookup helpers ──────────────────────────────────────────────────────

function buildInitialMultiLookupMappings(data: PoFetchedData): MultiLookupMapping[] {
  return data.customFields
    .filter(cf => cf.CustomFieldType === 'LookupMulti' && cf.CustomFieldEntityType === 'Project')
    .map(cf => ({
      poFieldName: cf.ODataFieldName || cf.CustomFieldName,
      targetShape: 'MultiChoice' as MultiLookupTargetShape,
    }))
}

function buildDataOnlyMultiLookupMappings(data: PoFetchedData, snapshot: SchemaSnapshot, prefix: string): MultiLookupMapping[] {
  const projectEntity = snapshot.entities['msdyn_project']
  return data.customFields
    .filter(cf => cf.CustomFieldType === 'LookupMulti' && cf.CustomFieldEntityType === 'Project')
    .map(cf => {
      const poFieldName = cf.ODataFieldName || cf.CustomFieldName
      const expectedLogicalName = toLogicalName(cf.CustomFieldName, prefix)

      // Check for MultiChoice column. If Step 2 can match a MultiSelectPicklist
      // column, the existing column schema is authoritative and MultiChoice wins.
      const mcColumn = projectEntity
        ? autoMatchColumn(cf, getCompatibleColumns(projectEntity, 'LookupMulti'), prefix)
          ?? projectEntity.attributes.find(a => a.logicalName === expectedLogicalName && a.type === 'MultiSelectPicklist')
        : undefined

      // Check for N:N relationship targeting the expected lookup entity
      let nnRel: NNRelationshipMeta | undefined
      if (cf.CustomFieldLookupTableUID && data.lookupTables) {
        const lt = data.lookupTables.find(t => t.LookupTableUID === cf.CustomFieldLookupTableUID)
        if (lt) {
          const expectedEntity = lookupEntityLogicalName(lt, prefix)
          nnRel = projectEntity?.nnRelationships?.find(r => r.targetEntityLogicalName === expectedEntity)
        }
      }

      if (mcColumn) {
        return {
          poFieldName,
          targetShape: 'MultiChoice' as MultiLookupTargetShape,
          targetColumnLogicalName: mcColumn.logicalName,
        }
      }

      if (nnRel) {
        const navProp = nnRel.entity1LogicalName === 'msdyn_project'
          ? nnRel.entity2NavigationPropertyName
          : nnRel.entity1NavigationPropertyName
        return {
          poFieldName,
          targetShape: 'N:N' as MultiLookupTargetShape,
          targetEntityLogicalName: nnRel.targetEntityLogicalName,
          targetEntitySetName: nnRel.targetEntitySetName,
          matchFieldLogicalName: '',  // user must confirm match field
          relationshipSchemaName: nnRel.schemaName,
          navigationPropertyName: navProp,
          relationshipType: 'pure-nn' as const,
        }
      }
      // Neither found — default to N:N (user can configure; error shown in bottom panel)
      return {
        poFieldName,
        targetShape: 'N:N' as MultiLookupTargetShape,
      }
    })
}

function activeMultiLookupMappings(
  fieldMappings: FieldMapping[],
  multiLookupMappings: MultiLookupMapping[],
): MultiLookupMapping[] {
  return fieldMappings
    .filter(m => !m.skip && m.customField.CustomFieldType === 'LookupMulti')
    .map(m => {
      const poFieldName = m.customField.ODataFieldName || m.customField.CustomFieldName
      return multiLookupMappings.find(ml => ml.poFieldName === poFieldName)
        ?? {
          poFieldName,
          targetShape: 'MultiChoice' as MultiLookupTargetShape,
          targetColumnLogicalName: m.useExistingField ? m.targetLogicalName : undefined,
        }
    })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildInitialMappings(data: PoFetchedData, prefix: string): FieldMapping[] {
  const lookupMap = new Map(data.lookupTables.map(lt => [lt.LookupTableUID, lt]))
  return data.customFields.map(cf => ({
    customField: cf,
    targetColumnType: SUGGESTED_DV_TYPE[cf.CustomFieldType],
    targetLogicalName: toLogicalName(cf.CustomFieldName, prefix),
    lookupTable: cf.CustomFieldLookupTableUID
      ? lookupMap.get(cf.CustomFieldLookupTableUID)
      : undefined,
    skip: cf.CustomFieldEntityType === 'Resource',
    migrateValue: cf.CustomFieldEntityType === 'Project',
    useExistingField: false,
  }))
}

function buildSchemaOnlyMappings(data: PoFetchedData, prefix: string): FieldMapping[] {
  const lookupMap = new Map(data.lookupTables.map(lt => [lt.LookupTableUID, lt]))
  return data.customFields.map(cf => {
    const lookupTable = cf.CustomFieldLookupTableUID
      ? lookupMap.get(cf.CustomFieldLookupTableUID)
      : undefined
    const targetColumnType = SUGGESTED_DV_TYPE[cf.CustomFieldType]
    return {
      customField: cf,
      targetColumnType,
      targetLogicalName: toLogicalName(cf.CustomFieldName, prefix),
      lookupTable,
      skip: cf.CustomFieldEntityType === 'Resource',
      migrateValue: false,
      useExistingField: false,
      useExistingLookupEntity: false,
      relatedEntity: targetColumnType === 'Lookup' && lookupTable
        ? { logicalName: lookupEntityLogicalName(lookupTable, prefix), logicalCollectionName: '' }
        : undefined,
    }
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTargetSummary(
  m: FieldMapping,
  prefix: string,
): { text: string; isWarning: boolean } {
  if (m.targetColumnType === 'Lookup' && m.lookupTable) {
    if (m.useExistingLookupEntity && m.relatedEntity?.logicalName) {
      return { text: `Use existing · ${m.relatedEntity.logicalName}`, isWarning: false }
    }
    const entityName = lookupEntityLogicalName(m.lookupTable, prefix)
    const count = m.lookupTable.entries.length
    return {
      text: `Create lookup · ${entityName} · ${count} ${count === 1 ? 'entry' : 'entries'}`,
      isWarning: count === 0,
    }
  }
  if ((m.targetColumnType === 'OptionSet' || m.targetColumnType === 'MultiSelectOptionSet') && m.lookupTable) {
    if (m.optionSetName) {
      return { text: `Reuse choice · ${m.optionSetName}`, isWarning: false }
    }
    const count = m.lookupTable.entries.length
    return {
      text: `Create choice · ${m.targetLogicalName} · ${count} ${count === 1 ? 'entry' : 'entries'}`,
      isWarning: count === 0,
    }
  }
  return { text: '', isWarning: false }
}

function toSelfLookupOptions(entityLogicalName: string, relationships: RawRelationshipMeta[]): SelfLookupOption[] {
  return relationships
    .filter(r => r.ReferencedEntity === entityLogicalName && r.ReferencingAttribute)
    .map(r => ({
      lookupLogicalName: r.ReferencingAttribute,
      navigationPropertyName: r.ReferencingEntityNavigationPropertyName,
      label: r.ReferencingAttribute,
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

function preferredSelfLookupOption(options: SelfLookupOption[]): SelfLookupOption | undefined {
  if (options.length === 1) return options[0]
  return options.find(option => option.lookupLogicalName.toLowerCase().includes('parent'))
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  root: {
    padding: '32px',
    width: '100%',
    maxWidth: '1080px',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '28px',
    boxSizing: 'border-box',
  },
  title: { fontSize: '20px', fontWeight: '600', color: tokens.colorNeutralForeground1 },
  subtitle: { fontSize: '13px', color: tokens.colorNeutralForeground3, marginTop: '4px' },
  sectionTitle: { fontSize: '15px', fontWeight: '600', color: tokens.colorNeutralForeground1, marginBottom: '12px' },
  toolbar: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  tableWrap: { width: '100%', overflowX: 'auto' },
  table: { width: '100%', minWidth: '940px', borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: '13px' },
  th: {
    textAlign: 'left',
    padding: '8px 10px',
    background: tokens.colorNeutralBackground3,
    borderBottom: `2px solid ${tokens.colorNeutralStroke1}`,
    fontWeight: '600',
    color: tokens.colorNeutralForeground2,
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '7px 10px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    verticalAlign: 'top',
  },
  trSkipped: { opacity: 0.45 },
  entityBadge: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '10px',
    fontSize: '11px',
    fontWeight: '600',
    color: '#fff',
  },
  logicalName: {
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    fontFamily: 'Consolas, monospace',
    overflowWrap: 'anywhere',
  },
  fieldNameCell: { display: 'flex', flexDirection: 'column', gap: '3px' },
  fieldNameBadgeRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
  modeToggle: { display: 'flex', gap: '10px', marginBottom: '6px' },
  modeLink: {
    fontSize: '12px',
    cursor: 'pointer',
    border: 'none',
    background: 'none',
    padding: '0',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
  },
  selectFixed: {
    width: '100%',
    maxWidth: '210px',
    minWidth: '0',
    overflow: 'hidden',
  },
  targetCell: { minWidth: 0 },
  targetStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    width: '100%',
    maxWidth: '460px',
    minWidth: 0,
  },
  targetControl: {
    width: '100%',
    minWidth: '0',
    maxWidth: '460px',
  },
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' },
  summary: { fontSize: '13px', color: tokens.colorNeutralForeground3 },
  helperText: {
    minHeight: '18px',
    fontSize: '11px',
    color: tokens.colorNeutralForeground3,
    fontFamily: 'Consolas, monospace',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    lineHeight: '16px',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  helperTextWarning: {
    minHeight: '18px',
    fontSize: '11px',
    color: tokens.colorStatusWarningForeground1,
    fontFamily: 'Consolas, monospace',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    lineHeight: '16px',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  targetBadge: {
    display: 'inline-block',
    flex: '0 0 auto',
    padding: '1px 6px',
    borderRadius: '8px',
    fontSize: '10px',
    fontWeight: '600',
    marginRight: '4px',
    verticalAlign: 'middle',
  },
  overrideChip: {
    display: 'inline-block',
    marginTop: '4px',
    padding: '1px 7px',
    borderRadius: '8px',
    fontSize: '10px',
    fontWeight: '600',
    backgroundColor: tokens.colorStatusWarningBackground1,
    color: tokens.colorStatusWarningForeground1,
  },
})

// ─── Component ────────────────────────────────────────────────────────────────

export function Step2Mapping() {
  const styles = useStyles()
  const {
    fetchedData, mappingConfig, setMappingConfig, nextStep, prevStep,
    selectedSolution, skipColumnCreation,
    migrationMode, schemaSnapshot, setResolverPlan, setMigrationMode,
  } = useMigration()

  const prefix = selectedSolution?.publisherPrefix ?? 'cr9a1'

  const [fieldMappings, setFieldMappings] = useState<FieldMapping[]>([])
  const [multiLookupMappingsState, setMultiLookupMappingsState] = useState<MultiLookupMapping[]>([])
  // Cache of fetched attributes per lookup entity logical name
  const [mlEntityAttrs, setMlEntityAttrs] = useState<Record<string, DvEntityAttribute[]>>({})
  const [fieldFilter, setFieldFilter] = useState<FieldFilter>('all')
  const [dvAttributes, setDvAttributes] = useState<DvEntityAttribute[]>([])
  const [dvAttrError, setDvAttrError] = useState<string | null>(null)
  const [dvEntities, setDvEntities] = useState<DvEntityDefinition[]>([])
  const [selfLookupOptions, setSelfLookupOptions] = useState<Record<string, SelfLookupOption[]>>({})
  const [solutionEntityIds, setSolutionEntityIds] = useState<Set<string>>(new Set())
  const [globalOptionSets, setGlobalOptionSets] = useState<DvGlobalOptionSetDefinition[]>([])
  const [solutionOptionSetIds, setSolutionOptionSetIds] = useState<Set<string>>(new Set())
  const [loadWarning, setLoadWarning] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Pre-fetch attributes for already-configured multi-lookup target entities
  useEffect(() => {
    for (const ml of multiLookupMappingsState) {
      const target = ml.targetEntityLogicalName
      if (!target) continue
      if (schemaSnapshot?.entities[target] || mlEntityAttrs[target]) continue
      fetchEntityWithCustomAttributes(target)
        .then(data => setMlEntityAttrs(prev => ({
          ...prev,
          [target]: data.rawAttrs.map(a => ({
            logicalName: a.LogicalName,
            displayName: a.DisplayName?.UserLocalizedLabel?.Label ?? a.LogicalName,
            attributeType: a.AttributeType,
          })),
        })))
        .catch(() => {})
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiLookupMappingsState])

  // Initialise mappings from fetched data (or restore from context).
  // In dataOnly mode, re-init when schemaSnapshot becomes available.
  // mappingConfig intentionally excluded — loadJson handler sets it directly.
  useEffect(() => {
    if (!fetchedData) return
    if (mappingConfig) {
      setFieldMappings(mappingConfig.fieldMappings)
      setMultiLookupMappingsState(mappingConfig.multiLookups ?? [])
      return
    }
    if (migrationMode === 'dataOnly' && schemaSnapshot) {
      setFieldMappings(buildDataOnlyMappings(fetchedData, schemaSnapshot, prefix))
      setMultiLookupMappingsState(buildDataOnlyMultiLookupMappings(fetchedData, schemaSnapshot, prefix))
    } else if (migrationMode === 'schemaOnly') {
      setFieldMappings(buildSchemaOnlyMappings(fetchedData, prefix))
      setMultiLookupMappingsState(buildInitialMultiLookupMappings(fetchedData))
    } else if (migrationMode === 'full') {
      setFieldMappings(buildInitialMappings(fetchedData, prefix))
      setMultiLookupMappingsState(buildInitialMultiLookupMappings(fetchedData))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchedData, prefix, migrationMode, schemaSnapshot])

  // Load existing msdyn_project attributes for "map to existing field" dropdown
  useEffect(() => {
    fetchEntityAttributes('msdyn_project')
      .then(attrs => setDvAttributes(attrs.sort((a, b) => a.displayName.localeCompare(b.displayName))))
      .catch(e => setDvAttrError(String(e)))
  }, [])

  // Load entity definitions for Lookup target table picker
  useEffect(() => {
    fetchEntityDefinitions()
      .then(setDvEntities)
      .catch(() => { /* non-fatal */ })
  }, [])

  useEffect(() => {
    const entityNames = Array.from(new Set(fieldMappings
      .filter(m =>
        !m.skip &&
        m.targetColumnType === 'Lookup' &&
        !!m.lookupTable &&
        hasHierarchicalEntries(m.lookupTable) &&
        m.useExistingLookupEntity &&
        !!m.relatedEntity?.logicalName
      )
      .map(m => m.relatedEntity!.logicalName)
      .filter(entity => !selfLookupOptions[entity])
    ))

    for (const entityName of entityNames) {
      fetchEntityManyToOneRelationships(entityName)
        .then(rels => setSelfLookupOptions(prev => ({
          ...prev,
          [entityName]: toSelfLookupOptions(entityName, rels),
        })))
        .catch(() => setSelfLookupOptions(prev => ({ ...prev, [entityName]: [] })))
    }
  }, [fieldMappings, selfLookupOptions])

  useEffect(() => {
    setFieldMappings(prev => {
      let changed = false
      const next = prev.map(m => {
        if (
          m.skip ||
          m.targetColumnType !== 'Lookup' ||
          !m.lookupTable ||
          !hasHierarchicalEntries(m.lookupTable) ||
          !m.useExistingLookupEntity ||
          !m.relatedEntity?.logicalName ||
          m.lookupParent
        ) return m

        const preferred = preferredSelfLookupOption(selfLookupOptions[m.relatedEntity.logicalName] ?? [])
        if (!preferred) return m
        changed = true
        return {
          ...m,
          lookupParent: {
            lookupLogicalName: preferred.lookupLogicalName,
            navigationPropertyName: preferred.navigationPropertyName,
          },
        }
      })
      return changed ? next : prev
    })
  }, [selfLookupOptions])

  // Load entity IDs in the selected solution so the table picker can be filtered
  useEffect(() => {
    if (!selectedSolution?.solutionid) return
    fetchSolutionEntityIds(selectedSolution.solutionid)
      .then(setSolutionEntityIds)
      .catch(() => { /* non-fatal — fall back to unfiltered list */ })
  }, [selectedSolution?.solutionid])

  useEffect(() => {
    Promise.all([
      fetchGlobalOptionSetDefinitions(),
      selectedSolution?.solutionid
        ? fetchSolutionComponentIds(selectedSolution.solutionid, 9)
        : Promise.resolve(new Set<string>()),
    ])
      .then(([sets, ids]) => {
        setGlobalOptionSets(sets)
        setSolutionOptionSetIds(ids)
      })
      .catch(() => { /* non-fatal - schemaOnly can still create new choices */ })
  }, [selectedSolution?.solutionid])

  if (!fetchedData) {
    return (
      <div style={{ padding: '32px' }}>
        <MessageBar intent="warning">
          <MessageBarBody>No data loaded. Go back to Step 1 and connect first.</MessageBarBody>
        </MessageBar>
      </div>
    )
  }

  // ── Field mapping handlers ────────────────────────────────────────────────

  function setFieldType(idx: number, type: DataverseColumnType) {
    setFieldMappings(prev => prev.map((m, i) => i === idx
      ? { ...m, targetColumnType: type, lookupParent: type === 'Lookup' ? m.lookupParent : undefined }
      : m
    ))
  }

  function setFieldSkip(idx: number, skip: boolean) {
    const mapping = fieldMappings[idx]
    setFieldMappings(prev => prev.map((m, i) => i === idx ? { ...m, skip } : m))
    if (mapping?.customField.CustomFieldType === 'LookupMulti') {
      const poFieldName = mapping.customField.ODataFieldName || mapping.customField.CustomFieldName
      setMultiLookupMappingsState(prev => {
        if (skip) return prev.filter(ml => ml.poFieldName !== poFieldName)
        if (prev.some(ml => ml.poFieldName === poFieldName)) return prev
        return [...prev, defaultMultiLookupMapping(mapping)]
      })
    }
  }

  function setFieldRelatedEntity(idx: number, logicalName: string) {
    const entity = dvEntities.find(e => e.logicalName === logicalName)
    setFieldMappings(prev => prev.map((m, i) => i === idx
      ? { ...m, relatedEntity: entity ? { logicalName: entity.logicalName, logicalCollectionName: entity.logicalCollectionName } : undefined }
      : m
    ))
  }

  function setSchemaOnlyLookupSource(idx: number, value: string) {
    setFieldMappings(prev => prev.map((m, i) => {
      if (i !== idx) return m
      if (value === '__create') {
        return {
          ...m,
          useExistingLookupEntity: false,
          lookupParent: undefined,
          relatedEntity: m.lookupTable
            ? { logicalName: lookupEntityLogicalName(m.lookupTable, prefix), logicalCollectionName: '' }
            : undefined,
        }
      }
      const entity = dvEntities.find(e => e.logicalName === value)
      return {
        ...m,
        useExistingLookupEntity: true,
        lookupParent: undefined,
        relatedEntity: entity ? { logicalName: entity.logicalName, logicalCollectionName: entity.logicalCollectionName } : undefined,
      }
    }))
  }

  function setLookupParent(idx: number, lookupLogicalName: string) {
    setFieldMappings(prev => prev.map((m, i) => {
      if (i !== idx) return m
      if (!lookupLogicalName || !m.relatedEntity?.logicalName) return { ...m, lookupParent: undefined }
      const option = (selfLookupOptions[m.relatedEntity.logicalName] ?? [])
        .find(o => o.lookupLogicalName === lookupLogicalName)
      return {
        ...m,
        lookupParent: option
          ? {
              lookupLogicalName: option.lookupLogicalName,
              navigationPropertyName: option.navigationPropertyName,
            }
          : undefined,
      }
    }))
  }

  function setSchemaOnlyOptionSetSource(idx: number, value: string) {
    setFieldMappings(prev => prev.map((m, i) => i === idx
      ? { ...m, optionSetName: value === '__create' ? undefined : value }
      : m
    ))
  }

  function setFieldMigrateValue(idx: number, migrateValue: boolean) {
    setFieldMappings(prev => prev.map((m, i) => i === idx ? { ...m, migrateValue } : m))
  }

  function setFieldCreateName(idx: number, displayName: string) {
    setFieldMappings(prev => prev.map((m, i) => {
      if (i !== idx) return m
      return {
        ...m,
        targetDisplayName: displayName,
        targetLogicalName: toLogicalName(displayName || m.customField.CustomFieldName, prefix),
      }
    }))
  }

  function defaultMultiLookupMapping(mapping: FieldMapping): MultiLookupMapping {
    return {
      poFieldName: mapping.customField.ODataFieldName || mapping.customField.CustomFieldName,
      targetShape: 'MultiChoice',
      targetColumnLogicalName: mapping.useExistingField ? mapping.targetLogicalName : undefined,
    }
  }

  function setFieldsSkip(indexes: number[], skip: boolean) {
    const lookupMultiMappings = indexes
      .map(idx => fieldMappings[idx])
      .filter((m): m is FieldMapping => !!m && m.customField.CustomFieldType === 'LookupMulti')
    setFieldMappings(prev => prev.map((m, i) => indexes.includes(i) ? { ...m, skip } : m))
    if (lookupMultiMappings.length > 0) {
      const lookupMultiNames = new Set(lookupMultiMappings.map(m => m.customField.ODataFieldName || m.customField.CustomFieldName))
      setMultiLookupMappingsState(prev => {
        if (skip) return prev.filter(ml => !lookupMultiNames.has(ml.poFieldName))
        const next = [...prev]
        for (const mapping of lookupMultiMappings) {
          const defaultMapping = defaultMultiLookupMapping(mapping)
          if (!next.some(ml => ml.poFieldName === defaultMapping.poFieldName)) {
            next.push(defaultMapping)
          }
        }
        return next
      })
    }
  }

  function setFieldExistingMapping(idx: number, logicalName: string, attrType: string) {
    setFieldMappings(prev => prev.map((m, i) => {
      if (i !== idx) return m
      if (!logicalName) {
        return {
          ...m,
          targetLogicalName: toLogicalName(m.customField.CustomFieldName, prefix),
          targetColumnType: SUGGESTED_DV_TYPE[m.customField.CustomFieldType],
          useExistingField: false,
        }
      }
      return {
        ...m,
        targetLogicalName: logicalName,
        targetColumnType: DV_ATTR_TYPE_MAP[attrType] ?? m.targetColumnType,
        useExistingField: true,
        migrateValue: true,
      }
    }))
  }

  function setFieldExistingDataOnly(idx: number, logicalName: string, col: ColumnMeta | undefined) {
    setFieldMappings(prev => prev.map((m, i) => {
      if (i !== idx) return m
      if (!logicalName) {
        return { ...m, useExistingField: false, matchSource: undefined, migrateValue: false }
      }
      return {
        ...m,
        targetLogicalName: logicalName,
        targetColumnType: (col ? SCHEMA_TYPE_TO_DV_TYPE[col.type] : undefined) ?? m.targetColumnType,
        useExistingField: true,
        migrateValue: true,
        matchSource: 'manual' as const,
      }
    }))

    const mapping = fieldMappings[idx]
    if (mapping?.customField.CustomFieldType === 'LookupMulti') {
      const poFieldName = mapping.customField.ODataFieldName || mapping.customField.CustomFieldName
      setMultiLookupMappingsState(prev => {
        const existing = prev.find(ml => ml.poFieldName === poFieldName)
        const updated: MultiLookupMapping = {
          ...(existing ?? {}),
          poFieldName,
          targetShape: 'MultiChoice',
          targetColumnLogicalName: logicalName || undefined,
        }
        return [...prev.filter(ml => ml.poFieldName !== poFieldName), updated]
      })
    }
  }

  function setMultiLookupTargetShape(idx: number, poFieldName: string, newShape: MultiLookupTargetShape) {
    const mapping = fieldMappings[idx]
    if (!mapping) return
    const multiChoiceColumn = newShape === 'MultiChoice'
      ? findMultiChoiceColumn(mapping, schemaSnapshot, prefix)
      : null

    setMultiLookupMappingsState(prev => {
      const existing = prev.find(ml => ml.poFieldName === poFieldName)
      const updated: MultiLookupMapping = {
        ...(existing ?? {}),
        poFieldName,
        targetShape: newShape,
        ...(newShape === 'MultiChoice'
          ? { targetColumnLogicalName: multiChoiceColumn?.logicalName }
          : {}),
      }
      return [...prev.filter(ml => ml.poFieldName !== poFieldName), updated]
    })

    setFieldMappings(prev => prev.map((m, i) => {
      if (i !== idx) return m
      if (newShape === 'N:N') {
        return {
          ...m,
          targetColumnType: 'MultiSelectOptionSet',
          targetLogicalName: toLogicalName(m.customField.CustomFieldName, prefix),
          useExistingField: false,
          migrateValue: false,
          matchSource: undefined,
        }
      }
      if (!multiChoiceColumn) {
        return {
          ...m,
          targetColumnType: 'MultiSelectOptionSet',
          useExistingField: false,
          migrateValue: false,
          matchSource: undefined,
        }
      }
      return {
        ...m,
        targetLogicalName: multiChoiceColumn.logicalName,
        targetColumnType: SCHEMA_TYPE_TO_DV_TYPE[multiChoiceColumn.type] ?? 'MultiSelectOptionSet',
        useExistingField: true,
        migrateValue: true,
        matchSource: 'auto' as const,
      }
    }))
  }

  function setFieldUseExisting(idx: number, useExisting: boolean) {
    setFieldMappings(prev => prev.map((m, i) => {
      if (i !== idx) return m
      if (!useExisting) {
        return {
          ...m,
          targetLogicalName: toLogicalName(m.customField.CustomFieldName, prefix),
          targetColumnType: SUGGESTED_DV_TYPE[m.customField.CustomFieldType],
          useExistingField: false,
        }
      }
      return { ...m, useExistingField: true }
    }))
  }

  // ── Save / Load JSON ─────────────────────────────────────────────────────

  function handleSaveJson() {
    const multiLookups = activeMultiLookupMappings(fieldMappings, multiLookupMappingsState)
    const config: MappingConfiguration = {
      siteUrl: fetchedData?.pwaUrl ?? '',
      publisherPrefix: prefix,
      skipColumnCreation,
      migrationMode,
      fieldMappings,
      ownerMappings: [],
      multiLookups,
      savedAt: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'migration-mapping.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleLoadJson(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      try {
        const config = JSON.parse(ev.target?.result as string) as MappingConfiguration
        setFieldMappings(config.fieldMappings)
        setMultiLookupMappingsState(config.multiLookups ?? [])
        const loadedMode = config.migrationMode ?? 'full'
        setMigrationMode(loadedMode)
        if (loadedMode === 'dataOnly' && !schemaSnapshot) {
          setLoadWarning('Loaded a data-only mapping — go back to Step 1, select a solution and run the schema scan before proceeding.')
        } else {
          setLoadWarning(null)
        }
      } catch {
        alert('Invalid mapping file.')
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  function handleRedetectTypes() {
    if (!fetchedData) return
    if (migrationMode === 'dataOnly' && schemaSnapshot) {
      setFieldMappings(buildDataOnlyMappings(fetchedData, schemaSnapshot, prefix))
      setMultiLookupMappingsState(buildDataOnlyMultiLookupMappings(fetchedData, schemaSnapshot, prefix))
    } else if (migrationMode === 'schemaOnly') {
      setFieldMappings(buildSchemaOnlyMappings(fetchedData, prefix))
      setMultiLookupMappingsState(buildInitialMultiLookupMappings(fetchedData))
    } else {
      setFieldMappings(buildInitialMappings(fetchedData, prefix))
      setMultiLookupMappingsState(buildInitialMultiLookupMappings(fetchedData))
    }
  }

  function scrollToFirstUnmapped() {
    const first = unmappedDataOnlyRows[0]
    if (first) {
      document.getElementById(`mapping-row-${first.customField.CustomFieldId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }

  // ── Next step ─────────────────────────────────────────────────────────────

  function handleNext() {
    const multiLookups = activeMultiLookupMappings(fieldMappings, multiLookupMappingsState)
    const config: MappingConfiguration = {
      siteUrl: fetchedData?.pwaUrl ?? '',
      publisherPrefix: prefix,
      skipColumnCreation,
      migrationMode,
      fieldMappings,
      ownerMappings: [],
      multiLookups,
      savedAt: new Date().toISOString(),
    }
    setMappingConfig(config)
    if (migrationMode === 'dataOnly' && schemaSnapshot) {
      setResolverPlan(buildResolverPlanFromMappings(fieldMappings, schemaSnapshot, fetchedData?.lookupTables ?? []))
    }
    nextStep()
  }


  const activeFields = fieldMappings.filter(m => !m.skip)
  const migratingFields = fieldMappings.filter(m => !m.skip && m.migrateValue)
  const displayedFieldEntries = fieldMappings
    .map((mapping, idx) => ({ mapping, idx }))
    .filter(({ mapping }) => {
      switch (fieldFilter) {
        case 'active': return !mapping.skip
        case 'skipped': return mapping.skip
        case 'project': return mapping.customField.CustomFieldEntityType === 'Project'
        case 'task': return mapping.customField.CustomFieldEntityType === 'Task'
        case 'resource': return mapping.customField.CustomFieldEntityType === 'Resource'
        default: return true
      }
    })
  const displayedFieldIndexes = displayedFieldEntries.map(e => e.idx)
  const displayedFieldIndexSet = new Set(displayedFieldIndexes)
  const hiddenFieldIndexes = fieldMappings
    .map((_, idx) => idx)
    .filter(idx => !displayedFieldIndexSet.has(idx))
  const solutionEntities = dvEntities.filter(e =>
    solutionEntityIds.has((e.metadataId ?? '').toLowerCase().replace(/[{}]/g, ''))
  )
  const solutionChoices = globalOptionSets.filter(os =>
    solutionOptionSetIds.has(os.metadataId.toLowerCase().replace(/[{}]/g, ''))
  )
  const unmappedDataOnlyRows = migrationMode === 'dataOnly' && schemaSnapshot
    ? fieldMappings.filter(m => {
        if (m.skip) return false
        // N:N LookupMulti fields are configured in the bottom panel — not "unmapped"
        if (m.customField.CustomFieldType === 'LookupMulti') {
          const poFN = m.customField.ODataFieldName || m.customField.CustomFieldName
          const ml = multiLookupMappingsState.find(x => x.poFieldName === poFN)
          if (!ml || ml.targetShape === 'N:N') return false
          return !(m.useExistingField && m.targetLogicalName)
        }
        const dvEntityKey = PO_ENTITY_TO_DV[m.customField.CustomFieldEntityType]
        const dvEntity = dvEntityKey ? schemaSnapshot.entities[dvEntityKey] : undefined
        const compat = dvEntity ? getCompatibleColumns(dvEntity, m.customField.CustomFieldType) : []
        return compat.length > 0 && !(m.useExistingField && m.targetLogicalName)
      })
    : []

  // ── Derived display state ───────────────────────────────────────────────────

  // Fields where a create-with-0-entries will happen (likely a data fetch issue)
  const warningFields = fieldMappings.filter(m => {
    if (m.skip || m.useExistingField || m.useExistingLookupEntity) return false
    return m.lookupTable !== undefined && m.lookupTable.entries.length === 0
  })

  // Count how many active fields resolve to each target (choice / lookup entity)
  // so we can mark targets shared across multiple source fields
  const targetShareCount = new Map<string, number>()
  for (const m of fieldMappings) {
    if (m.skip || m.useExistingField || m.useExistingLookupEntity) continue
    const key =
      (m.targetColumnType === 'Lookup' && m.lookupTable)
        ? lookupEntityLogicalName(m.lookupTable, prefix)
        : ((m.targetColumnType === 'OptionSet' || m.targetColumnType === 'MultiSelectOptionSet') && m.lookupTable)
          ? (m.optionSetName ?? m.targetLogicalName)
          : null
    if (key) targetShareCount.set(key, (targetShareCount.get(key) ?? 0) + 1)
  }

  // Hide per-row entity badge when all displayed fields are the same entity type
  const uniqueDisplayedEntityTypes = new Set(
    displayedFieldEntries.map(e => e.mapping.customField.CustomFieldEntityType)
  )
  const showEntityBadgePerRow = uniqueDisplayedEntityTypes.size > 1
  // Entity type shown once as a header label when all rows are the same
  const singleEntityType = showEntityBadgePerRow ? null : [...uniqueDisplayedEntityTypes][0] ?? null

  return (
    <div className={styles.root}>
      <div>
        <div className={styles.title}>Step 2 — Field Mapping</div>
        <div className={styles.subtitle}>
          Review the auto-detected Dataverse column types for each Project Online custom field.
          Override where needed, then map project owners to Dataverse users.
        </div>
      </div>

      {/* ── Solution + skip banner ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '12px',
        padding: '10px 14px',
        background: tokens.colorNeutralBackground2,
        borderRadius: tokens.borderRadiusMedium,
        border: `1px solid ${tokens.colorNeutralStroke1}`,
        fontSize: '13px',
      }}>
        <span>
          Solution: <strong>{selectedSolution?.friendlyname ?? '—'}</strong>
          {' · '}
          Prefix:{' '}
          <code style={{ fontFamily: 'Consolas, monospace', background: tokens.colorBrandBackground2, color: tokens.colorBrandForeground1, padding: '1px 6px', borderRadius: '4px' }}>
            {prefix}_
          </code>
        </span>
        {migrationMode === 'dataOnly' && (
          <span style={{ fontSize: '12px', color: '#107c10', fontWeight: '600' }}>
            Data only — mapping to existing schema
          </span>
        )}
        {migrationMode === 'schemaOnly' && (
          <span style={{ fontSize: '12px', color: '#107c10', fontWeight: '600' }}>
            Schema only - create new schema, skip data import
          </span>
        )}
      </div>

      {/* ── Toolbar ── */}
      <div className={styles.toolbar}>
        <Button size="small" onClick={handleRedetectTypes}>
          {migrationMode === 'dataOnly' ? 'Re-scan existing columns' : 'Re-detect column types'}
        </Button>
        <Select size="small" value={fieldFilter} onChange={(_, d) => setFieldFilter(d.value as FieldFilter)}>
          <option value="all">All fields</option>
          <option value="active">Active only</option>
          <option value="skipped">Skipped only</option>
          <option value="project">Project fields</option>
          <option value="task">Task fields</option>
          <option value="resource">Resource fields</option>
        </Select>
        <Button size="small" disabled={hiddenFieldIndexes.length === 0} onClick={() => setFieldsSkip(hiddenFieldIndexes, true)}>
          Keep shown
        </Button>
        <Button size="small" onClick={() => setFieldsSkip(displayedFieldIndexes, true)}>
          Skip shown
        </Button>
        <Button size="small" onClick={() => setFieldsSkip(fieldMappings.map((_, idx) => idx), true)}>
          Skip all
        </Button>
        <Button size="small" onClick={() => setFieldsSkip(displayedFieldIndexes, false)}>
          Unskip shown
        </Button>
        <Button size="small" onClick={handleSaveJson}>Save mapping as JSON</Button>
        <Button size="small" onClick={() => fileInputRef.current?.click()}>Load mapping from JSON</Button>
        <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleLoadJson} />
        {migrationMode === 'schemaOnly' ? (
          <span className={styles.summary}>
            {activeFields.length} field{activeFields.length !== 1 ? 's' : ''} will be created, {fieldMappings.length - activeFields.length} skipped
            {warningFields.length > 0 && <>, <span style={{ color: tokens.colorStatusWarningForeground1, fontWeight: '600' }}>{warningFields.length} warning{warningFields.length !== 1 ? 's' : ''}</span></>}
            {fieldFilter !== 'all' ? ` · showing ${displayedFieldEntries.length} filtered` : ''}
          </span>
        ) : (
        <span className={styles.summary}>
          {activeFields.length} of {fieldMappings.length} fields active · {migratingFields.length} value(s) will migrate
          {warningFields.length > 0 && <> · <span style={{ color: tokens.colorStatusWarningForeground1, fontWeight: '600' }}>{warningFields.length} warning{warningFields.length !== 1 ? 's' : ''}</span></>}
          {fieldFilter !== 'all' ? ` · showing ${displayedFieldEntries.length} filtered` : ''}
        </span>
        )}
      </div>

      {/* ── Field mapping table ── */}
      <div>
        <div className={styles.sectionTitle}>
          Custom Field Mapping ({fieldMappings.length} fields)
          {singleEntityType && (
            <span
              className={styles.entityBadge}
              style={{ background: ENTITY_COLORS[singleEntityType] ?? '#888', marginLeft: '10px', verticalAlign: 'middle' }}
            >
              {singleEntityType}
            </span>
          )}
        </div>
        {migrationMode !== 'schemaOnly' && dvAttrError && (
          <MessageBar intent="warning" style={{ marginBottom: '8px' }}>
            <MessageBarBody>Could not load existing Dataverse fields: {dvAttrError}</MessageBarBody>
          </MessageBar>
        )}
        <div className={styles.tableWrap}>
        <table className={styles.table}>
          <colgroup>
            <col style={{ width: '48px' }} />
            <col style={{ width: '31%' }} />
            <col style={{ width: '92px' }} />
            <col style={{ width: '220px' }} />
            <col />
            {migrationMode === 'full' && <col style={{ width: '96px' }} />}
          </colgroup>
          <thead>
            <tr>
              <th className={styles.th}>Skip</th>
              <th className={styles.th}>Field Name</th>
              <th className={styles.th} style={{ whiteSpace: 'nowrap' }}>PO Type</th>
              <th className={styles.th} style={{ whiteSpace: 'nowrap' }}>Migrate as</th>
              <th className={styles.th}>Dataverse Target</th>
              {migrationMode === 'full' && (
                <th className={styles.th} style={{ textAlign: 'center' }}>Migrate value</th>
              )}
            </tr>
          </thead>
          <tbody>
            {displayedFieldEntries.length === 0 && (
              <tr>
                <td className={styles.td} colSpan={migrationMode === 'full' ? 6 : 5} style={{ textAlign: 'center', color: tokens.colorNeutralForeground3 }}>
                  {fieldMappings.length === 0 ? 'No custom fields found in Project Online.' : 'No fields match the current filter.'}
                </td>
              </tr>
            )}
            {displayedFieldEntries.map(({ mapping: m, idx }) => {
              const isLookupMulti = m.customField.CustomFieldType === 'LookupMulti'
              const poFieldKey = m.customField.ODataFieldName || m.customField.CustomFieldName
              const mlMapping = isLookupMulti ? multiLookupMappingsState.find(x => x.poFieldName === poFieldKey) : undefined
              const targetShape: MultiLookupTargetShape = mlMapping?.targetShape ?? (isLookupMulti ? 'MultiChoice' : 'MultiChoice')
              const isNN = isLookupMulti && targetShape === 'N:N'

              // Per-row display state
              const targetSummary = (!m.skip && !m.useExistingField && !isNN)
                ? formatTargetSummary(m, prefix)
                : { text: '', isWarning: false }
              const rowTargetKey =
                (!m.skip && !m.useExistingField && !m.useExistingLookupEntity)
                  ? ((m.targetColumnType === 'Lookup' && m.lookupTable)
                    ? lookupEntityLogicalName(m.lookupTable, prefix)
                    : ((m.targetColumnType === 'OptionSet' || m.targetColumnType === 'MultiSelectOptionSet') && m.lookupTable)
                      ? (m.optionSetName ?? m.targetLogicalName)
                      : null)
                  : null
              const isSharedTarget = rowTargetKey !== null && (targetShareCount.get(rowTargetKey) ?? 0) > 1
              const isExistingTarget = m.useExistingField || !!m.useExistingLookupEntity
              const isOverridden = !m.skip && !isLookupMulti
                && m.targetColumnType !== SUGGESTED_DV_TYPE[m.customField.CustomFieldType]
              const isHierarchicalLookup = !!m.lookupTable && hasHierarchicalEntries(m.lookupTable)
              const rowSelfLookupOptions = m.relatedEntity?.logicalName
                ? (selfLookupOptions[m.relatedEntity.logicalName] ?? [])
                : []

              return (
              <tr
                key={m.customField.CustomFieldId}
                id={`mapping-row-${m.customField.CustomFieldId}`}
                className={m.skip ? styles.trSkipped : undefined}
                style={isNN && !m.skip ? { background: tokens.colorNeutralBackground2 } : undefined}
              >

                {/* Col 1: Skip */}
                <td className={styles.td} style={{ paddingTop: '5px' }}>
                  <Checkbox checked={m.skip} onChange={(_, d) => setFieldSkip(idx, !!d.checked)} />
                </td>

                {/* Col 2: Field Name + entity badge + logical name */}
                <td className={styles.td}>
                  <div className={styles.fieldNameCell}>
                    <div className={styles.fieldNameBadgeRow}>
                      {migrationMode === 'dataOnly' && !m.skip && (() => {
                        if (isLookupMulti) {
                          // N:N: green if configured, yellow if not
                          if (isNN) {
                            return mlMapping?.targetEntityLogicalName && mlMapping?.matchFieldLogicalName
                              ? <span title="N:N configured">🟢</span>
                              : <span title="N:N — configure below">🟡</span>
                          }
                          // MultiChoice: check if column found
                          return (mlMapping?.targetColumnLogicalName || (m.useExistingField && m.targetLogicalName))
                            ? <span title="Auto-matched MultiChoice column">🟢</span>
                            : <span title="No MultiChoice column found">🔴</span>
                        }
                        const dvEntityKey = PO_ENTITY_TO_DV[m.customField.CustomFieldEntityType]
                        const dvEntity = dvEntityKey ? schemaSnapshot?.entities[dvEntityKey] : undefined
                        const compatible = dvEntity ? getCompatibleColumns(dvEntity, m.customField.CustomFieldType) : []
                        if (compatible.length === 0) return <span title="No compatible column in schema">🔴</span>
                        if (m.useExistingField && m.targetLogicalName) return <span title={m.matchSource === 'auto' ? 'Auto-matched' : 'Mapped'}>🟢</span>
                        return <span title="Manual selection required">🟡</span>
                      })()}
                      <strong style={{ fontSize: '13px' }}>{m.customField.CustomFieldName}</strong>
                      {showEntityBadgePerRow && (
                        <span
                          className={styles.entityBadge}
                          style={{ background: ENTITY_COLORS[m.customField.CustomFieldEntityType] ?? '#888' }}
                        >
                          {m.customField.CustomFieldEntityType}
                        </span>
                      )}
                    </div>
                    <span className={styles.logicalName}>{m.targetLogicalName}</span>
                    {isNN && !m.skip && (
                      <span style={{ fontSize: '11px', color: tokens.colorNeutralForeground3, fontStyle: 'italic' }}>
                        Configured below as N:N
                      </span>
                    )}
                  </div>
                </td>

                {/* Col 3: PO Type */}
                <td className={styles.td} style={{ whiteSpace: 'nowrap', color: tokens.colorNeutralForeground2, paddingTop: '10px' }}>
                  {m.customField.CustomFieldType}
                </td>

                {/* Col 4: Migrate as */}
                <td className={styles.td}>
                  {m.skip
                    ? <span style={{ color: tokens.colorNeutralForeground4, fontSize: '12px' }}>—</span>
                    : isLookupMulti
                      ? <Select
                          size="small"
                          className={styles.selectFixed}
                          value={targetShape}
                          onChange={(_, d) => {
                            const newShape = d.value as MultiLookupTargetShape
                            setMultiLookupTargetShape(idx, poFieldKey, newShape)
                          }}
                        >
                          <option value="MultiChoice">MultiChoice</option>
                          <option value="N:N">N:N relationship</option>
                        </Select>
                      : migrationMode === 'schemaOnly'
                        ? <>
                            <Select
                              size="small"
                              className={styles.selectFixed}
                              value={m.targetColumnType}
                              title={DV_TYPE_LABELS[m.targetColumnType]}
                              onChange={(_, d) => setFieldType(idx, d.value as DataverseColumnType)}
                            >
                              {(DV_TYPE_ALTERNATIVES[m.customField.CustomFieldType] ?? [m.targetColumnType]).map(t => (
                                <option key={t} value={t} title={DV_TYPE_LABELS[t]}>{DV_TYPE_LABELS[t]}</option>
                              ))}
                            </Select>
                            {isOverridden && (
                              <div className={styles.overrideChip}>
                                Changed from {DV_TYPE_LABELS[SUGGESTED_DV_TYPE[m.customField.CustomFieldType]]}
                              </div>
                            )}
                          </>
                        : <span style={{ color: tokens.colorNeutralForeground4, fontSize: '12px' }}>—</span>
                  }
                </td>

                {/* Col 5: Dataverse Target */}
                <td className={`${styles.td} ${styles.targetCell}`}>
                  {m.skip
                    ? <span style={{ color: tokens.colorNeutralForeground4, fontSize: '12px' }}>—</span>
                    : isNN
                      ? <span style={{ fontSize: '12px', color: tokens.colorNeutralForeground3, fontStyle: 'italic' }}>↓ see N:N panel below</span>
                    : migrationMode === 'schemaOnly'
                      ? <div className={styles.targetStack}>
                          <Input
                            size="small"
                            className={styles.targetControl}
                            value={m.targetDisplayName ?? m.customField.CustomFieldName}
                            onChange={e => setFieldCreateName(idx, e.target.value)}
                            placeholder="Display name"
                          />
                          {m.targetColumnType === 'Lookup' && m.lookupTable && (
                            <Select
                              size="small"
                              className={styles.targetControl}
                              value={m.useExistingLookupEntity ? (m.relatedEntity?.logicalName ?? '') : '__create'}
                              title={m.useExistingLookupEntity
                                ? (m.relatedEntity?.logicalName ?? '')
                                : lookupEntityLogicalName(m.lookupTable, prefix)}
                              onChange={(_, d) => setSchemaOnlyLookupSource(idx, d.value)}
                            >
                              <option value="__create" title={lookupEntityLogicalName(m.lookupTable, prefix)}>
                                Create lookup table: {lookupEntityLogicalName(m.lookupTable, prefix)}
                              </option>
                              {solutionEntities.map(e => (
                                <option key={e.logicalName} value={e.logicalName} title={`${e.displayName} (${e.logicalName})`}>
                                  Use existing: {e.displayName} ({e.logicalName})
                                </option>
                              ))}
                            </Select>
                          )}
                          {m.targetColumnType === 'Lookup' && m.lookupTable && m.useExistingLookupEntity && isHierarchicalLookup && (
                            <Select
                              size="small"
                              className={styles.targetControl}
                              value={m.lookupParent?.lookupLogicalName ?? ''}
                              title="Self-referencing parent lookup used for hierarchical Project Online lookup values"
                              onChange={(_, d) => setLookupParent(idx, d.value)}
                            >
                              <option value="">
                                {rowSelfLookupOptions.length === 0 ? 'Parent: no self lookup found (flat)' : 'Parent: seed flat values'}
                              </option>
                              {rowSelfLookupOptions.map(option => (
                                <option key={option.lookupLogicalName} value={option.lookupLogicalName} title={option.navigationPropertyName}>
                                  Parent: {option.label}
                                </option>
                              ))}
                            </Select>
                          )}
                          {(m.targetColumnType === 'OptionSet' || m.targetColumnType === 'MultiSelectOptionSet') && m.lookupTable && (
                            <Select
                              size="small"
                              className={styles.targetControl}
                              value={m.optionSetName ?? '__create'}
                              title={m.optionSetName ?? m.targetLogicalName}
                              onChange={(_, d) => setSchemaOnlyOptionSetSource(idx, d.value)}
                            >
                              <option value="__create" title={m.targetLogicalName}>
                                Create choice: {m.targetLogicalName}
                              </option>
                              {solutionChoices.map(os => (
                                <option key={os.name} value={os.name} title={`${os.displayName} (${os.name})`}>
                                  Use existing: {os.displayName} ({os.name})
                                </option>
                              ))}
                            </Select>
                          )}
                          {targetSummary.text && (
                            <div
                              className={targetSummary.isWarning ? styles.helperTextWarning : styles.helperText}
                              title={
                                m.targetColumnType === 'Lookup' && m.lookupTable && m.targetLogicalName !== lookupEntityLogicalName(m.lookupTable, prefix)
                                  ? `Column: ${m.targetLogicalName} — lookup entity named differently from source field`
                                  : undefined
                              }
                            >
                              {targetSummary.isWarning && '⚠ '}
                              {isExistingTarget
                                ? <span className={styles.targetBadge} style={{ background: '#107c10', color: '#fff' }}>Exists</span>
                                : isSharedTarget
                                  ? <span className={styles.targetBadge} style={{ background: '#7719aa', color: '#fff' }}>Shared</span>
                                  : <span className={styles.targetBadge} style={{ background: '#0078d4', color: '#fff' }}>New</span>
                              }
                              {targetSummary.text}
                            </div>
                          )}
                        </div>
                    : migrationMode === 'dataOnly'
                      ? (() => {
                          const dvEntityKey = PO_ENTITY_TO_DV[m.customField.CustomFieldEntityType]
                          const dvEntity = dvEntityKey ? schemaSnapshot?.entities[dvEntityKey] : undefined
                          const compatible = dvEntity ? getCompatibleColumns(dvEntity, m.customField.CustomFieldType) : []
                          if (compatible.length === 0) {
                            const hint = isLookupMulti
                              ? 'No MultiSelectPicklist column found. Run schemaOnly first, or switch Migrate as to N:N.'
                              : `No compatible ${m.customField.CustomFieldType} column in ${dvEntityKey ?? 'entity'}. Create it manually in Dataverse or switch to Full mode in Step 1.`
                            return <span style={{ fontSize: '12px', color: '#a4262c' }}>{hint}</span>
                          }
                          return (
                            <Select
                              size="small"
                              className={styles.targetControl}
                              value={m.useExistingField ? m.targetLogicalName : ''}
                              onChange={(_, d) => {
                                const col = compatible.find(c => c.logicalName === d.value)
                                setFieldExistingDataOnly(idx, d.value, col)
                              }}
                            >
                              <option value="">— select existing column —</option>
                              {compatible.map(col => (
                                <option key={col.logicalName} value={col.logicalName} title={`${col.displayName} (${col.logicalName})`}>
                                  {col.displayName} ({col.logicalName})
                                </option>
                              ))}
                            </Select>
                          )
                        })()
                      : <div className={styles.targetStack}>
                          <div className={styles.modeToggle}>
                            <button
                              className={styles.modeLink}
                              disabled={!m.useExistingField}
                              style={{
                                color: !m.useExistingField ? tokens.colorBrandForeground1 : tokens.colorNeutralForeground3,
                                fontWeight: !m.useExistingField ? '600' : '400',
                              }}
                              onClick={() => setFieldUseExisting(idx, false)}
                            >
                              New column
                            </button>
                            <button
                              className={styles.modeLink}
                              disabled={m.useExistingField}
                              style={{
                                color: m.useExistingField ? tokens.colorBrandForeground1 : tokens.colorNeutralForeground3,
                                fontWeight: m.useExistingField ? '600' : '400',
                              }}
                              onClick={() => setFieldUseExisting(idx, true)}
                            >
                              Use existing
                            </button>
                          </div>
                          {!m.useExistingField
                            ? <>
                                <Input
                                  size="small"
                                  className={styles.targetControl}
                                  value={m.targetDisplayName ?? m.customField.CustomFieldName}
                                  onChange={e => setFieldCreateName(idx, e.target.value)}
                                  placeholder="Display name"
                                />
                                <Select
                                  size="small"
                                  className={styles.targetControl}
                                  value={m.targetColumnType}
                                  title={DV_TYPE_LABELS[m.targetColumnType]}
                                  onChange={(_, d) => setFieldType(idx, d.value as DataverseColumnType)}
                                >
                                  {(DV_TYPE_ALTERNATIVES[m.customField.CustomFieldType] ?? [m.targetColumnType]).map(t => (
                                    <option key={t} value={t} title={DV_TYPE_LABELS[t]}>{DV_TYPE_LABELS[t]}</option>
                                  ))}
                                </Select>
                                {isOverridden && (
                                  <div className={styles.overrideChip}>
                                    Changed from {DV_TYPE_LABELS[SUGGESTED_DV_TYPE[m.customField.CustomFieldType]]}
                                  </div>
                                )}
                                {m.targetColumnType === 'Lookup' && (
                                  <Select
                                    size="small"
                                    className={styles.targetControl}
                                    value={m.relatedEntity?.logicalName ?? ''}
                                    title={dvEntities.find(e => e.logicalName === m.relatedEntity?.logicalName)?.displayName ?? ''}
                                    onChange={(_, d) => setFieldRelatedEntity(idx, d.value)}
                                  >
                                    <option value="">— pick related table —</option>
                                    {dvEntities
                                      .filter(e => !solutionEntityIds.size || solutionEntityIds.has((e.metadataId ?? '').toLowerCase().replace(/[{}]/g, '')))
                                      .map(e => (
                                        <option key={e.logicalName} value={e.logicalName} title={`${e.displayName} (${e.logicalName})`}>
                                          {e.displayName} ({e.logicalName})
                                        </option>
                                      ))}
                                  </Select>
                                )}
                                {targetSummary.text && (
                                  <div
                                    className={targetSummary.isWarning ? styles.helperTextWarning : styles.helperText}
                                    title={
                                      m.targetColumnType === 'Lookup' && m.lookupTable && m.targetLogicalName !== lookupEntityLogicalName(m.lookupTable, prefix)
                                        ? `Column: ${m.targetLogicalName} — lookup entity named differently from source field`
                                        : undefined
                                    }
                                  >
                                    {targetSummary.isWarning && '⚠ '}
                                    {isSharedTarget
                                      ? <span className={styles.targetBadge} style={{ background: '#7719aa', color: '#fff' }}>Shared</span>
                                      : <span className={styles.targetBadge} style={{ background: '#0078d4', color: '#fff' }}>New</span>
                                    }
                                    {targetSummary.text}
                                  </div>
                                )}
                              </>
                            : <Select
                                size="small"
                                className={styles.targetControl}
                                value={m.useExistingField ? m.targetLogicalName : ''}
                                title={dvAttributes.find(a => a.logicalName === m.targetLogicalName)?.displayName ?? ''}
                                onChange={(_, d) => {
                                  const attr = dvAttributes.find(a => a.logicalName === d.value)
                                  setFieldExistingMapping(idx, d.value, attr?.attributeType ?? '')
                                }}
                              >
                                <option value="">— select existing field —</option>
                                {dvAttributes
                                  .filter(a => PO_COMPATIBLE_ATTR_TYPES[m.customField.CustomFieldType]?.includes(a.attributeType))
                                  .map(a => (
                                    <option key={a.logicalName} value={a.logicalName} title={`${a.displayName} (${a.logicalName})`}>
                                      {a.displayName} ({a.logicalName})
                                    </option>
                                  ))
                                }
                              </Select>
                          }
                        </div>
                  }
                </td>

                {/* Col 6: Migrate value */}
                {migrationMode === 'full' && (
                  <td className={styles.td} style={{ textAlign: 'center', paddingTop: '5px' }}>
                    <Checkbox
                      checked={m.migrateValue}
                      disabled={m.skip || m.customField.CustomFieldEntityType === 'Task'}
                      onChange={(_, d) => setFieldMigrateValue(idx, !!d.checked)}
                    />
                  </td>
                )}

              </tr>
            )})}
          </tbody>
        </table>
        </div>
      </div>

      {/* ── Multi-value Lookup Fields (LookupMulti) — N:N panel ── */}
      {(() => {
        const allLmFields = fieldMappings.filter(m => !m.skip && m.customField.CustomFieldType === 'LookupMulti' && m.customField.CustomFieldEntityType === 'Project')
        const nnFields = allLmFields.filter(m => {
          const poFN = m.customField.ODataFieldName || m.customField.CustomFieldName
          const ml = multiLookupMappingsState.find(x => x.poFieldName === poFN)
          return ml?.targetShape === 'N:N'
        })
        if (nnFields.length === 0 && allLmFields.length === 0) return null
        const projectEntity = schemaSnapshot?.entities['msdyn_project']
        return (
          <div>
            <div className={styles.sectionTitle}>Multi-value lookup fields ({nnFields.length})</div>
            {(migrationMode === 'full' || migrationMode === 'schemaOnly') && nnFields.length > 0 && (
              <MessageBar intent="info">
                <MessageBarBody>
                  These fields use N:N relationships. Lookup entities and N:N relationships will be created automatically in Step 3.
                </MessageBarBody>
              </MessageBar>
            )}
            {nnFields.length === 0 && allLmFields.length > 0 && (
              <div style={{
                padding: '16px',
                border: `2px dashed ${tokens.colorNeutralStroke1}`,
                borderRadius: tokens.borderRadiusMedium,
                textAlign: 'center',
                fontSize: '12px',
                color: tokens.colorNeutralForeground3,
              }}>
                No fields set to N:N. Change Migrate as to N:N relationship in the table above to configure here.
              </div>
            )}
            {migrationMode === 'dataOnly' && !schemaSnapshot && (
              <MessageBar intent="warning">
                <MessageBarBody>Run a schema scan in Step 1 to map multi-value lookup fields.</MessageBarBody>
              </MessageBar>
            )}
            {migrationMode === 'dataOnly' && schemaSnapshot && nnFields.map(m => {
              const nnRelsFetched = projectEntity?.nnRelationships !== undefined
              const nnRels = projectEntity?.nnRelationships ?? []
              const currentMapping = multiLookupMappingsState.find(ml => ml.poFieldName === (m.customField.ODataFieldName || m.customField.CustomFieldName))
              const selectedTargetEntity = currentMapping?.targetEntityLogicalName ?? ''
              const selectedSchemaName = currentMapping?.relationshipSchemaName ?? ''
              const selectedMatchField = currentMapping?.matchFieldLogicalName ?? ''
              const poFieldName = m.customField.ODataFieldName || m.customField.CustomFieldName
              // Attributes from snapshot OR from on-demand fetch (custom lookup entity not in default scan targets)
              const fetchedAttrs = selectedTargetEntity ? (mlEntityAttrs[selectedTargetEntity] ?? null) : null
              const snapshotAttrs = selectedTargetEntity ? schemaSnapshot.entities[selectedTargetEntity]?.attributes : undefined
              const matchFieldCandidates: Array<{ logicalName: string; displayName: string }> = snapshotAttrs
                ? snapshotAttrs.filter(a => a.type === 'String' || a.type === 'Memo')
                : fetchedAttrs
                  ? fetchedAttrs.filter(a => a.attributeType === 'String' || a.attributeType === 'Memo' || a.attributeType === 'Virtual')
                  : []

              function setMultiLookupTarget(schemaName: string) {
                const nn = nnRels.find(r => r.schemaName === schemaName)
                if (!nn) return
                // Dataverse naming: Entity1NavigationPropertyName is the nav prop ON entity2 pointing to entity1.
                // Entity2NavigationPropertyName is the nav prop ON entity1 pointing to entity2.
                // So when entity1 = msdyn_project, the nav prop accessible FROM msdyn_project is entity2NavigationPropertyName.
                const navProp = nn.entity1LogicalName === 'msdyn_project'
                  ? nn.entity2NavigationPropertyName
                  : nn.entity1NavigationPropertyName
                setMultiLookupMappingsState(prev => {
                  const existing = prev.find(ml => ml.poFieldName === poFieldName)
                  const updated: MultiLookupMapping = {
                    ...(existing ?? {}),
                    poFieldName,
                    targetShape: 'N:N',
                    targetEntityLogicalName: nn.targetEntityLogicalName,
                    targetEntitySetName: nn.targetEntitySetName,
                    matchFieldLogicalName: existing?.matchFieldLogicalName ?? '',
                    relationshipSchemaName: nn.schemaName,
                    navigationPropertyName: navProp,
                    relationshipType: 'pure-nn',
                  }
                  return [...prev.filter(ml => ml.poFieldName !== poFieldName), updated]
                })
                // Fetch attributes for this entity if not already cached or in snapshot
                if (!schemaSnapshot?.entities[nn.targetEntityLogicalName] && !mlEntityAttrs[nn.targetEntityLogicalName]) {
                  fetchEntityWithCustomAttributes(nn.targetEntityLogicalName)
                    .then(data => setMlEntityAttrs(prev => ({
                      ...prev,
                      [nn.targetEntityLogicalName]: data.rawAttrs.map(a => ({
                        logicalName: a.LogicalName,
                        displayName: a.DisplayName?.UserLocalizedLabel?.Label ?? a.LogicalName,
                        attributeType: a.AttributeType,
                      })),
                    })))
                    .catch(() => {})
                }
              }

              function setMultiLookupMatchField(matchField: string) {
                setMultiLookupMappingsState(prev => prev.map(ml =>
                  ml.poFieldName === poFieldName ? { ...ml, matchFieldLogicalName: matchField } : ml
                ))
              }

              const isConfigured = !!currentMapping?.targetEntityLogicalName && !!currentMapping?.matchFieldLogicalName
              const statusColor = !nnRelsFetched ? '#a78a00' : nnRels.length === 0 ? '#a4262c' : isConfigured ? '#107c10' : '#a78a00'
              const statusText = !nnRelsFetched
                ? '⚠ Re-scan schema to load N:N relationships'
                : nnRels.length === 0
                  ? '✗ No N:N relationships found on msdyn_project'
                  : isConfigured
                    ? `✓ ${currentMapping!.targetEntityLogicalName} via ${currentMapping!.matchFieldLogicalName}`
                    : '⚠ Select target entity and match field'

              return (
                <div key={m.customField.CustomFieldId} style={{
                  padding: '12px 14px',
                  marginTop: '8px',
                  background: tokens.colorNeutralBackground2,
                  border: `1px solid ${tokens.colorNeutralStroke1}`,
                  borderRadius: tokens.borderRadiusMedium,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ fontSize: '13px' }}>{m.customField.CustomFieldName}</strong>
                    <span style={{ fontSize: '12px', color: statusColor }}>{statusText}</span>
                  </div>
                  {!nnRelsFetched ? (
                    <span style={{ fontSize: '12px', color: '#a78a00' }}>
                      Schema snapshot is outdated. Go back to Step 1 and re-run the schema scan to load N:N relationships.
                    </span>
                  ) : nnRels.length === 0 ? (
                    <span style={{ fontSize: '12px', color: '#a4262c' }}>
                      No N:N relationships on msdyn_project in the scanned solution. Run a schemaOnly migration first to create them.
                    </span>
                  ) : (
                    <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <span style={{ fontSize: '11px', color: tokens.colorNeutralForeground3 }}>Target entity (N:N)</span>
                        <Select
                          size="small"
                          className={styles.selectFixed}
                          value={selectedSchemaName}
                          onChange={(_, d) => setMultiLookupTarget(d.value)}
                        >
                          <option value="">— select entity —</option>
                          {nnRels.map(r => (
                            <option key={r.schemaName} value={r.schemaName}>
                              {r.targetEntityLogicalName} ({r.schemaName})
                            </option>
                          ))}
                        </Select>
                      </div>
                      {selectedTargetEntity && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <span style={{ fontSize: '11px', color: tokens.colorNeutralForeground3 }}>Match PO labels against</span>
                          <Select
                            size="small"
                            className={styles.selectFixed}
                            value={selectedMatchField}
                            onChange={(_, d) => setMultiLookupMatchField(d.value)}
                          >
                            <option value="">— select field —</option>
                            {matchFieldCandidates.map(a => (
                              <option key={a.logicalName} value={a.logicalName}>
                                {a.displayName} ({a.logicalName})
                              </option>
                            ))}
                          </Select>
                        </div>
                      )}
                    </div>
                  )}
                  {m.lookupTable && (
                    <span style={{ fontSize: '11px', color: tokens.colorNeutralForeground3 }}>
                      {m.lookupTable.LookupTableName} · {m.lookupTable.entries.length} entries
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )
      })()}

      {/* ── dataOnly no-snapshot warning ── */}
      {migrationMode === 'dataOnly' && !schemaSnapshot && (
        <MessageBar intent="warning">
          <MessageBarBody>
            No schema loaded. Go back to Step 1, select a solution and run the schema scan.
          </MessageBarBody>
        </MessageBar>
      )}

      {/* ── loadWarning (after JSON load) ── */}
      {loadWarning && (
        <MessageBar intent="warning">
          <MessageBarBody>{loadWarning}</MessageBarBody>
        </MessageBar>
      )}

      {/* ── unmapped fields warning ── */}
      {migrationMode === 'dataOnly' && unmappedDataOnlyRows.length > 0 && (
        <MessageBar intent="warning">
          <MessageBarBody>
            {unmappedDataOnlyRows.length} field{unmappedDataOnlyRows.length !== 1 ? 's have' : ' has'} no column selected and will be skipped during migration.
            {' '}Check the Skip box to confirm, or{' '}
            <button
              onClick={scrollToFirstUnmapped}
              style={{ background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: '2px', padding: 0, fontSize: 'inherit', color: 'inherit' }}
            >
              scroll to first unmapped field
            </button>.
          </MessageBarBody>
        </MessageBar>
      )}

      {/* ── Footer ── */}
      <div className={styles.footer}>
        <Button onClick={prevStep}>← Back</Button>
        <Button appearance="primary" onClick={handleNext} disabled={activeFields.length === 0}>
          {migrationMode === 'dataOnly'
            ? 'Next: Validate Schema →'
            : migrationMode === 'schemaOnly'
              ? 'Next: Create Schema →'
              : 'Next: Create Columns →'}
        </Button>
      </div>
    </div>
  )
}
