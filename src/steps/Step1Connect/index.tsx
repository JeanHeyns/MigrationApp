import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Field,
  Input,
  Radio,
  RadioGroup,
  Select,
  Spinner,
  MessageBar,
  MessageBarBody,
  Tab,
  TabList,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { ArrowUploadRegular, ArrowDownloadRegular } from '@fluentui/react-icons'
import { useMigration } from '../../app/MigrationContext'
import { fetchProjects } from '../../services/projectOnline/projects'
import { fetchTasks } from '../../services/projectOnline/tasks'
import { fetchResources } from '../../services/projectOnline/resources'
import { fetchAssignments, fetchTeamMembers } from '../../services/projectOnline/assignments'
import { fetchCustomFields } from '../../services/projectOnline/customFields'
import { fetchLookupTables } from '../../services/projectOnline/lookupTables'
import { fetchSolutions } from '../../services/plannerPremium/dataverseClient'
import { inspectSolution } from '../../services/plannerPremium/schemaInspector'
import { parseWorkbook, generateTemplate } from '../../services/fileImportService'
import type { PoFetchedData } from '../../models/projectOnline.types'
import type { DvSolution } from '../../models/plannerPremium.types'
import type { MigrationMode } from '../../models/dataOnly.types'

const useStyles = makeStyles({
  root: {
    padding: '32px',
    maxWidth: '760px',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  title: {
    fontSize: '20px',
    fontWeight: '600',
    color: tokens.colorNeutralForeground1,
    marginBottom: '4px',
  },
  subtitle: {
    fontSize: '13px',
    color: tokens.colorNeutralForeground3,
  },
  sectionTitle: {
    fontSize: '14px',
    fontWeight: '600',
    color: tokens.colorNeutralForeground1,
    marginBottom: '8px',
  },
  urlRow: {
    display: 'flex',
    gap: '12px',
    alignItems: 'flex-end',
  },
  urlInput: {
    flex: 1,
  },
  solutionRow: {
    display: 'flex',
    gap: '12px',
    alignItems: 'flex-end',
  },
  solutionSelect: {
    flex: 1,
  },
  prefixBadge: {
    display: 'inline-block',
    padding: '3px 10px',
    borderRadius: '12px',
    background: tokens.colorBrandBackground2,
    color: tokens.colorBrandForeground1,
    fontFamily: 'Consolas, monospace',
    fontSize: '12px',
    fontWeight: '600',
    whiteSpace: 'nowrap',
    alignSelf: 'flex-end',
    marginBottom: '5px',
  },
  sectionBox: {
    padding: '16px',
    background: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  progressArea: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '16px',
    background: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  progressLabel: {
    fontSize: '13px',
    fontWeight: '600',
    color: tokens.colorNeutralForeground2,
    marginBottom: '4px',
  },
  progressItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '13px',
    color: tokens.colorNeutralForeground2,
  },
  previewGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
    gap: '12px',
  },
  previewCard: {
    background: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  previewCount: {
    fontSize: '28px',
    fontWeight: '700',
    color: tokens.colorBrandForeground1,
    lineHeight: '1',
  },
  previewLabel: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
  },
  uploadBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  uploadRow: {
    display: 'flex',
    gap: '12px',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  uploadHint: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
  },
  fileName: {
    fontSize: '13px',
    color: tokens.colorNeutralForeground2,
    fontStyle: 'italic',
  },
  templateRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 14px',
    background: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    fontSize: '13px',
    color: tokens.colorNeutralForeground2,
  },
  modeToggleRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  modeLabel: {
    fontSize: '13px',
    fontWeight: '600',
    color: tokens.colorNeutralForeground1,
  },
  scanSummary: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '13px',
    color: '#107c10',
    padding: '8px 12px',
    background: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  scanRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '13px',
    color: tokens.colorNeutralForeground2,
  },
})

type FetchItemStatus = 'pending' | 'fetching' | 'done' | 'error'

interface FetchItem {
  key: keyof PoFetchedData
  label: string
  status: FetchItemStatus
  count: number
  error?: string
}

