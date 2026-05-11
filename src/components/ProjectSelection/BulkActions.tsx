import { useState } from 'react'
import { Button, Input, makeStyles, tokens } from '@fluentui/react-components'
import { useMigration } from '../../app/MigrationContext'

const useStyles = makeStyles({
  root: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    flexWrap: 'wrap',
    padding: '8px 0',
  },
  divider: {
    width: '1px',
    height: '20px',
    background: tokens.colorNeutralStroke1,
    flexShrink: 0,
  },
  group: {
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
  },
  narrowInput: {
    width: '56px',
  },
})

interface BulkActionsProps {
  /** Full unfiltered project ID list — used for All / Invert */
  allProjectIds: string[]
  /** Currently visible (filtered) project IDs — used for First N / Range */
  displayedProjectIds: string[]
  disabled?: boolean
}

export function BulkActions({ allProjectIds, displayedProjectIds, disabled }: BulkActionsProps) {
  const styles = useStyles()
  const { selectedProjectIds, setSelectedProjectIds, selectProjectsByIds } = useMigration()

  const [firstN, setFirstN] = useState(20)
  const [rangeFrom, setRangeFrom] = useState(1)
  const [rangeTo, setRangeTo] = useState(20)

  function handleAll() {
    setSelectedProjectIds(new Set(allProjectIds))
  }

  function handleNone() {
    setSelectedProjectIds(new Set())
  }

  function handleInvert() {
    setSelectedProjectIds(new Set(allProjectIds.filter(id => !selectedProjectIds.has(id))))
  }

  function handleFirstN() {
    const n = Math.max(1, firstN)
    setSelectedProjectIds(new Set(displayedProjectIds.slice(0, n)))
  }

  function handleRange() {
    const from = Math.max(1, rangeFrom) - 1
    const to = Math.max(from + 1, rangeTo)
    setSelectedProjectIds(new Set(displayedProjectIds.slice(from, to)))
  }

  const isFiltered = displayedProjectIds.length < allProjectIds.length

  function handleSelectFiltered() {
    selectProjectsByIds(displayedProjectIds)
  }

  return (
    <div className={styles.root}>
      <div className={styles.group}>
        <Button size="small" disabled={disabled} onClick={handleAll}>All</Button>
        <Button size="small" disabled={disabled} onClick={handleNone}>None</Button>
        <Button size="small" disabled={disabled} onClick={handleInvert}>Invert</Button>
        {isFiltered && (
          <Button size="small" disabled={disabled} onClick={handleSelectFiltered}>
            Select filtered ({displayedProjectIds.length})
          </Button>
        )}
      </div>

      <div className={styles.divider} />

      <div className={styles.group}>
        <span style={{ fontSize: '12px', color: tokens.colorNeutralForeground3 }}>First</span>
        <Input
          className={styles.narrowInput}
          size="small"
          type="number"
          value={String(firstN)}
          disabled={disabled}
          onChange={(_, d) => setFirstN(Math.max(1, parseInt(d.value) || 1))}
        />
        <Button size="small" disabled={disabled} onClick={handleFirstN}>
          Select{isFiltered ? ` (of ${displayedProjectIds.length} filtered)` : ''}
        </Button>
      </div>

      <div className={styles.divider} />

      <div className={styles.group}>
        <span style={{ fontSize: '12px', color: tokens.colorNeutralForeground3 }}>Rows</span>
        <Input
          className={styles.narrowInput}
          size="small"
          type="number"
          value={String(rangeFrom)}
          disabled={disabled}
          onChange={(_, d) => setRangeFrom(Math.max(1, parseInt(d.value) || 1))}
        />
        <span style={{ fontSize: '12px', color: tokens.colorNeutralForeground3 }}>–</span>
        <Input
          className={styles.narrowInput}
          size="small"
          type="number"
          value={String(rangeTo)}
          disabled={disabled}
          onChange={(_, d) => setRangeTo(Math.max(1, parseInt(d.value) || 1))}
        />
        <Button size="small" disabled={disabled} onClick={handleRange}>Select</Button>
      </div>
    </div>
  )
}
