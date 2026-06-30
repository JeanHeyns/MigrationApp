import { useMemo, useState } from 'react'
import {
  Button,
  MessageBar,
  MessageBarBody,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { useMigration } from '../../app/MigrationContext'
import { LoaderFeedbackPanel } from '../../components/LoaderFeedbackPanel'
import type { AssociationAttempt, ImportError } from '../../models/plannerPremium.types'
import type { LoaderWarning } from '../../services/fileUpload/types'
import type { SchemaCreationResults, SkippedFieldInstance } from '../../models/dataOnly.types'
import { buildScheduleDiagnostic } from '../../services/diagnostics/scheduleDiagnostic'
import { buildDependencyUnknownsDiagnostic } from '../../services/diagnostics/dependencyUnknownsDiagnostic'
import type { ProjectSettingsLite } from '../../services/diagnostics/types'
import { effectiveSettings } from '../../utils/effectiveProjectSettings'
import { getDataverseOrgUrl } from '../../config/environment'
import { fetchTasksForProjects } from '../../services/projectOnline/tasks'
import { fetchDependencies } from '../../services/projectOnline/dependencies'
import { fetchAssignmentsForProjects } from '../../services/projectOnline/assignments'

const useStyles = makeStyles({
  root: {
    padding: '32px',
    maxWidth: '760px',
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
  assocFilterBar: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '12px' },
  assocSearchInput: {
    marginLeft: 'auto',
    padding: '4px 8px',
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    fontSize: '12px',
    width: '200px',
    background: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
  },
  assocDetail: {
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
    padding: '10px',
    marginTop: '6px',
    fontSize: '12px',
    fontFamily: 'Consolas, monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  },
  statusOk: { color: tokens.colorPaletteGreenForeground1, fontWeight: '600' },
  statusWarn: { color: tokens.colorPaletteYellowForeground2, fontWeight: '600' },
  statusFail: { color: tokens.colorPaletteRedForeground1, fontWeight: '600' },
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

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
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
    ...(results.nnRelationships?.created ?? []).map(r => ['N:N Relationships', 'created', r.schemaName, r.poField]),
    ...(results.nnRelationships?.skipped ?? []).map(r => ['N:N Relationships', 'skipped', r.schemaName, r.reason]),
    ...(results.nnRelationships?.failed ?? []).map(r => ['N:N Relationships', 'failed', r.schemaName, r.error]),
  ]
}

function categoryTotal<T extends Record<string, unknown[]>>(category: T): number {
  return Object.values(category).reduce((sum, rows) => sum + rows.length, 0)
}

function buildWarningsCsvRows(warnings: LoaderWarning[]): string[][] {
  return [
    ['Sheet', 'Row', 'Column', 'Code', 'Message', 'Details'],
    ...warnings.map(w => [
      w.sheet,
      w.row != null ? String(w.row) : '',
      w.column ?? '',
      w.code,
      w.message,
      w.details != null ? JSON.stringify(w.details) : '',
    ]),
  ]
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

// ─── Association Diagnostics Panel ───────────────────────────────────────────

type AssocFilter = 'all' | 'failed' | 'nomatch'

function assocStatus(d: AssociationAttempt): { label: string; cls: 'ok' | 'warn' | 'fail' } {
  if (d.matchedGuids.length === 0) return { label: '⚠ no matches', cls: 'warn' }
  const failed = d.attempts.filter(a => a.errorMessage && a.errorCode !== 'AlreadyExists').length
  if (failed > 0) return { label: `✗ ${failed} failed`, cls: 'fail' }
  return { label: '✓ OK', cls: 'ok' }
}

function AssociationDiagnosticsPanel({ diagnostics }: { diagnostics: AssociationAttempt[] }) {
  const styles = useStyles()
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())
  const [expandedAttempts, setExpandedAttempts] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<AssocFilter>('all')
  const [search, setSearch] = useState('')

  function toggleRow(k: string) {
    setExpandedRows(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n })
  }
  function toggleAttempt(k: string) {
    setExpandedAttempts(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n })
  }

  const totalAttempts = diagnostics.reduce((s, d) => s + d.attempts.length, 0)
  const totalSucceeded = diagnostics.reduce((s, d) =>
    s + d.attempts.filter(a => !a.errorMessage || a.errorCode === 'AlreadyExists').length, 0)
  const totalFailed = diagnostics.reduce((s, d) =>
    s + d.attempts.filter(a => a.errorMessage && a.errorCode !== 'AlreadyExists').length, 0)
  const projectCount = new Set(diagnostics.map(d => d.projectId)).size

  const filtered = diagnostics.filter(d => {
    if (filter === 'failed' && !d.attempts.some(a => a.errorMessage && a.errorCode !== 'AlreadyExists')) return false
    if (filter === 'nomatch' && d.matchedGuids.length > 0) return false
    const q = search.toLowerCase()
    if (q && !d.projectName.toLowerCase().includes(q) && !d.poFieldName.toLowerCase().includes(q)) return false
    return true
  })

  function exportJson() {
    const blob = new Blob([JSON.stringify(diagnostics, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'association-diagnostics.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const filterBtn = (f: AssocFilter, label: string) => (
    <Button
      size="small"
      appearance={filter === f ? 'primary' : 'secondary'}
      onClick={() => setFilter(f)}
    >
      {label}
    </Button>
  )

  if (diagnostics.length === 0) {
    return (
      <div className={styles.panel}>
        <div className={styles.sectionTitle}>N:N Association Diagnostics</div>
        <MessageBar intent="warning">
          <MessageBarBody>
            No N:N association attempts recorded. This means no LookupMulti fields with N:N mapping were processed.
            Possible causes: no LookupMulti fields in mapping, all fields set to skip, or writer logic was not invoked.
          </MessageBarBody>
        </MessageBar>
      </div>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar} style={{ justifyContent: 'space-between', marginBottom: '10px' }}>
        <div className={styles.sectionTitle}>N:N Association Diagnostics</div>
        <Button size="small" onClick={exportJson}>Export JSON</Button>
      </div>

      <div className={styles.muted} style={{ marginBottom: '10px' }}>
        {projectCount} project{projectCount !== 1 ? 's' : ''} · {diagnostics.length} field mapping{diagnostics.length !== 1 ? 's' : ''} · {totalAttempts} attempt{totalAttempts !== 1 ? 's' : ''} · {totalSucceeded} OK · {totalFailed} failed
      </div>

      <div className={styles.assocFilterBar}>
        {filterBtn('all', 'All')}
        {filterBtn('failed', 'Only failed')}
        {filterBtn('nomatch', 'Only no matches')}
        <input
          className={styles.assocSearchInput}
          placeholder="Search project or field…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className={styles.muted}>No entries match the current filter.</div>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th}>Project</th>
              <th className={styles.th}>PO Field</th>
              <th className={styles.th}>Target Entity</th>
              <th className={styles.th} style={{ textAlign: 'right' }}>Requested</th>
              <th className={styles.th} style={{ textAlign: 'right' }}>Matched</th>
              <th className={styles.th} style={{ textAlign: 'right' }}>Attempts</th>
              <th className={styles.th}>Status</th>
              <th className={styles.th} style={{ width: '32px' }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((d, idx) => {
              const rowKey = `${d.projectId}::${d.poFieldName}::${idx}`
              const expanded = expandedRows.has(rowKey)
              const st = assocStatus(d)
              return (
                <>
                  <tr key={rowKey} style={{ cursor: 'pointer' }} onClick={() => toggleRow(rowKey)}>
                    <td className={styles.td}>{d.projectName}</td>
                    <td className={`${styles.td} ${styles.code}`}>{d.poFieldName}</td>
                    <td className={`${styles.td} ${styles.code}`}>{d.targetEntitySetName}</td>
                    <td className={styles.td} style={{ textAlign: 'right' }}>{d.requestedLabels.length}</td>
                    <td className={styles.td} style={{ textAlign: 'right' }}>{d.matchedGuids.length}</td>
                    <td className={styles.td} style={{ textAlign: 'right' }}>{d.attempts.length}</td>
                    <td className={styles.td}>
                      <span className={st.cls === 'ok' ? styles.statusOk : st.cls === 'warn' ? styles.statusWarn : styles.statusFail}>
                        {st.label}
                      </span>
                    </td>
                    <td className={styles.td}>{expanded ? '▲' : '▼'}</td>
                  </tr>
                  {expanded && (
                    <tr key={`${rowKey}::detail`}>
                      <td colSpan={8} className={styles.td} style={{ padding: '0 10px 12px' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '8px', fontSize: '12px' }}>
                          <div>
                            <strong>Requested ({d.requestedLabels.length})</strong>
                            <div className={styles.code} style={{ marginTop: '4px' }}>
                              {d.requestedLabels.length === 0 ? <span className={styles.muted}>—</span> : d.requestedLabels.join(', ')}
                            </div>
                          </div>
                          <div>
                            <strong>Matched GUIDs ({d.matchedGuids.length})</strong>
                            <div className={styles.code} style={{ marginTop: '4px' }}>
                              {d.matchedGuids.length === 0 ? <span className={styles.muted}>—</span> : d.matchedGuids.join('\n')}
                            </div>
                          </div>
                          {d.failedLabels.length > 0 && (
                            <div>
                              <strong className={styles.statusFail}>Not matched ({d.failedLabels.length})</strong>
                              <div className={styles.code} style={{ marginTop: '4px' }}>{d.failedLabels.join(', ')}</div>
                            </div>
                          )}
                        </div>

                        {d.attempts.length === 0 ? (
                          <div className={styles.statusWarn} style={{ marginTop: '10px', fontSize: '12px' }}>
                            No associate attempts made — matchedGuids was empty or loop was not reached.
                          </div>
                        ) : (
                          <div style={{ marginTop: '10px' }}>
                            <strong style={{ fontSize: '12px' }}>Attempts ({d.attempts.length})</strong>
                            {d.attempts.map((attempt, ai) => {
                              const attemptKey = `${rowKey}::attempt::${ai}`
                              const attemptExpanded = expandedAttempts.has(attemptKey)
                              const hasError = attempt.errorMessage && attempt.errorCode !== 'AlreadyExists'
                              return (
                                <div key={attemptKey} style={{ marginTop: '6px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: '4px', overflow: 'hidden' }}>
                                  <div
                                    style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', background: tokens.colorNeutralBackground3, cursor: 'pointer', fontSize: '12px' }}
                                    onClick={e => { e.stopPropagation(); toggleAttempt(attemptKey) }}
                                  >
                                    <span className={styles.code} style={{ flex: 1 }}>{attempt.targetGuid}</span>
                                    <span className={hasError ? styles.statusFail : styles.statusOk}>
                                      HTTP {attempt.httpStatus ?? '?'}{attempt.errorCode ? ` (${attempt.errorCode})` : ''}
                                    </span>
                                    <span className={styles.muted}>{attempt.durationMs}ms</span>
                                    <span className={styles.muted}>{attemptExpanded ? '▲' : '▼'}</span>
                                  </div>
                                  {attemptExpanded && (
                                    <div className={styles.assocDetail}>
                                      <div><strong>URL:</strong> POST {attempt.url}</div>
                                      <div style={{ marginTop: '6px' }}><strong>Body:</strong></div>
                                      <div>{JSON.stringify(attempt.body, null, 2)}</div>
                                      {attempt.errorMessage && (
                                        <div style={{ marginTop: '6px' }}>
                                          <strong className={styles.statusFail}>Error:</strong>
                                          <span> {attempt.errorMessage}</span>
                                        </div>
                                      )}
                                      <div style={{ marginTop: '6px' }} className={styles.muted}>{attempt.timestamp}</div>
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────

export function Step5Report() {
  const styles = useStyles()
  const {
    importResults, prevStep, setCurrentStep,
    migrationMode, skippedFieldInstances, selectedSolution,
    schemaCreationResults, resetState, associationDiagnostics,
    selectedProjectIds, fetchedData, setSelectedProjectIds,
    dataSource, pwaUrl, fileUploadWarnings, fileUploadFileName,
    projectDefaults, projectOverrides, scheduleModeOptions, addLog,
  } = useMigration()

  const [exportingDiagnostic, setExportingDiagnostic] = useState(false)
  const [exportingUnknowns, setExportingUnknowns] = useState(false)

  // One-shot debug tool — see docs/diagnostics/dependency-migration-audit.md.
  // TODO: prompt for project id instead of hard-coding the reference project.
  async function handleExportDependencyUnknowns() {
    setExportingUnknowns(true)
    try {
      const DV_PROJECT_ID = '878099e9-3053-49b6-a2de-4f8d3cf588fb'
      const poProject = fetchedData?.projects.find(
        p =>
          p.ProjectId.replace(/[{}]/g, '').toLowerCase() === DV_PROJECT_ID ||
          (p.ProjectName ?? '').trim().toLowerCase() === 'ads',
      )
      const report = await buildDependencyUnknownsDiagnostic({
        dvProjectId: DV_PROJECT_ID,
        pwaUrl: fetchedData?.pwaUrl || pwaUrl,
        poProjectId: poProject?.ProjectId,
        projectName: poProject?.ProjectName,
      })
      downloadJson(`dependency-unknowns-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, report)
    } catch (err) {
      addLog({ level: 'error', message: `Dependency unknowns export failed: ${String(err)}` })
    } finally {
      setExportingUnknowns(false)
    }
  }

  async function handleExportDiagnostic() {
    if (!fetchedData) return
    setExportingDiagnostic(true)
    try {
      const scheduleModeLabels = new Map<number, string>(scheduleModeOptions.map(o => [o.value, o.label]))
      const settingsByProject = new Map<string, ProjectSettingsLite>()
      for (const p of fetchedData.projects) {
        const eff = effectiveSettings(p.ProjectId, projectDefaults, projectOverrides)
        const scheduleModeLabel = eff.scheduleMode != null ? scheduleModeLabels.get(eff.scheduleMode) ?? null : null
        settingsByProject.set(p.ProjectId, { hoursPerDay: eff.hoursPerDay, scheduleMode: eff.scheduleMode, scheduleModeLabel })
      }
      const diagnosticProjects = selectedProjectIds.size > 0
        ? fetchedData.projects.filter(p => selectedProjectIds.has(p.ProjectId))
        : fetchedData.projects
      let diagnosticTasks = fetchedData.tasks
      let diagnosticDependencies = fetchedData.dependencies
      let diagnosticAssignments = fetchedData.assignments

      if (dataSource === 'ProjectOnline' && diagnosticProjects.length > 0 && (diagnosticTasks.length === 0 || diagnosticDependencies.length === 0 || diagnosticAssignments.length === 0)) {
        const siteUrl = fetchedData.pwaUrl || pwaUrl
        const [tasks, dependencies, assignments] = await Promise.all([
          diagnosticTasks.length === 0 ? fetchTasksForProjects(siteUrl, diagnosticProjects) : Promise.resolve(diagnosticTasks),
          diagnosticDependencies.length === 0 ? fetchDependencies(siteUrl, diagnosticProjects) : Promise.resolve(diagnosticDependencies),
          diagnosticAssignments.length === 0 ? fetchAssignmentsForProjects(siteUrl, diagnosticProjects) : Promise.resolve(diagnosticAssignments),
        ])
        diagnosticTasks = tasks
        diagnosticDependencies = dependencies
        diagnosticAssignments = assignments
      }

      const report = await buildScheduleDiagnostic({
        dataSource,
        migrationMode,
        tenantUrl: getDataverseOrgUrl(),
        selectedProjectIds,
        projects: fetchedData.projects,
        tasks: diagnosticTasks,
        dependencies: diagnosticDependencies,
        assignments: diagnosticAssignments,
        resources: fetchedData.resources,
        settingsByProject,
        scheduleModeLabels,
      })
      downloadJson(`schedule-diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, report)
    } catch (err) {
      addLog({ level: 'error', message: `Schedule diagnostic export failed: ${String(err)}` })
    } finally {
      setExportingDiagnostic(false)
    }
  }

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
      ['PO Field', 'Dataverse Field', 'Reason', 'Original Value', 'Source ID', 'Failed Labels', 'Resolved Labels'],
      ...skippedFieldInstances.map(inst => [
        inst.poField,
        inst.dvField,
        inst.reason,
        String(inst.originalValue ?? ''),
        inst.sourceId,
        inst.partialResolution?.failedLabels.join('|') ?? '',
        inst.partialResolution?.resolvedLabels.join('|') ?? '',
      ]),
    ])
  }

  function exportSchemaResults() {
    if (!schemaCreationResults) return
    const solutionName = selectedSolution?.uniquename ?? 'unknown'
    const date = new Date().toISOString().slice(0, 10)
    downloadCsv(`schema-creation-${solutionName}-${date}.csv`, schemaRows(schemaCreationResults))
  }

  function exportUploadWarnings() {
    if (!fileUploadWarnings.length) return
    const base = fileUploadFileName
      ? fileUploadFileName.replace(/\.[^.]+$/, '')
      : 'upload'
    const stamp = new Date().toISOString()
      .replace(/[-:]/g, '')
      .replace('T', '-')
      .slice(0, 13)
    downloadCsv(`${base}-warnings-${stamp}.csv`, buildWarningsCsvRows(fileUploadWarnings))
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
          <div className={styles.toolbar}>
            <Button size="small" onClick={exportSummary} disabled={importResults.length === 0}>Export summary CSV</Button>
            <Button
              size="small"
              onClick={handleExportDiagnostic}
              disabled={importResults.length === 0 || !fetchedData || exportingDiagnostic}
            >
              {exportingDiagnostic ? 'Building diagnostic…' : 'Export schedule diagnostics (JSON)'}
            </Button>
            <Button
              size="small"
              onClick={handleExportDependencyUnknowns}
              disabled={exportingUnknowns}
            >
              {exportingUnknowns ? 'Building audit…' : 'Export dependency-unknowns audit'}
            </Button>
          </div>
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

      {/* File Upload Warnings — FileUpload source only */}
      {dataSource === 'FileUpload' && fileUploadWarnings.length > 0 && (
        <div className={styles.panel}>
          <div className={styles.toolbar} style={{ justifyContent: 'space-between', marginBottom: '10px' }}>
            <div className={styles.sectionTitle}>
              File Upload Warnings ({fileUploadWarnings.length})
            </div>
            <Button size="small" onClick={exportUploadWarnings}>
              Export CSV ({fileUploadWarnings.length})
            </Button>
          </div>
          <LoaderFeedbackPanel
            mode="warnings"
            warnings={fileUploadWarnings}
            fileName={fileUploadFileName}
            title=""
          />
        </div>
      )}

      {/* N:N Association Diagnostics — dataOnly mode only */}
      {migrationMode === 'dataOnly' && (
        <AssociationDiagnosticsPanel diagnostics={associationDiagnostics} />
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
