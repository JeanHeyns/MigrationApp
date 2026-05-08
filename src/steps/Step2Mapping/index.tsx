import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Checkbox,
  Divider,
  MessageBar,
  MessageBarBody,
  Select,
  Spinner,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { useMigration } from '../../app/MigrationContext'
import { fetchSystemUsers } from '../../services/plannerPremium/dataverseClient'
import {
  fetchEntityAttributes,
  fetchEntityDefinitions,
  fetchGlobalOptionSetDefinitions,
  fetchSolutionComponentIds,
  fetchSolutionEntityIds,
  type DvEntityAttribute,
  type DvEntityDefinition,
  type DvGlobalOptionSetDefinition,
} from '../../services/dataverseService'
import { toLogicalName } from '../../services/projectOnline/customFields'
import { fetchResourcesByIds } from '../../services/projectOnline/resources'
import { lookupEntityLogicalName } from '../../services/plannerPremium/lookupEntityManager'
import type { PoCustomField, PoCustomFieldType, PoFetchedData, PoResource } from '../../models/projectOnline.types'
import type { DataverseColumnType, FieldMapping, MappingConfiguration, OwnerMapping } from '../../models/mapping.types'
import type { DvSystemUser } from '../../models/plannerPremium.types'
import type { ColumnMeta, ColumnMetaType, EntitySchema, ResolverEntry, ResolverPlan, SchemaSnapshot } from '../../models/dataOnly.types'

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
  Number:      ['Integer', 'Decimal', 'Double', 'Money'],
  Cost:        ['Money', 'Decimal'],
  Duration:    ['Integer', 'Decimal'],
  Date:        ['DateTime'],
  Flag:        ['Boolean'],
  Lookup:      ['Picklist', 'Lookup', 'Owner'],
  LookupMulti: ['MultiSelectPicklist'],
}

const SUGGESTED_DV_TYPE: Record<PoCustomFieldType, DataverseColumnType> = {
  Text:        'Text',
  Number:      'Decimal',
  Cost:        'Currency',
  Duration:    'Integer',
  Date:        'Date',
  Flag:        'Boolean',
  Lookup:      'OptionSet',
  LookupMulti: 'MultiSelectOptionSet',
}

