import React, { createContext, useCallback, useContext, useState } from 'react'
import type { PoFetchedData } from '../models/projectOnline.types'
import type { MappingConfiguration, OptionSetMapping } from '../models/mapping.types'
import type { DvSolution, ImportResult, LogEntry } from '../models/plannerPremium.types'
import type { MigrationMode, SchemaCreationResults, SchemaSnapshot, ResolverPlan, SkippedFieldInstance } from '../models/dataOnly.types'
import { clearDataverseOrgUrl, setDataverseOrgUrl } from '../config/environment'

export type DataSource = 'ProjectOnline' | 'FileUpload'
export type DataverseUrlSource = 'loading' | 'localStorage' | 'environmentVariable' | 'manualInput' | 'error'

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
  mappingConfig: MappingConfiguration | null
  optionSetMappings: OptionSetMapping[]
  importResults: ImportResult[]
  logs: LogEntry[]
  migrationMode: MigrationMode
  schemaSnapshot: SchemaSnapshot | null
  resolverPlan: ResolverPlan | null
  skippedFieldInstances: SkippedFieldInstance[]
  schemaCreationResults: SchemaCreationResults | null
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
  setFetchedData: (data: PoFetchedData) => void
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
  setSchemaCreationResults: (results: SchemaCreationResults | null) => void
  resetState: () => void
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
  const [fetchedData, setFetchedData] = useState<PoFetchedData | null>(null)
  const [mappingConfig, setMappingConfig] = useState<MappingConfiguration | null>(null)
  const [optionSetMappings, setOptionSetMappings] = useState<OptionSetMapping[]>([])
  const [importResults, setImportResults] = useState<ImportResult[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [migrationMode, setMigrationModeState] = useState<MigrationMode>('full')
  const [schemaSnapshot, setSchemaSnapshot] = useState<SchemaSnapshot | null>(null)
  const [resolverPlan, setResolverPlan] = useState<ResolverPlan | null>(null)
  const [skippedFieldInstances, setSkippedFieldInstances] = useState<SkippedFieldInstance[]>([])
  const [schemaCreationResults, setSchemaCreationResults] = useState<SchemaCreationResults | null>(null)

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

  const resetState = useCallback(() => {
    setCurrentStep(1)
    setPwaUrl('')
    setDataSource('ProjectOnline')
    setSelectedSolution(null)
    setSkipColumnCreation(false)
    setFetchedData(null)
    setMappingConfig(null)
    setOptionSetMappings([])
    setImportResults([])
    setLogs([])
    setMigrationModeState('full')
    setSchemaSnapshot(null)
    setResolverPlan(null)
    setSkippedFieldInstances([])
    setSchemaCreationResults(null)
    try { localStorage.removeItem('DEBUG_DATAONLY_WRITER') } catch { /* ignore */ }
  }, [])

  return (
    <MigrationContext.Provider value={{
      currentStep, pwaUrl, dataverseOrgUrl, dataverseUrlSource, dataverseUrlError,
      dataSource, selectedSolution, skipColumnCreation,
      fetchedData, mappingConfig, optionSetMappings, importResults, logs,
      migrationMode, schemaSnapshot, resolverPlan, schemaCreationResults,
      setCurrentStep, nextStep, prevStep, setPwaUrl,
      setResolvedDataverseUrl, setDataverseUrlError, clearResolvedDataverseUrl,
      setDataSource,
      setSelectedSolution, setSkipColumnCreation,
      setFetchedData, setMappingConfig, setOptionSetMappings,
      addImportResult, clearImportResults, addLog, clearLogs,
      setMigrationMode, setSchemaSnapshot, setResolverPlan,
      skippedFieldInstances, addSkippedFieldInstances, clearSkippedFieldInstances,
      setSchemaCreationResults, resetState,
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
