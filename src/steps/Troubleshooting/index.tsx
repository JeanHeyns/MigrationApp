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
  type AttributeOptionSetMetadata,
  type EntityWithCustomAttributes,
  type OptionSetDebugAttempt,
  type RawPicklistAttributeMeta,
} from '../../services/dataverseService'
import type { ColumnMeta, GlobalOptionSetMeta } from '../../models/dataOnly.types'

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
  const { schemaSnapshot, setCurrentStep, projectWriteDiagnostics, fetchedData } = useMigration()
  const [entityName, setEntityName] = useState(TARGET_ENTITIES[0].logicalName)
  const [fieldName, setFieldName] = useState('')
  const [projectDiagnosticId, setProjectDiagnosticId] = useState('')
  const [data, setData] = useState<TroubleData | null>(null)
  const [globalOptionSet, setGlobalOptionSet] = useState<GlobalOptionSetMeta | null>(null)
  const [attributeOptionSet, setAttributeOptionSet] = useState<AttributeOptionSetMetadata | null>(null)
  const [optionSetAttempts, setOptionSetAttempts] = useState<OptionSetDebugAttempt[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

      <div className={styles.footer}>
        <Button onClick={() => setCurrentStep(1)}>Back to Connect</Button>
        <Button appearance="primary" onClick={() => setCurrentStep(2)}>Back to Mapping</Button>
      </div>
    </div>
  )
}
