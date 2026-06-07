import { useEffect, useMemo, useState } from 'react'
import { Button, makeStyles, tokens } from '@fluentui/react-components'
import type { LoaderError, LoaderWarning } from '../../services/fileUpload/types'

export interface LoaderFeedbackPanelProps {
  mode: 'warnings' | 'errors'
  warnings?: LoaderWarning[]
  fileName?: string
  errors?: LoaderError[]
  onDownloadTemplate?: () => void
  /** Override the auto-generated panel title. Pass "" to suppress it. */
  title?: string
}

const useStyles = makeStyles({
  warningPanel: {
    padding: '12px 16px',
    background: tokens.colorPaletteYellowBackground1,
    border: `1px solid ${tokens.colorPaletteYellowBorder1}`,
    borderRadius: tokens.borderRadiusMedium,
    fontSize: '13px',
  },
  errorPanel: {
    padding: '12px 16px',
    background: tokens.colorPaletteRedBackground1,
    border: `1px solid ${tokens.colorPaletteRedBorder1}`,
    borderRadius: tokens.borderRadiusMedium,
    fontSize: '13px',
  },
  header: {
    fontWeight: '600',
    marginBottom: '10px',
    color: tokens.colorNeutralForeground1,
  },
  groupHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    cursor: 'pointer',
    userSelect: 'none',
    padding: '4px 0',
    fontWeight: '600',
    color: tokens.colorNeutralForeground1,
    ':hover': { color: tokens.colorBrandForeground1 },
  },
  groupCount: {
    color: tokens.colorNeutralForeground3,
    fontWeight: 'normal',
    fontSize: '12px',
  },
  warningList: {
    marginTop: '2px',
    marginBottom: '8px',
    paddingLeft: '18px',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  warningRow: {
    color: tokens.colorNeutralForeground2,
    lineHeight: '1.5',
  },
  rowLabel: {
    color: tokens.colorNeutralForeground3,
    marginRight: '4px',
    fontVariantNumeric: 'tabular-nums',
  },
  colLabel: {
    color: tokens.colorNeutralForeground3,
    marginLeft: '4px',
    fontStyle: 'italic',
  },
  errorList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    marginBottom: '10px',
  },
  errorRow: {
    color: tokens.colorNeutralForeground1,
    lineHeight: '1.5',
  },
  sheetLabel: {
    fontWeight: '600',
  },
  downloadHint: {
    color: tokens.colorNeutralForeground3,
    marginBottom: '8px',
    fontSize: '12px',
  },
})

function computeGroups(warnings: LoaderWarning[]): [string, LoaderWarning[]][] {
  const map = new Map<string, LoaderWarning[]>()
  for (const w of warnings) {
    const existing = map.get(w.sheet)
    if (existing) existing.push(w)
    else map.set(w.sheet, [w])
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length)
}

function defaultExpanded(groups: [string, LoaderWarning[]][]): Set<string> {
  if (groups.length === 0) return new Set()
  if (groups.length <= 3) return new Set(groups.slice(0, 2).map(([sheet]) => sheet))
  return new Set()
}

export function LoaderFeedbackPanel({
  mode,
  warnings,
  fileName,
  errors,
  onDownloadTemplate,
  title,
}: LoaderFeedbackPanelProps) {
  const styles = useStyles()

  const warningGroups = useMemo(
    () => (mode === 'warnings' ? computeGroups(warnings ?? []) : []),
    [mode, warnings],
  )

  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => defaultExpanded(warningGroups))

  // Reset expansion when a new set of warnings arrives (e.g. re-upload)
  useEffect(() => {
    setExpandedGroups(defaultExpanded(warningGroups))
  }, [warningGroups])

  const toggleGroup = (sheet: string) =>
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(sheet)) next.delete(sheet)
      else next.add(sheet)
      return next
    })

  if (mode === 'warnings' && (!warnings || warnings.length === 0)) return null
  if (mode === 'errors' && (!errors || errors.length === 0)) return null

  // ── Errors mode ──────────────────────────────────────────────────────────
  if (mode === 'errors') {
    const fileLabel = fileName ?? 'file'
    return (
      <div className={styles.errorPanel}>
        <div className={styles.header}>✗ Could not load {fileLabel}</div>
        <div className={styles.errorList}>
          {errors!.map((err, i) => (
            <div key={i} className={styles.errorRow}>
              ·{err.sheet
                ? <> <span className={styles.sheetLabel}>[{err.sheet}]</span> {err.message}</>
                : <> {err.message}</>}
            </div>
          ))}
        </div>
        {onDownloadTemplate && (
          <>
            <div className={styles.downloadHint}>
              Download a fresh template and copy your data into it:
            </div>
            <Button size="small" onClick={onDownloadTemplate}>
              Download empty template
            </Button>
          </>
        )}
      </div>
    )
  }

  // ── Warnings mode ─────────────────────────────────────────────────────────
  const totalCount = warnings!.length
  const headerText = title !== undefined
    ? title
    : fileName
      ? `${fileName} — ${totalCount} warning${totalCount === 1 ? '' : 's'}`
      : `${totalCount} warning${totalCount === 1 ? '' : 's'}`

  return (
    <div className={styles.warningPanel}>
      {headerText !== '' && <div className={styles.header}>⚠ {headerText}</div>}
      {warningGroups.map(([sheet, groupWarnings]) => {
        const isOpen = expandedGroups.has(sheet)
        return (
          <div key={sheet}>
            <div
              className={styles.groupHeader}
              onClick={() => toggleGroup(sheet)}
              role="button"
              tabIndex={0}
              aria-expanded={isOpen}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  toggleGroup(sheet)
                }
              }}
            >
              <span>{isOpen ? '▼' : '▶'}</span>
              <span>{sheet}</span>
              <span className={styles.groupCount}>
                {groupWarnings.length} warning{groupWarnings.length === 1 ? '' : 's'}
              </span>
            </div>
            {isOpen && (
              <div className={styles.warningList}>
                {groupWarnings.map((w, i) => {
                  const rowLabel = w.row !== undefined ? `Row ${w.row}:` : '(sheet):'
                  return (
                    <div key={i} className={styles.warningRow}>
                      <span className={styles.rowLabel}>{rowLabel}</span>
                      {w.message}
                      {w.column !== undefined && (
                        <span className={styles.colLabel}>[in column "{w.column}"]</span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
