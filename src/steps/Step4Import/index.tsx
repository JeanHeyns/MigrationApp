import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Checkbox,
  MessageBar,
  MessageBarBody,
  ProgressBar,
  Select,
  Spinner,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { useMigration, isFilterActive } from '../../app/MigrationContext'
import { BulkActions } from '../../components/ProjectSelection/BulkActions'
import { FilterBar } from '../../components/ProjectSelection/FilterBar'
import { applyFilter } from '../../utils/projectFilter'
import { writeResources } from '../../services/plannerPremium/resourceWriter'
import { writeProjects } from '../../services/plannerPremium/projectWriter'
import type { ProjectWriteResult } from '../../services/plannerPremium/projectWriter'
import { fetchSystemUsers } from '../../services/plannerPremium/dataverseClient'
import type { DvSystemUser } from '../../models/plannerPremium.types'
import { writeTasks } from '../../services/plannerPremium/taskWriter'
import type { TaskWriteResult } from '../../services/plannerPremium/taskWriter'
import { writeDependencies } from '../../services/plannerPremium/dependencyWriter'
import type { DependencyWriteResult } from '../../services/plannerPremium/dependencyWriter'
import { writeTeamMembers, writeAssignments } from '../../services/plannerPremium/assignmentWriter'
import type { AssignmentWriteResult } from '../../services/plannerPremium/assignmentWriter'
import { buildResolverMap, clearResolverCaches } from '../../services/plannerPremium/resolverFactory'
import type { FieldResolver } from '../../services/plannerPremium/resolverFactory'
import type { ImportError, ImportResult } from '../../models/plannerPremium.types'
import type { PoTask } from '../../models/projectOnline.types'
import type { SkippedFieldInstance } from '../../models/dataOnly.types'
import { getConcurrencyLimit, runWithConcurrency } from '../../services/plannerPremium/concurrency'
import { useBrowserCloseGuard } from '../../hooks/useBrowserCloseGuard'

