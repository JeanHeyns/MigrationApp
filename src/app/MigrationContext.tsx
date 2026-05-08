import React, { createContext, useContext, useState } from 'react'
import type { PoFetchedData } from '../models/projectOnline.types'
import type { MappingConfiguration, OptionSetMapping } from '../models/mapping.types'
import type { DvSolution, ImportResult, LogEntry } from '../models/plannerPremium.types'
import type { MigrationMode, SchemaSnapshot, ResolverPlan, SkippedFieldInstance } from '../models/dataOnly.types'

export type DataSource = 'ProjectOnline' | 'FileUpload'

interface MigrationState {
  currentStep: number
  pwaUrl: string
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
}

interface MigrationActions {
  setCurrentStep: (step: number) => void
  nextStep: () => void
  prevStep: () => void
  setPwaUrl: (url: string) => void
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
}

type MigrationContextType = MigrationState & MigrationActions

const MigrationContext = createContext<MigrationContextType | null>(null)

export function MigrationProvider({ children }: { children: React.ReactNode }) {
  const [currentStep, setCurrentStep] = useState(1)
  const [pwaUrl, setPwaUrl] = useState('')
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

  function setMigrationMode(mode: MigrationMode) {
    setMigrationModeState(mode)
    setSkipColumnCreation(mode === 'dataOnly')
    if (mode === 'full') {
      setSchemaSnapshot(null)
      setResolverPlan(null)
    }
  }

  const nextStep = () => setCurrentStep(s => Math.min(s + 1, 5))
  const prevStep = () => setCurrentStep(s => Math.max(s - 1, 1))

  const addImportResult = (result: ImportResult) =>
    setImportResults(prev => [...prev, result])
  const clearImportResults = () => setImportResults([])

  const addLog = (entry: Omit<LogEntry, 'timestamp'>) =>
    setLogs(prev => [...prev, { ...entry, timestamp: new Date().toISOString() }])

  const clearLogs = () => setLogs([])

  const addSkippedFieldInstances = (instances: SkippedFieldInstance[]) =>
    setSkippedFieldInstances(prev => [...prev, ...instances])

  const clearSkippedFieldInstances = () => setSkippedFieldInstances([])

  return (
    <MigrationContext.Provider value={{
      currentStep, pwaUrl, dataSource, selectedSolution, skipColumnCreation,
      fetchedData, mappingConfig, optionSetMappings, importResults, logs,
      migrationMode, schemaSnapshot, resolverPlan,
      setCurrentStep, nextStep, prevStep, setPwaUrl, setDataSource,
      setSelectedSolution, setSkipColumnCreation,
      setFetchedData, setMappingConfig, setOptionSetMappings,
      addImportResult, clearImportResults, addLog, clearLogs,
      setMigrationMode, setSchemaSnapshot, setResolverPlan,
      skippedFieldInstances, addSkippedFieldInstances, clearSkippedFieldInstances,
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