const INITIAL_ITEMS: FetchItem[] = [
  { key: 'projects',     label: 'Projects',      status: 'pending', count: 0 },
  { key: 'tasks',        label: 'Tasks',          status: 'pending', count: 0 },
  { key: 'resources',    label: 'Resources',      status: 'pending', count: 0 },
  { key: 'assignments',  label: 'Assignments',    status: 'pending', count: 0 },
  { key: 'teamMembers',  label: 'Team Members',   status: 'pending', count: 0 },
  { key: 'customFields', label: 'Custom Fields',  status: 'pending', count: 0 },
  { key: 'lookupTables', label: 'Lookup Tables',  status: 'pending', count: 0 },
]

const SCHEMA_ONLY_ITEMS: FetchItem[] = INITIAL_ITEMS.map(item =>
  item.key === 'customFields' || item.key === 'lookupTables'
    ? item
    : { ...item, status: 'done', count: 0 }
)

const STATUS_ICON: Record<FetchItemStatus, string> = {
  pending:  '○',
  fetching: '⟳',
  done:     '✓',
  error:    '✗',
}

const STATUS_COLOR: Record<FetchItemStatus, string> = {
  pending:  '#888',
  fetching: '#0078d4',
  done:     '#107c10',
  error:    '#a4262c',
}

