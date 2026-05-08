import { Button, FluentProvider, webLightTheme, makeStyles } from '@fluentui/react-components'
import { MigrationProvider, useMigration } from './app/MigrationContext'
import { StepRouter } from './app/StepRouter'
import { StepIndicator } from './components/StepIndicator'
import { ErrorBoundary } from './components/ErrorBoundary'

const useStyles = makeStyles({
  shell: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    background: '#f5f5f5',
  },
  header: {
    background: '#0078d4',
    color: '#fff',
    padding: '12px 32px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
  },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  headerTitle: {
    fontSize: '15px',
    fontWeight: '600',
    margin: 0,
  },
  headerSub: {
    fontSize: '12px',
    opacity: 0.8,
  },
  content: {
    flex: 1,
    overflowY: 'auto',
  },
})

function WizardShell() {
  const styles = useStyles()
  const { currentStep, setCurrentStep } = useMigration()

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div>
          <div className={styles.headerTitle}>Project Online → Planner Premium Migration Tool</div>
          <div className={styles.headerSub}>Migrate projects, tasks, and resources to Project for the Web</div>
        </div>
        <div className={styles.headerActions}>
          <Button
            appearance={currentStep === 6 ? 'primary' : 'secondary'}
            size="small"
            onClick={() => setCurrentStep(6)}
          >
            Troubleshooting
          </Button>
        </div>
      </header>

      <StepIndicator currentStep={currentStep} />

      <main className={styles.content}>
        <ErrorBoundary>
          <StepRouter />
        </ErrorBoundary>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <FluentProvider theme={webLightTheme}>
      <MigrationProvider>
        <WizardShell />
      </MigrationProvider>
    </FluentProvider>
  )
}
