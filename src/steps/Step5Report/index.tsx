import { useMemo, useState } from 'react'
import {
  Button,
  MessageBar,
  MessageBarBody,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { useMigration } from '../../app/MigrationContext'
import type { ImportError } from '../../models/plannerPremium.types'
import type { SchemaCreationResults, SkippedFieldInstance } from '../../models/dataOnly.types'

const useStyles = makeStyles({
  root: {
    padding: '32px',
    maxWidth: '1100px',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  title: { fontSize: '20px', fontWeight: '600', color: tokens.colorNeutralForeground1 },
  subtitle: { fontSize: '13px', color: tokens.colorNeutralForeground3, marginTop: '4px' },
  summaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '12px' },
  metric: {
    padding: '14px',
    background: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  metricLabel: { fontSize: '12px', color: tokens.colorNeutralForeground3 },
  metricValue: { fontSize: '24px', fontWeight: '600', color: tokens.colorNeutralForeground1, marginTop: '4px' },
  panel: {
    padding: '16px',
    background: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  sectionTitle: { fontSize: '15px', fontWeight: '600', marginBottom: '10px', color: tokens.colorNeutralForeground1 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
  th: {
    textAlign: 'left',
    padding: '8px 10px',
    background: tokens.colorNeutralBackground3,
    borderBottom: `2px solid ${tokens.colorNeutralStroke1}`,
    fontWeight: '600',
    color: tokens.colorNeutralForeground2,
  },
  td: { padding: '8px 10px', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, verticalAlign: 'top' },
  code: { fontFamily: 'Consolas, monospace', fontSize: '12px' },
  errorMessage: { maxWidth: '620px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  toolbar: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' },
  muted: { color: tokens.colorNeutralForeground3, fontSize: '12px' },
})

// ─── CSV helpers (shared) ─────────────────────────────────────────────────────

function csvEscape(value: unknown): string {
  const text = String(value ?? '')
  return `"${text.replace(/"/g, '""')}"`
}

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows.map(row => row.map(csvEscape).join(',')).join('\n')
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function flattenErrors(errors: ImportError[]): string[][] {
  return [
    ['Entity', 'Source ID', 'Timestamp', 'Message', 'ErrorClass'],
    ...errors.map(error => [error.entity, error.sourceId, error.timestamp, error.message, error.errorClass ?? '']),
  ]
}

// ─── Error grouping ───────────────────────────────────────────────────────────

const ERROR_CLASS_LABELS: Record<string, string> = {
  OutlineDemoteTooFar: 'Outline level invalid (E_DEMOTETOOFAR)',
  BatchFailed:         'Batch execution failed',
  Timeout:             'Gateway timeout (transient)',
  Throttled:           'API throttled',
  NonFSDependency:     'Non-FS dependency type (license limitation)',
  PredecessorMissing:  'Predecessor or successor task not imported',
  Other:               'Other error',
}

interface ProjectGroup {
  projectId: string
  projectName: string
  errors: ImportError[]
}

interface ErrorGroup {
  errorClass: string
  label: string
  total: number
  projectGroups: ProjectGroup[]
}

function buildErrorGroups(errors: ImportError[], projectNameMap: Map<string, string>): ErrorGroup[] {
  // Group: errorClass → projectId → errors
  const byClass = new Map<string, Map<string, ImportError[]>>()
  for (const e of errors) {
    const cls = e.errorClass ?? 'Other'
    const pid = e.projectId ?? '__unknown__'
    if (!byClass.has(cls)) byClass.set(cls, new Map())
    const byProject = byClass.get(cls)!
    const list = byProject.get(pid) ?? []
    list.push(e)
    byProject.set(pid, list)
  }

  return [...byClass.entries()].map(([cls, byProject]) => {
    const projectGroups: ProjectGroup[] = [...byProject.entries()].map(([pid, errs]) => ({
      projectId: pid,
      projectName: pid === '__unknown__' ? 'Unknown project' : (projectNameMap.get(pid) ?? pid),
      errors: errs,
    }))
    return {
      errorClass: cls,
      label: ERROR_CLASS_LABELS[cls] ?? cls,
      total: projectGroups.reduce((s, g) => s + g.errors.length, 0),
      projectGroups,
    }
  })
}

function schemaRows(results: SchemaCreationResults): string[][] {
  return [
    ['Category', 'Status', 'Entity/Name', 'Detail'],
    ...results.columns.created.map(r => ['Columns', 'created', `${r.entity}.${r.logicalName}`, r.type]),
    ...results.columns.skipped.map(r => ['Columns', 'skipped', `${r.entity}.${r.logicalName}`, r.reason]),
    ...results.columns.failed.map(r => ['Columns', 'failed', `${r.entity}.${r.logicalName}`, r.error]),
    ...results.optionSets.created.map(r => ['Option Sets', 'created', r.name, `${r.optionCount} options`]),
    ...results.optionSets.skipped.map(r => ['Option Sets', 'skipped', r.name, r.reason]),
    ...results.optionSets.failed.map(r => ['Option Sets', 'failed', r.name, r.error]),
    ...results.lookupEntities.created.map(r => ['Lookup Entities', 'created', r.logicalName, r.displayName]),
    ...results.lookupEntities.skipped.map(r => ['Lookup Entities', 'skipped', r.logicalName, r.reason]),
    ...results.lookupEntities.failed.map(r => ['Lookup Entities', 'failed', r.logicalName, r.error]),
    ...results.lookupEntries.inserted.map(r => ['Lookup Entries', 'inserted', `${r.entity}.${r.name}`, '']),
    ...results.lookupEntries.skipped.map(r => ['Lookup Entries', 'skipped', `${r.entity}.${r.name}`, r.reason]),
    ...results.lookupEntries.failed.map(r => ['Lookup Entries', 'failed', `${r.entity}.${r.name}`, r.error]),
  ]
}

function categoryTotal<T extends Record<string, unknown[]>>(category: T): number {
  return Object.values(category).reduce((sum, rows) => sum + rows.length, 0)
}

// ─── Skipped fields grouping ──────────────────────────────────────────────────

interface SkippedGroup {
  poField: string
  dvField: string
  reason: string
  count: number
  exampleValues: string[]
  extraCount: number
}

function buildSkippedGroups(instances: SkippedFieldInstance[]): SkippedGroup[] {
  const map = new Map<string, { poField: string; dvField: string; reason: string; count: number; uniqueValues: Set<string> }>()

  for (const inst of instances) {
    const key = `${inst.poField}||${inst.reason}`
    const valStr = String(inst.originalValue ?? '')
    const existing = map.get(key)
    if (existing) {
      existing.count++
      if (valStr) existing.uniqueValues.add(valStr)
    } else {
      map.set(key, {
        poField: inst.poField,
        dvField: inst.dvField,
        reason: inst.reason,
        count: 1,
        uniqueValues: valStr ? new Set([valStr]) : new Set(),
      })
    }
  }

  return [...map.values()]
    .sort((a, b) => b.count - a.count)
    .map(g => ({
      poField: g.poField,
      dvField: g.dvField,
      reason: g.reason,
      count: g.count,
      exampleValues: [...g.uniqueValues].slice(0, 5),
      extraCount: Math.max(0, g.uniqueValues.size - 5),
    }))
}

// ─── Component ────────────────────────────────────────────────────────────────

export function Step5Report() {
  const styles = useStyles()
  const {
    importResults, prevStep, setCurrentStep,
    migrationMode, skippedFieldInstances, selectedSolution,
    schemaCreationResults, resetState,
    selectedProjectIds, fetchedData, setSelectedProjectIds,
  } = useMigration()

  const totalRecords = importResults.reduce((s, r) => s + r.total, 0)
  const totalSucceeded = importResults.reduce((s, r) => s + r.succeeded, 0)
  const totalFailed = importResults.reduce((s, r) => s + r.failed, 0)
  const totalSkipped = importResults.reduce((s, r) => s + (r.skipped ?? 0), 0)
  const allErrors = importResults.flatMap(r => r.errors)
  const successRate = totalRecords > 0 ? Math.round((totalSucceeded / totalRecords) * 100) : 0

  const skippedGroups = useMemo(() => buildSkippedGroups(skippedFieldInstances), [skippedFieldInstances])
  const projectNameMap = useMemo(() => new Map(
    (fetchedData?.projects ?? []).map(p => [p.ProjectId, p.ProjectName])
  ), [fetchedData])
  const errorGroups = useMemo(() => buildErrorGroups(allErrors, projectNameMap), [allErrors, projectNameMap])
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  function toggleGroup(key: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  function exportSummary() {
    downloadCsv('migration-summary.csv', [
      ['Entity', 'Total', 'Succeeded', 'Failed', 'Success Rate'],
      ...importResults.map(result => [
        result.entity,
        String(result.total),
        String(result.succeeded),
        String(result.failed),
        result.total > 0 ? `${Math.round((result.succeeded / result.total) * 100)}%` : '0%',
      ]),
    ])
  }

  function exportErrors() {
    downloadCsv('migration-errors.csv', flattenErrors(allErrors))
  }

  function exportSkippedFields() {
    const solutionName = selectedSolution?.uniquename ?? 'unknown'
    const date = new Date().toISOString().slice(0, 10)
    downloadCsv(`skipped-fields-${solutionName}-${date}.csv`, [
      ['PO Field', 'Dataverse Field', 'Reason', 'Original Value', 'Source ID'],
      ...skippedFieldInstances.map(inst => [
        inst.poField,
        inst.dvField,
        inst.reason,
        String(inst.originalValue ?? ''),
        inst.sourceId,
      ]),
    ])
  }

  function exportSchemaResults() {
    if (!schemaCreationResults) return
    const solutionName = selectedSolution?.uniquename ?? 'unknown'
    const date = new Date().toISOString().slice(0, 10)
    downloadCsv(`schema-creation-${solutionName}-${date}.csv`, schemaRows(schemaCreationResults))
  }

  function handleNextBatch() {
    setSelectedProjectIds(new Set())
    setCurrentStep(2)
  }

  function handleStartNew() {
    resetState()
  }

  const showImportReport = migrationMode !== 'schemaOnly'

  return (
    <div className={styles.root}>
      <div>
        <div className={styles.title}>Step 5 - Validation Report</div>
        <div className={styles.subtitle}>
          Review import totals and skipped or failed records before closing the migration.
        </div>
      </div>

      {showImportReport && importResults.length === 0 && (
        <MessageBar intent="warning">
          <MessageBarBody>No import results are available yet. Run Step 4 first.</MessageBarBody>
        </MessageBar>
      )}

      {schemaCreationResults && (
        <div className={styles.panel}>
          <div className={styles.toolbar} style={{ justifyContent: 'space-between', marginBottom: '10px' }}>
            <div className={styles.sectionTitle}>Schema Creation Summary</div>
            <Button size="small" onClick={exportSchemaResults}>Export schema CSV</Button>
          </div>
          {categoryTotal(schemaCreationResults.columns) +
            categoryTotal(schemaCreationResults.optionSets) +
            categoryTotal(schemaCreationResults.lookupEntities) +
            categoryTotal(schemaCreationResults.lookupEntries) === 0 ? (
              <MessageBar intent="success">
                <MessageBarBody>No schema changes needed.</MessageBarBody>
              </MessageBar>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.th}>Category</th>
                    <th className={styles.th}>Created / inserted</th>
                    <th className={styles.th}>Skipped</th>
                    <th className={styles.th}>Failed</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className={styles.td}>Columns</td>
                    <td className={styles.td}>{schemaCreationResults.columns.created.length}</td>
                    <td className={styles.td}>{schemaCreationResults.columns.skipped.length}</td>
                    <td className={styles.td}>{schemaCreationResults.columns.failed.length}</td>
                  </tr>
                  <tr>
                    <td className={styles.td}>Option Sets</td>
                    <td className={styles.td}>{schemaCreationResults.optionSets.created.length}</td>
                    <td className={styles.td}>{schemaCreationResults.optionSets.skipped.length}</td>
                    <td className={styles.td}>{schemaCreationResults.optionSets.failed.length}</td>
                  </tr>
                  <tr>
                    <td className={styles.td}>Lookup Entities</td>
                    <td className={styles.td}>{schemaCreationResults.lookupEntities.created.length}</td>
                    <td className={styles.td}>{schemaCreationResults.lookupEntities.skipped.length}</td>
                    <td className={styles.td}>{schemaCreationResults.lookupEntities.failed.length}</td>
                  </tr>
                  <tr>
                    <td className={styles.td}>Lookup Entries</td>
                    <td className={styles.td}>{schemaCreationResults.lookupEntries.inserted.length}</td>
                    <td className={styles.td}>{schemaCreationResults.lookupEntries.skipped.length}</td>
                    <td className={styles.td}>{schemaCreationResults.lookupEntries.failed.length}</td>
                  </tr>
                </tbody>
              </table>
            )}
        </div>
      )}

      {showImportReport && (
      <>
      <div className={styles.summaryGrid}>
        {fetchedData && (
          <div className={styles.metric}>
            <div className={styles.metricLabel}>Projects migrated</div>
            <div className={styles.metricValue}>
              {selectedProjectIds.size}
              <span style={{ fontSize: '14px', fontWeight: 'normal', color: tokens.colorNeutralForeground3 }}>
                {' '}/ {fetchedData.projects.length}
              </span>
            </div>
          </div>
        )}
        <div className={styles.metric}>
          <div className={styles.metricLabel}>Records processed</div>
          <div className={styles.metricValue}>{totalRecords}</div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricLabel}>Succeeded</div>
          <div className={styles.metricValue}>{totalSucceeded}</div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricLabel}>Failed / skipped</div>
          <div className={styles.metricValue}>{totalFailed}</div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricLabel}>Success rate</div>
          <div className={styles.metricValue}>{successRate}%</div>
        </div>
      </div>

      {/* Entity Results */}
      <div className={styles.panel}>
        <div className={styles.toolbar} style={{ justifyContent: 'space-between', marginBottom: '10px' }}>
          <div className={styles.sectionTitle}>Entity Results</div>
          <Button size="small" onClick={exportSummary} disabled={importResults.length === 0}>Export summary CSV</Button>
        </div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th}>Entity</th>
              <th className={styles.th}>Total</th>
              <th className={styles.th}>Succeeded</th>
              <th className={styles.th}>Failed / skipped</th>
              <th className={styles.th}>Rate</th>
            </tr>
          </thead>
          <tbody>
            {importResults.map(result => (
              <tr key={result.entity}>
                <td className={styles.td}>{result.entity}</td>
                <td className={styles.td}>{result.total}</td>
                <td className={styles.td}>{result.succeeded}</td>
                <td className={styles.td}>{result.failed}</td>
                <td className={styles.td}>
                  {result.total > 0 ? `${Math.round((result.succeeded / result.total) * 100)}%` : '0%'}
                </td>
              </tr>
            ))}
            {importResults.length === 0 && (
              <tr><td className={styles.td} colSpan={5}>No results.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Already-existed skipped records — info panel */}
      {totalSkipped > 0 && (
        <div className={styles.panel}>
          <div className={styles.sectionTitle} style={{ marginBottom: '8px' }}>
            Records already existed — skipped ({totalSkipped})
          </div>
          <MessageBar intent="info">
            <MessageBarBody>
              {totalSkipped} record{totalSkipped !== 1 ? 's' : ''} already existed in the target environment and were left unchanged.
              {' '}If this is unexpected, a previous run may have partially completed.
            </MessageBarBody>
          </MessageBar>
          {importResults.filter(r => (r.skipped ?? 0) > 0).map(r => (
            <div key={r.entity} className={styles.muted} style={{ marginTop: '6px' }}>
              {r.entity}: {r.skipped} skipped
            </div>
          ))}
        </div>
      )}

      {/* Failures grouped by error class */}
      <div className={styles.panel}>
        <div className={styles.toolbar} style={{ justifyContent: 'space-between', marginBottom: '10px' }}>
          <div className={styles.sectionTitle}>Import Failures ({totalFailed})</div>
          <Button size="small" onClick={exportErrors} disabled={allErrors.length === 0}>Export errors CSV</Button>
        </div>
        {allErrors.length === 0 ? (
          <MessageBar intent="success">
            <MessageBarBody>No import failures.</MessageBarBody>
          </MessageBar>
        ) : (
          errorGroups.map(group => {
            const classKey = group.errorClass
            const classExpanded = expandedGroups.has(classKey)
            return (
              <div key={classKey} style={{ marginBottom: '12px' }}>
                {/* Error class header */}
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', padding: '6px 0', borderBottom: `1px solid ${tokens.colorNeutralStroke2}` }}
                  onClick={() => toggleGroup(classKey)}
                >
                  <span style={{ fontSize: '13px', fontWeight: '600', color: tokens.colorNeutralForeground1 }}>
                    {group.label}
                  </span>
                  <span className={styles.muted}>({group.total})</span>
                  <span className={styles.muted} style={{ marginLeft: 'auto' }}>{classExpanded ? '▲' : '▼'}</span>
                </div>

                {/* Per-project sub-groups */}
                {classExpanded && group.projectGroups.map(pg => {
                  const projectKey = `${classKey}::${pg.projectId}`
                  const projectExpanded = expandedGroups.has(projectKey)
                  return (
                    <div key={projectKey} style={{ marginLeft: '16px', marginTop: '6px' }}>
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '4px 0' }}
                        onClick={() => toggleGroup(projectKey)}
                      >
                        <span style={{ fontSize: '12px', color: tokens.colorNeutralForeground2 }}>
                          {pg.projectName}
                        </span>
                        <span className={styles.muted}>— {pg.errors.length} error{pg.errors.length !== 1 ? 's' : ''}</span>
                        <span className={styles.muted} style={{ marginLeft: 'auto' }}>{projectExpanded ? '▲' : '▼'}</span>
                      </div>
                      {projectExpanded && (
                        <table className={styles.table} style={{ marginTop: '4px' }}>
                          <thead>
                            <tr>
                              <th className={styles.th}>Entity</th>
                              <th className={styles.th}>Source ID</th>
                              <th className={styles.th}>Message</th>
                              <th className={styles.th}>Time</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pg.errors.map((error: ImportError, idx: number) => (
                              <tr key={`${error.entity}-${error.sourceId}-${idx}`}>
                                <td className={styles.td}>{error.entity}</td>
                                <td className={`${styles.td} ${styles.code}`}>{error.sourceId}</td>
                                <td className={`${styles.td} ${styles.errorMessage}`}>{error.message}</td>
                                <td className={styles.td}>{new Date(error.timestamp).toLocaleString()}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })
        )}
      </div>
      </>
      )}

      {/* Skipped Fields — dataOnly mode only */}
      {migrationMode === 'dataOnly' && (
        <div className={styles.panel}>
          <div className={styles.toolbar} style={{ justifyContent: 'space-between', marginBottom: '10px' }}>
            <div className={styles.sectionTitle}>Skipped Fields</div>
            <Button size="small" onClick={exportSkippedFields} disabled={skippedFieldInstances.length === 0}>
              Export CSV ({skippedFieldInstances.length})
            </Button>
          </div>

          {skippedGroups.length === 0 ? (
            <MessageBar intent="success">
              <MessageBarBody>All fields migrated successfully — no unresolved choice or lookup values.</MessageBarBody>
            </MessageBar>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th}>PO Field</th>
                  <th className={styles.th}>Dataverse Field</th>
                  <th className={styles.th}>Reason</th>
                  <th className={styles.th} style={{ width: '72px', textAlign: 'right' }}>Records</th>
                  <th className={styles.th}>Example values</th>
                </tr>
              </thead>
              <tbody>
                {skippedGroups.map((group, idx) => (
                  <tr key={idx}>
                    <td className={`${styles.td} ${styles.code}`}>{group.poField}</td>
                    <td className={`${styles.td} ${styles.code}`}>{group.dvField}</td>
                    <td className={styles.td} style={{ maxWidth: '340px', wordBreak: 'break-word' }}>{group.reason}</td>
                    <td className={styles.td} style={{ textAlign: 'right', fontWeight: '600' }}>{group.count}</td>
                    <td className={styles.td}>
                      <span className={styles.code}>
                        {group.exampleValues.map((v, i) => (
                          <span key={i}>
                            {i > 0 && <span className={styles.muted}>, </span>}
                            &ldquo;{v}&rdquo;
                          </span>
                        ))}
                      </span>
                      {group.extraCount > 0 && (
                        <span className={styles.muted}> +{group.extraCount} more</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <div className={styles.footer}>
        <Button onClick={prevStep}>{migrationMode === 'schemaOnly' ? 'Back to Schema Creation' : 'Back to Import'}</Button>
        <Button appearance="primary" onClick={handleNextBatch}>Migrate Next Batch</Button>
        <Button onClick={handleStartNew}>Start New Migration</Button>
      </div>
    </div>
  )
}
