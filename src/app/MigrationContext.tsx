import React, { createContext, useCallback, useContext, useState } from 'react'
import type { PoFetchedData } from '../models/projectOnline.types'
import type { MappingConfiguration, OptionSetMapping } from '../models/mapping.types'
import type { DvSolution, ImportResult, LogEntry, ProjectWriteDiagnostic } from '../models/plannerPremium.types'
import type { MigrationMode, SchemaCreationResults, SchemaSnapshot, ResolverPlan, SkippedFieldInstance } from '../models/dataOnly.types'
import { clearDataverseOrgUrl, setDataverseOrgUrl } from '../config/environment'

export interface ProjectFilter {
  searchTerm: string
  startDateFrom: string | null
  startDateTo: string | null
  finishDateFrom: string | null
  finishDateTo: string | null
  ownerNames: string[]
  taskCountMin: number | null
  taskCountMax: number | null
}

function emptyFilter(): ProjectFilter {
  return {
    searchTerm: '',
    startDateFrom: null,
    startDateTo: null,
    finishDateFrom: null,
    finishDateTo: null,
    ownerNames: [],
    taskCountMin: null,
    taskCountMax: null,
  }
}

export function isFilterActive(filter: ProjectFilter): boolean {
  return (
    filter.searchTerm !== '' ||
    filter.startDateFrom !== null ||
    filter.startDateTo !== null ||
    filter.finishDateFrom !== null ||
    filter.finishDateTo !== null ||
    filter.ownerNames.length > 0 ||
    filter.taskCountMin !== null ||
    filter.taskCountMax !== null
  )
}

export type DataSource = 'ProjectOnline' | 'FileUpload'
export type DataverseUrlSource = 'loading' | 'localStorage' | 'environmentVariable' | 'manualInput' | 'error'

export interface MigrationScope {
  projects: true
  tasks: boolean
  dependencies: boolean
  assignments: boolean
  resources: boolean
}

export interface ImportProgress {
  startedAt: Date
  projectsCompleted: number
  projectsTotal: number
  concurrency: number
}

const DEFAULT_MIGRATION_SCOPE: MigrationScope = {
  projects: true,
  tasks: true,
  dependencies: true,
  assignments: true,
  resources: true,
}

interface MigrationState {
  currentStep: number
  pwaUrl: string
  dataverseOrgUrl: string | null
  dataverseUrlSource: DataverseUrlSource
  dataverseUrlError: string | null
  dataSource: DataSource
  selectedSolution: DvSolution | null
  skipColumnCreation: boolean
  fetchedData: PoFetchedData | null
  selectedProjectIds: Set<string>
  projectFilter: ProjectFilter
  mappingConfig: MappingConfiguration | null
  optionSetMappings: OptionSetMapping[]
  importResults: ImportResult[]
  logs: LogEntry[]
  migrationMode: MigrationMode
  schemaSnapshot: SchemaSnapshot | null
  resolverPlan: ResolverPlan | null
  skippedFieldInstances: SkippedFieldInstance[]
  projectWriteDiagnostics: ProjectWriteDiagnostic[]
  schemaCreationResults: SchemaCreationResults | null
  migrationScope: MigrationScope
  importProgress: ImportProgress | null
  stopRequested: boolean
  importWasStopped: boolean
}

interface MigrationActions {
  setCurrentStep: (step: number) => void
  nextStep: () => void
  prevStep: () => void
  setPwaUrl: (url: string) => void
  setResolvedDataverseUrl: (url: string, source: DataverseUrlSource) => void
  setDataverseUrlError: (error: string) => void
  clearResolvedDataverseUrl: () => void
  setDataSource: (source: DataSource) => void
  setSelectedSolution: (solution: DvSolution | null) => void
  setSkipColumnCreation: (skip: boolean) => void
  setFetchedData: (data: PoFetchedData | null) => void
  setSelectedProjectIds: (ids: Set<string>) => void
  toggleProjectSelection: (id: string) => void
  selectProjectsByIds: (ids: string[]) => void
  deselectProjectsByIds: (ids: string[]) => void
  setProjectFilter: (filter: ProjectFilter) => void
  clearProjectFilter: () => void
  setMappingConfig: (config: MappingConfiguration) => void
  setOptionSetMappings: (mappings: OptionSetMapping[]) => void
  addImportResult: (result: ImportResult) => void
  clearImportResults: () => void
  addLog: (entry: Omit<LogEntry, 'timestamp'>) => void
  clearLogs: () => void
  setMigrationMode: (mode: MigrationMode) => void
  setSchemaSnapshot: (snapshot: SchemaSnapshot | null) => void
  setResolverPlan: (plan: ResolverPlan | null) => void
  addSkippedFieldInstances: (instances: SkippedFieldInstance[]) => void
  clearSkippedFieldInstances: () => void
  addProjectWriteDiagnostics: (diagnostics: ProjectWriteDiagnostic[]) => void
  clearProjectWriteDiagnostics: () => void
  setSchemaCreationResults: (results: SchemaCreationResults | null) => void
  resetState: () => void
  setMigrationScope: (partial: Partial<Omit<MigrationScope, 'projects'>>) => void
  startImport: (totalProjects: number, concurrency: number) => void
  completeProject: (durationMs: number) => void
  clearImportProgress: () => void
  requestStop: () => void
  clearStopRequest: () => void
  setImportWasStopped: (value: boolean) => void
}

