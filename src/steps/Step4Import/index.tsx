import { useMemo, useRef, useState } from 'react'
import {
  Button,
  Checkbox,
  MessageBar,
  MessageBarBody,
  ProgressBar,
  Spinner,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { useMigration } from '../../app/MigrationContext'
import { writeResources } from '../../services/plannerPremium/resourceWriter'
import { writeProjects } from '../../services/plannerPremium/projectWriter'
import { writeTasks } from '../../services/plannerPremium/taskWriter'
import { writeTeamMembers, writeAssignments } from '../../services/plannerPremium/assignmentWriter'
import type { ImportError, ImportResult } from '../../models/plannerPremium.types'

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
})

type Phase = 'Ready' | 'Resources' | 'Projects' | 'Team members' | 'Tasks' | 'Assignments' | 'Done' | 'Failed'

export function Step4Import() {
  const styles = useStyles()
  const {
    fetchedData, mappingConfig, optionSetMappings, nextStep, prevStep,
    addImportResult, clearImportResults,
  } = useMigration()
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(
    () => new Set(fetchedData?.projects.map(p => p.ProjectId) ?? []),
  )
  const [phase, setPhase] = useState<Phase>('Ready')
  const [running, setRunning] = useState(false)
  const [logLines, setLogLines] = useState<string[]>([])
  const [completed, setCompleted] = useState(0)
  const [total, setTotal] = useState(0)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [confirmScheduleRebuild, setConfirmScheduleRebuild] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

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

  function toggleProject(projectId: string, checked: boolean) {
    setSelectedProjectIds(prev => {
      const next = new Set(prev)
      if (checked) next.add(projectId)
      else next.delete(projectId)
      return next
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

  async function runImport() {
    setRunning(true)
    setFatalError(null)
    setLogLines([])
    clearImportResults()

    const workTotal =
      data.resources.length +
      selectedProjects.length +
      selectedTeamMembers.length +
      selectedTasks.length +
      selectedAssignments.length
    setTotal(workTotal)
    setCompleted(0)

    try {
      setPhase('Resources')
      appendLog(`Matching/importing ${data.resources.length} resources`)
      const resourceResults = await writeResources(data.resources, r => {
        setCompleted(c => c + 1)
        appendLog(`${r.success ? 'OK' : 'SKIP'} resource ${r.poResourceUid}${r.error ? `: ${r.error.message}` : ''}`)
      })
      addImportResult(makeResult('Resources', resourceResults.length, resourceResults.flatMap(r => r.error ? [r.error] : [])))
      const resourceIdMap = Object.fromEntries(resourceResults.filter(r => r.success && r.dvBookableResourceId).map(r => [r.poResourceUid, r.dvBookableResourceId as string]))

      setPhase('Projects')
      appendLog(`Importing ${selectedProjects.length} projects`)
      const projectResults = await writeProjects(selectedProjects, config, optionSetMappings, r => {
        setCompleted(c => c + 1)
        appendLog(`${r.success ? 'OK' : 'ERR'} project ${r.poProjectId}${r.error ? `: ${r.error.message}` : ''}`)
      })
      addImportResult(makeResult('Projects', projectResults.length, projectResults.flatMap(r => r.error ? [r.error] : [])))
      const projectIdMap = Object.fromEntries(projectResults.filter(r => r.success && r.dvProjectId).map(r => [r.poProjectId, r.dvProjectId as string]))

      setPhase('Team members')
      appendLog(`Importing ${selectedTeamMembers.length} project team members`)
      const teamResults = await writeTeamMembers(selectedTeamMembers, projectIdMap, resourceIdMap, r => {
        setCompleted(c => c + 1)
        appendLog(`${r.success ? 'OK' : 'SKIP'} team member ${r.poAssignmentId}${r.error ? `: ${r.error.message}` : ''}`)
      })
      addImportResult(makeResult('Team members', teamResults.length, teamResults.flatMap(r => r.error ? [r.error] : [])))
      const teamMemberIdMap = Object.fromEntries(teamResults.filter(r => r.success && r.dvAssignmentId).map(r => [r.poAssignmentId, r.dvAssignmentId as string]))

      setPhase('Tasks')
      appendLog(`Importing ${selectedTasks.length} tasks through Project schedule OperationSets`)
      const taskResults = await writeTasks(selectedTasks, projectIdMap, config, optionSetMappings, r => {
        setCompleted(c => c + 1)
        appendLog(`${r.success ? 'OK' : 'ERR'} task ${r.poTaskId}${r.error ? `: ${r.error.message}` : ''}`)
      })
      addImportResult(makeResult('Tasks', taskResults.length, taskResults.flatMap(r => r.error ? [r.error] : [])))
      const taskIdMap = Object.fromEntries(taskResults.filter(r => r.success && r.dvTaskId).map(r => [r.poTaskId, r.dvTaskId as string]))

      setPhase('Assignments')
      appendLog(`Importing ${selectedAssignments.length} assignments through Project schedule OperationSets`)
      const assignmentResults = await writeAssignments(selectedAssignments, projectIdMap, taskIdMap, teamMemberIdMap, r => {
        setCompleted(c => c + 1)
        appendLog(`${r.success ? 'OK' : 'SKIP'} assignment ${r.poAssignmentId}${r.error ? `: ${r.error.message}` : ''}`)
      })
      addImportResult(makeResult('Assignments', assignmentResults.length, assignmentResults.flatMap(r => r.error ? [r.error] : [])))

      setPhase('Done')
      appendLog('Import completed')
    } catch (e) {
      setPhase('Failed')
      setFatalError(String(e))
      appendLog(`Fatal error: ${String(e)}`)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className={styles.root}>
      <div>
        <div className={styles.title}>Step 4 - Import Data</div>
        <div className={styles.subtitle}>
          Select projects, then import resources, projects, team members, summary tasks, tasks, and assignments.
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

      <div className={styles.toolbar}>
        <Button size="small" disabled={running} onClick={() => setSelectedProjectIds(new Set(data.projects.map(p => p.ProjectId)))}>
          Select all
        </Button>
        <Button size="small" disabled={running} onClick={() => setSelectedProjectIds(new Set())}>
          Select none
        </Button>
        <span className={styles.muted}>
          {selectedProjects.length} projects selected · {selectedTasks.length} tasks · {selectedAssignments.length} assignments
        </span>
      </div>

      <div className={styles.panel}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th} style={{ width: '48px' }}>Import</th>
              <th className={styles.th}>Project</th>
              <th className={styles.th}>Start</th>
              <th className={styles.th}>Finish</th>
            </tr>
          </thead>
          <tbody>
            {data.projects.map(project => (
              <tr key={project.ProjectId}>
                <td className={styles.td}>
                  <Checkbox
                    checked={selectedProjectIds.has(project.ProjectId)}
                    disabled={running}
                    onChange={(_, d) => toggleProject(project.ProjectId, !!d.checked)}
                  />
                </td>
                <td className={styles.td}>{project.ProjectName}</td>
                <td className={styles.td}>{project.ProjectStartDate ?? '-'}</td>
                <td className={styles.td}>{project.ProjectFinishDate ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.panel}>
        <div className={styles.toolbar}>
          {running && <Spinner size="tiny" />}
          <strong>{phase}</strong>
          <span className={styles.muted}>{completed} / {total}</span>
        </div>
        <ProgressBar value={total > 0 ? completed / total : 0} />
        {logLines.length > 0 && (
          <div className={styles.log} ref={logRef}>
            {logLines.map((line, idx) => <div key={idx}>{line}</div>)}
          </div>
        )}
      </div>

      <div className={styles.footer}>
        <Button onClick={prevStep} disabled={running}>Back</Button>
        <div className={styles.toolbar}>
          <Button appearance="primary" onClick={runImport} disabled={running || selectedProjects.length === 0 || !confirmScheduleRebuild}>
            {running ? 'Importing...' : 'Start Import'}
          </Button>
          <Button onClick={nextStep} disabled={running || phase !== 'Done'}>Next: Validation Report</Button>
        </div>
      </div>
    </div>
  )
}
