import type { PoAssignment, PoTask } from '../../models/projectOnline.types'
import type {
  AssignmentDiagnostic,
  DiagnosticInput,
  ProjectDiagnostic,
  ResourceDiagnostic,
  ScheduleDiagnosticReport,
  TaskDiagnostic,
} from './types'
import { listRecords } from '../plannerPremium/dataverseClient'
import { cleanGuid } from '../plannerPremium/importHelpers'
import { calendarWorkingDaysInclusive, MON_FRI_MASK, type ProjectCalendar } from '../plannerPremium/scheduleMath'

// Bump together with package.json version.
const MIGRATOR_VERSION = '0.0.0'
const PROJECT_CAP = 50
const MON_FRI: ProjectCalendar = { workingDayMask: MON_FRI_MASK, holidays: new Set(), hoursPerDay: 8 }

// ─── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** Whole-day difference (target − source), comparing date-only prefixes. null if either missing. */
export function deltaDays(source: string | null | undefined, target: string | null | undefined): number | null {
  const s = toDateOnly(source)
  const t = toDateOnly(target)
  if (!s || !t) return null
  const ms = Date.parse(`${t}T00:00:00Z`) - Date.parse(`${s}T00:00:00Z`)
  return Math.round(ms / 86_400_000)
}

function toDateOnly(value: string | null | undefined): string | null {
  if (!value) return null
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value))
  return m ? m[1] : null
}

/** Matches a source task to its Dataverse row: by id first (DV id == cleaned PO guid), then subject + start. */
export function matchTargetTask(
  poTask: PoTask,
  targets: Record<string, unknown>[],
): Record<string, unknown> | null {
  const sourceId = cleanGuid(poTask.TaskId)?.toLowerCase()
  if (sourceId) {
    const byId = targets.find(t => String(t.msdyn_projecttaskid ?? '').toLowerCase() === sourceId)
    if (byId) return byId
  }
  const subject = String(poTask.TaskName ?? '').trim()
  const start = toDateOnly(poTask.TaskStartDate)
  const bySubject = targets.find(t =>
    String(t.msdyn_subject ?? '').trim() === subject &&
    (!start || toDateOnly(String(t.msdyn_scheduledstart ?? '')) === start),
  )
  return bySubject ?? null
}

/** Slice count + total hours from a stored msdyn_plannedwork JSON string (handles Hours and minutes shapes). */
export function parsePlannedWork(raw: unknown): { sliceCount: number | null; totalHours: number | null } {
  if (raw == null || raw === '') return { sliceCount: null, totalHours: null }
  try {
    const arr = JSON.parse(String(raw))
    if (!Array.isArray(arr)) return { sliceCount: null, totalHours: null }
    let total = 0
    for (const slice of arr) {
      if (typeof slice?.Hours === 'number') total += slice.Hours
      else if (typeof slice?.minutes === 'number') total += slice.minutes / 60
    }
    return { sliceCount: arr.length, totalHours: Math.round(total * 100) / 100 }
  } catch {
    return { sliceCount: null, totalHours: null }
  }
}

