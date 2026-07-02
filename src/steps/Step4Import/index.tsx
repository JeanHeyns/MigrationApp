import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Checkbox,
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogBody,
  DialogContent,
  DialogActions,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  ProgressBar,
  Select,
  Spinner,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { SettingsRegular } from '@fluentui/react-icons'
import { useMigration, isFilterActive } from '../../app/MigrationContext'
import { BulkActions } from '../../components/ProjectSelection/BulkActions'
import { FilterBar } from '../../components/ProjectSelection/FilterBar'
import { applyFilter } from '../../utils/projectFilter'
import { fetchTasksForProjects } from '../../services/projectOnline/tasks'
import { fetchDependencies } from '../../services/projectOnline/dependencies'
import { fetchAssignmentsForProjects, fetchTeamMembersForProjects } from '../../services/projectOnline/assignments'
import { writeResources } from '../../services/plannerPremium/resourceWriter'
import type { ResourceImportMode, ResourceImportOption } from '../../services/plannerPremium/resourceWriter'
import { writeProjects } from '../../services/plannerPremium/projectWriter'
import type { ProjectWriteResult } from '../../services/plannerPremium/projectWriter'
import { fetchSystemUsers } from '../../services/plannerPremium/dataverseClient'
import type { DvSystemUser } from '../../models/plannerPremium.types'
import { writeTasks, correctTaskSchedule, correctTaskEffort, correctTaskProgress } from '../../services/plannerPremium/taskWriter'
import type { TaskWriteResult } from '../../services/plannerPremium/taskWriter'
import { readProjectCalendar, clearCalendarCache } from '../../services/plannerPremium/calendarReader'
import { writeDependencies } from '../../services/plannerPremium/dependencyWriter'
import type { DependencyWriteResult } from '../../services/plannerPremium/dependencyWriter'
import { writeTeamMembers, writeAssignments } from '../../services/plannerPremium/assignmentWriter'
import type { AssignmentWriteResult } from '../../services/plannerPremium/assignmentWriter'
import { markProjectMigrationCompleted } from '../../services/plannerPremium/projectCompletionMarker'
import { buildResolverMap, buildMultiLookupResolverDataOnly, clearResolverCaches } from '../../services/plannerPremium/resolverFactory'
import type { FieldResolver, ResolverBuildWarning } from '../../services/plannerPremium/resolverFactory'
import type { ImportError, ImportResult } from '../../models/plannerPremium.types'
import type { PoAssignment, PoProjectTeamMember, PoResource, PoTask } from '../../models/projectOnline.types'
import type { SkippedFieldInstance } from '../../models/dataOnly.types'
import type { ProjectOverride } from '../../types/projectDefaults'
import { effectiveSettings } from '../../utils/effectiveProjectSettings'
import { getConcurrencyLimit, runWithConcurrency } from '../../services/plannerPremium/concurrency'
import { useBrowserCloseGuard } from '../../hooks/useBrowserCloseGuard'
import { workValueToHours } from '../../services/plannerPremium/scheduleMath'

