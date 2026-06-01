import { useRef, useState } from 'react'
import { Button, MessageBar, MessageBarBody, Spinner, makeStyles, tokens } from '@fluentui/react-components'
import { useMigration } from '../../app/MigrationContext'
import { createOptionSets } from '../../services/plannerPremium/choiceSetManager'
import { createColumns, createMigrationColumns } from '../../services/plannerPremium/columnManager'
import { orchestrateSchemaCreation } from '../../services/plannerPremium/schemaOrchestrator'
import type { OptionSetMapping } from '../../models/mapping.types'
import type { ColumnCreateResult } from '../../services/plannerPremium/columnManager'

const useStyles = makeStyles({
  root: { padding: '32px', maxWidth: '760px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '24px' },
  title: { fontSize: '20px', fontWeight: '600', color: tokens.colorNeutralForeground1 },
  subtitle: { fontSize: '13px', color: tokens.colorNeutralForeground3 },
  summary: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: '12px',
  },
  summaryCard: {
    background: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  summaryCount: {
    fontSize: '28px',
    fontWeight: '700',
    color: tokens.colorBrandForeground1,
    lineHeight: '1',
  },
  summaryLabel: { fontSize: '12px', color: tokens.colorNeutralForeground3 },
  logPanel: {
    fontFamily: 'Consolas, monospace',
    fontSize: '12px',
    lineHeight: '1.6',
    background: tokens.colorNeutralBackground4,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    padding: '12px 16px',
    maxHeight: '320px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  logLine: { display: 'flex', gap: '8px', alignItems: 'flex-start' },
  logTime: { color: tokens.colorNeutralForeground3, whiteSpace: 'nowrap', flexShrink: 0 },
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
})

type Phase = 'idle' | 'running' | 'done' | 'error'

interface LogLine {
  time: string
  level: 'info' | 'success' | 'warning' | 'error'
  message: string
}

const LEVEL_COLOR: Record<LogLine['level'], string> = {
  info:    tokens.colorNeutralForeground2,
  success: '#107c10',
  warning: '#a78a00',
  error:   '#a4262c',
}
const LEVEL_PREFIX: Record<LogLine['level'], string> = {
  info: '→', success: '✓', warning: '!', error: '✗',
}

export function Step3CreateColumns() {
  const styles = useStyles()
  const {
    fetchedData, mappingConfig, selectedSolution, setOptionSetMappings, setMappingConfig,
    nextStep, prevStep, migrationMode, setSchemaCreationResults,
  } = useMigration()

  const [phase, setPhase] = useState<Phase>('idle')
  const [logLines, setLogLines] = useState<LogLine[]>([])
  const [successCount, setSuccessCount] = useState(0)
  const [skipCount, setSkipCount] = useState(0)
  const [errorCount, setErrorCount] = useState(0)
  const logRef = useRef<HTMLDivElement>(null)

  const skip = migrationMode === 'dataOnly'
  const activeMappings = mappingConfig?.fieldMappings.filter(f => !f.skip) ?? []
  const lookupMappings = activeMappings.filter(f => f.targetColumnType === 'OptionSet' || f.targetColumnType === 'MultiSelectOptionSet')
  const uniqueLookupCount = new Set(lookupMappings.map(f => f.lookupTable?.LookupTableUID).filter(Boolean)).size
  const lookupEntityCount = new Set(activeMappings
    .filter(f => f.targetColumnType === 'Lookup' && !f.useExistingLookupEntity)
    .map(f => f.lookupTable?.LookupTableUID)
    .filter(Boolean)
  ).size

  function appendLog(level: LogLine['level'], message: string) {
    const time = new Date().toLocaleTimeString('en', { hour12: false })
    setLogLines(prev => [...prev, { time, level, message }])
    // Auto-scroll
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
    })
  }

  async function handleStart() {
    if (!mappingConfig || !selectedSolution) return

    setPhase('running')
    setLogLines([])
    setSuccessCount(0)
    setSkipCount(0)
    setErrorCount(0)

    appendLog('info', `Starting column setup for solution "${selectedSolution.uniquename}"…`)

    if (migrationMode === 'schemaOnly') {
      if (!fetchedData) return
      const orchestration = await orchestrateSchemaCreation({
        mappingConfig,
        poLookupTables: fetchedData.lookupTables,
        selectedSolution,
        publisherPrefix: mappingConfig.publisherPrefix,
        onProgress: (msg, level = 'info') => appendLog(level, msg),
      })
      setOptionSetMappings(orchestration.optionSetMappings)
      setSchemaCreationResults(orchestration)
      if (orchestration.multiLookupMappings.length > 0 && mappingConfig) {
        setMappingConfig({ ...mappingConfig, multiLookups: orchestration.multiLookupMappings })
      }
      const ok =
        orchestration.columns.created.length +
        orchestration.optionSets.created.length +
        orchestration.lookupEntities.created.length +
        orchestration.lookupEntries.inserted.length
      const skipped =
        orchestration.columns.skipped.length +
        orchestration.optionSets.skipped.length +
        orchestration.lookupEntities.skipped.length +
        orchestration.lookupEntries.skipped.length
      const err =
        orchestration.columns.failed.length +
        orchestration.optionSets.failed.length +
        orchestration.lookupEntities.failed.length +
        orchestration.lookupEntries.failed.length
      setSuccessCount(ok)
      setSkipCount(skipped)
      setErrorCount(err)
      appendLog(err > 0 ? 'error' : 'success', `Schema setup complete - ${ok} created, ${skipped} skipped, ${err} error(s).`)
      setPhase(err > 0 ? 'error' : 'done')
      return
    }

    let osMappings: OptionSetMapping[] = []

    // ── Phase 1: OptionSets ──
    if (uniqueLookupCount > 0) {
      appendLog('info', `Creating ${uniqueLookupCount} global OptionSet(s)…`)
      osMappings = await createOptionSets(
        mappingConfig.fieldMappings,
        selectedSolution.uniquename,
        (name, success, alreadyExisted, error) => {
          if (!success) {
            appendLog('error', `OptionSet "${name}": ${error}`)
          } else if (alreadyExisted) {
            appendLog('warning', `OptionSet "${name}" already exists — skipped`)
          } else {
            appendLog('success', `OptionSet "${name}" created`)
          }
        },
      )
    } else {
      appendLog('info', 'No lookup-based OptionSets needed.')
    }

    // ── Phase 2: Columns ──
    appendLog('info', `Creating ${activeMappings.length} column(s)…`)
    let ok = 0, skipped = 0, err = 0

    appendLog('info', 'Creating migration tracking column(s)...')
    const migrationResults = await createMigrationColumns(
      mappingConfig.publisherPrefix,
      selectedSolution.uniquename,
    )
    for (const result of migrationResults) {
      if (!result.success) {
        err++
        appendLog('error', `${result.entityLogicalName}.${result.logicalName}: ${result.error}`)
      } else if (result.alreadyExisted) {
        skipped++
        appendLog('warning', `${result.entityLogicalName}.${result.logicalName} already exists - skipped`)
      } else {
        ok++
        appendLog('success', `${result.entityLogicalName}.${result.logicalName} created`)
      }
    }

    const colResults: ColumnCreateResult[] = await createColumns(
      mappingConfig.fieldMappings,
      osMappings,
      selectedSolution.uniquename,
      (result) => {
        if (!result.success) {
          err++
          appendLog('error', `${result.entityLogicalName}.${result.logicalName}: ${result.error}`)
        } else if (result.alreadyExisted) {
          skipped++
          appendLog('warning', `${result.entityLogicalName}.${result.logicalName} already exists — skipped`)
        } else {
          ok++
          appendLog('success', `${result.entityLogicalName}.${result.logicalName} created`)
        }
      },
    )

    void colResults

    setSuccessCount(ok)
    setSkipCount(skipped)
    setErrorCount(err)
    setOptionSetMappings(osMappings)

    if (err > 0) {
      appendLog('error', `Done — ${ok} created, ${skipped} already existed, ${err} error(s).`)
      setPhase('error')
    } else {
      appendLog('success', `Done — ${ok} created, ${skipped} already existed.`)
      setPhase('done')
    }
  }

  const isDone = phase === 'done' || phase === 'error'

  return (
    <div className={styles.root}>
      <div>
        <div className={styles.title}>Step 3 — Create Columns in Dataverse</div>
        <div className={styles.subtitle}>
          Creates global OptionSets and columns on msdyn_project / msdyn_projecttask based on the field mapping.
        </div>
      </div>

      {skip ? (
        <>
          <MessageBar intent="success">
            <MessageBarBody>
              Schema validated — no columns or option sets need to be created.
            </MessageBarBody>
          </MessageBar>
          <div className={styles.summary}>
            <div className={styles.summaryCard}>
              <div className={styles.summaryCount} style={{ color: '#107c10' }}>{activeMappings.length}</div>
              <div className={styles.summaryLabel}>Columns reused from existing schema</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryCount} style={{ color: '#107c10' }}>0</div>
              <div className={styles.summaryLabel}>Columns to create</div>
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Summary cards */}
          {phase === 'idle' && mappingConfig && (
            <div className={styles.summary}>
              <div className={styles.summaryCard}>
                <div className={styles.summaryCount}>{uniqueLookupCount}</div>
                <div className={styles.summaryLabel}>OptionSets to create</div>
              </div>
              {migrationMode === 'schemaOnly' && (
                <div className={styles.summaryCard}>
                  <div className={styles.summaryCount}>{lookupEntityCount}</div>
                  <div className={styles.summaryLabel}>Lookup entities to ensure</div>
                </div>
              )}
              <div className={styles.summaryCard}>
                <div className={styles.summaryCount}>{activeMappings.length}</div>
                <div className={styles.summaryLabel}>Columns to create</div>
              </div>
              <div className={styles.summaryCard}>
                <div className={styles.summaryCount}>{selectedSolution?.publisherPrefix ?? '—'}_</div>
                <div className={styles.summaryLabel}>Solution prefix</div>
              </div>
            </div>
          )}

          {!mappingConfig && (
            <MessageBar intent="warning">
              <MessageBarBody>No mapping configuration found. Go back to Step 2 and save a mapping.</MessageBarBody>
            </MessageBar>
          )}

          {/* Start button */}
          {phase === 'idle' && mappingConfig && (
            <Button
              appearance="primary"
              onClick={handleStart}
              disabled={!selectedSolution}
            >
              {migrationMode === 'schemaOnly' ? 'Create Schema' : 'Create OptionSets & Columns'}
            </Button>
          )}

          {/* Live log */}
          {(phase === 'running' || isDone) && (
            <div className={styles.logPanel} ref={logRef}>
              {logLines.map((line, i) => (
                <div key={i} className={styles.logLine}>
                  <span className={styles.logTime}>{line.time}</span>
                  <span style={{ color: LEVEL_COLOR[line.level], fontWeight: '600', width: '14px', flexShrink: 0 }}>
                    {LEVEL_PREFIX[line.level]}
                  </span>
                  <span style={{ color: LEVEL_COLOR[line.level] }}>{line.message}</span>
                </div>
              ))}
              {phase === 'running' && (
                <div className={styles.logLine} style={{ marginTop: '4px' }}>
                  <Spinner size="extra-tiny" />
                  <span style={{ color: tokens.colorNeutralForeground3, marginLeft: '6px' }}>Running…</span>
                </div>
              )}
            </div>
          )}

          {/* Result summary */}
          {isDone && (
            <div className={styles.summary}>
              <div className={styles.summaryCard}>
                <div className={styles.summaryCount} style={{ color: '#107c10' }}>{successCount}</div>
                <div className={styles.summaryLabel}>Created</div>
              </div>
              <div className={styles.summaryCard}>
                <div className={styles.summaryCount} style={{ color: '#a78a00' }}>{skipCount}</div>
                <div className={styles.summaryLabel}>Already existed</div>
              </div>
              <div className={styles.summaryCard}>
                <div className={styles.summaryCount} style={{ color: errorCount > 0 ? '#a4262c' : tokens.colorNeutralForeground3 }}>
                  {errorCount}
                </div>
                <div className={styles.summaryLabel}>Errors</div>
              </div>
            </div>
          )}
        </>
      )}

      <div className={styles.footer}>
        <Button onClick={prevStep} disabled={phase === 'running'}>← Back</Button>
        <Button
          appearance="primary"
          onClick={nextStep}
          disabled={phase === 'running' || (!skip && !isDone)}
        >
          {migrationMode === 'schemaOnly' ? 'Next: View Report →' : 'Next: Import Data →'}
        </Button>
      </div>
    </div>
  )
}
