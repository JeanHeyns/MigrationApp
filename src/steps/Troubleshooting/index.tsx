import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  MessageBar,
  MessageBarBody,
  Select,
  Spinner,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { useMigration } from '../../app/MigrationContext'
import {
  debugFetchAttributeOptionSetMetadata,
  fetchCustomMultiPicklistAttributes,
  fetchCustomPicklistAttributes,
  fetchEntityWithCustomAttributes,
  fetchGlobalOptionSetFull,
  getEntityManyToManyRelationships,
  listAllRecords,
  type AttributeOptionSetMetadata,
  type EntityWithCustomAttributes,
  type OptionSetDebugAttempt,
  type RawPicklistAttributeMeta,
} from '../../services/dataverseService'
import type { ColumnMeta, GlobalOptionSetMeta, NNRelationshipMeta } from '../../models/dataOnly.types'

const TARGET_ENTITIES = [
  { logicalName: 'msdyn_project', label: 'Project (msdyn_project)' },
  { logicalName: 'msdyn_projecttask', label: 'Task (msdyn_projecttask)' },
  { logicalName: 'msdyn_projectteam', label: 'Resource/team (msdyn_projectteam)' },
]

const useStyles = makeStyles({
  root: {
    padding: '32px',
    maxWidth: '1100px',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  },
  title: { fontSize: '20px', fontWeight: '600', color: tokens.colorNeutralForeground1 },
  subtitle: { fontSize: '13px', color: tokens.colorNeutralForeground3, marginTop: '4px' },
  toolbar: {
    display: 'grid',
    gridTemplateColumns: 'minmax(220px, 280px) minmax(260px, 1fr) auto',
    gap: '12px',
    alignItems: 'end',
  },
  field: { display: 'flex', flexDirection: 'column', gap: '6px' },
  label: { fontSize: '12px', fontWeight: '600', color: tokens.colorNeutralForeground2 },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: '16px',
  },
  panel: {
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: '8px',
    padding: '14px',
    minWidth: 0,
  },
  panelTitle: {
    fontSize: '13px',
    fontWeight: '600',
    color: tokens.colorNeutralForeground1,
    marginBottom: '10px',
  },
  pre: {
    margin: 0,
    padding: '12px',
    borderRadius: '6px',
    background: tokens.colorNeutralBackground3,
    color: tokens.colorNeutralForeground1,
    fontFamily: 'Consolas, ui-monospace, monospace',
    fontSize: '12px',
    lineHeight: '18px',
    overflowX: 'auto',
    maxHeight: '420px',
  },
  footer: { display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' },
  fullPanel: {
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: '8px',
    padding: '14px',
    minWidth: 0,
  },
  projectHeader: {
    display: 'grid',
    gridTemplateColumns: 'minmax(220px, 360px) 1fr',
    gap: '12px',
    alignItems: 'end',
    marginBottom: '12px',
  },
})

interface TroubleData {
  entity: EntityWithCustomAttributes
  picklists: RawPicklistAttributeMeta[]
  multiPicklists: RawPicklistAttributeMeta[]
}

interface LutCompareResult {
  dvLabels: string[]
  poLutLabels: string[]
  matches: Array<{ poLabel: string; dvMatch: string | null }>
  unmatchedDv: string[]
  rawPoSamples: string[]
}

function pretty(value: unknown): string {
  if (value === undefined) return 'undefined'
  return JSON.stringify(value, null, 2)
}

function optionCount(attr: RawPicklistAttributeMeta | undefined): number {
  return attr?.OptionSet?.Options?.length ?? 0
}

function choiceAttributeType(rawAttribute: EntityWithCustomAttributes['rawAttrs'][number] | undefined): 'Picklist' | 'MultiSelectPicklist' | null {
  if (!rawAttribute) return null
  if (rawAttribute.AttributeType === 'Picklist') return 'Picklist'
  if (rawAttribute.AttributeType === 'MultiSelectPicklist') return 'MultiSelectPicklist'
  if (rawAttribute.AttributeType === 'Virtual' && rawAttribute.AttributeTypeName?.Value === 'MultiSelectPicklistType') {
    return 'MultiSelectPicklist'
  }
  return null
}