const DV_TYPE_ALTERNATIVES: Record<PoCustomFieldType, DataverseColumnType[]> = {
  Text:        ['Text', 'Memo'],
  Number:      ['Decimal', 'Integer'],
  Cost:        ['Currency'],
  Duration:    ['Integer', 'Decimal'],
  Date:        ['Date', 'DateTime'],
  Flag:        ['Boolean'],
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

function buildDataOnlyMappings(data: PoFetchedData, snapshot: SchemaSnapshot, prefix: string): FieldMapping[] {
  return data.customFields.map(cf => {
    const dvEntityKey = PO_ENTITY_TO_DV[cf.CustomFieldEntityType]
    const dvEntity = dvEntityKey ? snapshot.entities[dvEntityKey] : undefined
    const compatible = dvEntity ? getCompatibleColumns(dvEntity, cf.CustomFieldType) : []

    if (compatible.length === 0) {
      return {
        customField: cf,
        targetColumnType: SUGGESTED_DV_TYPE[cf.CustomFieldType],
        targetLogicalName: toLogicalName(cf.CustomFieldName, prefix),
        skip: true,
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
      skip: false,
      migrateValue: false,
      useExistingField: false,
    }
  })
}

function buildResolverPlanFromMappings(mappings: FieldMapping[], snapshot: SchemaSnapshot): ResolverPlan {
  const fields: ResolverEntry[] = []
  for (const m of mappings) {
    if (m.skip || !m.useExistingField || !m.targetLogicalName) continue
    const dvEntityKey = PO_ENTITY_TO_DV[m.customField.CustomFieldEntityType]
    const dvEntity = dvEntityKey ? snapshot.entities[dvEntityKey] : undefined
    if (!dvEntity) continue
    const col = dvEntity.attributes.find(a => a.logicalName === m.targetLogicalName)
    if (!col) continue
    const targetEntity = col.targets?.[0]
    const targetEntityObj = targetEntity ? snapshot.entities[targetEntity] : undefined
    fields.push({
      poFieldName:      m.customField.ODataFieldName ?? m.customField.CustomFieldName,
      dvLogicalName:    m.targetLogicalName,
      dvType:           col.type,
      optionSetName:    m.optionSetName ?? col.optionSetName,
      targetEntity,
      targetEntitySet:  targetEntityObj?.entitySetName,
      primaryNameField: targetEntityObj?.primaryNameField,
      navigationProperty: col.navigationProperty,
    })
  }
  return { fields }
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

function ownerResourceId(p: { ProjectOwnerResourceId?: string; ProjectOwnerResourceUid?: string }): string | undefined {
  return p.ProjectOwnerResourceId ?? p.ProjectOwnerResourceUid
}

function buildOwnerMappings(
  data: PoFetchedData,
  systemUsers: DvSystemUser[],
  ownerResources: PoResource[],
): OwnerMapping[] {
  const ownerUids = [...new Set(
    data.projects.map(ownerResourceId).filter(Boolean) as string[]
  )]
  return ownerUids.map(uid => {
    const resource = ownerResources.find(r => r.ResourceId === uid)
      ?? data.resources.find(r => (r.ResourceId ?? r.ResourceUID) === uid)
    const name = resource?.ResourceName ?? uid
    const email = resource?.ResourceEmailAddress
    const ntAccount = resource?.ResourceNTAccount

    const matched = systemUsers.find(u =>
      (email && u.internalemailaddress?.toLowerCase() === email.toLowerCase()) ||
      u.fullname?.toLowerCase() === name.toLowerCase() ||
      (ntAccount && u.domainname?.toLowerCase() === ntAccount.toLowerCase())
    )

    return {
      poResourceUid: uid,
      poOwnerName: name,
      poOwnerEmail: email,
      dataverseSystemUserId:   matched?.systemuserid,
      dataverseSystemUserName: matched?.fullname,
      matched: !!matched,
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
  ownerTable: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
  ownerRow: { borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  matchBadge: {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '10px',
    fontSize: '11px',
    fontWeight: '600',
  },
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' },
  summary: { fontSize: '13px', color: tokens.colorNeutralForeground3 },
})

// ─── Component ────────────────────────────────────────────────────────────────

export function Step2Mapping() {
  const styles = useStyles()
  const {
    fetchedData, mappingConfig, setMappingConfig, nextStep, prevStep,
    selectedSolution, skipColumnCreation, dataSource,
    migrationMode, schemaSnapshot, setResolverPlan, setMigrationMode,
  } = useMigration()

  const prefix = selectedSolution?.publisherPrefix ?? 'cr9a1'

  const [fieldMappings, setFieldMappings] = useState<FieldMapping[]>([])
  const [ownerMappings, setOwnerMappings] = useState<OwnerMapping[]>([])
  const [systemUsers, setSystemUsers] = useState<DvSystemUser[]>([])
  const [dvAttributes, setDvAttributes] = useState<DvEntityAttribute[]>([])
  const [dvAttrError, setDvAttrError] = useState<string | null>(null)
  const [dvEntities, setDvEntities] = useState<DvEntityDefinition[]>([])
  const [solutionEntityIds, setSolutionEntityIds] = useState<Set<string>>(new Set())
  const [globalOptionSets, setGlobalOptionSets] = useState<DvGlobalOptionSetDefinition[]>([])
  const [solutionOptionSetIds, setSolutionOptionSetIds] = useState<Set<string>>(new Set())
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [userLoadError, setUserLoadError] = useState<string | null>(null)
  const [loadWarning, setLoadWarning] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Initialise mappings from fetched data (or restore from context).
  // In dataOnly mode, re-init when schemaSnapshot becomes available.
  // mappingConfig intentionally excluded — loadJson handler sets it directly.
  useEffect(() => {
    if (!fetchedData) return
    if (mappingConfig) {
      setFieldMappings(mappingConfig.fieldMappings)
      setOwnerMappings(mappingConfig.ownerMappings)
      return
    }
    if (migrationMode === 'dataOnly' && schemaSnapshot) {
      setFieldMappings(buildDataOnlyMappings(fetchedData, schemaSnapshot, prefix))
    } else if (migrationMode === 'schemaOnly') {
      setFieldMappings(buildSchemaOnlyMappings(fetchedData, prefix))
    } else if (migrationMode === 'full') {
      setFieldMappings(buildInitialMappings(fetchedData, prefix))
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

  // Load Dataverse system users and owner resources for owner matching
  useEffect(() => {
    if (!fetchedData || migrationMode === 'schemaOnly') return
    setLoadingUsers(true)
    const ownerIds = [...new Set(
      fetchedData.projects.map(ownerResourceId).filter(Boolean) as string[]
    )]
    const ownerResourcesPromise = dataSource === 'ProjectOnline'
      ? fetchResourcesByIds(fetchedData.pwaUrl, ownerIds)
      : Promise.resolve([] as import('../../models/projectOnline.types').PoResource[])

    Promise.all([fetchSystemUsers(), ownerResourcesPromise])
      .then(([users, ownerResources]) => {
        setSystemUsers(users)
        if (!mappingConfig) {
          setOwnerMappings(buildOwnerMappings(fetchedData, users, ownerResources))
        }
      })
      .catch(e => setUserLoadError(String(e)))
      .finally(() => setLoadingUsers(false))
  }, [fetchedData]) // eslint-disable-line react-hooks/exhaustive-deps

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
    setFieldMappings(prev => prev.map((m, i) => i === idx ? { ...m, skip } : m))
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

  // ── Owner mapping handlers ────────────────────────────────────────────────

  function setOwnerUser(idx: number, userId: string) {
    const user = systemUsers.find(u => u.systemuserid === userId)
    setOwnerMappings(prev => prev.map((m, i) =>
      i === idx ? {
        ...m,
        dataverseSystemUserId: user?.systemuserid,
        dataverseSystemUserName: user?.fullname,
        matched: !!user,
      } : m
    ))
  }

  // ── Save / Load JSON ─────────────────────────────────────────────────────

  function handleSaveJson() {
    const config: MappingConfiguration = {
      siteUrl: fetchedData?.pwaUrl ?? '',
      publisherPrefix: prefix,
      skipColumnCreation,
      migrationMode,
      fieldMappings,
      ownerMappings,
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
        setOwnerMappings(config.ownerMappings)
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
    } else if (migrationMode === 'schemaOnly') {
      setFieldMappings(buildSchemaOnlyMappings(fetchedData, prefix))
    } else {
      setFieldMappings(buildInitialMappings(fetchedData, prefix))
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
    const config: MappingConfiguration = {
      siteUrl: fetchedData?.pwaUrl ?? '',
      publisherPrefix: prefix,
      skipColumnCreation,
      migrationMode,
      fieldMappings,
      ownerMappings,
      savedAt: new Date().toISOString(),
    }
    setMappingConfig(config)
    if (migrationMode === 'dataOnly' && schemaSnapshot) {
      setResolverPlan(buildResolverPlanFromMappings(fieldMappings, schemaSnapshot))
    }
    nextStep()
  }

  const activeFields = fieldMappings.filter(m => !m.skip)
  const migratingFields = fieldMappings.filter(m => !m.skip && m.migrateValue)
  const unmatchedOwners = ownerMappings.filter(m => !m.matched)
  const solutionEntities = dvEntities.filter(e =>
    solutionEntityIds.has((e.metadataId ?? '').toLowerCase().replace(/[{}]/g, ''))
  )
  const solutionChoices = globalOptionSets.filter(os =>
    solutionOptionSetIds.has(os.metadataId.toLowerCase().replace(/[{}]/g, ''))
  )
  const unmappedDataOnlyRows = migrationMode === 'dataOnly' && schemaSnapshot
    ? fieldMappings.filter(m => {
        if (m.skip) return false
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
          {activeFields.length} of {fieldMappings.length} fields active · {migratingFields.length} value(s) will migrate ·{' '}
          {unmatchedOwners.length > 0
            ? <span style={{ color: tokens.colorPaletteRedForeground1 }}>{unmatchedOwners.length} owner(s) unmatched</span>
            : <span style={{ color: '#107c10' }}>all owners matched</span>
          }
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
              <th className={styles.th}>Dataverse Target</th>
              {migrationMode === 'full' && (
                <th className={styles.th} style={{ width: '88px', textAlign: 'center' }}>Migrate value</th>
              )}
            </tr>
          </thead>
          <tbody>
            {fieldMappings.length === 0 && (
              <tr>
                <td className={styles.td} colSpan={5} style={{ textAlign: 'center', color: tokens.colorNeutralForeground3 }}>
                  No custom fields found in Project Online.
                </td>
              </tr>
            )}
            {fieldMappings.map((m, idx) => (
              <tr
                key={m.customField.CustomFieldId}
                id={`mapping-row-${m.customField.CustomFieldId}`}
                className={m.skip ? styles.trSkipped : undefined}
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
                  </div>
                </td>

                {/* Col 3: PO Type */}
                <td className={styles.td} style={{ whiteSpace: 'nowrap', color: tokens.colorNeutralForeground2 }}>
                  {m.customField.CustomFieldType}
                </td>

                {/* Col 4: Dataverse Target */}
                <td className={styles.td}>
                  {m.skip
                    ? <span style={{ color: tokens.colorNeutralForeground4, fontSize: '12px' }}>—</span>
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
                            return (
                              <span style={{ fontSize: '12px', color: '#a4262c' }}>
                                No compatible {m.customField.CustomFieldType} column in {dvEntityKey ?? 'entity'}.
                                {' '}Create it manually in Dataverse or switch to Full mode in Step 1.
                              </span>
                            )
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

                {/* Col 5: Migrate value */}
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
            ))}
          </tbody>
        </table>
      </div>

      {migrationMode !== 'schemaOnly' && <Divider />}

      {/* ── Owner mapping ── */}
      <div style={{ display: migrationMode === 'schemaOnly' ? 'none' : undefined }}>
        <div className={styles.sectionTitle}>
          Project Owner Mapping
          {loadingUsers && <Spinner size="tiny" style={{ marginLeft: '8px' }} />}
        </div>

        {userLoadError && (
          <MessageBar intent="warning" style={{ marginBottom: '12px' }}>
            <MessageBarBody>Could not load Dataverse users: {userLoadError}</MessageBarBody>
          </MessageBar>
        )}

        {ownerMappings.length === 0 && !loadingUsers && (
          <p style={{ color: tokens.colorNeutralForeground3, fontSize: '13px' }}>
            No project owners found, or no owner field present in the fetched projects.
          </p>
        )}

        {ownerMappings.length > 0 && (
          <table className={styles.ownerTable}>
            <thead>
              <tr>
                <th className={styles.th}>Project Online Owner</th>
                <th className={styles.th}>Email</th>
                <th className={styles.th}>Match Status</th>
                <th className={styles.th}>Dataverse User</th>
              </tr>
            </thead>
            <tbody>
              {ownerMappings.map((om, idx) => (
                <tr key={om.poResourceUid} className={styles.ownerRow}>
                  <td className={styles.td}>{om.poOwnerName}</td>
                  <td className={styles.td} style={{ color: tokens.colorNeutralForeground3 }}>
                    {om.poOwnerEmail ?? '—'}
                  </td>
                  <td className={styles.td}>
                    <span
                      className={styles.matchBadge}
                      style={{
                        background: om.matched ? '#dff6dd' : '#fde7e9',
                        color: om.matched ? '#107c10' : '#a4262c',
                      }}
                    >
                      {om.matched ? '✓ Matched' : '✗ Unmatched'}
                    </span>
                  </td>
                  <td className={styles.td}>
                    <Select
                      size="small"
                      value={om.dataverseSystemUserId ?? ''}
                      onChange={(_, d) => setOwnerUser(idx, d.value)}
                      disabled={loadingUsers}
                    >
                      <option value="">— Select user —</option>
                      {systemUsers.map(u => (
                        <option key={u.systemuserid} value={u.systemuserid}>{u.fullname}</option>
                      ))}
                    </Select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

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
