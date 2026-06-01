import { fetchAttributeOptionSetMetadata } from '../dataverseService'
import type { ScheduleModeOption } from '../../types/projectDefaults'

// Fallback list based on public Microsoft documentation.
// Verify values in dev tenant via:
// GET /api/data/v9.2/EntityDefinitions(LogicalName='msdyn_project')/Attributes(LogicalName='msdyn_schedulemode')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet
export const FALLBACK_SCHEDULE_MODES: ScheduleModeOption[] = [
  { value: 192350000, label: 'Fixed Effort' },
  { value: 192350001, label: 'Fixed Duration' },
  { value: 192350002, label: 'Fixed Units' },
  { value: 192350003, label: 'Fixed Duration / Effort Driven' },
  { value: 192350004, label: 'Fixed Units / Effort Driven' },
]

let cachedOptions: ScheduleModeOption[] | null = null

export function clearScheduleModeCache(): void {
  cachedOptions = null
}

export async function fetchScheduleModeOptions(): Promise<ScheduleModeOption[]> {
  if (cachedOptions) return cachedOptions

  try {
    const meta = await fetchAttributeOptionSetMetadata(
      'msdyn_project',
      '',
      'Picklist',
      'msdyn_schedulemode',
    )
    if (meta && meta.options.length > 0) {
      cachedOptions = meta.options.map(o => ({ value: o.value, label: o.label }))
      return cachedOptions
    }
  } catch (e) {
    console.warn('[scheduleMode] Failed to fetch option set, using fallback:', e)
  }

  console.warn('[scheduleMode] Using fallback schedule mode options — verify values in dev tenant')
  return FALLBACK_SCHEDULE_MODES
}

export function findScheduleModeByLabel(
  options: ScheduleModeOption[],
  label: string,
): ScheduleModeOption | undefined {
  const target = label.trim().toLowerCase()
  return options.find(o => o.label.trim().toLowerCase() === target)
}
