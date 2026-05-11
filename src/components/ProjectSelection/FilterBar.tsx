import { useEffect, useRef, useState } from 'react'
import {
  Button,
  Checkbox,
  Input,
  Label,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { useMigration, isFilterActive } from '../../app/MigrationContext'
import type { ProjectFilter } from '../../app/MigrationContext'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '10px 12px',
    background: tokens.colorNeutralBackground3,
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  row: {
    display: 'flex',
    gap: '12px',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  fieldGroup: {
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
  },
  label: {
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    whiteSpace: 'nowrap',
  },
  input: {
    width: '120px',
  },
  dateInput: {
    width: '140px',
  },
  narrowInput: {
    width: '72px',
  },
  advanced: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    paddingTop: '8px',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  ownerList: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  activeBadge: {
    fontSize: '11px',
    background: tokens.colorBrandBackground,
    color: tokens.colorNeutralForegroundOnBrand,
    borderRadius: tokens.borderRadiusMedium,
    padding: '1px 7px',
  },
})

interface FilterBarProps {
  /** All unique owner names from fetched projects */
  ownerNames: string[]
  /** Whether task count filter should be available */
  tasksAvailable: boolean
}

export function FilterBar({ ownerNames, tasksAvailable }: FilterBarProps) {
  const styles = useStyles()
  const { projectFilter, setProjectFilter, clearProjectFilter } = useMigration()
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [searchInput, setSearchInput] = useState(projectFilter.searchTerm)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function patch(partial: Partial<ProjectFilter>) {
    setProjectFilter({ ...projectFilter, ...partial })
  }

  function handleSearchChange(value: string) {
    setSearchInput(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => patch({ searchTerm: value }), 200)
  }

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [])

  function toggleOwner(name: string) {
    const current = projectFilter.ownerNames
    const next = current.includes(name)
      ? current.filter(n => n !== name)
      : [...current, name]
    patch({ ownerNames: next })
  }

  const active = isFilterActive(projectFilter)

  return (
    <div className={styles.root}>
      <div className={styles.row}>
        <div className={styles.fieldGroup}>
          <Input
            className={styles.input}
            size="small"
            placeholder="Search projects…"
            value={searchInput}
            onChange={(_, d) => handleSearchChange(d.value)}
          />
        </div>

        <div className={styles.fieldGroup}>
          <span className={styles.label}>Start</span>
          <Input
            className={styles.dateInput}
            size="small"
            type="date"
            value={projectFilter.startDateFrom ?? ''}
            onChange={(_, d) => patch({ startDateFrom: d.value || null })}
          />
          <span className={styles.label}>–</span>
          <Input
            className={styles.dateInput}
            size="small"
            type="date"
            value={projectFilter.startDateTo ?? ''}
            onChange={(_, d) => patch({ startDateTo: d.value || null })}
          />
        </div>

        <div className={styles.fieldGroup}>
          <span className={styles.label}>Finish</span>
          <Input
            className={styles.dateInput}
            size="small"
            type="date"
            value={projectFilter.finishDateFrom ?? ''}
            onChange={(_, d) => patch({ finishDateFrom: d.value || null })}
          />
          <span className={styles.label}>–</span>
          <Input
            className={styles.dateInput}
            size="small"
            type="date"
            value={projectFilter.finishDateTo ?? ''}
            onChange={(_, d) => patch({ finishDateTo: d.value || null })}
          />
        </div>

        <div className={styles.fieldGroup} style={{ marginLeft: 'auto', gap: '8px' }}>
          {active && <span className={styles.activeBadge}>Filter active</span>}
          <Button size="small" onClick={() => setShowAdvanced(v => !v)}>
            {showAdvanced ? 'Less ▲' : 'More ▼'}
          </Button>
          {active && (
            <Button size="small" onClick={() => { clearProjectFilter(); setSearchInput('') }}>
              Clear
            </Button>
          )}
        </div>
      </div>

      {showAdvanced && (
        <div className={styles.advanced}>
          {ownerNames.length > 0 && (
            <div className={styles.row}>
              <span className={styles.label}>Owner</span>
              <div className={styles.ownerList}>
                {ownerNames.map(name => (
                  <Checkbox
                    key={name}
                    label={name}
                    checked={projectFilter.ownerNames.includes(name)}
                    onChange={() => toggleOwner(name)}
                  />
                ))}
              </div>
            </div>
          )}

          <div className={styles.row}>
            <span className={styles.label}>Task count</span>
            <div className={styles.fieldGroup}>
              <Label size="small" style={{ color: tokens.colorNeutralForeground3 }}>Min</Label>
              <Input
                className={styles.narrowInput}
                size="small"
                type="number"
                disabled={!tasksAvailable}
                placeholder="—"
                value={projectFilter.taskCountMin !== null ? String(projectFilter.taskCountMin) : ''}
                onChange={(_, d) => patch({ taskCountMin: d.value !== '' ? parseInt(d.value) : null })}
              />
              <Label size="small" style={{ color: tokens.colorNeutralForeground3 }}>Max</Label>
              <Input
                className={styles.narrowInput}
                size="small"
                type="number"
                disabled={!tasksAvailable}
                placeholder="—"
                value={projectFilter.taskCountMax !== null ? String(projectFilter.taskCountMax) : ''}
                onChange={(_, d) => patch({ taskCountMax: d.value !== '' ? parseInt(d.value) : null })}
              />
              {!tasksAvailable && (
                <span className={styles.label} title="Enable task fetch in Step 1 scope settings">
                  (tasks not fetched)
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