type MigrationContextType = MigrationState & MigrationActions

const MigrationContext = createContext<MigrationContextType | null>(null)

export function MigrationProvider({ children }: { children: React.ReactNode }) {
  const [currentStep, setCurrentStep] = useState(1)
  const [pwaUrl, setPwaUrl] = useState('')
  const [dataverseOrgUrl, setDataverseOrgUrlState] = useState<string | null>(null)
  const [dataverseUrlSource, setDataverseUrlSource] = useState<DataverseUrlSource>('loading')
  const [dataverseUrlError, setDataverseUrlErrorState] = useState<string | null>(null)
  const [dataSource, setDataSource] = useState<DataSource>('ProjectOnline')
  const [selectedSolution, setSelectedSolution] = useState<DvSolution | null>(null)
  const [skipColumnCreation, setSkipColumnCreation] = useState(false)
  const [fetchedData, setFetchedDataState] = useState<PoFetchedData | null>(null)
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(new Set())
  const [projectFilter, setProjectFilterState] = useState<ProjectFilter>(emptyFilter())
  const [mappingConfig, setMappingConfig] = useState<MappingConfiguration | null>(null)
  const [optionSetMappings, setOptionSetMappings] = useState<OptionSetMapping[]>([])
  const [importResults, setImportResults] = useState<ImportResult[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [migrationMode, setMigrationModeState] = useState<MigrationMode>('full')
  const [schemaSnapshot, setSchemaSnapshot] = useState<SchemaSnapshot | null>(null)
  const [resolverPlan, setResolverPlan] = useState<ResolverPlan | null>(null)
  const [skippedFieldInstances, setSkippedFieldInstances] = useState<SkippedFieldInstance[]>([])
  const [projectWriteDiagnostics, setProjectWriteDiagnostics] = useState<ProjectWriteDiagnostic[]>([])
  const [schemaCreationResults, setSchemaCreationResults] = useState<SchemaCreationResults | null>(null)
  const [migrationScope, setMigrationScopeState] = useState<MigrationScope>(DEFAULT_MIGRATION_SCOPE)
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [stopRequested, setStopRequested] = useState(false)
  const [importWasStopped, setImportWasStopped] = useState(false)

  const setMigrationMode = useCallback((mode: MigrationMode) => {
    setMigrationModeState(mode)
    setSkipColumnCreation(mode === 'dataOnly')
    setSchemaSnapshot(null)
    setResolverPlan(null)
    if (mode !== 'schemaOnly') {
      setSchemaCreationResults(null)
    }
  }, [])

  const nextStep = useCallback(
    () => setCurrentStep(s => migrationMode === 'schemaOnly' && s === 3 ? 5 : Math.min(s + 1, 5)),
    [migrationMode],
  )
  const prevStep = useCallback(
    () => setCurrentStep(s => migrationMode === 'schemaOnly' && s === 5 ? 3 : Math.max(s - 1, 1)),
    [migrationMode],
  )

  const addImportResult = useCallback((result: ImportResult) =>
    setImportResults(prev => [...prev, result]), [])
  const clearImportResults = useCallback(() => setImportResults([]), [])

  const addLog = useCallback((entry: Omit<LogEntry, 'timestamp'>) =>
    setLogs(prev => [...prev, { ...entry, timestamp: new Date().toISOString() }]), [])

  const clearLogs = useCallback(() => setLogs([]), [])

  const setResolvedDataverseUrl = useCallback((url: string, source: DataverseUrlSource) => {
    setDataverseOrgUrl(url)
    setDataverseOrgUrlState(url)
    setDataverseUrlSource(source)
    setDataverseUrlErrorState(null)
  }, [])

  const setDataverseUrlError = useCallback((error: string) => {
    setDataverseOrgUrlState(null)
    setDataverseUrlSource('error')
    setDataverseUrlErrorState(error)
  }, [])

  const clearResolvedDataverseUrl = useCallback(() => {
    clearDataverseOrgUrl()
    setDataverseOrgUrlState(null)
    setDataverseUrlSource('loading')
    setDataverseUrlErrorState(null)
  }, [])

  const addSkippedFieldInstances = useCallback((instances: SkippedFieldInstance[]) =>
    setSkippedFieldInstances(prev => [...prev, ...instances]), [])

  const clearSkippedFieldInstances = useCallback(() => setSkippedFieldInstances([]), [])
  const addProjectWriteDiagnostics = useCallback((diagnostics: ProjectWriteDiagnostic[]) =>
    setProjectWriteDiagnostics(prev => [...prev, ...diagnostics]), [])
  const clearProjectWriteDiagnostics = useCallback(() => setProjectWriteDiagnostics([]), [])

  const setMigrationScope = useCallback((partial: Partial<Omit<MigrationScope, 'projects'>>) => {
    setMigrationScopeState(prev => {
      let tasks = partial.tasks ?? prev.tasks
      let dependencies = partial.dependencies ?? prev.dependencies
      let assignments = partial.assignments ?? prev.assignments
      let resources = partial.resources ?? prev.resources
      // tasks: false → force deps + assignments off
      if (!tasks) { dependencies = false; assignments = false }
      // deps: true → force tasks on
      if (dependencies) tasks = true
      // assignments: true → force resources on
      if (assignments) resources = true
      return { projects: true, tasks, dependencies, assignments, resources }
    })
  }, [])

  const startImport = useCallback((totalProjects: number, concurrency: number) => {
    setImportProgress({
      startedAt: new Date(),
      projectsCompleted: 0,
      projectsTotal: totalProjects,
      concurrency,
    })
  }, [])

  const completeProject = useCallback((_durationMs: number) => {
    setImportProgress(prev => {
      if (!prev) return prev
      return { ...prev, projectsCompleted: prev.projectsCompleted + 1 }
    })
  }, [])

  const setFetchedData = useCallback((data: PoFetchedData | null) => {
    setFetchedDataState(data)
    setSelectedProjectIds(new Set(data?.projects.map(p => p.ProjectId) ?? []))
    setProjectFilterState(emptyFilter())
    setMappingConfig(null)
    setOptionSetMappings([])
    setImportResults([])
    setSchemaSnapshot(null)
    setResolverPlan(null)
    setSkippedFieldInstances([])
    setProjectWriteDiagnostics([])
    setSchemaCreationResults(null)
    setImportProgress(null)
    setStopRequested(false)
    setImportWasStopped(false)
  }, [])

  const toggleProjectSelection = useCallback((id: string) => {
    setSelectedProjectIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectProjectsByIds = useCallback((ids: string[]) => {
    setSelectedProjectIds(prev => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
  }, [])

  const deselectProjectsByIds = useCallback((ids: string[]) => {
    setSelectedProjectIds(prev => {
      const next = new Set(prev)
      for (const id of ids) next.delete(id)
      return next
    })
  }, [])

  const setProjectFilter = useCallback((filter: ProjectFilter) => setProjectFilterState(filter), [])
  const clearProjectFilter = useCallback(() => setProjectFilterState(emptyFilter()), [])

  const clearImportProgress = useCallback(() => setImportProgress(null), [])
  const requestStop = useCallback(() => setStopRequested(true), [])
  const clearStopRequest = useCallback(() => setStopRequested(false), [])

  const resetState = useCallback(() => {
    setCurrentStep(1)
    setPwaUrl('')
    setDataSource('ProjectOnline')
    setSelectedSolution(null)
    setSkipColumnCreation(false)
    setFetchedDataState(null)
    setSelectedProjectIds(new Set())
    setProjectFilterState(emptyFilter())
    setMappingConfig(null)
    setOptionSetMappings([])
    setImportResults([])
    setLogs([])
    setMigrationModeState('full')
    setSchemaSnapshot(null)
    setResolverPlan(null)
    setSkippedFieldInstances([])
    setProjectWriteDiagnostics([])
    setSchemaCreationResults(null)
    setMigrationScopeState(DEFAULT_MIGRATION_SCOPE)
    setImportProgress(null)
    setStopRequested(false)
    setImportWasStopped(false)
    try { localStorage.removeItem('DEBUG_DATAONLY_WRITER') } catch { /* ignore */ }
  }, [])

  return (
    <MigrationContext.Provider value={{
      currentStep, pwaUrl, dataverseOrgUrl, dataverseUrlSource, dataverseUrlError,
      dataSource, selectedSolution, skipColumnCreation,
      fetchedData, selectedProjectIds, projectFilter,
      mappingConfig, optionSetMappings, importResults, logs,
      migrationMode, schemaSnapshot, resolverPlan, schemaCreationResults,
      skippedFieldInstances, projectWriteDiagnostics,
      migrationScope, importProgress, stopRequested, importWasStopped,
      setCurrentStep, nextStep, prevStep, setPwaUrl,
      setResolvedDataverseUrl, setDataverseUrlError, clearResolvedDataverseUrl,
      setDataSource,
      setSelectedSolution, setSkipColumnCreation,
      setFetchedData, setSelectedProjectIds, toggleProjectSelection,
      selectProjectsByIds, deselectProjectsByIds,
      setProjectFilter, clearProjectFilter,
      setMappingConfig, setOptionSetMappings,
      addImportResult, clearImportResults, addLog, clearLogs,
      setMigrationMode, setSchemaSnapshot, setResolverPlan,
      addSkippedFieldInstances, clearSkippedFieldInstances,
      addProjectWriteDiagnostics, clearProjectWriteDiagnostics,
      setSchemaCreationResults, resetState,
      setMigrationScope, startImport, completeProject, clearImportProgress,
      requestStop, clearStopRequest, setImportWasStopped,
    }}>
      {children}
    </MigrationContext.Provider>
  )
}

export function useMigration(): MigrationContextType {
  const ctx = useContext(MigrationContext)
  if (!ctx) throw new Error('useMigration must be used inside MigrationProvider')
  return ctx
}
