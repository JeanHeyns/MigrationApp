import {
  Button,
  MessageBar,
  MessageBarBody,
  makeStyles,
  tokens,
} from '@fluentui/react-components'
import { useMigration } from '../../app/MigrationContext'
import type { ImportError } from '../../models/plannerPremium.types'

const useStyles = makeStyles({
  root: {
    padding: '32px',
    maxWidth: '1100px',
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  title: { fontSize: '20px', fontWeight: '600', color: tokens.colorNeutralForeground1 },
  subtitle: { fontSize: '13px', color: tokens.colorNeutralForeground3, marginTop: '4px' },
  summaryGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '12px' },
  metric: {
    padding: '14px',
    background: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  metricLabel: { fontSize: '12px', color: tokens.colorNeutralForeground3 },
  metricValue: { fontSize: '24px', fontWeight: '600', color: tokens.colorNeutralForeground1, marginTop: '4px' },
  panel: {
    padding: '16px',
    background: tokens.colorNeutralBackground2,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  sectionTitle: { fontSize: '15px', fontWeight: '600', marginBottom: '10px', color: tokens.colorNeutralForeground1 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px' },
  th: {
    textAlign: 'left',
    padding: '8px 10px',
    background: tokens.colorNeutralBackground3,
    borderBottom: `2px solid ${tokens.colorNeutralStroke1}`,
    fontWeight: '600',
    color: tokens.colorNeutralForeground2,
  },
  td: { padding: '8px 10px', borderBottom: `1px solid ${tokens.colorNeutralStroke2}`, verticalAlign: 'top' },
  code: { fontFamily: 'Consolas, monospace', fontSize: '12px' },
  errorMessage: { maxWidth: '620px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  toolbar: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' },
})

function csvEscape(value: unknown): string {
  const text = String(value ?? '')
  return `"${text.replace(/"/g, '""')}"`
}

function downloadCsv(filename: string, rows: string[][]) {
  const csv = rows.map(row => row.map(csvEscape).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function flattenErrors(errors: ImportError[]): string[][] {
  return [
    ['Entity', 'Source ID', 'Timestamp', 'Message'],
    ...errors.map(error => [error.entity, error.sourceId, error.timestamp, error.message]),
  ]
}

export function Step5Report() {
  const styles = useStyles()
  const { importResults, prevStep, setCurrentStep } = useMigration()

  const totalRecords = importResults.reduce((s, r) => s + r.total, 0)
  const totalSucceeded = importResults.reduce((s, r) => s + r.succeeded, 0)
  const totalFailed = importResults.reduce((s, r) => s + r.failed, 0)
  const allErrors = importResults.flatMap(r => r.errors)
  const successRate = totalRecords > 0 ? Math.round((totalSucceeded / totalRecords) * 100) : 0

  function exportSummary() {
    downloadCsv('migration-summary.csv', [
      ['Entity', 'Total', 'Succeeded', 'Failed', 'Success Rate'],
      ...importResults.map(result => [
        result.entity,
        String(result.total),
        String(result.succeeded),
        String(result.failed),
        result.total > 0 ? `${Math.round((result.succeeded / result.total) * 100)}%` : '0%',
      ]),
    ])
  }

  function exportErrors() {
    downloadCsv('migration-errors.csv', flattenErrors(allErrors))
  }

  return (
    <div className={styles.root}>
      <div>
        <div className={styles.title}>Step 5 - Validation Report</div>
        <div className={styles.subtitle}>
          Review import totals and skipped or failed records before closing the migration.
        </div>
      </div>

      {importResults.length === 0 && (
        <MessageBar intent="warning">
          <MessageBarBody>No import results are available yet. Run Step 4 first.</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.summaryGrid}>
        <div className={styles.metric}>
          <div className={styles.metricLabel}>Total processed</div>
          <div className={styles.metricValue}>{totalRecords}</div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricLabel}>Succeeded</div>
          <div className={styles.metricValue}>{totalSucceeded}</div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricLabel}>Failed / skipped</div>
          <div className={styles.metricValue}>{totalFailed}</div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricLabel}>Success rate</div>
          <div className={styles.metricValue}>{successRate}%</div>
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.toolbar} style={{ justifyContent: 'space-between', marginBottom: '10px' }}>
          <div className={styles.sectionTitle}>Entity Results</div>
          <Button size="small" onClick={exportSummary} disabled={importResults.length === 0}>Export summary CSV</Button>
        </div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th}>Entity</th>
              <th className={styles.th}>Total</th>
              <th className={styles.th}>Succeeded</th>
              <th className={styles.th}>Failed / skipped</th>
              <th className={styles.th}>Rate</th>
            </tr>
          </thead>
          <tbody>
            {importResults.map(result => (
              <tr key={result.entity}>
                <td className={styles.td}>{result.entity}</td>
                <td className={styles.td}>{result.total}</td>
                <td className={styles.td}>{result.succeeded}</td>
                <td className={styles.td}>{result.failed}</td>
                <td className={styles.td}>
                  {result.total > 0 ? `${Math.round((result.succeeded / result.total) * 100)}%` : '0%'}
                </td>
              </tr>
            ))}
            {importResults.length === 0 && (
              <tr>
                <td className={styles.td} colSpan={5}>No results.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className={styles.panel}>
        <div className={styles.toolbar} style={{ justifyContent: 'space-between', marginBottom: '10px' }}>
          <div className={styles.sectionTitle}>Failures And Skips</div>
          <Button size="small" onClick={exportErrors} disabled={allErrors.length === 0}>Export errors CSV</Button>
        </div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th}>Entity</th>
              <th className={styles.th}>Source ID</th>
              <th className={styles.th}>Message</th>
              <th className={styles.th}>Time</th>
            </tr>
          </thead>
          <tbody>
            {allErrors.map((error, idx) => (
              <tr key={`${error.entity}-${error.sourceId}-${idx}`}>
                <td className={styles.td}>{error.entity}</td>
                <td className={`${styles.td} ${styles.code}`}>{error.sourceId}</td>
                <td className={`${styles.td} ${styles.errorMessage}`}>{error.message}</td>
                <td className={styles.td}>{new Date(error.timestamp).toLocaleString()}</td>
              </tr>
            ))}
            {allErrors.length === 0 && (
              <tr>
                <td className={styles.td} colSpan={4}>No failures or skipped records.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className={styles.footer}>
        <Button onClick={prevStep}>Back to Import</Button>
        <Button onClick={() => setCurrentStep(1)}>Start New Migration</Button>
      </div>
    </div>
  )
}
