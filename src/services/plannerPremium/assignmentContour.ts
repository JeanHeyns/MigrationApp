import type { PoAssignment, PoTask } from '../../models/projectOnline.types'
import type { ProjectCalendar } from './scheduleMath'
import { listWorkingDays } from './scheduleMath'

/**
 * One day-slice of a resource assignment's planned-work contour.
 * Matches the PSA 3.x `msdyn_plannedwork` serialization (verified against MS docs):
 *   [{ "Start": "/Date(1543856400000)/", "End": "/Date(1543885200000)/", "Hours": 7.6 }, ...]
 * `Start`/`End` are `/Date(unix-ms)/` strings; `Hours` is the hours worked that day.
 */
export interface ContourSlice {
  Start: string
  End: string
  Hours: number
}

export interface ContourResult {
  slices: ContourSlice[]
  /** Non-fatal note surfaced to the import log (e.g. units capped). */
  warning?: string
}

const WORK_DAY_START_HOUR = 9

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function toMsDate(d: Date): string {
  return `/Date(${d.getTime()})/`
}

/** Adds `workingDays` working days to `from` (exclusive of `from`), per the calendar. */
function addWorkingDays(fromISO: string, workingDays: number, calendar: ProjectCalendar): string | undefined {
  // Reuse listWorkingDays over a generous window, then pick the Nth working day.
  const from = parseISO(fromISO)
  if (!from) return undefined
  const windowEnd = new Date(from)
  windowEnd.setDate(windowEnd.getDate() + workingDays * 3 + 14) // ample margin for weekends/holidays
  const days = listWorkingDays(fromISO, format(windowEnd), calendar)
  const target = days[Math.min(workingDays, days.length - 1)]
  return target ? format(target) : undefined
}

function parseISO(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

function format(d: Date): string {
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const da = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${da}`
}

/**
 * Builds a per-working-day work contour for one assignment, honoring the project
 * calendar (working weekdays + holidays) and the resource's allocation percentage.
 *
 * Allocation: PO `AssignmentUnits` is a 0–100 percentage. Each working day gets
 * `hoursPerDay × (units / 100)` hours, front-loaded from 09:00 local time. Sub-day
 * precision is intentionally omitted (not migration-critical — see fix-spec §3).
 *
 * Returns an empty contour (caller should then omit `msdyn_plannedwork`) for
 * milestones, missing dates, or non-positive units.
 */
export function buildAssignmentContour(
  task: PoTask,
  assignment: PoAssignment,
  calendar: ProjectCalendar,
): ContourResult {
  if (task.TaskIsMilestone) return { slices: [] }

  const start = task.TaskStartDate
  if (!start) return { slices: [], warning: `task ${task.TaskId} has no start date — no contour written` }

  // Fall back to a single working day when the task has no finish date.
  let finish = task.TaskFinishDate
  if (!finish) finish = addWorkingDays(start, 0, calendar) ?? start

  const rawUnits = assignment.AssignmentUnits ?? 100
  let warning: string | undefined
  let units = rawUnits
  if (units > 100) {
    warning = `assignment units ${rawUnits} capped to 100`
    units = 100
  }
  if (units <= 0) {
    return { slices: [], warning: `assignment units ${rawUnits} ≤ 0 — no contour written` }
  }

  const hoursPerSlice = round2(calendar.hoursPerDay * (units / 100))
  if (hoursPerSlice <= 0) return { slices: [], warning }

  const slices: ContourSlice[] = []
  for (const date of listWorkingDays(start, finish, calendar)) {
    const workStart = new Date(date)
    workStart.setHours(WORK_DAY_START_HOUR, 0, 0, 0)
    const workEnd = new Date(workStart.getTime() + hoursPerSlice * 3_600_000)
    slices.push({ Start: toMsDate(workStart), End: toMsDate(workEnd), Hours: hoursPerSlice })
  }

  return { slices, warning }
}

export function serializePlannedWork(contour: ContourSlice[]): string {
  return JSON.stringify(contour)
}
