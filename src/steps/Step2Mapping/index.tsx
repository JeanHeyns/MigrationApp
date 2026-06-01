import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Checkbox,
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
  fetchEntityWithCustomAttributes,
  fetchGlobalOptionSetDefinitions,
  fetchSolutionComponentIds,
  fetchSolutionEntityIds,
  type DvEntityAttribute,
  type DvEntityDefinition,
  type DvGlobalOptionSetDefinition,
} from '../../services/dataverseService'
import { toLogicalName } from '../../services/projectOnline/customFields'
import { lookupEntityLogicalName } from '../../services/plannerPremium/lookupEntityManager'
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
  Number:      ['Integer', 'Decimal', 'Money'],
  Cost:        ['Money', 'Decimal'],
  Duration:    ['Integer', 'Decimal'],
  Date:        ['DateTime'],
  Flag:        ['Boolean'],
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

// ─── dataOnly helpers ─────────────────────────────────────────────────────────

function getCompatibleColumns(dvEntity: EntitySchema, poType: string): ColumnMeta[] {
  const compatible = PO_TO_SCHEMA_TYPES[poType] ?? []
  return dvEntity.attributes.filter(a => compatible.includes(a.type))
}

function autoMatchColumn(cf: PoCustomField, compatible: ColumnMeta[], prefix: string): ColumnMeta | null {
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
      sourceOptions:    isChoice ? sourceOptionsForMapping(m, lookupTableMap) : undefined,
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

      // Check for MultiChoice column (MultiSelectPicklist with expected name)
      const mcColumn = projectEntity?.attributes.find(
        a => a.logicalName === expectedLogicalName && a.type === 'MultiSelectPicklist',
      )

      // Check for N:N relationship targeting the expected lookup entity
      let nnRel: NNRelationshipMeta | undefined
      if (cf.CustomFieldLookupTableUID && data.lookupTables) {
        const lt = data.lookupTables.find(t => t.LookupTableUID === cf.CustomFieldLookupTableUID)
        if (lt) {
          const expectedEntity = lookupEntityLogicalName(lt, prefix)
          nnRel = projectEntity?.nnRelationships?.find(r => r.targetEntityLogicalName === expectedEntity)
        }
      }

      // N:N takes priority (spec A.10.2)
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
      if (mcColumn) {
        return {
          poFieldName,
          targetShape: 'MultiChoice' as MultiLookupTargetShape,
          targetColumnLogicalName: mcColumn.logicalName,
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
  const activeLookupMultiFields = new Set(
    fieldMappings
      .filter(m => !m.skip && m.customField.CustomFieldType === 'LookupMulti')
      .map(m => m.customField.ODataFieldName || m.customField.CustomFieldName),
  )
  return multiLookupMappings.filter(ml => activeLookupMultiFields.has(ml.poFieldName))
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
    const targetColumnType =
      cf.CustomFieldType === 'Lookup' && lookupTable
        ? 'Lookup'
        : SUGGESTED_DV_TYPE[cf.CustomFieldType]
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

// ─── Styles ───────────────────────────────────────────────────────────────────

const useStyles = makeStyles({
  root: {
    padding: '32px',
    maxWidth: '900px',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '28px',
  },
  title: { fontSize: '20px', fontWeight: '600', color: tokens.colorNeutralForeground1 },
  subtitle: { fontSize: '13px', color: tokens.colorNeutralForeground3, marginTop: '4px' },
  sectionTitle: { fontSize: '15px', fontWeight: '600', color: tokens.colorNeutralForeground1, marginBottom: '12px' },
  toolbar: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
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
    verticalAlign: 'middle',
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
    width: '190px',
    maxWidth: '190px',
    overflow: 'hidden',
  },
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' },
  summary: { fontSize: '13px', color: tokens.colorNeutralForeground3 },
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
  const [dvAttributes, setDvAttributes] = useState<DvEntityAttribute[]>([])
  const [dvAttrError, setDvAttrError] = useState<string | null>(null)
  const [dvEntities, setDvEntities] = useState<DvEntityDefinition[]>([])
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
    setFieldMappings(prev => prev.map((m, i) => i === idx ? { ...m, targetColumnType: type } : m))
  }

  function setFieldSkip(idx: number, skip: boolean) {
    const mapping = fieldMappings[idx]
    setFieldMappings(prev => prev.map((m, i) => i === idx ? { ...m, skip } : m))
    if (skip && mapping?.customField.CustomFieldType === 'LookupMulti') {
      const poFieldName = mapping.customField.ODataFieldName || mapping.customField.CustomFieldName
      setMultiLookupMappingsState(prev => prev.filter(ml => ml.poFieldName !== poFieldName))
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
          relatedEntity: m.lookupTable
            ? { logicalName: lookupEntityLogicalName(m.lookupTable, prefix), logicalCollectionName: '' }
            : undefined,
        }
      }
      const entity = dvEntities.find(e => e.logicalName === value)
      return {
        ...m,
        useExistingLookupEntity: true,
        relatedEntity: entity ? { logicalName: entity.logicalName, logicalCollectionName: entity.logicalCollectionName } : undefined,
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
        <Button size="small" onClick={handleSaveJson}>Save mapping as JSON</Button>
        <Button size="small" onClick={() => fileInputRef.current?.click()}>Load mapping from JSON</Button>
        <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleLoadJson} />
        {migrationMode === 'schemaOnly' ? (
          <span className={styles.summary}>
            {activeFields.length} field{activeFields.length !== 1 ? 's' : ''} will be created, {fieldMappings.length - activeFields.length} skipped
          </span>
        ) : (
        <span className={styles.summary}>
          {activeFields.length} of {fieldMappings.length} fields active · {migratingFields.length} value(s) will migrate
        </span>
        )}
      </div>

      {/* ── Field mapping table ── */}
      <div>
        <div className={styles.sectionTitle}>Custom Field Mapping ({fieldMappings.length} fields)</div>
        {migrationMode !== 'schemaOnly' && dvAttrError && (
          <MessageBar intent="warning" style={{ marginBottom: '8px' }}>
            <MessageBarBody>Could not load existing Dataverse fields: {dvAttrError}</MessageBarBody>
          </MessageBar>
        )}
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th} style={{ width: '40px' }}>Skip</th>
              <th className={styles.th}>Field Name</th>
              <th className={styles.th} style={{ whiteSpace: 'nowrap' }}>PO Type</th>
              <th className={styles.th} style={{ width: '140px', whiteSpace: 'nowrap' }}>Migrate as</th>
              <th className={styles.th}>Dataverse Target</th>
              {migrationMode === 'full' && (
                <th className={styles.th} style={{ width: '88px', textAlign: 'center' }}>Migrate value</th>
              )}
            </tr>
          </thead>
          <tbody>
            {fieldMappings.length === 0 && (
              <tr>
                <td className={styles.td} colSpan={6} style={{ textAlign: 'center', color: tokens.colorNeutralForeground3 }}>
                  No custom fields found in Project Online.
                </td>
              </tr>
            )}
            {fieldMappings.map((m, idx) => {
              const isLookupMulti = m.customField.CustomFieldType === 'LookupMulti'
              const poFieldKey = m.customField.ODataFieldName || m.customField.CustomFieldName
              const mlMapping = isLookupMulti ? multiLookupMappingsState.find(x => x.poFieldName === poFieldKey) : undefined
              const targetShape: MultiLookupTargetShape = mlMapping?.targetShape ?? (isLookupMulti ? 'MultiChoice' : 'MultiChoice')
              const isNN = isLookupMulti && targetShape === 'N:N'

              return (
              <tr
                key={m.customField.CustomFieldId}
                id={`mapping-row-${m.customField.CustomFieldId}`}
                className={m.skip ? styles.trSkipped : undefined}
                style={isNN && !m.skip ? { background: tokens.colorNeutralBackground2 } : undefined}
              >

                {/* Col 1: Skip */}
                <td className={styles.td}>
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
                      <span
                        className={styles.entityBadge}
                        style={{ background: ENTITY_COLORS[m.customField.CustomFieldEntityType] ?? '#888' }}
                      >
                        {m.customField.CustomFieldEntityType}
                      </span>
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
                <td className={styles.td} style={{ whiteSpace: 'nowrap', color: tokens.colorNeutralForeground2 }}>
                  {m.customField.CustomFieldType}
                </td>

                {/* Col 4: Migrate as — only relevant for LookupMulti */}
                <td className={styles.td}>
                  {isLookupMulti && !m.skip
                    ? <>
                        <Select
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
                      </>
                    : <span style={{ color: tokens.colorNeutralForeground4, fontSize: '12px' }}>—</span>
                  }
                </td>

                {/* Col 5: Dataverse Target */}
                <td className={styles.td}>
                  {m.skip
                    ? <span style={{ color: tokens.colorNeutralForeground4, fontSize: '12px' }}>—</span>
                    : isNN
                      ? <span style={{ fontSize: '12px', color: tokens.colorNeutralForeground3, fontStyle: 'italic' }}>↓ see N:N panel below</span>
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
                          {m.targetColumnType === 'Lookup' && m.lookupTable && (
                            <Select
                              size="small"
                              className={styles.selectFixed}
                              value={m.useExistingLookupEntity ? (m.relatedEntity?.logicalName ?? '') : '__create'}
                              onChange={(_, d) => setSchemaOnlyLookupSource(idx, d.value)}
                              style={{ marginTop: '6px' }}
                            >
                              <option value="__create">Create lookup table: {lookupEntityLogicalName(m.lookupTable, prefix)}</option>
                              {solutionEntities.map(e => (
                                <option key={e.logicalName} value={e.logicalName} title={`${e.displayName} (${e.logicalName})`}>
                                  Use existing: {e.displayName} ({e.logicalName})
                                </option>
                              ))}
                            </Select>
                          )}
                          {(m.targetColumnType === 'OptionSet' || m.targetColumnType === 'MultiSelectOptionSet') && m.lookupTable && (
                            <Select
                              size="small"
                              className={styles.selectFixed}
                              value={m.optionSetName ?? '__create'}
                              onChange={(_, d) => setSchemaOnlyOptionSetSource(idx, d.value)}
                              style={{ marginTop: '6px' }}
                            >
                              <option value="__create">Create choice: {m.targetLogicalName}</option>
                              {solutionChoices.map(os => (
                                <option key={os.name} value={os.name} title={`${os.displayName} (${os.name})`}>
                                  Use existing: {os.displayName} ({os.name})
                                </option>
                              ))}
                            </Select>
                          )}
                          {m.targetColumnType === 'Lookup' && m.lookupTable && (
                            <div style={{ marginTop: '4px', fontSize: '12px', color: tokens.colorNeutralForeground3 }}>
                              {m.useExistingLookupEntity
                                ? 'Will create a lookup column to the selected table.'
                                : <>Will create lookup entity {lookupEntityLogicalName(m.lookupTable, prefix)} with {m.lookupTable.entries.length} entries</>}
                            </div>
                          )}
                          {m.targetColumnType !== 'Lookup' && m.lookupTable && (
                            <div style={{ marginTop: '4px', fontSize: '12px', color: tokens.colorNeutralForeground3 }}>
                              {m.lookupTable.LookupTableName} Â· {m.lookupTable.entries.length} entries
                            </div>
                          )}
                        </>
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
                              className={styles.selectFixed}
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
                      : <>
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
                                {m.targetColumnType === 'Lookup' && (
                                  <Select
                                    size="small"
                                    className={styles.selectFixed}
                                    value={m.relatedEntity?.logicalName ?? ''}
                                    title={dvEntities.find(e => e.logicalName === m.relatedEntity?.logicalName)?.displayName ?? ''}
                                    onChange={(_, d) => setFieldRelatedEntity(idx, d.value)}
                                    style={{ marginTop: '6px' }}
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
                                {m.targetColumnType !== 'Lookup' && m.lookupTable && (
                                  <div style={{ marginTop: '4px', fontSize: '12px', color: tokens.colorNeutralForeground3 }}>
                                    {m.lookupTable.LookupTableName} · {m.lookupTable.entries.length} entries
                                  </div>
                                )}
                              </>
                            : <Select
                                size="small"
                                className={styles.selectFixed}
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
                        </>
                  }
                </td>

                {/* Col 6: Migrate value */}
                {migrationMode === 'full' && (
                  <td className={styles.td} style={{ textAlign: 'center' }}>
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

      {/* ── Multi-value Lookup Fields (LookupMulti) — N:N panel ── */}
      {(() => {
        const allLmFields = fieldMappings.filter(m => !m.skip && m.customField.CustomFieldType === 'LookupMulti' && m.customField.CustomFieldEntityType === 'Project')
        const nnFields = allLmFields.filter(m => {
          const poFN = m.customField.ODataFieldName || m.customField.CustomFieldName
          const ml = multiLookupMappingsState.find(x => x.poFieldName === poFN)
          return !ml || ml.targetShape === 'N:N' || ml.targetShape === undefined
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