function num(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function str(value: unknown): string | null {
  if (value == null) return null
  const s = String(value)
  return s === '' ? null : s
}

// ─── Builder ──────────────────────────────────────────────────────────────────

export async function buildScheduleDiagnostic(input: DiagnosticInput): Promise<ScheduleDiagnosticReport> {
  const allProjects = input.selectedProjectIds.size > 0
    ? input.projects.filter(p => input.selectedProjectIds.has(p.ProjectId))
    : input.projects

  const capped = allProjects.slice(0, PROJECT_CAP)
  const isProjectOnline = input.dataSource === 'ProjectOnline'

  const projects: ProjectDiagnostic[] = []
  for (const poProject of capped) {
    projects.push(await buildProjectDiagnostic(poProject, input, isProjectOnline))
  }

  return {
    meta: {
      exportedAt: new Date().toISOString(),
      migratorVersion: MIGRATOR_VERSION,
      tenantUrl: input.tenantUrl,
      dataSource: input.dataSource,
      migrationMode: input.migrationMode,
      projectCount: projects.length,
      privacyNote: 'This export contains project and resource names. Review before sharing externally.',
      ...(allProjects.length > capped.length ? { truncatedToCap: PROJECT_CAP } : {}),
    },
    projects,
  }
}

async function buildProjectDiagnostic(
  poProject: import('../../models/projectOnline.types').PoProject,
  input: DiagnosticInput,
  isProjectOnline: boolean,
): Promise<ProjectDiagnostic> {
  const dvProjectId = cleanGuid(poProject.ProjectId)?.toLowerCase() ?? poProject.ProjectId
  const settings = input.settingsByProject.get(poProject.ProjectId) ?? { hoursPerDay: 8, scheduleMode: null, scheduleModeLabel: null }

  const source: ProjectDiagnostic['source'] = {
    projectId: poProject.ProjectId,
    startDate: toDateOnly(poProject.ProjectStartDate),
    finishDate: toDateOnly(poProject.ProjectFinishDate),
    workHoursPerDay: settings.hoursPerDay,
    scheduleMode: settings.scheduleModeLabel,
  }

  const sourceTasks = input.tasks.filter(t => t.ProjectId === poProject.ProjectId)
  const sourceAssignments = input.assignments.filter(a => a.ProjectId === poProject.ProjectId)
  const assignedTaskIds = new Set(sourceAssignments.map(a => a.TaskId))

  const diag: ProjectDiagnostic = {
    projectId: dvProjectId,
    projectName: poProject.ProjectName,
    source,
    target: null,
    delta: { startDays: null, finishDays: null, hoursPerDayMatch: null, scheduleModeMatch: null },
    tasks: [],
    assignments: [],
    resources: [],
    unmatchedTasks: [],
  }

  try {
    const projectRow = await fetchProject(dvProjectId)
    if (projectRow) {
      const targetMode = num(projectRow.msdyn_schedulemode)
      const targetModeLabel = targetMode != null
        ? input.scheduleModeLabels.get(targetMode) ?? `unknown (${targetMode})`
        : null
      diag.target = { ...projectRow, msdyn_schedulemode_label: targetModeLabel }
      diag.delta = {
        startDays: deltaDays(source.startDate, str(projectRow.msdyn_scheduledstart)),
        finishDays: deltaDays(source.finishDate, str(projectRow.msdyn_finish)),
        hoursPerDayMatch: num(projectRow.msdyn_hoursperday) === settings.hoursPerDay,
        scheduleModeMatch: settings.scheduleMode != null && targetMode != null
          ? settings.scheduleMode === targetMode
          : null,
      }
    }

    const targetTasks = await fetchTasksForProject(dvProjectId)
    diag.tasks = sourceTasks.map(poTask => {
      const matched = matchTargetTask(poTask, targetTasks)
      if (!matched) diag.unmatchedTasks.push(poTask.TaskId)
      return buildTaskDiagnostic(poTask, matched, settings.hoursPerDay, assignedTaskIds.has(poTask.TaskId), isProjectOnline)
    })

    const { assignments, resources } = await buildAssignmentsAndResources(
      dvProjectId, sourceAssignments, settings.hoursPerDay,
    )
    diag.assignments = assignments
    diag.resources = resources
  } catch (e) {
    diag.fetchError = String(e).slice(0, 300)
  }

  return diag
}

function buildTaskDiagnostic(
  poTask: PoTask,
  matched: Record<string, unknown> | null,
  hoursPerDay: number,
  isAssigned: boolean,
  isProjectOnline: boolean,
): TaskDiagnostic {
  const durationDays = poTask.TaskStartDate && poTask.TaskFinishDate
    ? calendarWorkingDaysInclusive(poTask.TaskStartDate, poTask.TaskFinishDate, MON_FRI)
    : null
  const durationMinutesSource = num(poTask.TaskDurationInMinutes)
  const sourceDurMinutes = durationMinutesSource ?? (durationDays != null ? Math.round(durationDays * hoursPerDay * 60) : null)

  const tDuration = matched ? num(matched.msdyn_duration) : null
  const tSchedMinutes = matched ? num(matched.msdyn_scheduleddurationminutes) : null

  return {
    taskId_source: poTask.TaskId,
    taskId_target: matched ? str(matched.msdyn_projecttaskid) : null,
    subject: String(poTask.TaskName ?? ''),
    isAssigned,
    isLeaf: !poTask.TaskIsSummary,
    source: {
      startDate: toDateOnly(poTask.TaskStartDate),
      finishDate: toDateOnly(poTask.TaskFinishDate),
      durationDays,
      durationMinutes_source: durationMinutesSource,
      ...(isProjectOnline ? { work_hours: num(poTask.TaskWork) } : {}),
    },
    target: matched ? { ...matched } : null,
    delta: matched
      ? {
          startDays: deltaDays(toDateOnly(poTask.TaskStartDate), str(matched.msdyn_scheduledstart)),
          endDays: deltaDays(toDateOnly(poTask.TaskFinishDate), str(matched.msdyn_scheduledend)),
          durationDaysDelta: tDuration != null && durationDays != null
            ? Math.round((tDuration - durationDays) * 100) / 100
            : null,
          scheduledDurationMinutesDelta: tSchedMinutes != null && sourceDurMinutes != null
            ? tSchedMinutes - sourceDurMinutes
            : null,
        }
      : null,
  }
}

async function buildAssignmentsAndResources(
  dvProjectId: string,
  sourceAssignments: PoAssignment[],
  projectHoursPerDay: number,
): Promise<{ assignments: AssignmentDiagnostic[]; resources: ResourceDiagnostic[] }> {
  const targetAssignments = await fetchAssignmentsForProject(dvProjectId)
  const teams = await fetchProjectTeams(dvProjectId)
  const teamById = new Map(teams.map(t => [String(t.msdyn_projectteamid ?? '').toLowerCase(), t]))

  const assignments: AssignmentDiagnostic[] = targetAssignments.map(row => {
    const teamId = String(row._msdyn_projectteamid_value ?? '').toLowerCase()
    const team = teamById.get(teamId)
    const resourceName = team ? str(team.msdyn_name) : null
    const pw = parsePlannedWork(row.msdyn_plannedwork)
    const planned = str(row.msdyn_plannedwork)
    return {
      assignmentId_source: null,
      assignmentId_target: str(row.msdyn_resourceassignmentid),
      taskId_target: str(row._msdyn_taskid_value),
      resourceName,
      source: { units: null },
      target: {
        ...row,
        msdyn_plannedwork_sliceCount: pw.sliceCount,
        msdyn_plannedwork_totalHours: pw.totalHours,
        ...(planned ? {} : { note: 'no contour written' }),
      },
    }
  })

  // Map source units onto matched target assignments by task (best-effort; multiple
  // assignments per task share the first source unit value).
  const sourceUnitByTask = new Map<string, number | null>()
  for (const a of sourceAssignments) {
    const key = cleanGuid(a.TaskId)?.toLowerCase() ?? a.TaskId
    if (!sourceUnitByTask.has(key)) sourceUnitByTask.set(key, num(a.AssignmentUnits))
  }
  for (const a of assignments) {
    const key = (a.taskId_target ?? '').toLowerCase()
    if (sourceUnitByTask.has(key)) a.source.units = sourceUnitByTask.get(key) ?? null
  }

  // Unique bookable resources referenced by the teams in play.
  const resourceIds = [...new Set(teams
    .map(t => str(t._msdyn_bookableresourceid_value)?.toLowerCase())
    .filter((v): v is string => !!v))]

  const resources: ResourceDiagnostic[] = []
  for (const resourceId of resourceIds) {
    resources.push(await buildResourceDiagnostic(resourceId, projectHoursPerDay))
  }

  return { assignments, resources }
}

async function buildResourceDiagnostic(bookableResourceId: string, projectHoursPerDay: number): Promise<ResourceDiagnostic> {
  try {
    const rows = await listRecords('bookableresources', undefined, `bookableresourceid eq ${bookableResourceId}`, 1)
    const row = rows[0] ?? null
    const resourceName = row ? str(row.name) : null
    const calendarId = row ? str(row._calendarid_value) : null

    if (!calendarId) {
      return {
        resourceName,
        bookableresourceId: bookableResourceId,
        raw: row,
        calendar: {
          calendarId: null,
          hasCalendar: false,
          workingHoursPerDay: null,
          matchesProjectCalendar: null,
          note: 'No resource calendar — assigned tasks use the project calendar (no resource-calendar drift source).',
        },
      }
    }

    const workingHoursPerDay = await readCalendarHoursPerDay(calendarId)
    const matches = workingHoursPerDay != null ? Math.abs(workingHoursPerDay - projectHoursPerDay) < 0.01 : null
    return {
      resourceName,
      bookableresourceId: bookableResourceId,
      raw: row,
      calendar: {
        calendarId,
        hasCalendar: true,
        workingHoursPerDay,
        matchesProjectCalendar: matches,
        note: workingHoursPerDay == null
          ? 'Resource has its own calendar; working-hours could not be parsed from calendar rules — inspect manually.'
          : matches
            ? `Resource calendar ${workingHoursPerDay}h/day matches project ${projectHoursPerDay}h/day.`
            : `Resource calendar ${workingHoursPerDay}h/day differs from project ${projectHoursPerDay}h/day — drift expected on assigned tasks.`,
      },
    }
  } catch (e) {
    return {
      resourceName: null,
      bookableresourceId: bookableResourceId,
      raw: null,
      calendar: {
        calendarId: null,
        hasCalendar: false,
        workingHoursPerDay: null,
        matchesProjectCalendar: null,
        note: `Resource/calendar read failed: ${String(e).slice(0, 120)}`,
      },
    }
  }
}

/**
 * Best-effort working-hours-per-day from a calendar's rules. PfW calendar rules
 * are tenant/version dependent; we read all rules (no $select, to avoid 400s) and
 * take the most common positive daily working-minutes value. Returns null when no
 * confident value is found.
 */
async function readCalendarHoursPerDay(calendarId: string): Promise<number | null> {
  const rules = await listRecords('calendarrules', undefined, `_calendarid_value eq ${calendarId}`, 200)
  const minutes: number[] = []
  for (const rule of rules) {
    const effort = num(rule.effort) ?? num(rule.duration)
    if (effort != null && effort > 0 && effort <= 24 * 60) minutes.push(effort)
  }
  if (minutes.length === 0) return null
  // Most frequent value
  const freq = new Map<number, number>()
  for (const m of minutes) freq.set(m, (freq.get(m) ?? 0) + 1)
  const best = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0]
  return Math.round((best / 60) * 100) / 100
}

