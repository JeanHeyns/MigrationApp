import { useEffect, useRef } from 'react'
import { makeStyles, tokens } from '@fluentui/react-components'
import type { LogEntry } from '../models/plannerPremium.types'

const useStyles = makeStyles({
  root: {
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    overflow: 'hidden',
  },
  header: {
    padding: '6px 12px',
    background: tokens.colorNeutralBackground3,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    fontSize: '12px',
    fontWeight: '600',
    color: tokens.colorNeutralForeground2,
  },
  body: {
    height: '180px',
    overflowY: 'auto',
    padding: '8px 10px',
    background: '#1e1e1e',
    fontFamily: "'Cascadia Code', Consolas, monospace",
    fontSize: '12px',
  },
  entry: {
    marginBottom: '3px',
    lineHeight: '1.5',
  },
  time: {
    opacity: 0.5,
    marginRight: '6px',
  },
})

const LEVEL_COLORS: Record<LogEntry['level'], string> = {
  info:    '#9cdcfe',
  success: '#4ec9b0',
  error:   '#f48771',
  warning: '#dcdcaa',
}

interface LogPanelProps {
  logs: LogEntry[]
  title?: string
}

export function LogPanel({ logs, title = 'Log' }: LogPanelProps) {
  const styles = useStyles()
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight
    }
  }, [logs])

  return (
    <div className={styles.root}>
      <div className={styles.header}>{title}</div>
      <div className={styles.body} ref={bodyRef}>
        {logs.length === 0 && (
          <span style={{ color: '#555' }}>No log entries yet.</span>
        )}
        {logs.map((log, i) => (
          <div key={i} className={styles.entry} style={{ color: LEVEL_COLORS[log.level] }}>
            <span className={styles.time}>
              [{new Date(log.timestamp).toLocaleTimeString()}]
            </span>
            {log.message}
          </div>
        ))}
      </div>
    </div>
  )
}