export function Step1Connect() {
  const styles = useStyles()
  const {
    pwaUrl, setPwaUrl, dataSource, setDataSource,
    selectedSolution, setSelectedSolution, setFetchedData, nextStep,
    migrationMode, setMigrationMode, schemaSnapshot, setSchemaSnapshot,
  } = useMigration()

  // ── Project Online state ─────────────────────────────────────────────────
  const [localUrl, setLocalUrl] = useState(pwaUrl)
  const [phase, setPhase]       = useState<'idle' | 'fetching' | 'done' | 'error'>('idle')
  const [items, setItems]       = useState<FetchItem[]>(INITIAL_ITEMS)
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [result, setResult]     = useState<PoFetchedData | null>(null)

  // ── File upload state ────────────────────────────────────────────────────
  const fileInputRef            = useRef<HTMLInputElement>(null)
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [uploadResult, setUploadResult] = useState<PoFetchedData | null>(null)
  const [uploadError, setUploadError]   = useState<string | null>(null)
  const [uploadParsing, setUploadParsing] = useState(false)

  // ── Shared: Dataverse solutions ──────────────────────────────────────────
  const [solutions, setSolutions]           = useState<DvSolution[]>([])
  const [solutionsLoading, setSolutionsLoading] = useState(true)
  const [solutionsError, setSolutionsError] = useState<string | null>(null)

  // ── Schema scan (dataOnly mode) ──────────────────────────────────────────
  const [scanPhase, setScanPhase] = useState<'idle' | 'scanning' | 'done' | 'error'>('idle')
  const [scanError, setScanError] = useState<string | null>(null)

  useEffect(() => {
    fetchSolutions()
      .then(setSolutions)
      .catch(e => setSolutionsError(String(e)))
      .finally(() => setSolutionsLoading(false))
  }, [])

  // Auto-trigger scan when dataOnly mode is active and solution is chosen (or changed)
  useEffect(() => {
    if (migrationMode !== 'dataOnly' || !selectedSolution) return
    if (schemaSnapshot?.solutionId === selectedSolution.solutionid) return
    runScan()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [migrationMode, selectedSolution?.solutionid])

  async function runScan() {
    if (!selectedSolution) return
    setScanPhase('scanning')
    setScanError(null)
    setSchemaSnapshot(null)
    try {
      const snapshot = await inspectSolution(selectedSolution.solutionid)
      setSchemaSnapshot(snapshot)
      setScanPhase('done')
    } catch (e) {
      setScanError(String(e))
      setScanPhase('error')
    }
  }

  // ── Project Online handlers ──────────────────────────────────────────────
  function updateItem(key: keyof PoFetchedData, patch: Partial<FetchItem>) {
    setItems(prev => prev.map(it => it.key === key ? { ...it, ...patch } : it))
  }

  async function handleConnect() {
    const url = localUrl.trim().replace(/\/$/, '')
    if (!url.startsWith('https://')) {
      setGlobalError('URL must start with https://')
      return
    }
    setGlobalError(null)
    setPhase('fetching')
    setItems(migrationMode === 'schemaOnly' ? SCHEMA_ONLY_ITEMS : INITIAL_ITEMS)
    setPwaUrl(url)

    const data: PoFetchedData = {
      pwaUrl: url,
      projects: [], tasks: [], resources: [], assignments: [],
      teamMembers: [], customFields: [], lookupTables: [],
    }

    type FetchStep = { key: keyof PoFetchedData; fn: () => Promise<unknown[]> }
    const fullSteps: FetchStep[] = [
      { key: 'projects',     fn: () => fetchProjects(url) },
      { key: 'tasks',        fn: () => fetchTasks(url) },
      { key: 'resources',    fn: () => fetchResources(url) },
      { key: 'assignments',  fn: () => fetchAssignments(url) },
      { key: 'teamMembers',  fn: () => fetchTeamMembers(url) },
      { key: 'customFields', fn: () => fetchCustomFields(url) },
      { key: 'lookupTables', fn: () => fetchLookupTables(url) },
    ]
    const schemaOnlySteps: FetchStep[] = [
      { key: 'customFields', fn: () => fetchCustomFields(url) },
      { key: 'lookupTables', fn: () => fetchLookupTables(url) },
    ]
    const steps = migrationMode === 'schemaOnly' ? schemaOnlySteps : fullSteps

    let anyError = false
    for (const step of steps) {
      updateItem(step.key, { status: 'fetching' })
      try {
        const fetched = await step.fn()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(data as any)[step.key] = fetched
        updateItem(step.key, { status: 'done', count: fetched.length })
      } catch (e) {
        anyError = true
        updateItem(step.key, { status: 'error', error: String(e) })
      }
    }

    setResult(data)
    setFetchedData(data)
    setPhase(anyError ? 'error' : 'done')
  }

  // ── File upload handlers ─────────────────────────────────────────────────
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadedFile(file)
    setUploadError(null)
    setUploadResult(null)
    setUploadParsing(true)
    try {
      const data = await parseWorkbook(file)
      setUploadResult(data)
      setFetchedData(data)
    } catch (err) {
      setUploadError(String(err))
    } finally {
      setUploadParsing(false)
    }
  }

  function handleDownloadTemplate() {
    const blob = generateTemplate()
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = 'migration-template.xlsx'
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleSolutionChange(id: string) {
    const sol = solutions.find(s => s.solutionid === id) ?? null
    setSelectedSolution(sol)
  }

  function handleSourceChange(source: string) {
    setDataSource(source as 'ProjectOnline' | 'FileUpload')
    // Reset results when switching source
    setResult(null)
    setUploadResult(null)
    setUploadedFile(null)
    setUploadError(null)
    setGlobalError(null)
    setPhase('idle')
    setItems(INITIAL_ITEMS)
  }

  // ── canProceed logic ─────────────────────────────────────────────────────
  const poReady     = dataSource === 'ProjectOnline' && (phase === 'done' || phase === 'error') && !!result && (
    migrationMode === 'schemaOnly'
      ? result.customFields.length > 0 || result.lookupTables.length > 0
      : result.projects.length > 0
  )
  const fileReady   = dataSource === 'FileUpload' && !!uploadResult && uploadResult.projects.length > 0
  const scanOk      = migrationMode !== 'dataOnly' || scanPhase === 'done'
  const canProceed  = (poReady || fileReady) && !!selectedSolution && scanOk

  const isFetching  = phase === 'fetching'
  const isDone      = phase === 'done' || phase === 'error'

  // Active preview data (either source)
  const activeResult = dataSource === 'ProjectOnline' ? result : uploadResult
  const previewItems: { label: string; count: number }[] = activeResult
    ? [
        { label: 'Projects',     count: activeResult.projects.length },
        { label: 'Tasks',        count: activeResult.tasks.length },
        { label: 'Resources',    count: activeResult.resources.length },
        { label: 'Assignments',  count: activeResult.assignments.length },
        { label: 'Team Members', count: activeResult.teamMembers.length },
        { label: 'Custom Fields',count: activeResult.customFields.length },
        { label: 'Lookup Tables',count: activeResult.lookupTables.length },
      ]
    : []

  return (
    <div className={styles.root}>
      <div>
        <div className={styles.title}>Step 1 — Connect &amp; Read</div>
        <div className={styles.subtitle}>
          Connect to Project Online or upload an Excel/CSV file to begin the migration.
        </div>
      </div>

      {/* ── Source selector ── */}
      <TabList
        selectedValue={dataSource}
        onTabSelect={(_, d) => handleSourceChange(d.value as string)}
      >
        <Tab value="ProjectOnline">Project Online</Tab>
        <Tab value="FileUpload">Upload File (Excel / CSV)</Tab>
      </TabList>

      {/* ── Project Online panel ── */}
      {dataSource === 'ProjectOnline' && (
        <>
          <div className={styles.urlRow}>
            <Field label="Project Online PWA URL" className={styles.urlInput}>
              <Input
                type="url"
                placeholder="https://contoso.sharepoint.com/sites/pwa"
                value={localUrl}
                onChange={e => setLocalUrl(e.target.value)}
                disabled={isFetching}
              />
            </Field>
            <Button
              appearance="primary"
              onClick={handleConnect}
              disabled={isFetching || !localUrl.trim()}
              icon={isFetching ? <Spinner size="tiny" /> : undefined}
            >
              {isFetching ? 'Reading…' : 'Connect & Read'}
            </Button>
          </div>

          {globalError && (
            <MessageBar intent="error">
              <MessageBarBody>{globalError}</MessageBarBody>
            </MessageBar>
          )}

          {(isFetching || isDone) && (
            <div className={styles.progressArea}>
              <div className={styles.progressLabel}>
                {isFetching ? 'Reading Project Online data…' : 'Read complete'}
              </div>
              {items.map(item => (
                <div key={item.key} className={styles.progressItem}>
                  <span style={{ color: STATUS_COLOR[item.status], fontWeight: '600', width: '16px' }}>
                    {STATUS_ICON[item.status]}
                  </span>
                  <span style={{ width: '130px' }}>{item.label}</span>
                  {item.status === 'done'     && <span style={{ color: '#107c10' }}>{item.count} records</span>}
                  {item.status === 'fetching' && <Spinner size="extra-tiny" />}
                  {item.status === 'error'    && <span style={{ color: '#a4262c', fontSize: '11px' }}>{item.error}</span>}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── File Upload panel ── */}
      {dataSource === 'FileUpload' && (
        <div className={styles.uploadBox}>
          <div className={styles.templateRow}>
            <ArrowDownloadRegular style={{ fontSize: '16px' }} />
            <span>Download the migration template, fill it in, then upload it here.</span>
            <Button
              appearance="subtle"
              size="small"
              icon={<ArrowDownloadRegular />}
              onClick={handleDownloadTemplate}
            >
              Download Template
            </Button>
          </div>

          <div className={styles.uploadRow}>
            <Button
              appearance="secondary"
              icon={<ArrowUploadRegular />}
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadParsing}
            >
              {uploadParsing ? 'Parsing…' : 'Choose File'}
            </Button>
            {uploadParsing && <Spinner size="tiny" />}
            {uploadedFile && !uploadParsing && (
              <span className={styles.fileName}>{uploadedFile.name}</span>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
          </div>
          <div className={styles.uploadHint}>
            Supported formats: .xlsx, .xls, .csv — use the template above for correct column structure.
          </div>

          {uploadError && (
            <MessageBar intent="error">
              <MessageBarBody>Parse error: {uploadError}</MessageBarBody>
            </MessageBar>
          )}
        </div>
      )}

      {/* ── Dataverse Solution (shared) ── */}
      <div className={styles.sectionBox}>
        <div className={styles.sectionTitle}>Dataverse Solution</div>

        {solutionsLoading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: tokens.colorNeutralForeground3 }}>
            <Spinner size="tiny" /> Loading solutions…
          </div>
        )}

        {solutionsError && (
          <MessageBar intent="warning">
            <MessageBarBody>Could not load solutions: {solutionsError}</MessageBarBody>
          </MessageBar>
        )}

        {!solutionsLoading && !solutionsError && (
          <div className={styles.solutionRow}>
            <Field label="Solution (determines field name prefix)" className={styles.solutionSelect}>
              <Select
                value={selectedSolution?.solutionid ?? ''}
                onChange={(_, d) => handleSolutionChange(d.value)}
              >
                <option value="">— Select a solution —</option>
                {solutions.map(s => (
                  <option key={s.solutionid} value={s.solutionid}>
                    {s.friendlyname} ({s.publisherPrefix}_)
                  </option>
                ))}
              </Select>
            </Field>
            {selectedSolution && (
              <div className={styles.prefixBadge}>
                prefix: {selectedSolution.publisherPrefix}_
              </div>
            )}
          </div>
        )}

        {!solutionsLoading && solutions.length === 0 && !solutionsError && (
          <div style={{ fontSize: '13px', color: tokens.colorNeutralForeground3 }}>
            No unmanaged solutions found in this Dataverse environment.
          </div>
        )}

        {/* ── Migration mode toggle (shown once solution is selected) ── */}
        {selectedSolution && (
          <div className={styles.modeToggleRow}>
            <div className={styles.modeLabel}>Migration mode</div>
            <RadioGroup
              value={migrationMode}
              onChange={(_, d) => {
                const mode = d.value as MigrationMode
                setMigrationMode(mode)
                if (mode !== 'dataOnly') {
                  setSchemaSnapshot(null)
                  setScanPhase('idle')
                  setScanError(null)
                }
              }}
              layout="horizontal"
            >
              <Radio value="full" label="Full migration — create columns + migrate data" />
              <Radio value="dataOnly" label="Data only — use existing schema, migrate data" />
              <Radio value="schemaOnly" label="Schema only — create schema, skip data" />
            </RadioGroup>
          </div>
        )}

        {/* ── Schema scan feedback (dataOnly mode) ── */}
        {migrationMode === 'dataOnly' && selectedSolution && (
          <>
            {scanPhase === 'scanning' && (
              <div className={styles.scanRow}>
                <Spinner size="tiny" />
                <span>Scanning Dataverse schema…</span>
              </div>
            )}

            {scanPhase === 'done' && schemaSnapshot && (() => {
              const totalCols = Object.values(schemaSnapshot.entities).reduce((s, e) => s + e.attributes.length, 0)
              const entitiesWithCols = Object.values(schemaSnapshot.entities).filter(e => e.attributes.length > 0).length
              const optionSets = schemaSnapshot.globalOptionSets.length
              return (
                <div className={styles.scanSummary}>
                  <span>✓ Schema scanned — {totalCols} custom column{totalCols !== 1 ? 's' : ''} across {entitiesWithCols} entit{entitiesWithCols !== 1 ? 'ies' : 'y'}, {optionSets} global option set{optionSets !== 1 ? 's' : ''}</span>
                  <Button
                    appearance="subtle"
                    size="small"
                    onClick={runScan}
                    style={{ marginLeft: 'auto' }}
                  >
                    Refresh
                  </Button>
                </div>
              )
            })()}

            {scanPhase === 'error' && (
              <MessageBar intent="error">
                <MessageBarBody>
                  Schema scan failed: {scanError}
                  <Button appearance="subtle" size="small" onClick={runScan} style={{ marginLeft: '8px' }}>
                    Retry
                  </Button>
                </MessageBarBody>
              </MessageBar>
            )}
          </>
        )}
      </div>

      {/* ── Preview cards (shared) ── */}
      {previewItems.length > 0 && (
        <>
          <div className={styles.previewGrid}>
            {previewItems.filter(i => i.count > 0).map(item => (
              <div key={item.label} className={styles.previewCard}>
                <div className={styles.previewCount}>{item.count}</div>
                <div className={styles.previewLabel}>{item.label}</div>
              </div>
            ))}
          </div>

          <div className={styles.footer}>
            {!selectedSolution && (
              <span style={{ fontSize: '13px', color: tokens.colorNeutralForeground3, alignSelf: 'center' }}>
                Select a solution to continue
              </span>
            )}
            <Button appearance="primary" onClick={nextStep} disabled={!canProceed}>
              Next: Field Mapping →
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