export function Troubleshooting() {
  const styles = useStyles()
  const { schemaSnapshot, setCurrentStep, projectWriteDiagnostics, fetchedData, mappingConfig } = useMigration()
  const [entityName, setEntityName] = useState(TARGET_ENTITIES[0].logicalName)
  const [fieldName, setFieldName] = useState('')
  const [projectDiagnosticId, setProjectDiagnosticId] = useState('')
  const [data, setData] = useState<TroubleData | null>(null)
  const [globalOptionSet, setGlobalOptionSet] = useState<GlobalOptionSetMeta | null>(null)
  const [attributeOptionSet, setAttributeOptionSet] = useState<AttributeOptionSetMetadata | null>(null)
  const [optionSetAttempts, setOptionSetAttempts] = useState<OptionSetDebugAttempt[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nnEntity, setNnEntity] = useState('msdyn_project')
  const [nnFetching, setNnFetching] = useState(false)
  const [nnRaw, setNnRaw] = useState<NNRelationshipMeta[] | null>(null)
  const [nnError, setNnError] = useState<string | null>(null)

  // LUT comparison state
  const [lutPoField, setLutPoField] = useState('')
  const [lutFetching, setLutFetching] = useState(false)
  const [lutResult, setLutResult] = useState<LutCompareResult | null>(null)
  const [lutError, setLutError] = useState<string | null>(null)

  const nnMappings = useMemo(
    () => (mappingConfig?.multiLookups ?? []).filter(
      ml => ml.targetShape === 'N:N' && ml.targetEntitySetName && ml.matchFieldLogicalName,
    ),
    [mappingConfig],
  )

  useEffect(() => {
    if (!lutPoField && nnMappings.length > 0) setLutPoField(nnMappings[0].poFieldName)
  }, [nnMappings, lutPoField])

  const selectedNnMapping = nnMappings.find(ml => ml.poFieldName === lutPoField)

  const snapshotEntity = schemaSnapshot?.entities[entityName]
  const snapshotColumn = snapshotEntity?.attributes.find(a => a.logicalName === fieldName)
  const rawAttribute = data?.entity.rawAttrs.find(a => a.LogicalName === fieldName)
  const rawPicklist = data?.picklists.find(a => a.LogicalName === fieldName)
  const rawMultiPicklist = data?.multiPicklists.find(a => a.LogicalName === fieldName)
  const rawChoice = rawPicklist ?? rawMultiPicklist
  const rawChoiceType = choiceAttributeType(rawAttribute)
  const selectedProjectDiagnostic = projectWriteDiagnostics.find(d => d.poProjectId === projectDiagnosticId) ?? projectWriteDiagnostics[0]
  const selectedPatchSummary = selectedProjectDiagnostic ? {
    project: selectedProjectDiagnostic.poProjectName,
    poProjectId: selectedProjectDiagnostic.poProjectId,
    dvProjectId: selectedProjectDiagnostic.dvProjectId,
    mode: selectedProjectDiagnostic.mode,
    patchAttempted: selectedProjectDiagnostic.patchAttempted,
    patchSucceeded: selectedProjectDiagnostic.patchSucceeded,
    patchError: selectedProjectDiagnostic.patchError,
    patchKeys: Object.keys(selectedProjectDiagnostic.patchPayload),
    ownerKeys: Object.keys(selectedProjectDiagnostic.ownerBind),
    mappedFields: selectedProjectDiagnostic.mappedFields.length,
    fieldsResolvedInPatch: selectedProjectDiagnostic.mappedFields.filter(f => f.resolvedInPatch).length,
    fieldsNotResolvedInPatch: selectedProjectDiagnostic.mappedFields
      .filter(f => f.migrateValue && !f.skipped && f.hasSourceValue && !f.resolvedInPatch)
      .map(f => ({
        poField: f.poField,
        sourceKey: f.sourceKey,
        targetLogicalName: f.targetLogicalName,
        targetColumnType: f.targetColumnType,
        hasSourceValue: f.hasSourceValue,
        sourceValue: f.sourceValue,
        skipReason: f.skipReason,
      })),
    fieldsMissingSourceValue: selectedProjectDiagnostic.mappedFields
      .filter(f => f.migrateValue && !f.skipped && !f.hasSourceValue)
      .map(f => ({
        poField: f.poField,
        expectedSourceKey: f.sourceKey,
        targetLogicalName: f.targetLogicalName,
        targetColumnType: f.targetColumnType,
      })),
    skippedFields: selectedProjectDiagnostic.skippedFields,
  } : undefined
  const projectDiagnosticSummary = {
    totalProjectsTracked: projectWriteDiagnostics.length,
    created: projectWriteDiagnostics.filter(d => d.mode === 'created').length,
    existing: projectWriteDiagnostics.filter(d => d.mode === 'existing').length,
    createFailed: projectWriteDiagnostics.filter(d => d.mode === 'createFailed').length,
    patchAttempted: projectWriteDiagnostics.filter(d => d.patchAttempted).length,
    patchSucceeded: projectWriteDiagnostics.filter(d => d.patchSucceeded === true).length,
    patchFailed: projectWriteDiagnostics.filter(d => d.patchSucceeded === false).length,
    fieldsNotResolvedInPatch: projectWriteDiagnostics.reduce(
      (sum, d) => sum + d.mappedFields.filter(f => f.migrateValue && !f.skipped && f.hasSourceValue && !f.resolvedInPatch).length,
      0,
    ),
    fieldsMissingSourceValue: projectWriteDiagnostics.reduce(
      (sum, d) => sum + d.mappedFields.filter(f => f.migrateValue && !f.skipped && !f.hasSourceValue).length,
      0,
    ),
    skippedFieldValues: projectWriteDiagnostics.reduce((sum, d) => sum + d.skippedFields.length, 0),
  }

  const fieldOptions = useMemo(() => {
    const fields = new Map<string, { logicalName: string; label: string; type?: string }>()

    for (const attr of data?.entity.rawAttrs ?? []) {
      fields.set(attr.LogicalName, {
        logicalName: attr.LogicalName,
        label: attr.DisplayName?.UserLocalizedLabel?.Label ?? attr.LogicalName,
        type: attr.AttributeTypeName?.Value ?? attr.AttributeType,
      })
    }

    for (const col of snapshotEntity?.attributes ?? []) {
      fields.set(col.logicalName, {
        logicalName: col.logicalName,
        label: col.displayName,
        type: col.type,
      })
    }

    return [...fields.values()].sort((a, b) => a.label.localeCompare(b.label))
  }, [data?.entity.rawAttrs, snapshotEntity?.attributes])

  async function fetchLutComparison() {
    const ml = selectedNnMapping
    if (!ml?.targetEntitySetName || !ml?.matchFieldLogicalName) return

    setLutFetching(true)
    setLutError(null)
    setLutResult(null)

    try {
      const records = await listAllRecords(ml.targetEntitySetName, [ml.matchFieldLogicalName])
      const dvLabels = records
        .map(r => String(r[ml.matchFieldLogicalName!] ?? '').trim())
        .filter(Boolean)
      const dvNormMap = new Map(dvLabels.map(l => [l.toLowerCase(), l]))

      const poFieldMapping = mappingConfig?.fieldMappings.find(
        fm => (fm.customField.ODataFieldName || fm.customField.CustomFieldName) === ml.poFieldName,
      )
      const sourceKeys = [
        ml.poFieldName,
        poFieldMapping?.customField.ODataFieldName,
        poFieldMapping?.customField.CustomFieldName,
      ].filter((value, index, values): value is string =>
        typeof value === 'string' && value.length > 0 && values.indexOf(value) === index
      )
      const seenPo = new Set<string>()
      const poLutLabels: string[] = []
      for (const entry of poFieldMapping?.lookupTable?.entries ?? []) {
        const label = entry.LookupEntryFullValue || entry.LookupEntryValue || ''
        if (!label) continue
        const key = label.toLowerCase()
        if (seenPo.has(key)) continue
        seenPo.add(key)
        poLutLabels.push(label)
      }

      const matches = poLutLabels.map(poLabel => ({
        poLabel,
        dvMatch: dvNormMap.get(poLabel.toLowerCase()) ?? null,
      }))

      const matchedDvKeys = new Set(matches.filter(m => m.dvMatch).map(m => m.dvMatch!.toLowerCase()))
      const unmatchedDv = dvLabels.filter(l => !matchedDvKeys.has(l.toLowerCase()))

      const seenRaw = new Set<string>()
      const rawPoSamples: string[] = []
      for (const project of (fetchedData?.projects ?? [])) {
        const key = sourceKeys.find(k => project[k] !== undefined)
        const val = key ? project[key] : undefined
        if (val == null || val === '') continue
        const str = String(val)
        if (!seenRaw.has(str)) {
          seenRaw.add(str)
          rawPoSamples.push(str)
        }
        if (rawPoSamples.length >= 20) break
      }

      setLutResult({ dvLabels, poLutLabels, matches, unmatchedDv, rawPoSamples })
    } catch (e) {
      setLutError(String(e))
    } finally {
      setLutFetching(false)
    }
  }

  async function loadEntity(selectedEntity = entityName) {
    setLoading(true)
    setError(null)
    setGlobalOptionSet(null)
    setAttributeOptionSet(null)
    setOptionSetAttempts([])
    try {
      const [entity, picklists, multiPicklists] = await Promise.all([
        fetchEntityWithCustomAttributes(selectedEntity),
        fetchCustomPicklistAttributes(selectedEntity).catch(() => []),
        fetchCustomMultiPicklistAttributes(selectedEntity).catch(() => []),
      ])

      setData({ entity, picklists, multiPicklists })
      const names = new Set([
        ...entity.rawAttrs.map(a => a.LogicalName),
        ...(schemaSnapshot?.entities[selectedEntity]?.attributes ?? []).map(a => a.logicalName),
      ])
      setFieldName(current => names.has(current) ? current : [...names].sort()[0] ?? '')
    } catch (e) {
      setData(null)
      setFieldName('')
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadEntity(entityName)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityName])

  useEffect(() => {
    if (projectDiagnosticId && projectWriteDiagnostics.some(d => d.poProjectId === projectDiagnosticId)) return
    setProjectDiagnosticId(projectWriteDiagnostics[0]?.poProjectId ?? '')
  }, [projectDiagnosticId, projectWriteDiagnostics])

  useEffect(() => {
    setAttributeOptionSet(null)
    setOptionSetAttempts([])
    if (!rawAttribute?.MetadataId) return
    if (!rawChoiceType) return

    debugFetchAttributeOptionSetMetadata(
      entityName,
      rawAttribute.MetadataId,
      rawChoiceType,
      rawAttribute.LogicalName,
    ).then(result => {
      setAttributeOptionSet(result.selected)
      setOptionSetAttempts(result.attempts)
    })
  }, [entityName, rawAttribute, rawChoiceType])

  useEffect(() => {
    const optionSetName = snapshotColumn?.optionSetName
      ?? rawChoice?.GlobalOptionSet?.Name
      ?? (rawChoice?.OptionSet?.IsGlobal ? rawChoice.OptionSet.Name : undefined)
      ?? (rawChoiceType && rawAttribute
        ? rawAttribute.LogicalName
        : undefined)

    if (!optionSetName) {
      setGlobalOptionSet(null)
      return
    }

    fetchGlobalOptionSetFull(optionSetName).then(setGlobalOptionSet)
  }, [rawAttribute, rawChoice, rawChoiceType, snapshotColumn?.optionSetName])

  const summary: Record<string, unknown> = {
    selectedEntity: entityName,
    selectedField: fieldName,
    snapshotType: snapshotColumn?.type,
    snapshotOptionSetName: snapshotColumn?.optionSetName,
    snapshotOptionSetMetadataId: snapshotColumn?.optionSetMetadataId,
    snapshotOptionSetIsGlobal: snapshotColumn?.optionSetIsGlobal,
    snapshotLocalOptionCount: snapshotColumn?.optionSetOptions?.length,
    snapshotInlineOptionCount: snapshotColumn?.inlineOptions?.length,
    rawAttributeType: rawAttribute?.AttributeType,
    rawAttributeTypeName: rawAttribute?.AttributeTypeName?.Value,
    rawPicklistOptionSetName: rawChoice?.OptionSet?.Name,
    rawGlobalOptionSetName: rawChoice?.GlobalOptionSet?.Name,
    rawOptionSetIsGlobal: rawChoice?.OptionSet?.IsGlobal,
    rawBoundOptionCount: optionCount(rawChoice),
    attributeMetadataId: rawAttribute?.MetadataId,
    attributeOptionSetName: attributeOptionSet?.name,
    attributeOptionSetIsGlobal: attributeOptionSet?.isGlobal,
    attributeOptionCount: attributeOptionSet?.options.length,
    globalOptionSetFallbackName: rawAttribute?.LogicalName,
    fetchedGlobalOptionCount: globalOptionSet?.options.length,
    attemptCount: optionSetAttempts.length,
    failedAttempts: optionSetAttempts.filter(a => !a.success).length,
  }

  const snapshotPayload: ColumnMeta | undefined = snapshotColumn

  return (
    <div className={styles.root}>
      <div>
        <div className={styles.title}>Troubleshooting</div>
        <div className={styles.subtitle}>Inspect Dataverse field metadata used by data-only option-set resolution.</div>
      </div>

      <div className={styles.toolbar}>
        <label className={styles.field}>
          <span className={styles.label}>Entity</span>
          <Select value={entityName} onChange={(_, d) => setEntityName(d.value)}>
            {TARGET_ENTITIES.map(entity => (
              <option key={entity.logicalName} value={entity.logicalName}>{entity.label}</option>
            ))}
          </Select>
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Field</span>
          <Select value={fieldName} onChange={(_, d) => setFieldName(d.value)} disabled={fieldOptions.length === 0}>
            {fieldOptions.map(field => (
              <option key={field.logicalName} value={field.logicalName}>
                {field.label} ({field.logicalName}){field.type ? ` - ${field.type}` : ''}
              </option>
            ))}
          </Select>
        </label>

        <Button onClick={() => loadEntity(entityName)} disabled={loading}>
          Refresh
        </Button>
      </div>

      {loading && <Spinner label="Loading metadata..." />}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {!schemaSnapshot && (
        <MessageBar intent="warning">
          <MessageBarBody>No schema snapshot is loaded. Go to Step 1 and scan the target solution to compare snapshot data.</MessageBarBody>
        </MessageBar>
      )}

      <section className={styles.fullPanel}>
        <div className={styles.panelTitle}>Project Creation Diagnostics</div>
        <div className={styles.projectHeader}>
          <label className={styles.field}>
            <span className={styles.label}>Project</span>
            <Select
              value={selectedProjectDiagnostic?.poProjectId ?? ''}
              onChange={(_, d) => setProjectDiagnosticId(d.value)}
              disabled={projectWriteDiagnostics.length === 0}
            >
              {projectWriteDiagnostics.map(diag => {
                const projectName = diag.poProjectName
                  || fetchedData?.projects.find(p => p.ProjectId === diag.poProjectId)?.ProjectName
                  || diag.poProjectId
                return (
                  <option key={diag.poProjectId} value={diag.poProjectId}>
                    {projectName} ({diag.mode}{diag.patchSucceeded === false ? ', patch failed' : ''})
                  </option>
                )
              })}
            </Select>
          </label>
          <pre className={styles.pre}>{pretty(projectDiagnosticSummary)}</pre>
        </div>
        {projectWriteDiagnostics.length === 0 ? (
          <MessageBar>
            <MessageBarBody>No project write diagnostics yet. Run Step 4 to capture create and patch payload details.</MessageBarBody>
          </MessageBar>
        ) : (
          <>
            <div className={styles.panelTitle}>Selected Project Patch Summary</div>
            <pre className={styles.pre}>{pretty(selectedPatchSummary)}</pre>
            <div className={styles.panelTitle}>Selected Project Full Diagnostic</div>
            <pre className={styles.pre}>{pretty(selectedProjectDiagnostic)}</pre>
          </>
        )}
      </section>

      <div className={styles.grid}>
        <section className={styles.panel}>
          <div className={styles.panelTitle}>Resolution Summary</div>
          <pre className={styles.pre}>{pretty(summary)}</pre>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelTitle}>Schema Snapshot Column</div>
          <pre className={styles.pre}>{pretty(snapshotPayload)}</pre>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelTitle}>Raw Entity Attribute</div>
          <pre className={styles.pre}>{pretty(rawAttribute)}</pre>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelTitle}>Raw Picklist Metadata</div>
          <pre className={styles.pre}>{pretty(rawChoice)}</pre>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelTitle}>Attribute Option Set Metadata</div>
          <pre className={styles.pre}>{pretty(attributeOptionSet)}</pre>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelTitle}>Fetched Global Option Set</div>
          <pre className={styles.pre}>{pretty(globalOptionSet)}</pre>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelTitle}>Option Set Call Attempts</div>
          <pre className={styles.pre}>{pretty(optionSetAttempts)}</pre>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelTitle}>Entity Metadata</div>
          <pre className={styles.pre}>{pretty(data?.entity)}</pre>
        </section>
      </div>

      {/* ── N:N Relationship Debug ── */}
      <section className={styles.fullPanel}>
        <div className={styles.panelTitle}>N:N Relationship Debug</div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', marginBottom: '12px', flexWrap: 'wrap' }}>
          <label className={styles.field} style={{ minWidth: '220px' }}>
            <span className={styles.label}>Entity</span>
            <Select value={nnEntity} onChange={(_, d) => setNnEntity(d.value)}>
              {TARGET_ENTITIES.map(e => (
                <option key={e.logicalName} value={e.logicalName}>{e.label}</option>
              ))}
            </Select>
          </label>
          <Button
            onClick={async () => {
              setNnFetching(true)
              setNnError(null)
              setNnRaw(null)
              try {
                const result = await getEntityManyToManyRelationships(nnEntity)
                setNnRaw(result)
              } catch (e) {
                setNnError(String(e))
              } finally {
                setNnFetching(false)
              }
            }}
            disabled={nnFetching}
          >
            {nnFetching ? 'Fetching…' : 'Fetch N:N relationships'}
          </Button>
        </div>

        {nnError && (
          <MessageBar intent="error" style={{ marginBottom: '10px' }}>
            <MessageBarBody>{nnError}</MessageBarBody>
          </MessageBar>
        )}

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelTitle}>
              Live API result — getEntityManyToManyRelationships({nnEntity})
              {nnRaw !== null && ` — ${nnRaw.length} relationship(s)`}
            </div>
            <pre className={styles.pre}>
              {nnRaw === null && nnError === null
                ? '— not fetched yet —'
                : pretty(nnRaw)}
            </pre>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelTitle}>
              Schema snapshot — {nnEntity} nnRelationships
              {schemaSnapshot?.entities[nnEntity]?.nnRelationships !== undefined
                ? ` — ${schemaSnapshot.entities[nnEntity].nnRelationships!.length} relationship(s)`
                : ' — undefined (re-scan needed)'}
            </div>
            <pre className={styles.pre}>
              {pretty(schemaSnapshot?.entities[nnEntity]?.nnRelationships)}
            </pre>
          </section>
        </div>
      </section>

      {/* ── N:N Lookup Value Comparison ── */}
      <section className={styles.fullPanel}>
        <div className={styles.panelTitle}>N:N Lookup Value Comparison</div>
        <div className={styles.subtitle} style={{ marginBottom: '12px' }}>
          Compare PO lookup table entries against Dataverse lookup entity records. Reveals why values fail to match during import.
        </div>

        {nnMappings.length === 0 ? (
          <MessageBar intent="warning">
            <MessageBarBody>
              No N:N multi-lookup mappings configured. Set up N:N mappings in Step 2 (select relationship + match field) and load this page again.
            </MessageBarBody>
          </MessageBar>
        ) : (
          <>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end', marginBottom: '12px', flexWrap: 'wrap' }}>
              <label className={styles.field} style={{ minWidth: '300px' }}>
                <span className={styles.label}>N:N Multi-lookup Field</span>
                <Select
                  value={lutPoField}
                  onChange={(_, d) => { setLutPoField(d.value); setLutResult(null) }}
                >
                  {nnMappings.map(ml => (
                    <option key={ml.poFieldName} value={ml.poFieldName}>{ml.poFieldName}</option>
                  ))}
                </Select>
              </label>
              {selectedNnMapping && (
                <div style={{ fontSize: '12px', color: tokens.colorNeutralForeground3, paddingBottom: '6px' }}>
                  Entity: <code>{selectedNnMapping.targetEntitySetName}</code> · Match field: <code>{selectedNnMapping.matchFieldLogicalName}</code>
                </div>
              )}
              <Button onClick={fetchLutComparison} disabled={lutFetching || !selectedNnMapping}>
                {lutFetching ? 'Fetching…' : 'Fetch & Compare'}
              </Button>
            </div>

            {lutError && (
              <MessageBar intent="error" style={{ marginBottom: '10px' }}>
                <MessageBarBody>{lutError}</MessageBarBody>
              </MessageBar>
            )}

            {lutResult && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
                <section className={styles.panel}>
                  <div className={styles.panelTitle}>
                    PO Lookup Table → DV ({lutResult.matches.filter(m => m.dvMatch).length}/{lutResult.matches.length} matched)
                  </div>
                  {lutResult.matches.length === 0 ? (
                    <div style={{ fontSize: '12px', color: tokens.colorNeutralForeground3 }}>
                      No PO lookup table entries found for this field. Check the mapping has a lookup table attached.
                    </div>
                  ) : (
                    <div style={{ maxHeight: '380px', overflowY: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: `1px solid ${tokens.colorNeutralStroke1}`, fontWeight: '600' }}>PO label</th>
                            <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: `1px solid ${tokens.colorNeutralStroke1}`, fontWeight: '600' }}>DV match</th>
                          </tr>
                        </thead>
                        <tbody>
                          {lutResult.matches.map((m, i) => (
                            <tr key={i} style={{ background: i % 2 === 0 ? 'transparent' : tokens.colorNeutralBackground2 }}>
                              <td style={{ padding: '3px 8px', fontFamily: 'Consolas, monospace', wordBreak: 'break-all' }}>{m.poLabel}</td>
                              <td style={{ padding: '3px 8px', color: m.dvMatch ? tokens.colorPaletteGreenForeground1 : tokens.colorPaletteRedForeground1, fontFamily: 'Consolas, monospace' }}>
                                {m.dvMatch ? `✓ ${m.dvMatch}` : '✗ niet gevonden'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                <section className={styles.panel}>
                  <div className={styles.panelTitle}>
                    DV Records — {selectedNnMapping?.matchFieldLogicalName} ({lutResult.dvLabels.length} waarden{lutResult.unmatchedDv.length > 0 ? `, ${lutResult.unmatchedDv.length} niet gematcht` : ''})
                  </div>
                  <div style={{ maxHeight: '380px', overflowY: 'auto' }}>
                    <pre className={styles.pre} style={{ maxHeight: 'none', margin: 0 }}>
                      {lutResult.dvLabels.length === 0 ? '(geen records gevonden)' : lutResult.dvLabels.join('\n')}
                    </pre>
                  </div>
                  {lutResult.unmatchedDv.length > 0 && (
                    <div style={{ marginTop: '8px', fontSize: '12px', color: tokens.colorNeutralForeground3 }}>
                      <strong>Niet gematcht door PO:</strong> {lutResult.unmatchedDv.join(', ')}
                    </div>
                  )}
                </section>

                <section className={styles.panel}>
                  <div className={styles.panelTitle}>
                    Ruwe PO projectwaarden ({lutResult.rawPoSamples.length} uniek{lutResult.rawPoSamples.length === 20 ? ', afgekapt' : ''})
                  </div>
                  <pre className={styles.pre}>
                    {lutResult.rawPoSamples.length === 0
                      ? '(geen waarden gevonden in projectdata)'
                      : lutResult.rawPoSamples.join('\n')}
                  </pre>
                  <div style={{ fontSize: '11px', color: tokens.colorNeutralForeground3, marginTop: '8px' }}>
                    Exacte waarden die PO stuurt per project. GUIDs worden via de PO lookup tabel vertaald voordat ze tegen Dataverse labels matchen.
                  </div>
                </section>
              </div>
            )}
          </>
        )}
      </section>

      <div className={styles.footer}>
        <Button onClick={() => setCurrentStep(1)}>Back to Connect</Button>
        <Button appearance="primary" onClick={() => setCurrentStep(2)}>Back to Mapping</Button>
      </div>
    </div>
  )
}
