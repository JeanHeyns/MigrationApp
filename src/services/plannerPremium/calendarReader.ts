import { listRecords } from './dataverseClient'
import { cleanGuid } from './importHelpers'
import { debugSchedule } from './scheduleDebug'
import { MON_FRI_MASK, type ProjectCalendar } from './scheduleMath'

// Re-export the pure calendar math so existing importers keep `from './calendarReader'`.
export type { ProjectCalendar } from './scheduleMath'
export { isWorkingDay, calendarWorkingDaysInclusive, listWorkingDays } from './scheduleMath'

/** Default Mon–Fri calendar with no holidays — used when the tenant calendar cannot be read. */
function fallbackCalendar(hoursPerDay: number): ProjectCalendar {
  return { workingDayMask: MON_FRI_MASK, holidays: new Set(), hoursPerDay }
}

const cache = new Map<string, ProjectCalendar>()

/** Clears the per-run calendar cache. Call between migration runs if settings changed. */
export function clearCalendarCache(): void {
  cache.clear()
}

/**
 * Reads the project's calendar (working days + holidays) once per project and
 * caches it for the duration of the run.
 *
 * NOTE: the exact `msdyn_calendarrules` schema (field names, how non-working
 * exceptions are flagged) is tenant-version dependent and is an open
 * verification point — see fix-spec §7.2 / §7.5. This reader is deliberately
 * defensive: any query failure or empty result falls back to a Mon–Fri / no-holiday
 * calendar, which is never worse than the previous behaviour (the old
 * `workingDaysInclusive` was Mon–Fri with no holidays either). Holiday-aware
 * counting only activates once the queries are confirmed against the dev tenant.
 */
export async function readProjectCalendar(projectId: string, hoursPerDay: number): Promise<ProjectCalendar> {
  const cached = cache.get(projectId)
  if (cached) return cached

  let calendar = fallbackCalendar(hoursPerDay)
  try {
    const holidays = await readHolidays(projectId)
    if (holidays.size > 0) {
      calendar = { workingDayMask: MON_FRI_MASK, holidays, hoursPerDay }
      debugSchedule(`calendar ${projectId}`, { holidays: holidays.size, hoursPerDay })
    } else {
      debugSchedule(`calendar ${projectId}: no holidays found, using Mon–Fri fallback`, { hoursPerDay })
    }
  } catch (e) {
    console.warn(`[calendarReader] could not read calendar for project ${projectId}, using Mon–Fri fallback: ${String(e).slice(0, 200)}`)
  }

  cache.set(projectId, calendar)
  return calendar
}

/**
 * Resolves the project's calendar id, then reads its non-working exception dates.
 * Returns an empty set (not an error) when the calendar or its rules are absent.
 */
async function readHolidays(projectId: string): Promise<Set<string>> {
  const projectRows = await listRecords(
    'msdyn_projects',
    'msdyn_projectid,_msdyn_calendar_value,_msdyn_calendarid_value',
    `msdyn_projectid eq ${projectId}`,
    1,
  )
  const project = projectRows[0]
  if (!project) return new Set()

  const calendarId = cleanGuid(
    String(project['_msdyn_calendar_value'] ?? project['_msdyn_calendarid_value'] ?? ''),
  )
  if (!calendarId) return new Set()

  // msdyn_isnonworking flags exception (non-working) rules such as holidays.
  const ruleRows = await listRecords(
    'msdyn_calendarrules',
    'msdyn_starttime,msdyn_enddate,msdyn_duration,msdyn_isnonworking',
    `_msdyn_calendar_value eq ${calendarId} and msdyn_isnonworking eq true`,
    5000,
  )

  const holidays = new Set<string>()
  for (const rule of ruleRows) {
    const iso = toDateOnly(rule['msdyn_starttime'])
    if (iso) holidays.add(iso)
  }
  return holidays
}

function toDateOnly(value: unknown): string | null {
  if (value == null) return null
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value))
  return match ? match[1] : null
}