// ─── Dataverse fetch helpers ──────────────────────────────────────────────────

// All diagnostic fetches drop $select on purpose: we are diagnosing, so we want the
// full row. Guessing field names against unreliable docs caused an iterative 400
// fail-cycle (msdyn_scheduledend, then msdyn_scheduleddurationminutes on the project).
// Performance is irrelevant for ≤50 projects.
async function fetchProject(dvProjectId: string): Promise<Record<string, unknown> | null> {
  const rows = await listRecords('msdyn_projects', undefined, `msdyn_projectid eq ${dvProjectId}`, 1)
  return rows[0] ?? null
}

async function fetchTasksForProject(dvProjectId: string): Promise<Record<string, unknown>[]> {
  return listRecords('msdyn_projecttasks', undefined, `_msdyn_project_value eq ${dvProjectId}`, 5000)
}

async function fetchAssignmentsForProject(dvProjectId: string): Promise<Record<string, unknown>[]> {
  return listRecords('msdyn_resourceassignments', undefined, `_msdyn_projectid_value eq ${dvProjectId}`, 5000)
}

async function fetchProjectTeams(dvProjectId: string): Promise<Record<string, unknown>[]> {
  return listRecords('msdyn_projectteams', undefined, `_msdyn_project_value eq ${dvProjectId}`, 5000)
}
