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
import { toLogicalName } from '../../services/projectOnline/customFields'
import type { PoCustomFieldType, PoFetchedData } from '../../models/projectOnline.types'
import type { DataverseColumnType, FieldMapping, MappingConfiguration, OwnerMapping } from '../../models/mapping.types'
import type { DvSystemUser } from '../../models/plannerPremium.types'

// ─── Type mappings ────────────────────────────────────────────────────────────

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
  }))
}

function buildOwnerMappings(data: PoFetchedData, systemUsers: DvSystemUser[]): OwnerMapping[] {
  const ownerUids = [...new Set(
    data.projects.map(p => p.ProjectOwnerResourceUid).filter(Boolean) as string[]
  )]
  return ownerUids.map(uid => {
    const resource = data.resources.find(r => (r.ResourceUID ?? r.ResourceId) === uid)
    const name = resource?.ResourceName ?? uid
    const email = resource?.ResourceEmailAddress

    const matched = systemUsers.find(u =>
      u.fullname?.toLowerCase() === name.toLowerCase() ||
      (email && u.internalemailaddress?.toLowerCase() === email.toLowerCase())
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
    maxWidth: '1100px',
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
    selectedSolution, skipColumnCreation, setSkipColumnCreation,
  } = useMigration()

  const prefix = selectedSolution?.publisherPrefix ?? 'cr9a1'

  const [fieldMappings, setFieldMappings] = useState<FieldMapping[]>([])
  const [ownerMappings, setOwnerMappings] = useState<OwnerMapping[]>([])
  const [systemUsers, setSystemUsers] = useState<DvSystemUser[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [userLoadError, setUserLoadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Initialise mappings from fetched data (or restore from context)
  // Re-runs when selectedSolution changes so logical names use the correct prefix
  useEffect(() => {
    if (!fetchedData) return
    if (mappingConfig) {
      setFieldMappings(mappingConfig.fieldMappings)
      setOwnerMappings(mappingConfig.ownerMappings)
    } else {
      setFieldMappings(buildInitialMappings(fetchedData, prefix))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchedData, mappingConfig, prefix])

  // Load Dataverse system users for owner matching
  useEffect(() => {
    if (!fetchedData) return
    setLoadingUsers(true)
    fetchSystemUsers()
      .then(users => {
        setSystemUsers(users)
        if (!mappingConfig) {
          setOwnerMappings(buildOwnerMappings(fetchedData, users))
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

  function setFieldDefault(idx: number, value: string) {
    setFieldMappings(prev => prev.map((m, i) => i === idx ? { ...m, manualDefault: value || undefined } : m))
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
        if (config.skipColumnCreation !== undefined) {
          setSkipColumnCreation(config.skipColumnCreation)
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
    setFieldMappings(buildInitialMappings(fetchedData, prefix))
  }

  // ── Next step ─────────────────────────────────────────────────────────────

  function handleNext() {
    const config: MappingConfiguration = {
      siteUrl: fetchedData?.pwaUrl ?? '',
      publisherPrefix: prefix,
      skipColumnCreation,
      fieldMappings,
      ownerMappings,
      savedAt: new Date().toISOString(),
    }
    setMappingConfig(config)
    nextStep()
  }

  const activeFields = fieldMappings.filter(m => !m.skip)
  const unmatchedOwners = ownerMappings.filter(m => !m.matched)

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
        <Checkbox
          label="Skip column creation (columns already exist in Dataverse)"
          checked={skipColumnCreation}
          onChange={(_, d) => setSkipColumnCreation(!!d.checked)}
        />
      </div>

      {/* ── Toolbar ── */}
      <div className={styles.toolbar}>
        <Button size="small" onClick={handleRedetectTypes}>Re-detect column types</Button>
        <Button size="small" onClick={handleSaveJson}>Save mapping as JSON</Button>
        <Button size="small" onClick={() => fileInputRef.current?.click()}>Load mapping from JSON</Button>
        <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleLoadJson} />
        <span className={styles.summary}>
          {activeFields.length} of {fieldMappings.length} fields active ·{' '}
          {unmatchedOwners.length > 0
            ? <span style={{ color: tokens.colorPaletteRedForeground1 }}>{unmatchedOwners.length} owner(s) unmatched</span>
            : <span style={{ color: '#107c10' }}>all owners matched</span>
          }
        </span>
      </div>

      {/* ── Field mapping table ── */}
      <div>
        <div className={styles.sectionTitle}>Custom Field Mapping ({fieldMappings.length} fields)</div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th} style={{ width: '32px' }}>Skip</th>
              <th className={styles.th}>Field Name</th>
              <th className={styles.th}>Entity</th>
              <th className={styles.th}>PO Type</th>
              <th className={styles.th}>Dataverse Column Type</th>
              <th className={styles.th}>Lookup / Notes</th>
              <th className={styles.th}>Default if not mapped</th>
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
            {fieldMappings.map((m, idx) => (
              <tr key={m.customField.CustomFieldId} className={m.skip ? styles.trSkipped : undefined}>
                <td className={styles.td}>
                  <Checkbox checked={m.skip} onChange={(_, d) => setFieldSkip(idx, !!d.checked)} />
                </td>
                <td className={styles.td}>
                  <div>{m.customField.CustomFieldName}</div>
                  <div className={styles.logicalName}>{m.targetLogicalName}</div>
                </td>
                <td className={styles.td}>
                  <span
                    className={styles.entityBadge}
                    style={{ background: ENTITY_COLORS[m.customField.CustomFieldEntityType] ?? '#888' }}
                  >
                    {m.customField.CustomFieldEntityType}
                  </span>
                </td>
                <td className={styles.td}>{m.customField.CustomFieldType}</td>
                <td className={styles.td}>
                  <Select
                    size="small"
                    value={m.targetColumnType}
                    onChange={(_, d) => setFieldType(idx, d.value as DataverseColumnType)}
                    disabled={m.skip}
                  >
                    {(DV_TYPE_ALTERNATIVES[m.customField.CustomFieldType] ?? [m.targetColumnType]).map(t => (
                      <option key={t} value={t}>{DV_TYPE_LABELS[t]}</option>
                    ))}
                  </Select>
                </td>
                <td className={styles.td}>
                  {m.lookupTable
                    ? <span style={{ fontSize: '12px' }}>
                        {m.lookupTable.LookupTableName}<br />
                        <span style={{ color: tokens.colorNeutralForeground3 }}>
                          {m.lookupTable.entries.length} entries
                        </span>
                      </span>
                    : <span style={{ color: tokens.colorNeutralForeground4, fontSize: '12px' }}>—</span>
                  }
                </td>
                <td className={styles.td}>
                  {!m.skip && m.lookupTable && (m.targetColumnType === 'OptionSet' || m.targetColumnType === 'MultiSelectOptionSet')
                    ? <Select
                        size="small"
                        value={m.manualDefault ?? ''}
                        onChange={(_, d) => setFieldDefault(idx, d.value)}
                      >
                        <option value="">— skip if not found —</option>
                        {m.lookupTable.entries.map(e => (
                          <option key={e.LookupEntryUID} value={e.LookupEntryUID}>
                            {e.LookupEntryFullValue || e.LookupEntryValue || e.LookupEntryUID}
                          </option>
                        ))}
                      </Select>
                    : <span style={{ color: tokens.colorNeutralForeground4, fontSize: '12px' }}>—</span>
                  }
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Divider />

      {/* ── Owner mapping ── */}
      <div>
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

      {/* ── Footer ── */}
      <div className={styles.footer}>
        <Button onClick={prevStep}>← Back</Button>
        <Button appearance="primary" onClick={handleNext} disabled={activeFields.length === 0}>
          Next: Create Columns →
        </Button>
      </div>
    </div>
  )
}
