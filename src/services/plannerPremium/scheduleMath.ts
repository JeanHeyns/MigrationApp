/**
 * Pure scheduling math — no Dataverse / IO imports, so it is safe to unit-test in
 * isolation. The calendar reader (which does hit Dataverse) builds a
 * {@link ProjectCalendar} and feeds it to these functions.
 */

/**
 * Working-time description for a single project.
 *
 * `workingDayMask` is a bitmask of working weekdays where bit 0 = Sunday,
 * bit 1 = Monday, … bit 6 = Saturday. The conventional Mon–Fri week is
 * `0b0111110` (62).
 */
export interface ProjectCalendar {
  workingDayMask: number
  /** Non-working dates as 'YYYY-MM-DD' strings (holidays / exceptions). */
  holidays: Set<string>
  /** Effective working hours per working day (e.g. 7.6). */
  hoursPerDay: number
}

export const MON_FRI_MASK = 0b0111110
export const DEFAULT_HOURS_PER_DAY = 7.6

export function parseDateOnly(value: string | undefined): Date | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

export function formatDateOnly(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** True when `date` is a working weekday for the calendar and not a holiday. */
export function isWorkingDay(date: Date, calendar: ProjectCalendar): boolean {
  const weekdayBit = 1 << date.getDay()
  if ((calendar.workingDayMask & weekdayBit) === 0) return false
  return !calendar.holidays.has(formatDateOnly(date))
}

/**
 * Inclusive count of working days between two date-only strings, honoring the
 * project calendar's working weekdays and holidays. Returns 0 when input is
 * invalid or finish precedes start.
 */
export function calendarWorkingDaysInclusive(
  start: string,
  finish: string,
  calendar: ProjectCalendar,
): number {
  const s = parseDateOnly(start)
  const f = parseDateOnly(finish)
  if (!s || !f || f.getTime() < s.getTime()) return 0

  let count = 0
  let guard = 0
  const cursor = new Date(s)
  while (cursor.getTime() <= f.getTime() && guard < 36500) {
    if (isWorkingDay(cursor, calendar)) count++
    cursor.setDate(cursor.getDate() + 1)
    guard++
  }
  return count
}

/**
 * Yields each working-day Date (inclusive) between two date-only strings,
 * skipping non-working weekdays and holidays per the calendar. Returns an empty
 * array when input is invalid or finish precedes start.
 */
export function listWorkingDays(
  start: string,
  finish: string,
  calendar: ProjectCalendar,
): Date[] {
  const s = parseDateOnly(start)
  const f = parseDateOnly(finish)
  if (!s || !f || f.getTime() < s.getTime()) return []

  const days: Date[] = []
  let guard = 0
  const cursor = new Date(s)
  while (cursor.getTime() <= f.getTime() && guard < 36500) {
    if (isWorkingDay(cursor, calendar)) days.push(new Date(cursor))
    cursor.setDate(cursor.getDate() + 1)
    guard++
  }
  return days
}

/**
 * Converts a duration in minutes to *days* as PSS expects on `msdyn_duration`
 * (double). Returns undefined when minutes is null. Falls back to the default
 * hours-per-day when given a non-positive value.
 */
export function taskDurationDays(minutes: number | null | undefined, hoursPerDay: number): number | undefined {
  if (minutes == null) return undefined
  const hpd = hoursPerDay > 0 ? hoursPerDay : DEFAULT_HOURS_PER_DAY
  return Math.round((minutes / 60 / hpd) * 100) / 100
}
