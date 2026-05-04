import React, { createContext, useContext, useState } from 'react'
import type { PoFetchedData } from '../models/projectOnline.types'
import type { MappingConfiguration, OptionSetMapping } from '../models/mapping.types'
import type { DvSolution, ImportResult, LogEntry } from '../models/plannerPremium.types'

interface MigrationState {
  currentStep: number
  pwaUrl: string
  selectedSolution: DvSolution | null
  skipColumnCreation: boolean
  fetchedData: PoFetchedData | null
  mappingConfig: MappingConfiguration | null
  optionSetMappings: OptionSetMapping[]
  importResults: ImportResult[]
  logs: LogEntry[]
}

interface MigrationActions {
  setCurrentStep: (step: number) => void
  nextStep: () => void
  prevStep: () => void
  setPwaUrl: (url: string) => void
  setSelectedSolution: (solution: DvSolution | null) => void
  setSkipColumnCreation: (skip: boolean) => void
  setFetchedData: (data: PoFetchedData) => void
  setMappingConfig: (config: MappingConfiguration) => void
  setOptionSetMappings: (mappings: OptionSetMapping[]) => void
  addImportResult: (result: ImportResult) => void
  clearImportResults: () => void
  addLog: (entry: Omit<LogEntry, 'timestamp'>) => void
  clearLogs: () => void
}

type MigrationContextType = MigrationState & MigrationActions

const MigrationContext = createContext<MigrationContextType | null>(null)

export function MigrationProvider({ children }: { children: React.ReactNode }) {
  const [currentStep, setCurrentStep] = useState(1)
  const [pwaUrl, setPwaUrl] = useState('')
  const [selectedSolution, setSelectedSolution] = useState<DvSolution | null>(null)
  const [skipColumnCreation, setSkipColumnCreation] = useState(false)
  const [fetchedData, setFetchedData] = useState<PoFetchedData | null>(null)
  const [mappingConfig, setMappingConfig] = useState<MappingConfiguration | null>(null)
  const [optionSetMappings, setOptionSetMappings] = useState<OptionSetMapping[]>([])
  const [importResults, setImportResults] = useState<ImportResult[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])

  const nextStep = () => setCurrentStep(s => Math.min(s + 1, 5))
  const prevStep = () => setCurrentStep(s => Math.max(s - 1, 1))

  const addImportResult = (result: ImportResult) =>
    setImportResults(prev => [...prev, result])
  const clearImportResults = () => setImportResults([])

  const addLog = (entry: Omit<LogEntry, 'timestamp'>) =>
    setLogs(prev => [...prev, { ...entry, timestamp: new Date().toISOString() }])

  const clearLogs = () => setLogs([])

  return (
    <MigrationContext.Provider value={{
      currentStep, pwaUrl, selectedSolution, skipColumnCreation,
      fetchedData, mappingConfig, optionSetMappings, importResults, logs,
      setCurrentStep, nextStep, prevStep, setPwaUrl,
      setSelectedSolution, setSkipColumnCreation,
      setFetchedData, setMappingConfig, setOptionSetMappings,
      addImportResult, clearImportResults, addLog, clearLogs,
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
