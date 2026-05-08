import { useMigration } from './MigrationContext'
import { Step1Connect } from '../steps/Step1Connect'
import { Step2Mapping } from '../steps/Step2Mapping'
import { Step3CreateColumns } from '../steps/Step3CreateColumns'
import { Step4Import } from '../steps/Step4Import'
import { Step5Report } from '../steps/Step5Report'
import { Troubleshooting } from '../steps/Troubleshooting'

export function StepRouter() {
  const { currentStep, migrationMode } = useMigration()

  switch (currentStep) {
    case 1: return <Step1Connect />
    case 2: return <Step2Mapping />
    case 3: return <Step3CreateColumns />
    case 4: return migrationMode === 'schemaOnly' ? <Step5Report /> : <Step4Import />
    case 5: return <Step5Report />
    case 6: return <Troubleshooting />
    default: return <Step1Connect />
  }
}
