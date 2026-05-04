import { useEffect, useState } from 'react'
import {
  Button,
  Field,
  Input,
  Select,
  Spinner,
  MessageBar,
  MessageBarBody,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { useMigration } from '../../app/MigrationContext'
import { fetchProjects } from '../../services/projectOnline/projects'
import { fetchTasks } from '../../services/projectOnline/tasks'
import { fetchResources } from '../../services/projectOnline/resources'
import { fetchAssignments, fetchTeamMembers } from '../../services/projectOnline/assignments'
import { fetchCustomFields } from '../../services/projectOnline/customFields'
import { fetchLookupTables } from '../../services/projectOnline/lookupTables'
import { fetchSolutions } from '../../services/plannerPremium/dataverseClient'
import type { PoFetchedData } from '../../models/projectOnline.types'
import type { DvSolution } from '../../models/plannerPremium.types'

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
  const { pwaUrl, setPwaUrl, selectedSolution, setSelectedSolution, setFetchedData, nextStep } = useMigration()

  const [localUrl, setLocalUrl] = useState(pwaUrl)
  const [phase, setPhase] = useState<'idle' | 'fetching' | 'done' | 'error'>('idle')
  const [items, setItems] = useState<FetchItem[]>(INITIAL_ITEMS)
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [result, setResult] = useState<PoFetchedData | null>(null)

  const [solutions, setSolutions] = useState<DvSolution[]>([])
  const [solutionsLoading, setSolutionsLoading] = useState(true)
  const [solutionsError, setSolutionsError] = useState<string | null>(null)

  // Load solutions from Dataverse on mount
  useEffect(() => {
    fetchSolutions()
      .then(setSolutions)
      .catch(e => setSolutionsError(String(e)))
      .finally(() => setSolutionsLoading(false))
  }, [])

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
    setItems(INITIAL_ITEMS)
    setPwaUrl(url)

    const data: PoFetchedData = {
      pwaUrl: url,
      projects: [], tasks: [], resources: [], assignments: [],
      teamMembers: [], customFields: [], lookupTables: [],
    }

    type FetchStep = {
      key: keyof PoFetchedData
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fn: () => Promise<any[]>
    }

    const steps: FetchStep[] = [
      { key: 'projects',     fn: () => fetchProjects(url) },
      { key: 'tasks',        fn: () => fetchTasks(url) },
      { key: 'resources',    fn: () => fetchResources(url) },
      { key: 'assignments',  fn: () => fetchAssignments(url) },
      { key: 'teamMembers',  fn: () => fetchTeamMembers(url) },
      { key: 'customFields', fn: () => fetchCustomFields(url) },
      { key: 'lookupTables', fn: () => fetchLookupTables(url) },
    ]

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

  function handleSolutionChange(id: string) {
    const sol = solutions.find(s => s.solutionid === id) ?? null
    setSelectedSolution(sol)
  }

  const isFetching = phase === 'fetching'
  const isDone = phase === 'done' || phase === 'error'
  const canProceed = isDone && !!result && result.projects.length > 0 && !!selectedSolution

  return (
    <div className={styles.root}>
      <div>
        <div className={styles.title}>Step 1 — Connect &amp; Read</div>
        <div className={styles.subtitle}>
          Enter your Project Online PWA URL and select the target Power Platform solution.
        </div>
      </div>

      {/* ── PWA URL ── */}
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

      {/* ── Dataverse Solution ── */}
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
            <Field
              label="Solution (determines field name prefix)"
              className={styles.solutionSelect}
            >
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
      </div>

      {/* ── PO fetch progress ── */}
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
              {item.status === 'done' && (
                <span style={{ color: '#107c10' }}>{item.count} records</span>
              )}
              {item.status === 'fetching' && (
                <Spinner size="extra-tiny" />
              )}
              {item.status === 'error' && (
                <span style={{ color: '#a4262c', fontSize: '11px' }}>{item.error}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Preview cards ── */}
      {isDone && result && (
        <>
          <div className={styles.previewGrid}>
            {items.filter(i => i.status === 'done').map(item => (
              <div key={item.key} className={styles.previewCard}>
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
            <Button
              appearance="primary"
              onClick={nextStep}
              disabled={!canProceed}
            >
              Next: Field Mapping →
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