const useStyles = makeStyles({
  root: { padding: '32px', maxWidth: '1100px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '24px' },
  title: { fontSize: '20px', fontWeight: '600', color: tokens.colorNeutralForeground1 },
  subtitle: { fontSize: '13px', color: tokens.colorNeutralForeground3, marginTop: '4px' },
  toolbar: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  panel: {
    padding: '16px',
    background: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
  th: {
    textAlign: 'left',
    padding: '8px 10px',
    background: tokens.colorNeutralBackground3,
    borderBottom: `2px solid ${tokens.colorNeutralStroke1}`,
    fontWeight: '600',
    color: tokens.colorNeutralForeground2,
  },
  td: { padding: '7px 10px', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, verticalAlign: 'middle' },
  muted: { color: tokens.colorNeutralForeground3 },
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' },
  log: {
    maxHeight: '220px',
    overflowY: 'auto',
    fontFamily: 'Consolas, monospace',
    fontSize: '12px',
    lineHeight: '18px',
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusSmall,
    padding: '10px',
  },
  progressRow: {
    display: 'flex',
    gap: '24px',
    fontSize: '13px',
    color: tokens.colorNeutralForeground2,
    flexWrap: 'wrap',
  },
})

type Phase = 'Ready' | 'Building resolvers' | 'Resources' | 'Importing' | 'Done' | 'Stopped' | 'Failed'

export function Step4Import() {
  const styles = useStyles()
  const {
    fetchedData, mappingConfig, optionSetMappings, nextStep, prevStep,
    addImportResult, clearImportResults,
    migrationMode, resolverPlan,
    addSkippedFieldInstances, clearSkippedFieldInstances,
    addProjectWriteDiagnostics, clearProjectWriteDiagnostics,
    addLog, setCurrentStep,
    migrationScope,
    importProgress, startImport, completeProject, clearImportProgress,
    requestStop, clearStopRequest, setImportWasStopped,
  } = useMigration()

  const { selectedProjectIds, toggleProjectSelection, projectFilter } = useMigration()
  const [systemUsers, setSystemUsers] = useState<DvSystemUser[]>([])
  const [projectOwnerMap, setProjectOwnerMap] = useState<Record<string, string>>({})
  const [phase, setPhase] = useState<Phase>('Ready')
  const [running, setRunning] = useState(false)
  const [logLines, setLogLines] = useState<string[]>([])
  const [completed, setCompleted] = useState(0)
  const [total, setTotal] = useState(0)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [confirmScheduleRebuild, setConfirmScheduleRebuild] = useState(false)
  const [stopButtonPressed, setStopButtonPressed] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const logRef = useRef<HTMLDivElement>(null)
  const stopRequestedRef = useRef(false)

  useBrowserCloseGuard(running)

  useEffect(() => {
    if (migrationMode === 'schemaOnly') setCurrentStep(5)
  }, [migrationMode, setCurrentStep])

  useEffect(() => {
    fetchSystemUsers().then(users => {
      setSystemUsers(users)
      if (fetchedData?.projects) {
        const autoMap: Record<string, string> = {}
        for (const project of fetchedData.projects) {
          if (!project.ProjectOwnerName) continue
          const ownerNameLower = project.ProjectOwnerName.toLowerCase()
          const match = users.find(u => u.fullname?.toLowerCase() === ownerNameLower)
          if (match) autoMap[project.ProjectId] = match.systemuserid
        }
        setProjectOwnerMap(autoMap)
      }
    }).catch(() => {})
  }, [fetchedData?.projects])

  useEffect(() => {
    if (!running) { setElapsed(0); return }
    const interval = setInterval(() => {
      if (importProgress) setElapsed(Date.now() - importProgress.startedAt.getTime())
    }, 1000)
    return () => clearInterval(interval)
  }, [running, importProgress])

  const selectedProjects = useMemo(
    () => fetchedData?.projects.filter(p => selectedProjectIds.has(p.ProjectId)) ?? [],
    [fetchedData?.projects, selectedProjectIds],
  )
  const selectedProjectIdLookup = useMemo(() => new Set(selectedProjects.map(p => p.ProjectId)), [selectedProjects])
  const selectedTasks = useMemo(() =>
    fetchedData?.tasks.filter(t =>
      selectedProjectIdLookup.has(t.ProjectId) &&
      t.TaskId !== '0' &&
      t.TaskOutlineNumber !== '0' &&
      t.TaskOutlineLevel !== 0
    ) ?? [],
    [fetchedData?.tasks, selectedProjectIdLookup],
  )
  const selectedTeamMembers = useMemo(() =>
    fetchedData?.teamMembers.filter(tm => selectedProjectIdLookup.has(tm.ProjectId)) ?? [],
    [fetchedData?.teamMembers, selectedProjectIdLookup],
  )
  const selectedAssignments = useMemo(() =>
    fetchedData?.assignments.filter(a => selectedProjectIdLookup.has(a.ProjectId)) ?? [],
    [fetchedData?.assignments, selectedProjectIdLookup],
  )
  const selectedDependencies = useMemo(() =>
    fetchedData?.dependencies.filter(d => selectedProjectIdLookup.has(d.ProjectId)) ?? [],
    [fetchedData?.dependencies, selectedProjectIdLookup],
  )

  const tasksByProjectId = useMemo(() => {
    const map = new Map<string, PoTask[]>()
    for (const t of fetchedData?.tasks ?? []) {
      const arr = map.get(t.ProjectId) ?? []
      arr.push(t)
      map.set(t.ProjectId, arr)
    }
    return map
  }, [fetchedData?.tasks])

  const ownerNames = useMemo(() =>
    [...new Set((fetchedData?.projects ?? []).map(p => p.ProjectOwnerName).filter(Boolean) as string[])].sort(),
    [fetchedData?.projects],
  )

  const filteredProjects = useMemo(() =>
    isFilterActive(projectFilter)
      ? applyFilter(fetchedData?.projects ?? [], projectFilter, tasksByProjectId)
      : (fetchedData?.projects ?? []),
    [fetchedData?.projects, projectFilter, tasksByProjectId],
  )

  if (!fetchedData || !mappingConfig) {
    return (
      <div className={styles.root}>
        <MessageBar intent="warning">
          <MessageBarBody>Missing fetched data or mapping configuration. Go back to Step 1/2 first.</MessageBarBody>
        </MessageBar>
        <Button onClick={prevStep}>Back</Button>
      </div>
    )
  }
  const data = fetchedData
  const config = mappingConfig

  function appendLog(message: string) {
    setLogLines(prev => [...prev, `${new Date().toLocaleTimeString()}  ${message}`])
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
    })
  }

  function makeResult(entity: string, totalRows: number, errors: ImportError[]): ImportResult {
    return {
      entity,
      total: totalRows,
      succeeded: totalRows - errors.length,
      failed: errors.length,
      errors,
    }
  }

  function handleStopClick() {
    const concurrency = getConcurrencyLimit()
    const confirmed = window.confirm(
      `Stop migration after current projects complete?\n\n` +
      `Up to ${concurrency} projects in progress will finish first. ` +
      `Subsequent projects will be skipped. Partial results will be available in the report.`
    )
    if (!confirmed) return
    stopRequestedRef.current = true
    setStopButtonPressed(true)
    requestStop()
    appendLog('Stop requested — finishing current projects')
  }

  async function runImport() {
    setRunning(true)
    setFatalError(null)
    setLogLines([])
    clearImportResults()
    clearSkippedFieldInstances()
    clearProjectWriteDiagnostics()
    clearStopRequest()
    clearImportProgress()
    stopRequestedRef.current = false
    setStopButtonPressed(false)

    const isDataOnly = migrationMode === 'dataOnly'
    const concurrency = getConcurrencyLimit()

    let totalOps = data.resources.length + selectedProjects.length + selectedTeamMembers.length
    if (migrationScope.tasks) totalOps += selectedTasks.length
    if (migrationScope.dependencies) totalOps += selectedDependencies.length
    if (migrationScope.assignments) totalOps += selectedAssignments.length
    setTotal(totalOps)
    setCompleted(0)

    startImport(selectedProjects.length, concurrency)
    appendLog(`Starting import — ${selectedProjects.length} projects, concurrency=${concurrency}`)

    let resolvers: Map<string, FieldResolver> | undefined

    if (isDataOnly) {
      if (!resolverPlan) {
        setFatalError('Resolver plan missing. Go back to Step 2 and save the mapping.')
        setRunning(false)
        return
      }
      setPhase('Building resolvers')
      appendLog('Building field resolvers…')
      try {
        clearResolverCaches()
        const { resolvers: built, warnings } = await buildResolverMap(resolverPlan)
        resolvers = built
        for (const w of warnings) {
          appendLog(`[Resolver ${w.severity.toUpperCase()}] ${w.field}: ${w.message}`)
          addLog({ level: w.severity === 'error' ? 'error' : 'warning', message: `Resolver build — ${w.field}: ${w.message}` })
        }
        appendLog(`Resolvers ready: ${resolvers.size} field(s)`)
      } catch (e) {
        setFatalError(`Failed to build resolvers: ${String(e)}`)
        setRunning(false)
        return
      }
    }

    try {
      // Phase 1: Resources (sequential, before parallel project loop)
      setPhase('Resources')
      appendLog(`Matching/importing ${data.resources.length} resources`)
      const resourceResults = await writeResources(data.resources, r => {
        setCompleted(c => c + 1)
        appendLog(`${r.success ? 'OK' : 'SKIP'} resource ${r.poResourceUid}${r.error ? `: ${r.error.message}` : ''}`)
      })
      const resourceIdMap = Object.fromEntries(
        resourceResults.filter(r => r.success && r.dvBookableResourceId)
          .map(r => [r.poResourceUid, r.dvBookableResourceId as string])
      )

      // Phase 2: Per-project parallel (project + team members + tasks + deps + assignments)
      setPhase('Importing')
      const allProjectResults: ProjectWriteResult[] = []
      const allTeamResults: AssignmentWriteResult[] = []
      const allTaskResults: TaskWriteResult[] = []
      const allDepResults: DependencyWriteResult[] = []
      const allAssignResults: AssignmentWriteResult[] = []
      const allSkipped: SkippedFieldInstance[] = []

      await runWithConcurrency(
        selectedProjects,
        async (project) => {
          if (stopRequestedRef.current) {
            appendLog(`[${project.ProjectName}] Skipped`)
            return
          }

          const projectStart = Date.now()

          const projectResults = await writeProjects([project], config, optionSetMappings, r => {
            setCompleted(c => c + 1)
            appendLog(`[${project.ProjectName}] ${r.success ? 'OK' : 'ERR'} project${r.error ? `: ${r.error.message}` : ''}${r.skippedFields?.length ? ` (${r.skippedFields.length} field(s) skipped)` : ''}`)
          }, resolvers, projectOwnerMap)
          allProjectResults.push(...projectResults)
          addProjectWriteDiagnostics(projectResults.flatMap(r => r.diagnostic ? [r.diagnostic] : []))

          if (isDataOnly) {
            const skipped: SkippedFieldInstance[] = projectResults.flatMap(r =>
              (r.skippedFields ?? []).map(sf => ({
                poField: sf.poField,
                dvField: sf.dvField,
                reason: sf.reason,
                originalValue: sf.originalValue,
                partialResolution: sf.partialResolution,
                sourceId: r.poProjectId,
              }))
            )
            allSkipped.push(...skipped)
          }

          const dvProjectId = projectResults.find(r => r.poProjectId === project.ProjectId && r.success)?.dvProjectId
          if (!dvProjectId) {
            completeProject(Date.now() - projectStart)
            return
          }

          const singleProjectMap = { [project.ProjectId]: dvProjectId }

          const projectTeamMembers = selectedTeamMembers.filter(tm => tm.ProjectId === project.ProjectId)
          const teamResults = await writeTeamMembers(projectTeamMembers, singleProjectMap, resourceIdMap, r => {
            setCompleted(c => c + 1)
            appendLog(`[${project.ProjectName}] ${r.success ? 'OK' : 'SKIP'} team member ${r.poAssignmentId}${r.error ? `: ${r.error.message}` : ''}`)
          })
          allTeamResults.push(...teamResults)
          const projectTeamMemberIdMap = Object.fromEntries(
            teamResults.filter(r => r.success && r.dvAssignmentId)
              .map(r => [r.poAssignmentId, r.dvAssignmentId as string])
          )

          if (migrationScope.tasks) {
            const projectTasks = selectedTasks.filter(t => t.ProjectId === project.ProjectId)
            const taskResults = await writeTasks(projectTasks, singleProjectMap, config, optionSetMappings, r => {
              setCompleted(c => c + 1)
              appendLog(`[${project.ProjectName}] ${r.success ? 'OK' : 'ERR'} task ${r.poTaskId}${r.error ? `: ${r.error.message}` : ''}`)
            })
            allTaskResults.push(...taskResults)
            const projectTaskIdMap = Object.fromEntries(
              taskResults.filter(r => r.success && r.dvTaskId)
                .map(r => [r.poTaskId, r.dvTaskId as string])
            )

            if (migrationScope.dependencies) {
              const projectDeps = selectedDependencies.filter(d => d.ProjectId === project.ProjectId)
              if (projectDeps.length > 0) {
                const depResults = await writeDependencies(projectDeps, singleProjectMap, projectTaskIdMap, r => {
                  setCompleted(c => c + 1)
                  appendLog(`[${project.ProjectName}] ${r.success ? 'OK' : 'SKIP'} dependency ${r.poDependencyId}${r.error ? `: ${r.error.message}` : ''}`)
                })
                allDepResults.push(...depResults)
              }
            }

            if (migrationScope.assignments) {
              const projectAssignments = selectedAssignments.filter(a => a.ProjectId === project.ProjectId)
              if (projectAssignments.length > 0) {
                const assignResults = await writeAssignments(
                  projectAssignments, singleProjectMap, projectTaskIdMap, projectTeamMemberIdMap, r => {
                    setCompleted(c => c + 1)
                    appendLog(`[${project.ProjectName}] ${r.success ? 'OK' : 'SKIP'} assignment ${r.poAssignmentId}${r.error ? `: ${r.error.message}` : ''}`)
                  }
                )
                allAssignResults.push(...assignResults)
              }
            }
          }

          completeProject(Date.now() - projectStart)
          appendLog(`[${project.ProjectName}] Complete`)
        },
        concurrency,
      )

      // Aggregate results for Step 5 report
      addImportResult(makeResult('Resources', resourceResults.length, resourceResults.flatMap(r => r.error ? [r.error] : [])))
      addImportResult(makeResult('Projects', allProjectResults.length, allProjectResults.flatMap(r => r.error ? [r.error] : [])))
      addImportResult(makeResult('Team members', allTeamResults.length, allTeamResults.flatMap(r => r.error ? [r.error] : [])))
      if (migrationScope.tasks) {
        addImportResult(makeResult('Tasks', allTaskResults.length, allTaskResults.flatMap(r => r.error ? [r.error] : [])))
        if (migrationScope.dependencies && allDepResults.length > 0) {
          addImportResult(makeResult('Dependencies', allDepResults.length, allDepResults.flatMap(r => r.error ? [r.error] : [])))
        }
        if (migrationScope.assignments && allAssignResults.length > 0) {
          addImportResult(makeResult('Assignments', allAssignResults.length, allAssignResults.flatMap(r => r.error ? [r.error] : [])))
        }
      }

      if (isDataOnly && allSkipped.length > 0) {
        addSkippedFieldInstances(allSkipped)
        appendLog(`${allSkipped.length} field value(s) skipped — see Step 5 Skipped Fields for details`)
      }

      if (stopRequestedRef.current) {
        setImportWasStopped(true)
        setPhase('Stopped')
        appendLog('Import stopped — some projects were skipped')
      } else {
        setPhase('Done')
        appendLog('Import completed')
      }
    } catch (e) {
      setPhase('Failed')
      setFatalError(String(e))
      appendLog(`Fatal error: ${String(e)}`)
    } finally {
      setRunning(false)
    }
  }

  const progressPct = total > 0 ? completed / total : 0
  const canProceed = phase === 'Done' || phase === 'Stopped'

  return (
    <div className={styles.root}>
      <div>
        <div className={styles.title}>Step 4 — Import Data</div>
        <div className={styles.subtitle}>
          Select projects, then import resources, projects, team members, tasks, and assignments.
        </div>
      </div>

      {fatalError && (
        <MessageBar intent="error">
          <MessageBarBody>{fatalError}</MessageBarBody>
        </MessageBar>
      )}

      <MessageBar intent="warning">
        <MessageBarBody>
          Import rebuilds the schedule for every selected project. Existing tasks, dependencies, and assignments are cleared before tasks are imported again.
        </MessageBarBody>
      </MessageBar>

      <Checkbox
        checked={confirmScheduleRebuild}
        disabled={running}
        label="I understand selected project schedules will be cleared and rebuilt"
        onChange={(_, d) => setConfirmScheduleRebuild(!!d.checked)}
      />

      <div style={{ fontSize: '13px', color: tokens.colorNeutralForeground3 }}>
        Scope: Projects ✓
        {migrationScope.tasks ? ' · Tasks ✓' : ' · Tasks ✗'}
        {migrationScope.dependencies ? ' · Dependencies ✓' : ' · Dependencies ✗'}
        {migrationScope.assignments ? ' · Assignments ✓' : ' · Assignments ✗'}
        {migrationScope.resources ? ' · Resources ✓' : ' · Resources ✗'}
      </div>

      <FilterBar
        ownerNames={ownerNames}
        tasksAvailable={migrationScope.tasks}
      />

      <BulkActions
        allProjectIds={data.projects.map(p => p.ProjectId)}
        displayedProjectIds={filteredProjects.map(p => p.ProjectId)}
        disabled={running}
      />
      <span className={styles.muted} style={{ fontSize: '13px' }}>
        {selectedProjects.length} of {data.projects.length} projects selected
        {isFilterActive(projectFilter) ? ` · showing ${filteredProjects.length} filtered` : ''}
        {migrationScope.tasks ? ` · ${selectedTasks.length} tasks` : ''}
        {migrationScope.assignments ? ` · ${selectedAssignments.length} assignments` : ''}
      </span>

      <div className={styles.panel}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th} style={{ width: '48px' }}>Import</th>
              <th className={styles.th}>Project</th>
              <th className={styles.th}>Start</th>
              <th className={styles.th}>Finish</th>
              <th className={styles.th}>Owner / Project Manager</th>
            </tr>
          </thead>
          <tbody>
            {filteredProjects.map(project => (
              <tr key={project.ProjectId}>
                <td className={styles.td}>
                  <Checkbox
                    checked={selectedProjectIds.has(project.ProjectId)}
                    disabled={running}
                    onChange={() => toggleProjectSelection(project.ProjectId)}
                  />
                </td>
                <td className={styles.td}>{project.ProjectName}</td>
                <td className={styles.td}>{project.ProjectStartDate ?? '-'}</td>
                <td className={styles.td}>{project.ProjectFinishDate ?? '-'}</td>
                <td className={styles.td}>
                  <Select
                    size="small"
                    disabled={running}
                    value={projectOwnerMap[project.ProjectId] ?? ''}
                    onChange={(_, d) => setProjectOwnerMap(prev => ({ ...prev, [project.ProjectId]: d.value }))}
                  >
                    <option value="">— no override —</option>
                    {systemUsers.map(u => (
                      <option key={u.systemuserid} value={u.systemuserid}>{u.fullname}</option>
                    ))}
                  </Select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.panel}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className={styles.toolbar}>
            {running && <Spinner size="tiny" />}
            <strong>{phase}</strong>
            <span className={styles.muted}>{completed} / {total}</span>
          </div>
          {running && (
            <Button
              size="small"
              disabled={stopButtonPressed}
              onClick={handleStopClick}
              style={{ background: tokens.colorPaletteRedBackground3, color: tokens.colorNeutralForegroundOnBrand }}
            >
              {stopButtonPressed ? 'Stopping…' : 'Stop Migration'}
            </Button>
          )}
        </div>

        {importProgress && (
          <div className={styles.progressRow}>
            <span>Projects: {importProgress.projectsCompleted} / {importProgress.projectsTotal}</span>
            <span>Elapsed: {formatDuration(elapsed)}</span>
            <span>
              ETA: {importProgress.etaMs != null ? `~${formatDuration(importProgress.etaMs)}` : 'Calculating…'}
            </span>
          </div>
        )}

        <ProgressBar value={progressPct} />

        {logLines.length > 0 && (
          <div className={styles.log} ref={logRef}>
            {logLines.map((line, idx) => <div key={idx}>{line}</div>)}
          </div>
        )}
      </div>

      <div className={styles.footer}>
        <Button onClick={prevStep} disabled={running}>Back</Button>
        <div className={styles.toolbar}>
          <Button
            appearance="primary"
            onClick={runImport}
            disabled={running || selectedProjects.length === 0 || !confirmScheduleRebuild}
          >
            {running ? 'Importing…' : 'Start Import'}
          </Button>
          <Button onClick={nextStep} disabled={running || !canProceed}>
            Next: Validation Report
          </Button>
        </div>
      </div>
    </div>
  )
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}
