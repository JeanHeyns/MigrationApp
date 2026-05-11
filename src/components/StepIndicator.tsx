import { makeStyles, tokens } from '@fluentui/react-components'
import { useMigration } from '../app/MigrationContext'

const STEPS = [
  { n: 1, label: 'Connect & Read' },
  { n: 2, label: 'Field Mapping' },
  { n: 3, label: 'Create Columns' },
  { n: 4, label: 'Import Data' },
  { n: 5, label: 'Validation Report' },
]

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'center',
    padding: '16px 32px',
    background: tokens.colorNeutralBackground2,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
    gap: '0',
  },
  stepWrapper: {
    display: 'flex',
    alignItems: 'center',
    flex: 1,
    minWidth: 0,
  },
  step: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexShrink: 0,
  },
  circle: {
    width: '28px',
    height: '28px',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '12px',
    fontWeight: '600',
    flexShrink: 0,
    transition: 'background 0.2s',
  },
  label: {
    fontSize: '12px',
    whiteSpace: 'nowrap',
  },
  connector: {
    flex: 1,
    height: '2px',
    marginInline: '8px',
    minWidth: '12px',
    transition: 'background 0.2s',
  },
  badge: {
    marginLeft: 'auto',
    flexShrink: 0,
    fontSize: '12px',
    color: tokens.colorNeutralForeground3,
    background: tokens.colorNeutralBackground4,
    borderRadius: tokens.borderRadiusMedium,
    padding: '2px 10px',
    whiteSpace: 'nowrap',
  },
})

interface StepIndicatorProps {
  currentStep: number
}

export function StepIndicator({ currentStep }: StepIndicatorProps) {
  const styles = useStyles()
  const { selectedProjectIds, fetchedData } = useMigration()
  const totalProjects = fetchedData?.projects.length ?? 0
  const showBadge = currentStep >= 2 && totalProjects > 0

  return (
    <div className={styles.root}>
      {STEPS.map((step, i) => {
        const done = currentStep > step.n
        const active = currentStep === step.n
        const circleColor = done ? '#107c10' : active ? tokens.colorBrandBackground : tokens.colorNeutralBackground4
        const textColor = done ? '#107c10' : active ? tokens.colorBrandForeground1 : tokens.colorNeutralForeground3

        return (
          <div key={step.n} className={styles.stepWrapper}>
            <div className={styles.step}>
              <div
                className={styles.circle}
                style={{ background: circleColor, color: done || active ? '#fff' : tokens.colorNeutralForeground3 }}
              >
                {done ? '✓' : step.n}
              </div>
              <span className={styles.label} style={{ color: textColor, fontWeight: active ? '600' : 'normal' }}>
                {step.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={styles.connector} style={{ background: done ? '#107c10' : tokens.colorNeutralStroke1 }} />
            )}
          </div>
        )
      })}
      {showBadge && (
        <span className={styles.badge}>
          {selectedProjectIds.size} / {totalProjects} projects
        </span>
      )}
    </div>
  )
}