const useStyles = makeStyles({
  root: { padding: '32px', maxWidth: '760px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '24px' },
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
  thSortable: {
    textAlign: 'left',
    padding: '8px 10px',
    background: tokens.colorNeutralBackground3,
    borderBottom: `2px solid ${tokens.colorNeutralStroke1}`,
    fontWeight: '600',
    color: tokens.colorNeutralForeground2,
    cursor: 'pointer',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    ':hover': { background: tokens.colorNeutralBackground4 },
  },
})

type Phase = 'Ready' | 'Loading schedule data' | 'Building resolvers' | 'Resources' | 'Importing' | 'Done' | 'Stopped' | 'Failed'
type SortCol = 'name' | 'start' | 'finish' | 'owner'
type SortDir = 'asc' | 'desc'
type ImportSection = 'resources' | 'projects' | 'import'

export function Step4Import() {
  const styles = useStyles()
  const {
    fetchedData, mappingConfig, optionSetMappings, nextStep, prevStep,
    dataSource, pwaUrl,
    addImportResult, clearImportResults,
    migrationMode, resolverPlan,
    addSkippedFieldInstances, clearSkippedFieldInstances,
    addProjectWriteDiagnostics, clearProjectWriteDiagnostics,
    addAssociationDiagnostics, clearAssociationDiagnostics,
    addLog, setCurrentStep,
    migrationScope,
    importProgress, startImport, completeProject, clearImportProgress,
    requestStop, clearStopRequest, setImportWasStopped,
  } = useMigration()

  const {
    selectedProjectIds, toggleProjectSelection, projectFilter,
    workHourTemplates, scheduleModeOptions, projectDefaults, projectOverrides,
    setProjectOverride, clearProjectOverride,
  } = useMigration()
  const [systemUsers, setSystemUsers] = useState<DvSystemUser[]>([])
  const [projectOwnerMap, setProjectOwnerMap] = useState<Record<string, string>>({})
  const [resourceOptions, setResourceOptions] = useState<Record<string, ResourceImportOption>>({})

  // ── Per-project override modal state ─────────────────────────────────────
  const [overrideModalId, setOverrideModalId] = useState<string | null>(null)
  const [overrideEnabled, setOverrideEnabled] = useState(false)
  const [overrideDraft, setOverrideDraft] = useState<Omit<ProjectOverride, 'projectId'>>({})
  const [overrideHpdError, setOverrideHpdError] = useState<string | null>(null)
  const [overrideHpwError, setOverrideHpwError] = useState<string | null>(null)
  const [overrideDpmError, setOverrideDpmError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('Ready')
  const [running, setRunning] = useState(false)
  const [logLines, setLogLines] = useState<string[]>([])
  const [completed, setCompleted] = useState(0)
  const [total, setTotal] = useState(0)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [scheduleLoadMessage, setScheduleLoadMessage] = useState<string | null>(null)
  const [confirmScheduleRebuild, setConfirmScheduleRebuild] = useState(false)
  const [skipSummaryTaskDependencies, setSkipSummaryTaskDependencies] = useState(true)
  const [includeDependencyLag, setIncludeDependencyLag] = useState(false)
  const [includeZeroWorkAssignments, setIncludeZeroWorkAssignments] = useState(false)
  const [stopButtonPressed, setStopButtonPressed] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [sortCol, setSortCol] = useState<SortCol>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [activeSection, setActiveSection] = useState<ImportSection>('resources')
  const logRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
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

  useEffect(() => {
    scrollToStepTop()
  }, [activeSection])

  function scrollToStepTop() {
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    window.requestAnimationFrame(() => {
      rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      document.scrollingElement?.scrollTo({ top: 0, behavior: 'smooth' })
    })
  }

  function goToSection(section: ImportSection) {
    setActiveSection(section)
    window.setTimeout(scrollToStepTop, 0)
  }

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

  const sortedProjects = useMemo(() => {
    const arr = [...filteredProjects]
    arr.sort((a, b) => {
      let av = '', bv = ''
      if (sortCol === 'name')   { av = a.ProjectName ?? '';       bv = b.ProjectName ?? '' }
      if (sortCol === 'start')  { av = a.ProjectStartDate ?? '';  bv = b.ProjectStartDate ?? '' }
      if (sortCol === 'finish') { av = a.ProjectFinishDate ?? ''; bv = b.ProjectFinishDate ?? '' }
      if (sortCol === 'owner')  { av = a.ProjectOwnerName ?? '';  bv = b.ProjectOwnerName ?? '' }
      return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    })
    return arr
  }, [filteredProjects, sortCol, sortDir])

  function handleSort(col: SortCol) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  function sortIndicator(col: SortCol) {
    if (sortCol !== col) return ' ↕'
    return sortDir === 'asc' ? ' ▲' : ' ▼'
  }

  function openOverrideModal(projectId: string) {
    const existing = projectOverrides.get(projectId)
    setOverrideEnabled(!!existing)
    const eff = effectiveSettings(projectId, projectDefaults, projectOverrides)
    setOverrideDraft({
      workHourTemplateId: eff.workHourTemplateId,
      workHourTemplateName: eff.workHourTemplateName,
      scheduleMode: eff.scheduleMode,
      hoursPerDay: eff.hoursPerDay,
      hoursPerWeek: eff.hoursPerWeek,
      daysPerMonth: eff.daysPerMonth,
    })
    setOverrideHpdError(null)
    setOverrideHpwError(null)
    setOverrideDpmError(null)
    setOverrideModalId(projectId)
  }

  function saveOverrideModal() {
    if (!overrideModalId) return
    if (overrideEnabled) {
      setProjectOverride({ projectId: overrideModalId, ...overrideDraft })
    } else {
      clearProjectOverride(overrideModalId)
    }
    setOverrideModalId(null)
  }

  const overrideCount = projectOverrides.size

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
    // 'DependencyFallback' entries are warnings on records that DID import
    // (with degraded type/lag) — shown in the report but not counted as failed.
    const warnings = errors.filter(e => e.errorClass === 'DependencyFallback')
    const realErrors = errors.filter(e => e.errorClass !== 'AlreadyExists' && e.errorClass !== 'Skipped' && e.errorClass !== 'DependencyFallback')
    const skipped = errors.length - realErrors.length - warnings.length
    return {
      entity,
      total: totalRows,
      succeeded: totalRows - realErrors.length - skipped,
      failed: realErrors.length,
      skipped,
      errors: [...realErrors, ...warnings],
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
    goToSection('import')
    setRunning(true)
    setFatalError(null)
    setLogLines([])
    clearImportResults()
    clearSkippedFieldInstances()
    clearProjectWriteDiagnostics()
    clearAssociationDiagnostics()
    clearStopRequest()
    clearImportProgress()
    stopRequestedRef.current = false
    setStopButtonPressed(false)

    const isDataOnly = migrationMode === 'dataOnly'
    const concurrency = getConcurrencyLimit()

    setTotal(data.resources.length + selectedProjects.length)
    setCompleted(0)
    setScheduleLoadMessage(null)

    startImport(selectedProjects.length, concurrency)
    appendLog(`Starting import — ${selectedProjects.length} projects, concurrency=${concurrency}`)

    let resolvers: Map<string, FieldResolver> | undefined
    let importTasks = selectedTasks
    let importDependencies = selectedDependencies
    let importAssignments = selectedAssignments
    let importTeamMembers = selectedTeamMembers

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

        const activeMultiLookupFields = new Set(
          config.fieldMappings
            .filter(m => !m.skip && m.customField.CustomFieldType === 'LookupMulti')
            .map(m => m.customField.ODataFieldName || m.customField.CustomFieldName),
        )

        // Build multi-lookup resolvers for active N:N fields (MultiChoice handled by buildResolverMap)
        const mlWarnings: ResolverBuildWarning[] = []
        for (const mlMapping of (mappingConfig?.multiLookups ?? [])) {
          if (!activeMultiLookupFields.has(mlMapping.poFieldName)) continue
          if (mlMapping.targetShape === 'MultiChoice') continue
          try {
            const fieldMapping = config.fieldMappings.find(
              m => (m.customField.ODataFieldName || m.customField.CustomFieldName) === mlMapping.poFieldName,
            )
            const mlResolver = await buildMultiLookupResolverDataOnly(mlMapping, mlWarnings, fieldMapping)
            resolvers.set(mlMapping.poFieldName, mlResolver)
          } catch (e) {
            appendLog(`[Resolver ERROR] ${mlMapping.poFieldName}: ${String(e)}`)
          }
        }
        for (const w of mlWarnings) {
          appendLog(`[Resolver ${w.severity.toUpperCase()}] ${w.field}: ${w.message}`)
        }

        appendLog(`Resolvers ready: ${resolvers.size} field(s)`)
      } catch (e) {
        setFatalError(`Failed to build resolvers: ${String(e)}`)
        setRunning(false)
        return
      }
    }

    try {
      if (dataSource === 'ProjectOnline' && migrationScope.tasks) {
        setPhase('Loading schedule data')
        appendLog(`Loading schedule data for ${selectedProjects.length} selected project(s)`)
        const siteUrl = data.pwaUrl || pwaUrl
        const [tasks, dependencies, assignments, teamMembers] = await Promise.all([
          fetchTasksForProjects(siteUrl, selectedProjects),
          migrationScope.dependencies ? fetchDependencies(siteUrl, selectedProjects) : Promise.resolve([]),
          migrationScope.assignments
            ? fetchAssignmentsForProjects(siteUrl, selectedProjects, { includeZeroWork: includeZeroWorkAssignments })
            : Promise.resolve([]),
          fetchTeamMembersForProjects(siteUrl, selectedProjects),
        ])
        importTasks = tasks
        importDependencies = dependencies
        importAssignments = assignments
        importTeamMembers = teamMembers
        setScheduleLoadMessage(`Loaded ${tasks.length} tasks, ${dependencies.length} dependencies, ${assignments.length} assignments, ${teamMembers.length} team members for the selected projects.`)
        appendLog(`Loaded schedule data: ${tasks.length} tasks, ${dependencies.length} dependencies, ${assignments.length} assignments, ${teamMembers.length} team members`)
      }

      const effectiveTeamMembers = selectedProjects.flatMap(project =>
        ensureAssignedResourcesInTeam(
          importTeamMembers.filter(tm => tm.ProjectId === project.ProjectId),
          importAssignments.filter(a => a.ProjectId === project.ProjectId),
          data.resources,
        )
      )

      let totalOps = selectedProjects.length + effectiveTeamMembers.length
      if (migrationScope.resources) totalOps += data.resources.length
      if (migrationScope.tasks) totalOps += importTasks.length
      if (migrationScope.dependencies) totalOps += importDependencies.length
      if (migrationScope.assignments) totalOps += importAssignments.length
      setTotal(totalOps)

      // Phase 1: Resources (sequential, before parallel project loop)
      let resourceResults: Awaited<ReturnType<typeof writeResources>> = []
      if (migrationScope.resources) {
        setPhase('Resources')
        appendLog(`Matching/importing ${data.resources.length} resources`)
        resourceResults = await writeResources(data.resources, buildEffectiveResourceOptions(data.resources, systemUsers, resourceOptions), r => {
          setCompleted(c => c + 1)
          appendLog(`${r.success ? 'OK' : 'SKIP'} resource ${r.poResourceUid}${r.error ? `: ${r.error.message}` : ''}`)
        })
      } else {
        appendLog('Resources skipped — outside migration scope')
      }
      const resourceIdMap = Object.fromEntries(
        resourceResults.filter(r => r.success && r.dvBookableResourceId)
          .map(r => [r.poResourceUid, r.dvBookableResourceId as string])
      )
      for (const resource of data.resources) {
        const id = resourceIdMap[resource.ResourceUID ?? ''] ?? resourceIdMap[resource.ResourceId ?? '']
        if (!id) continue
        if (resource.ResourceUID) resourceIdMap[resource.ResourceUID] = id
        if (resource.ResourceId) resourceIdMap[resource.ResourceId] = id
      }
      // Phase 2: Per-project parallel (project + team members + tasks + deps + assignments)
      setPhase('Importing')
      clearCalendarCache()
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
          try {

          const projectResults = await writeProjects([project], config, optionSetMappings, r => {
            setCompleted(c => c + 1)
            appendLog(`[${project.ProjectName}] ${r.success ? 'OK' : 'ERR'} project${r.error ? `: ${r.error.message}` : ''}${r.skippedFields?.length ? ` (${r.skippedFields.length} field(s) skipped)` : ''}`)
          }, resolvers, projectOwnerMap, projectDefaults, projectOverrides)
          allProjectResults.push(...projectResults)
          addProjectWriteDiagnostics(projectResults.flatMap(r => r.diagnostic ? [r.diagnostic] : []))
          const assocDiags = projectResults.flatMap(r => r.associationDiagnostics ?? [])
          if (assocDiags.length > 0) addAssociationDiagnostics(assocDiags)

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
          const projectSettings = effectiveSettings(project.ProjectId, projectDefaults, projectOverrides)
          const projectCalendar = await readProjectCalendar(dvProjectId, projectSettings.hoursPerDay)

          const projectAssignments = importAssignments.filter(a => a.ProjectId === project.ProjectId)
          const projectTeamMembers = effectiveTeamMembers.filter(tm => tm.ProjectId === project.ProjectId)
          const teamResults = await writeTeamMembers(projectTeamMembers, singleProjectMap, resourceIdMap, r => {
            setCompleted(c => c + 1)
            appendLog(`[${project.ProjectName}] ${r.success ? 'OK' : 'SKIP'} team member ${r.poAssignmentId}${r.error ? `: ${r.error.message}` : ''}`)
          })
          allTeamResults.push(...teamResults)
          const projectTeamMemberIdMap = Object.fromEntries(
            teamResults.filter(r => r.success && r.dvAssignmentId)
              .map(r => [r.poAssignmentId, r.dvAssignmentId as string])
          )
          for (const teamMember of projectTeamMembers) {
            const keys = [teamMember.ResourceUID, teamMember.ResourceId].filter((value): value is string => !!value)
            const id = keys.map(key => projectTeamMemberIdMap[`${teamMember.ProjectId}:${key}`]).find(Boolean)
            if (!id) continue
            for (const key of keys) {
              projectTeamMemberIdMap[`${teamMember.ProjectId}:${key}`] = id
            }
          }

          if (migrationScope.tasks) {
            const projectTasks = importTasks.filter(t => t.ProjectId === project.ProjectId)
            const taskEffortHours = buildTaskEffortHours(projectTasks, projectAssignments)
            const taskResults = await writeTasks(projectTasks, singleProjectMap, config, optionSetMappings, projectSettings.hoursPerDay, r => {
              setCompleted(c => c + 1)
              appendLog(`[${project.ProjectName}] ${r.success ? 'OK' : 'ERR'} task ${r.poTaskId}${r.error ? `: ${r.error.message}` : ''}`)
            }, taskEffortHours)
            allTaskResults.push(...taskResults)
            const projectTaskIdMap = Object.fromEntries(
              taskResults.filter(r => r.dvTaskId)
                .map(r => [r.poTaskId, r.dvTaskId as string])
            )

            if (migrationScope.dependencies) {
              const projectDeps = importDependencies.filter(d => d.ProjectId === project.ProjectId)
              const withLag = projectDeps.filter(d => d.Lag != null && d.Lag !== 0).length
              appendLog(`[${project.ProjectName}] Source dependencies: ${projectDeps.length}${includeDependencyLag ? `, with lead/lag: ${withLag}` : ''}`)
              if (projectDeps.length > 0) {
                const depResults = await writeDependencies(projectDeps, singleProjectMap, projectTaskIdMap, r => {
                  setCompleted(c => c + 1)
                  const sourceType = r.dependencyType ?? 'FS'
                  const sourceLagSeconds = r.lagSeconds ?? undefined
                  const writtenType = r.writtenDependencyType ?? sourceType
                  const writtenLagSeconds = r.writtenLagSeconds ?? undefined
                  const lagInfo = r.sourceLagTenthsOfMinute != null
                    ? ` ${sourceType} POlag=${r.sourceLagTenthsOfMinute} tenths-min/${sourceLagSeconds ?? 0}s`
                    : ` ${sourceType}`
                  const writtenInfo = r.success && (writtenType !== sourceType || writtenLagSeconds !== sourceLagSeconds)
                    ? ` -> wrote ${writtenType}${writtenLagSeconds != null ? ` lag=${writtenLagSeconds}s` : ' without lag'}`
                    : ''
                  const fallbackInfo = r.fallbackApplied ? ` fallback=${r.fallbackApplied}` : ''
                  appendLog(`[${project.ProjectName}] ${r.success ? 'OK' : 'SKIP'} dependency ${r.poDependencyId}${lagInfo}${writtenInfo}${fallbackInfo}${r.warning ? ` (${r.warning})` : ''}${r.error ? `: ${r.error.message}` : ''}`)
                }, {
                  tasks: projectTasks,
                  skipSummaryTaskDependencies,
                  includeSourceLag: includeDependencyLag,
                })
                allDepResults.push(...depResults)
              }
            }

            if (migrationScope.assignments) {
              if (projectAssignments.length > 0) {
                const assignResults = await writeAssignments(
                  projectAssignments, singleProjectMap, projectTaskIdMap, projectTeamMemberIdMap, r => {
                    setCompleted(c => c + 1)
                    appendLog(`[${project.ProjectName}] ${r.success ? 'OK' : 'SKIP'} assignment ${r.poAssignmentId}${r.warning ? ` (${r.warning})` : ''}${r.error ? `: ${r.error.message}` : ''}`)
                  },
                  projectTasks,
                  projectCalendar,
                  { includeZeroWorkAssignments },
                )
                allAssignResults.push(...assignResults)

              }
            }

            // Dependencies and assignments can both trigger PSS recalculation.
            // Re-assert each task's original start, finish, and effort as the final step.
            const correctionResults = await correctTaskSchedule(
              projectTasks, dvProjectId, projectTaskIdMap, projectCalendar, r => {
                appendLog(`[${project.ProjectName}] ${r.success ? 'OK' : 'ERR'} schedule ${r.poTaskId} → ${r.start?.slice(0, 10)} ${r.durationDays}d${r.error ? `: ${r.error.message}` : ''}`)
              },
              taskEffortHours,
            )
            const correctionFailures = correctionResults.filter(r => !r.success).length
            if (correctionFailures > 0) {
              appendLog(`[${project.ProjectName}] ${correctionFailures} schedule correction(s) failed`)
            }

            const effortCorrectionResults = await correctTaskEffort(
              projectTasks, dvProjectId, projectTaskIdMap, taskEffortHours, r => {
                appendLog(`[${project.ProjectName}] ${r.success ? 'OK' : 'ERR'} effort ${r.poTaskId} -> ${r.effortHours}h${r.error ? `: ${r.error.message}` : ''}`)
              },
            )
            const effortCorrectionFailures = effortCorrectionResults.filter(r => !r.success).length
            if (effortCorrectionFailures > 0) {
              appendLog(`[${project.ProjectName}] ${effortCorrectionFailures} effort correction(s) failed`)
            }

            const progressCorrectionResults = await correctTaskProgress(
              projectTasks, dvProjectId, projectTaskIdMap, r => {
                appendLog(`[${project.ProjectName}] ${r.success ? 'OK' : 'ERR'} progress ${r.poTaskId} -> ${Math.round(r.progress * 100)}%${r.error ? `: ${r.error.message}` : ''}`)
              },
            )
            const progressCorrectionFailures = progressCorrectionResults.filter(r => !r.success).length
            if (progressCorrectionFailures > 0) {
              appendLog(`[${project.ProjectName}] ${progressCorrectionFailures} progress correction(s) failed`)
            }

            const finalScheduleResults = await correctTaskSchedule(
              projectTasks, dvProjectId, projectTaskIdMap, projectCalendar, r => {
                appendLog(`[${project.ProjectName}] ${r.success ? 'OK' : 'ERR'} final schedule ${r.poTaskId} -> ${r.start?.slice(0, 10)} ${r.durationDays}d${r.error ? `: ${r.error.message}` : ''}`)
              },
              taskEffortHours,
              { includeDuration: true },
            )
            const finalScheduleFailures = finalScheduleResults.filter(r => !r.success).length
            if (finalScheduleFailures > 0) {
              appendLog(`[${project.ProjectName}] ${finalScheduleFailures} final schedule correction(s) failed`)
            }
          }

          try {
            const markerResult = await markProjectMigrationCompleted(dvProjectId)
            appendLog(
              markerResult === 'updated'
                ? `[${project.ProjectName}] OK project marker ppm_appliedtemplate=Migration`
                : `[${project.ProjectName}] project marker skipped: ppm_appliedtemplate column not present`,
            )
          } catch (e) {
            appendLog(`[${project.ProjectName}] ERR project marker ppm_appliedtemplate: ${String(e)}`)
          }

          completeProject(Date.now() - projectStart)
          appendLog(`[${project.ProjectName}] Complete`)

          } catch (e) {
            appendLog(`[${project.ProjectName}] FAILED: ${String(e)}`)
            addLog({ level: 'error', message: `Project ${project.ProjectName} failed during import: ${String(e)}` })
            completeProject(Date.now() - projectStart)
          }
        },
        concurrency,
      )

      // Aggregate results for Step 5 report
      if (migrationScope.resources) {
        addImportResult(makeResult('Resources', resourceResults.length, resourceResults.flatMap(r => r.error ? [r.error] : [])))
      }
      addImportResult(makeResult('Projects', allProjectResults.length, allProjectResults.flatMap(r => r.error ? [r.error] : [])))
      const totalAssociations = allProjectResults.reduce((sum, r) => sum + (r.associationsCreated ?? 0), 0)
      if (totalAssociations > 0) {
        addImportResult({ entity: 'Associations', total: totalAssociations, succeeded: totalAssociations, failed: 0, skipped: 0, errors: [] })
      }
      addImportResult(makeResult('Team members', allTeamResults.length, allTeamResults.flatMap(r => r.error ? [r.error] : [])))
      if (migrationScope.tasks) {
        addImportResult(makeResult('Tasks', allTaskResults.length, allTaskResults.flatMap(r => r.error ? [r.error] : [])))
        if (migrationScope.dependencies && allDepResults.length > 0) {
          const depErrors = allDepResults.flatMap(r => {
            if (r.error) return [r.error]
            if (!r.fallbackApplied) return []
            const degraded = [
              r.fallbackApplied !== 'withoutLag' ? `type ${r.dependencyType ?? '?'} written as FS` : null,
              r.fallbackApplied !== 'asFs' ? 'source lag dropped' : null,
            ].filter(Boolean).join('; ')
            return [{
              entity: 'Dependency',
              sourceId: r.poDependencyId,
              message: `Created with fallback (${degraded})${r.fallbackReason ? `: ${r.fallbackReason}` : ''}`,
              timestamp: new Date().toISOString(),
              errorClass: 'DependencyFallback',
              projectId: r.projectId,
            } satisfies ImportError]
          })
          addImportResult(makeResult('Dependencies', allDepResults.length, depErrors))
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

  const progressPct = total > 0 ? Math.min(1, completed / total) : 0
  const canProceed = phase === 'Done' || phase === 'Stopped'
  const resourceRows = data.resources.map(resource => {
    const sourceId = getResourceSourceId(resource)
    const user = matchSystemUser(resource, systemUsers)
    const option = resourceOptions[sourceId] ?? {}
    const mode = option.mode ?? (user ? 'user' : 'account')
    const name = option.nameOverride ?? resource.ResourceName
    return { resource, sourceId, user, mode, name }
  })
  const invalidResourceOptions = resourceRows.some(row => row.mode !== 'skip' && !row.name.trim())

  function updateResourceOption(sourceId: string, patch: ResourceImportOption) {
    setResourceOptions(prev => ({ ...prev, [sourceId]: { ...prev[sourceId], ...patch } }))
  }

  function bulkSetResourceMode(mode: ResourceImportMode, rows = resourceRows) {
    setResourceOptions(prev => {
      const next = { ...prev }
      for (const row of rows) {
        next[row.sourceId] = { ...next[row.sourceId], mode }
      }
      return next
    })
  }

  function resetResourceOptions() {
    setResourceOptions({})
  }

  return (
    <div ref={rootRef} className={styles.root}>
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

      <div style={{ fontSize: '13px', color: tokens.colorNeutralForeground3 }}>
        Scope: Projects ✓
        {migrationScope.tasks ? ' · Tasks ✓' : ' · Tasks ✗'}
        {migrationScope.dependencies ? ' · Dependencies ✓' : ' · Dependencies ✗'}
        {migrationScope.assignments ? ' · Assignments ✓' : ' · Assignments ✗'}
        {migrationScope.resources ? ' · Resources ✓' : ' · Resources ✗'}
      </div>

      <div className={styles.toolbar}>
        <Button
          appearance={activeSection === 'resources' ? 'primary' : 'secondary'}
          disabled={running}
          onClick={() => goToSection('resources')}
        >
          1. Resources
        </Button>
        <Button
          appearance={activeSection === 'projects' ? 'primary' : 'secondary'}
          disabled={running}
          onClick={() => goToSection('projects')}
        >
          2. Projects
        </Button>
        <Button
          appearance={activeSection === 'import' ? 'primary' : 'secondary'}
          onClick={() => goToSection('import')}
        >
          3. Import
        </Button>
      </div>

      {activeSection === 'resources' && (
      <div className={styles.panel}>
        <div className={styles.toolbar} style={{ justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontWeight: 600 }}>Resources</div>
            <div className={styles.muted} style={{ fontSize: '12px' }}>
              {resourceRows.filter(r => r.user).length} user match(es), {resourceRows.filter(r => !r.user).length} generic resource(s), {resourceRows.filter(r => r.mode === 'skip').length} skipped
            </div>
          </div>
          <div className={styles.toolbar}>
            <Button size="small" disabled={running} onClick={() => bulkSetResourceMode('skip')}>
              Skip all
            </Button>
            <Button size="small" disabled={running} onClick={() => bulkSetResourceMode('skip', resourceRows.filter(r => !r.user))}>
              Skip generic
            </Button>
            <Button size="small" disabled={running} onClick={resetResourceOptions}>
              Reset
            </Button>
          </div>
        </div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th} style={{ width: '70px' }}>Skip</th>
              <th className={styles.th}>Source resource</th>
              <th className={styles.th}>User match</th>
              <th className={styles.th} style={{ width: '170px' }}>Create as</th>
              <th className={styles.th}>Target name</th>
            </tr>
          </thead>
          <tbody>
            {resourceRows.map(row => (
              <tr key={row.sourceId}>
                <td className={styles.td}>
                  <Checkbox
                    checked={row.mode === 'skip'}
                    disabled={running}
                    onChange={(_, d) => updateResourceOption(row.sourceId, { mode: d.checked ? 'skip' : (row.user ? 'user' : 'account') })}
                  />
                </td>
                <td className={styles.td}>
                  <div>{row.resource.ResourceName}</div>
                  <div className={styles.muted} style={{ fontSize: '12px' }}>{row.sourceId}</div>
                </td>
                <td className={styles.td}>
                  {row.user ? row.user.fullname : <span className={styles.muted}>No user found</span>}
                </td>
                <td className={styles.td}>
                  <Select
                    size="small"
                    disabled={running}
                    value={row.mode}
                    onChange={(_, d) => updateResourceOption(row.sourceId, { mode: d.value as ResourceImportMode })}
                  >
                    {row.user && <option value="user">User</option>}
                    <option value="account">Account</option>
                    <option value="skip">Skip</option>
                  </Select>
                </td>
                <td className={styles.td}>
                  <Input
                    size="small"
                    disabled={running || row.mode === 'skip'}
                    value={row.name}
                    onChange={e => updateResourceOption(row.sourceId, { nameOverride: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      {activeSection === 'projects' && (
      <>
      <FilterBar
        ownerNames={ownerNames}
        tasksAvailable={dataSource === 'FileUpload' && migrationScope.tasks}
      />

      <BulkActions
        allProjectIds={data.projects.map(p => p.ProjectId)}
        displayedProjectIds={sortedProjects.map(p => p.ProjectId)}
        disabled={running}
      />
      <span className={styles.muted} style={{ fontSize: '13px' }}>
        {selectedProjects.length} of {data.projects.length} projects selected
        {isFilterActive(projectFilter) ? ` · showing ${filteredProjects.length} filtered` : ''}
        {migrationScope.tasks ? (dataSource === 'FileUpload' ? ` · ${selectedTasks.length} tasks` : ' · tasks load at import') : ''}
        {migrationScope.assignments ? (dataSource === 'FileUpload' ? ` · ${selectedAssignments.length} assignments` : ' · assignments load at import') : ''}
        {overrideCount > 0 ? ` · ${overrideCount} of ${data.projects.length} projects have overrides` : ''}
      </span>

      <div className={styles.panel}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th} style={{ width: '48px' }}>Import</th>
              <th className={styles.thSortable} onClick={() => handleSort('name')}>Project{sortIndicator('name')}</th>
              <th className={styles.thSortable} onClick={() => handleSort('start')}>Start{sortIndicator('start')}</th>
              <th className={styles.thSortable} onClick={() => handleSort('finish')}>Finish{sortIndicator('finish')}</th>
              <th className={styles.thSortable} onClick={() => handleSort('owner')}>Owner / Project Manager{sortIndicator('owner')}</th>
              <th className={styles.th} style={{ width: '36px' }} title="Working time overrides"></th>
            </tr>
          </thead>
          <tbody>
            {sortedProjects.map(project => (
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
                <td className={styles.td} style={{ textAlign: 'center' }}>
                  <Button
                    appearance="subtle"
                    size="small"
                    icon={<SettingsRegular style={{ color: projectOverrides.has(project.ProjectId) ? tokens.colorBrandForeground1 : undefined }} />}
                    disabled={running}
                    title="Working time override"
                    onClick={() => openOverrideModal(project.ProjectId)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>
      )}

      {(activeSection === 'import' || running) && (
      <>
      {scheduleLoadMessage && (
        <MessageBar intent="success">
          <MessageBarBody>{scheduleLoadMessage}</MessageBarBody>
        </MessageBar>
      )}
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
              ETA: {(() => {
                const { projectsCompleted, projectsTotal } = importProgress
                const remaining = projectsTotal - projectsCompleted
                if (projectsCompleted === 0 || elapsed === 0) return 'Calculating…'
                const etaMs = Math.max(0, Math.round((remaining / projectsCompleted) * elapsed))
                return `~${formatDuration(etaMs)}`
              })()}
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

      <Checkbox
        checked={confirmScheduleRebuild}
        disabled={running}
        label="I understand selected project schedules will be cleared and rebuilt"
        onChange={(_, d) => setConfirmScheduleRebuild(!!d.checked)}
      />
      {migrationScope.dependencies && (
        <Checkbox
          checked={skipSummaryTaskDependencies}
          disabled={running}
          label="No dependencies on summary tasks"
          onChange={(_, d) => setSkipSummaryTaskDependencies(!!d.checked)}
        />
      )}
      {migrationScope.dependencies && (
        <Checkbox
          checked={includeDependencyLag}
          disabled={running}
          label="Include source dependency lag/slack"
          onChange={(_, d) => setIncludeDependencyLag(!!d.checked)}
        />
      )}
      {migrationScope.assignments && (
        <Checkbox
          checked={includeZeroWorkAssignments}
          disabled={running}
          label="Include assignments with 0 work"
          onChange={(_, d) => setIncludeZeroWorkAssignments(!!d.checked)}
        />
      )}
      </>
      )}

      <div className={styles.footer}>
        <Button onClick={prevStep} disabled={running}>Back</Button>
        <div className={styles.toolbar}>
          {activeSection === 'resources' && (
            <Button appearance="primary" disabled={running || invalidResourceOptions} onClick={() => goToSection('projects')}>
              Next: Projects
            </Button>
          )}
          {activeSection === 'projects' && (
            <Button appearance="primary" disabled={running || selectedProjects.length === 0} onClick={() => goToSection('import')}>
              Next: Import
            </Button>
          )}
          {activeSection === 'import' && (
            <Button
              appearance="primary"
              onClick={runImport}
              disabled={running || selectedProjects.length === 0 || !confirmScheduleRebuild || invalidResourceOptions}
            >
              {running ? 'Importing…' : 'Start Import'}
            </Button>
          )}
          <Button onClick={nextStep} disabled={running || !canProceed}>
            Next: Validation Report
          </Button>
        </div>
      </div>

      {/* ── Per-project working time override modal ── */}
      <Dialog open={overrideModalId !== null} onOpenChange={(_, s) => { if (!s.open) setOverrideModalId(null) }}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>
              Working time for &ldquo;{data.projects.find(p => p.ProjectId === overrideModalId)?.ProjectName ?? overrideModalId}&rdquo;
            </DialogTitle>
            <DialogContent>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', paddingTop: '8px' }}>
                <Checkbox
                  checked={overrideEnabled}
                  label="Override defaults for this project"
                  onChange={(_, d) => setOverrideEnabled(!!d.checked)}
                />

                <Field label="Work hour template">
                  <Select
                    disabled={!overrideEnabled}
                    value={overrideDraft.workHourTemplateId ?? ''}
                    onChange={(_, d) => {
                      const tpl = workHourTemplates.find(t => t.id === d.value) ?? null
                      setOverrideDraft(prev => ({ ...prev, workHourTemplateId: tpl?.id ?? null, workHourTemplateName: tpl?.name ?? null }))
                    }}
                  >
                    {workHourTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </Select>
                </Field>

                <Field label="Schedule mode">
                  <Select
                    disabled={!overrideEnabled}
                    value={overrideDraft.scheduleMode !== null && overrideDraft.scheduleMode !== undefined ? String(overrideDraft.scheduleMode) : ''}
                    onChange={(_, d) => {
                      const val = d.value ? parseInt(d.value, 10) : null
                      setOverrideDraft(prev => ({ ...prev, scheduleMode: isNaN(val as number) ? null : val }))
                    }}
                  >
                    <option value="">— Dataverse default —</option>
                    {scheduleModeOptions.map(o => <option key={o.value} value={String(o.value)}>{o.label}</option>)}
                  </Select>
                </Field>

                <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                  <Field label="Hours per day" validationMessage={overrideHpdError ?? undefined} validationState={overrideHpdError ? 'error' : 'none'}>
                    <Input
                      type="number"
                      disabled={!overrideEnabled}
                      style={{ width: '90px' }}
                      value={String(overrideDraft.hoursPerDay ?? '')}
                      onChange={e => {
                        const n = parseFloat(e.target.value)
                        setOverrideHpdError(isNaN(n) || n <= 0 || n > 24 ? 'Must be > 0 and ≤ 24' : null)
                        setOverrideDraft(prev => ({ ...prev, hoursPerDay: isNaN(n) ? undefined : n }))
                      }}
                    />
                  </Field>
                  <Field label="Hours per week" validationMessage={overrideHpwError ?? undefined} validationState={overrideHpwError ? 'error' : 'none'}>
                    <Input
                      type="number"
                      disabled={!overrideEnabled}
                      style={{ width: '90px' }}
                      value={String(overrideDraft.hoursPerWeek ?? '')}
                      onChange={e => {
                        const n = parseFloat(e.target.value)
                        setOverrideHpwError(isNaN(n) || n <= 0 || n > 168 ? 'Must be > 0 and ≤ 168' : null)
                        setOverrideDraft(prev => ({ ...prev, hoursPerWeek: isNaN(n) ? undefined : n }))
                      }}
                    />
                  </Field>
                  <Field label="Days per month" validationMessage={overrideDpmError ?? undefined} validationState={overrideDpmError ? 'error' : 'none'}>
                    <Input
                      type="number"
                      disabled={!overrideEnabled}
                      style={{ width: '90px' }}
                      value={String(overrideDraft.daysPerMonth ?? '')}
                      onChange={e => {
                        const n = parseFloat(e.target.value)
                        setOverrideDpmError(isNaN(n) || n <= 0 || n > 31 ? 'Must be > 0 and ≤ 31' : null)
                        setOverrideDraft(prev => ({ ...prev, daysPerMonth: isNaN(n) ? undefined : n }))
                      }}
                    />
                  </Field>
                </div>
              </div>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setOverrideModalId(null)}>Cancel</Button>
              <Button
                appearance="primary"
                disabled={overrideEnabled && !!(overrideHpdError || overrideHpwError || overrideDpmError)}
                onClick={saveOverrideModal}
              >
                {overrideEnabled ? 'Save override' : 'Clear override'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
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

function buildTaskEffortHours(tasks: PoTask[], assignments: PoAssignment[] = []): Map<string, number> {
  const result = new Map<string, number>()
  const assignmentHoursByTaskId = new Map<string, number>()

  for (const assignment of assignments) {
    const hours = workValueToHours(assignment.AssignmentWork ?? assignment.AssignmentRemainingWork)
    if (hours == null) continue
    assignmentHoursByTaskId.set(assignment.TaskId, (assignmentHoursByTaskId.get(assignment.TaskId) ?? 0) + hours)
  }

  for (const task of tasks) {
    const taskWork = workValueToHours(task.TaskWork)
    if (taskWork != null) {
      result.set(task.TaskId, roundHours(taskWork))
      continue
    }

    const assignmentWork = assignmentHoursByTaskId.get(task.TaskId)
    if (assignmentWork != null) {
      result.set(task.TaskId, roundHours(assignmentWork))
      continue
    }

    if (task.TaskIsMilestone) result.set(task.TaskId, 0)
  }
  return result
}

function roundHours(value: number): number {
  return Math.round(value * 100) / 100
}

function getResourceSourceId(resource: PoResource): string {
  return resource.ResourceUID ?? resource.ResourceId ?? resource.ResourceName
}

function matchSystemUser(resource: PoResource, users: DvSystemUser[]): DvSystemUser | undefined {
  const email = resource.ResourceEmailAddress?.toLowerCase()
  return users.find(user =>
    (email && user.internalemailaddress?.toLowerCase() === email) ||
    user.fullname?.toLowerCase() === resource.ResourceName.toLowerCase() ||
    (resource.ResourceNTAccount && user.domainname?.toLowerCase() === resource.ResourceNTAccount.toLowerCase())
  )
}

function buildEffectiveResourceOptions(
  resources: PoResource[],
  users: DvSystemUser[],
  configured: Record<string, ResourceImportOption>,
): Record<string, ResourceImportOption> {
  return Object.fromEntries(resources.map(resource => {
    const sourceId = getResourceSourceId(resource)
    const user = matchSystemUser(resource, users)
    const option = configured[sourceId] ?? {}
    return [sourceId, {
      mode: option.mode ?? (user ? 'user' : 'account'),
      nameOverride: option.nameOverride?.trim() || resource.ResourceName,
    }]
  }))
}

function ensureAssignedResourcesInTeam(
  teamMembers: PoProjectTeamMember[],
  assignments: PoAssignment[],
  resources: PoResource[],
): PoProjectTeamMember[] {
  const byKey = new Map<string, PoProjectTeamMember>()

  for (const teamMember of teamMembers) {
    const resourceKey = teamMember.ResourceUID || teamMember.ResourceId
    if (!resourceKey) continue
    byKey.set(`${teamMember.ProjectId}:${resourceKey}`, teamMember)
  }

  for (const assignment of assignments) {
    const resourceKey = assignment.ResourceUID || assignment.ResourceId
    if (!resourceKey) continue
    const key = `${assignment.ProjectId}:${resourceKey}`
    if (byKey.has(key)) continue

    const resource = resources.find(r => r.ResourceUID === resourceKey || r.ResourceId === resourceKey)
    byKey.set(key, {
      ProjectId: assignment.ProjectId,
      ResourceUID: assignment.ResourceUID || assignment.ResourceId || resourceKey,
      ResourceId: assignment.ResourceId || assignment.ResourceUID || resourceKey,
      ResourceName: resource?.ResourceName,
    })
  }

  return [...byKey.values()]
}
