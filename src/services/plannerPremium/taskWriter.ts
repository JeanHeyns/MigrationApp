import type { PoTask } from '../../models/projectOnline.types'
import type { MappingConfiguration, OptionSetMapping } from '../../models/mapping.types'
import type { ImportError } from '../../models/plannerPremium.types'
import { listRecords } from './dataverseClient'
import { chunks, cleanGuid, getRecordId, nowError, sourceGuidOrNew } from './importHelpers'
import { abandonOperationSet, createOperationSet, executeOperationSet, executeOperationSetWithRetry, queueScheduleCreate, queueScheduleDelete, queueScheduleUpdate } from './scheduleApi'
import { calendarWorkingDaysInclusive, type ProjectCalendar } from './calendarReader'
import { taskDurationDays, DEFAULT_HOURS_PER_DAY, workValueToHours } from './scheduleMath'
import { debugSchedule } from './scheduleDebug'

const TASK_MATERIALIZATION_MAX_ATTEMPTS = 5
const TASK_MATERIALIZATION_DELAY_MS = 20000
const DEFAULT_TASK_NAME = 'No Task Name'
const WORK_DAY_START_HOUR_UTC = 9

export interface TaskWriteResult {
  poTaskId: string
  dvTaskId?: string
  success: boolean
  error?: ImportError
}

/**
 * Rebuilds project schedules through Project schedule OperationSets.
 * Existing assignments, dependencies, and tasks are cleared before tasks are recreated.
 *
 * Task custom fields are NOT migrated — neither in full nor in dataOnly mode.
 * The OperationSet PSS API does not accept custom field values on msdyn_projecttask,
 * and post-creation PATCH on locked task entities is not supported.
 */
export async function writeTasks(
  tasks: PoTask[],
  projectIdMap: Record<string, string>,
  mappingConfig: MappingConfiguration,
  optionSetMappings: OptionSetMapping[] = [],
  hoursPerDay: number = DEFAULT_HOURS_PER_DAY,
  onProgress?: (result: TaskWriteResult) => void,
  effortHoursByTaskId: Map<string, number> = new Map(),
): Promise<TaskWriteResult[]> {
  void mappingConfig
  void optionSetMappings
  const results: TaskWriteResult[] = []
  const tasksByProject = groupByProject(tasks)

  for (const [poProjectId, projectTasks] of tasksByProject) {
    const dvProjectId = projectIdMap[poProjectId]
    if (!dvProjectId) {
      for (const task of projectTasks) {
        const result = { poTaskId: task.TaskId, success: false, error: nowError('Task', task.TaskId, 'Project was not imported', undefined, poProjectId) }
        results.push(result)
        onProgress?.(result)
      }
      continue
    }

    const bucket = await findDefaultBucket(dvProjectId)
    if (!bucket) {
      for (const task of projectTasks) {
        const result = { poTaskId: task.TaskId, success: false, error: nowError('Task', task.TaskId, 'Default project bucket was not found', undefined, poProjectId) }
        results.push(result)
        onProgress?.(result)
      }
      continue
    }

    await clearSchedule(dvProjectId)
    const taskIdMap: Record<string, string> = {}
    const pending = projectTasks.filter(task => !isProjectSummaryTask(task)).sort(compareTasks)

    // committedLevels tracks taskId → outlineLevel for tasks already sent to Dataverse,
    // enabling cross-batch parent level lookup in validateAndNormalizeOutlineLevels.
    const committedLevels = new Map<string, number>()

    // Multi-round deferred placement for tasks whose parent was not yet committed
    let queue = [...pending]
    let placementRound = 0
    const MAX_PLACEMENT_ROUNDS = 3

    while (queue.length > 0 && placementRound < MAX_PLACEMENT_ROUNDS) {
      placementRound++
      const nextRoundDeferred: PoTask[] = []

      for (const chunk of chunks(queue, 180)) {
        if (chunk.length === 0) continue

        const { ready, deferred, warnings } = validateAndNormalizeOutlineLevels(chunk, committedLevels)

        for (const w of warnings) {
          console.warn('[taskWriter]', w)
        }

        nextRoundDeferred.push(...deferred)

        if (ready.length === 0) continue

        // Assign DV task IDs before queueing so taskIdMap is populated regardless of success
        const ops = ready.map(task => {
          const taskId = sourceGuidOrNew(task.TaskId)
          taskIdMap[task.TaskId] = taskId
          return { id: task.TaskId, entity: buildTaskEntity(task, taskId, dvProjectId, bucket, hoursPerDay, effortHoursByTaskId.get(task.TaskId)) }
        })

        const batchResult = await executeOperationSetWithRetry(
          dvProjectId,
          ops,
          `Project Online task import ${new Date().toISOString()}`,
        )

        for (const op of batchResult.succeeded) {
          const dvTaskId = taskIdMap[op.id]
          committedLevels.set(op.id, ready.find(t => t.TaskId === op.id)?.TaskOutlineLevel ?? 1)
          const result: TaskWriteResult = { poTaskId: op.id, dvTaskId, success: true }
          results.push(result)
          onProgress?.(result)
        }

        for (const { op, reason, errorClass } of batchResult.failed) {
          const result: TaskWriteResult = {
            poTaskId: op.id,
            dvTaskId: errorClass === 'AlreadyExists' ? taskIdMap[op.id] : undefined,
            success: false,
            error: nowError('Task', op.id, reason, errorClass, poProjectId),
          }
          results.push(result)
          onProgress?.(result)
          // For AlreadyExists, still track in committedLevels so deps can resolve.
          // Use the normalized level (ready), matching the success path above — the
          // pre-normalized level would mis-anchor children and re-trigger E_DEMOTETOOFAR.
          if (errorClass === 'AlreadyExists') {
            committedLevels.set(op.id, ready.find(t => t.TaskId === op.id)?.TaskOutlineLevel ?? 1)
          }
        }
      }

      queue = nextRoundDeferred
    }

    // Tasks still deferred after max placement rounds — fail them clearly
    for (const task of queue) {
      const result: TaskWriteResult = {
        poTaskId: task.TaskId,
        success: false,
        error: nowError('Task', task.TaskId, 'Parent task could not be placed after 3 placement rounds', undefined, poProjectId),
      }
      results.push(result)
      onProgress?.(result)
    }

    await remapMaterializedTaskIds(dvProjectId, pending, results, hoursPerDay)
  }

  return results
}

export interface ScheduleCorrectionResult {
  poTaskId: string
  start: string
  durationDays: number
  success: boolean
  error?: ImportError
}

export interface TaskEffortCorrectionResult {
  poTaskId: string
  effortHours: number
  success: boolean
  error?: ImportError
}

export interface TaskProgressCorrectionResult {
  poTaskId: string
  progress: number
  success: boolean
  error?: ImportError
}

export interface ScheduleCorrectionOptions {
  includeDuration?: boolean
}

/**
 * Post-assignment schedule correction for Fixed Effort projects.
 *
 * Two things move dates away from the imported schedule after tasks are created:
 *  1. Fixed Effort recomputes a task's duration when resources are assigned
 *     (Duration = Work / Units), shrinking it.
 *  2. Dependency creation recomputes a successor's start (predecessor finish +
 *     lag), which can land off the imported start.
 *
 * This pass re-asserts each leaf task's original start, finish, and effort via
 * msdyn_PssUpdateV1, pinning them like a manual edit does in the UI. Duration is
 * intentionally left to PSS; start/finish/effort are the source-of-truth fields.
 *
 * Must run AFTER tasks, assignments, and dependencies are written. Best-effort:
 * a failed OperationSet leaves the engine-computed values in place but does not
 * abort the import.
 */
export async function correctTaskSchedule(
  tasks: PoTask[],
  projectId: string,
  taskIdMap: Record<string, string>,
  calendar: ProjectCalendar,
  onProgress?: (result: ScheduleCorrectionResult) => void,
  effortHoursByTaskId: Map<string, number> = new Map(),
  options: ScheduleCorrectionOptions = {},
): Promise<ScheduleCorrectionResult[]> {
  const results: ScheduleCorrectionResult[] = []

  // Summary tasks have engine-rolled-up start and duration — they are not
  // editable, and correcting their leaves fixes them automatically. The
  // ProjectData OData feed exposes the TaskIsSummary boolean directly.
  const correctable = tasks
    .filter(task =>
      !isProjectSummaryTask(task) &&
      !task.TaskIsSummary &&
      !!taskIdMap[task.TaskId] &&
      !!task.TaskStartDate &&
      !!task.TaskFinishDate,
    )
    .map(task => ({ task, days: getCorrectionDurationDays(task, calendar) }))
    .filter(entry => entry.days >= 0)

  for (const chunk of chunks(correctable, 180)) {
    if (chunk.length === 0) continue

    let opSetId: string | undefined
    try {
      opSetId = await createOperationSet(projectId, `Correct task schedule ${new Date().toISOString()}`)
      for (const { task, days } of chunk) {
        await queueTaskScheduleUpdate(opSetId, task, taskIdMap[task.TaskId], days, effortHoursByTaskId, options)
        debugSchedule(`task ${task.TaskId} correction`, {
          intended_start: task.TaskStartDate,
          intended_finish: task.TaskFinishDate,
          source_duration_days: days,
          effort_hours: effortHoursByTaskId.get(task.TaskId) ?? getTaskEffort(task),
        })
      }
      await executeOperationSet(opSetId)
      for (const { task, days } of chunk) {
        const result: ScheduleCorrectionResult = { poTaskId: task.TaskId, start: task.TaskStartDate!, durationDays: days, success: true }
        results.push(result)
        onProgress?.(result)
      }
    } catch (e) {
      if (opSetId) await abandonOperationSet(opSetId)
      console.warn(`[taskWriter] schedule correction batch failed (${chunk.length} task(s)), retrying individually: ${String(e).slice(0, 300)}`)
      for (const { task, days } of chunk) {
        const result = await correctSingleTaskSchedule(projectId, task, taskIdMap[task.TaskId], days, effortHoursByTaskId, options)
        results.push(result)
        onProgress?.(result)
      }
    }
  }

  return results
}

async function correctSingleTaskSchedule(
  projectId: string,
  task: PoTask,
  dvTaskId: string,
  durationDays: number,
  effortHoursByTaskId: Map<string, number>,
  options: ScheduleCorrectionOptions,
): Promise<ScheduleCorrectionResult> {
  let opSetId: string | undefined
  try {
    opSetId = await createOperationSet(projectId, `Correct task schedule ${new Date().toISOString()}`)
    await queueTaskScheduleUpdate(opSetId, task, dvTaskId, durationDays, effortHoursByTaskId, options)
    await executeOperationSet(opSetId)
    return { poTaskId: task.TaskId, start: task.TaskStartDate!, durationDays, success: true }
  } catch (e) {
    if (opSetId) await abandonOperationSet(opSetId)
    return {
      poTaskId: task.TaskId,
      start: task.TaskStartDate!,
      durationDays,
      success: false,
      error: nowError('Task', task.TaskId, `Schedule correction failed: ${String(e)}`, undefined, undefined),
    }
  }
}

async function queueTaskScheduleUpdate(
  operationSetId: string,
  task: PoTask,
  dvTaskId: string,
  durationDays: number,
  effortHoursByTaskId: Map<string, number>,
  options: ScheduleCorrectionOptions,
): Promise<void> {
  await queueScheduleUpdate(operationSetId, {
    '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_projecttask',
    msdyn_projecttaskid: dvTaskId,
    msdyn_scheduledstart: toWorkdayStart(task.TaskStartDate),
    msdyn_start: toWorkdayStart(task.TaskStartDate),
    msdyn_scheduledend: toScheduledEnd(task.TaskFinishDate, durationDays),
    ...((options.includeDuration || durationDays === 0) ? { msdyn_duration: durationDays } : {}),
    ...(effortHoursByTaskId.has(task.TaskId) ? { msdyn_effort: effortHoursByTaskId.get(task.TaskId) } : {}),
  })
}

/**
 * Final pass that mirrors a manual UI effort edit: write only msdyn_effort and
 * leave start, finish, duration, dependencies, and assignments untouched.
 */
export async function correctTaskEffort(
  tasks: PoTask[],
  projectId: string,
  taskIdMap: Record<string, string>,
  effortHoursByTaskId: Map<string, number>,
  onProgress?: (result: TaskEffortCorrectionResult) => void,
): Promise<TaskEffortCorrectionResult[]> {
  const results: TaskEffortCorrectionResult[] = []
  const correctable = tasks.filter(task =>
    !isProjectSummaryTask(task) &&
    !task.TaskIsSummary &&
    !isZeroDurationTask(task) &&
    !!taskIdMap[task.TaskId] &&
    effortHoursByTaskId.has(task.TaskId),
  )

  for (const chunk of chunks(correctable, 180)) {
    if (chunk.length === 0) continue

    let opSetId: string | undefined
    try {
      opSetId = await createOperationSet(projectId, `Correct task effort ${new Date().toISOString()}`)
      for (const task of chunk) {
        await queueTaskEffortUpdate(opSetId, taskIdMap[task.TaskId], effortHoursByTaskId.get(task.TaskId)!)
      }
      await executeOperationSet(opSetId)

      for (const task of chunk) {
        const effortHours = effortHoursByTaskId.get(task.TaskId)!
        const result: TaskEffortCorrectionResult = { poTaskId: task.TaskId, effortHours, success: true }
        results.push(result)
        onProgress?.(result)
      }
    } catch (e) {
      if (opSetId) await abandonOperationSet(opSetId)
      console.warn(`[taskWriter] effort correction batch failed (${chunk.length} task(s)): ${String(e).slice(0, 300)}`)

      for (const task of chunk) {
        const effortHours = effortHoursByTaskId.get(task.TaskId)!
        const result = await correctSingleTaskEffort(projectId, task, taskIdMap[task.TaskId], effortHours)
        results.push(result)
        onProgress?.(result)
      }
    }
  }

  return results
}

async function correctSingleTaskEffort(
  projectId: string,
  task: PoTask,
  dvTaskId: string,
  effortHours: number,
): Promise<TaskEffortCorrectionResult> {
  let opSetId: string | undefined
  try {
    opSetId = await createOperationSet(projectId, `Correct task effort ${new Date().toISOString()}`)
    await queueTaskEffortUpdate(opSetId, dvTaskId, effortHours)
    await executeOperationSet(opSetId)
    return { poTaskId: task.TaskId, effortHours, success: true }
  } catch (e) {
    if (opSetId) await abandonOperationSet(opSetId)
    return {
      poTaskId: task.TaskId,
      effortHours,
      success: false,
      error: nowError('Task', task.TaskId, `Effort correction failed: ${String(e)}`, undefined, undefined),
    }
  }
}

async function queueTaskEffortUpdate(
  operationSetId: string,
  dvTaskId: string,
  effortHours: number,
): Promise<void> {
  await queueScheduleUpdate(operationSetId, {
    '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_projecttask',
    msdyn_projecttaskid: dvTaskId,
    msdyn_effort: effortHours,
  })
}

export async function correctTaskProgress(
  tasks: PoTask[],
  projectId: string,
  taskIdMap: Record<string, string>,
  onProgress?: (result: TaskProgressCorrectionResult) => void,
): Promise<TaskProgressCorrectionResult[]> {
  const results: TaskProgressCorrectionResult[] = []
  const correctable = tasks.filter(task =>
    !isProjectSummaryTask(task) &&
    !task.TaskIsSummary &&
    !!taskIdMap[task.TaskId] &&
    getTaskProgress(task) != null,
  )

  for (const chunk of chunks(correctable, 180)) {
    if (chunk.length === 0) continue

    let opSetId: string | undefined
    try {
      opSetId = await createOperationSet(projectId, `Correct task progress ${new Date().toISOString()}`)
      for (const task of chunk) {
        await queueTaskProgressUpdate(opSetId, taskIdMap[task.TaskId], getTaskProgress(task)!)
      }
      await executeOperationSet(opSetId)

      for (const task of chunk) {
        const progress = getTaskProgress(task)!
        const result: TaskProgressCorrectionResult = { poTaskId: task.TaskId, progress, success: true }
        results.push(result)
        onProgress?.(result)
      }
    } catch (e) {
      if (opSetId) await abandonOperationSet(opSetId)
      console.warn(`[taskWriter] progress correction batch failed (${chunk.length} task(s)): ${String(e).slice(0, 300)}`)

      for (const task of chunk) {
        const progress = getTaskProgress(task)!
        const result = await correctSingleTaskProgress(projectId, task, taskIdMap[task.TaskId], progress)
        results.push(result)
        onProgress?.(result)
      }
    }
  }

  return results
}

async function correctSingleTaskProgress(
  projectId: string,
  task: PoTask,
  dvTaskId: string,
  progress: number,
): Promise<TaskProgressCorrectionResult> {
  let opSetId: string | undefined
  try {
    opSetId = await createOperationSet(projectId, `Correct task progress ${new Date().toISOString()}`)
    await queueTaskProgressUpdate(opSetId, dvTaskId, progress)
    await executeOperationSet(opSetId)
    return { poTaskId: task.TaskId, progress, success: true }
  } catch (e) {
    if (opSetId) await abandonOperationSet(opSetId)
    return {
      poTaskId: task.TaskId,
      progress,
      success: false,
      error: nowError('Task', task.TaskId, `Progress correction failed: ${String(e)}`, undefined, undefined),
    }
  }
}

async function queueTaskProgressUpdate(
  operationSetId: string,
  dvTaskId: string,
  progress: number,
): Promise<void> {
  await queueScheduleUpdate(operationSetId, {
    '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_projecttask',
    msdyn_projecttaskid: dvTaskId,
    msdyn_progress: progress,
  })
}

interface NormalizeResult {
  ready: PoTask[]
  deferred: PoTask[]
  warnings: string[]
}

function validateAndNormalizeOutlineLevels(
  tasks: PoTask[],
  committedLevels: Map<string, number>,
): NormalizeResult {
  const ready: PoTask[] = []
  const deferred: PoTask[] = []
  const warnings: string[] = []
  const inBatchLevels = new Map<string, number>(committedLevels)

  // Tasks arrive sorted by TaskOutlineNumber (parents before children)
  for (const task of tasks) {
    const declared = task.TaskOutlineLevel ?? 1
    const parentId = task.TaskParentId

    if (!parentId || declared <= 1) {
      const level = Math.max(1, declared)
      ready.push(level !== declared ? { ...task, TaskOutlineLevel: level } : task)
      inBatchLevels.set(task.TaskId, level)
      continue
    }

    const parentLevel = inBatchLevels.get(parentId)

    if (parentLevel === undefined) {
      // Parent not yet seen — defer to next placement round
      deferred.push(task)
      continue
    }

    const allowed = parentLevel + 1
    if (declared !== allowed) {
      warnings.push(`Task ${task.TaskId}: OutlineLevel ${declared} normalized to ${allowed} (parent level ${parentLevel})`)
      ready.push({ ...task, TaskOutlineLevel: allowed })
      inBatchLevels.set(task.TaskId, allowed)
    } else {
      ready.push(task)
      inBatchLevels.set(task.TaskId, declared)
    }
  }

  return { ready, deferred, warnings }
}

async function remapMaterializedTaskIds(
  projectId: string,
  tasks: PoTask[],
  results: TaskWriteResult[],
  hoursPerDay: number,
): Promise<void> {
  const poTaskIds = new Set(tasks.map(task => task.TaskId))
  const projectResults = results.filter(result => result.success && result.dvTaskId && poTaskIds.has(result.poTaskId))
  if (projectResults.length === 0) return

  const rows = await waitForMaterializedTasks(projectId, projectResults.length)
  // Empty read (transient) — keep ids as-is rather than nuking every task.
  if (rows.length === 0) return

  const resolved = resolveMaterializedTaskIds(projectResults, rows, tasks, hoursPerDay)
  for (const result of projectResults) {
    if (!resolved.has(result.poTaskId)) continue
    const id = resolved.get(result.poTaskId)
    if (id === null) {
      // No real Dataverse row resolves to this task. Keeping the stale source GUID
      // makes the schedule-correction OperationSet reference a non-existent task,
      // which PSS rejects ("project 00000000… does not match the operation set").
      // Drop the id so dependencies and corrections skip it instead of crashing.
      console.warn(`[taskWriter] no materialized Dataverse row for task "${getTaskSubject(tasks.find(t => t.TaskId === result.poTaskId) ?? {} as PoTask)}" (${result.poTaskId}) — skipping its schedule correction`)
      result.dvTaskId = undefined
    } else if (id && id !== cleanGuid(result.dvTaskId)) {
      result.dvTaskId = id
    }
  }
}

/**
 * Pure matcher (unit-tested): maps each write result's poTaskId to the real
 * Dataverse task id. PSS frequently does NOT honor the source GUID we propose on
 * create, materializing its own id, so we re-resolve against the fetched rows.
 *
 * Tiers, most specific first, each claiming a still-unused row:
 *  1. subject + start + end + duration (exact)
 *  2. subject + start          (PSS shifted the end/duration)
 *  3. subject only             (PSS shifted all dates; duplicate names map in order)
 *
 * Returns the resolved id, the current id when PSS honored it, or `null` when no
 * row matches and the row set looks complete — the caller drops null ids so the
 * stale GUID never reaches an OperationSet.
 */
export function resolveMaterializedTaskIds(
  projectResults: Pick<TaskWriteResult, 'poTaskId' | 'dvTaskId'>[],
  rows: Record<string, unknown>[],
  tasks: PoTask[],
  hoursPerDay: number,
): Map<string, string | null> {
  const out = new Map<string, string | null>()
  const rowId = (row: Record<string, unknown> | undefined): string | undefined =>
    cleanGuid(getRecordId(row ?? {}, 'msdyn_projecttaskid'))
  const existingIds = new Set(rows.map(row => rowId(row)).filter(Boolean))
  const usedIds = new Set<string>()
  const taskByPoId = new Map(tasks.map(t => [t.TaskId, t]))
  const rowsComplete = rows.length >= projectResults.length

  const claim = (poTaskId: string, finder: () => Record<string, unknown> | undefined): boolean => {
    const id = rowId(finder())
    if (!id || usedIds.has(id)) return false
    usedIds.add(id)
    out.set(poTaskId, id)
    return true
  }
  const unused = (row: Record<string, unknown>): boolean => {
    const id = rowId(row)
    return !!id && !usedIds.has(id)
  }

  // Pass 0 — keep ids PSS actually honored.
  const pending: typeof projectResults = []
  for (const result of projectResults) {
    const currentId = cleanGuid(result.dvTaskId)
    if (currentId && existingIds.has(currentId)) {
      usedIds.add(currentId)
      out.set(result.poTaskId, currentId)
    } else {
      pending.push(result)
    }
  }

  // Pass 1 — strict match. Claims exact rows before looser tiers can take them.
  const afterStrict: typeof projectResults = []
  for (const result of pending) {
    const task = taskByPoId.get(result.poTaskId)
    if (!task) { out.set(result.poTaskId, cleanGuid(result.dvTaskId) ?? null); continue }
    const ok = claim(result.poTaskId, () => rows.find(row =>
      unused(row) &&
      String(row.msdyn_subject ?? '') === getTaskSubject(task) &&
      sameDate(row.msdyn_scheduledstart, task.TaskStartDate) &&
      sameDate(row.msdyn_scheduledend, task.TaskFinishDate) &&
      sameDuration(row.msdyn_duration, getTaskDurationDays(task, hoursPerDay)),
    ))
    if (!ok) afterStrict.push(result)
  }

  // Pass 2 — loose fallback: subject + start, then subject alone.
  for (const result of afterStrict) {
    const task = taskByPoId.get(result.poTaskId)
    if (!task) { out.set(result.poTaskId, cleanGuid(result.dvTaskId) ?? null); continue }
    const matched =
      claim(result.poTaskId, () => rows.find(row =>
        unused(row) &&
        String(row.msdyn_subject ?? '') === getTaskSubject(task) &&
        sameDate(row.msdyn_scheduledstart, task.TaskStartDate),
      )) ||
      claim(result.poTaskId, () => rows.find(row =>
        unused(row) &&
        String(row.msdyn_subject ?? '') === getTaskSubject(task),
      ))
    if (!matched) {
      // Complete row set + no match → drop (null). Incomplete set → keep current
      // id to avoid false drops on a slow/partial materialization read.
      out.set(result.poTaskId, rowsComplete ? null : (cleanGuid(result.dvTaskId) ?? null))
    }
  }

  return out
}

async function waitForMaterializedTasks(projectId: string, expectedCount: number): Promise<Record<string, unknown>[]> {
  let rows: Record<string, unknown>[] = []

  for (let attempt = 1; attempt <= TASK_MATERIALIZATION_MAX_ATTEMPTS; attempt += 1) {
    rows = await listRecords(
      'msdyn_projecttasks',
      'msdyn_projecttaskid,msdyn_subject,msdyn_scheduledstart,msdyn_scheduledend,msdyn_duration,_msdyn_project_value',
      `_msdyn_project_value eq ${projectId}`,
      5000,
    )

    if (rows.length >= expectedCount) return rows
    if (attempt < TASK_MATERIALIZATION_MAX_ATTEMPTS) {
      await sleep(TASK_MATERIALIZATION_DELAY_MS)
    }
  }

  return rows
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sameDate(left: unknown, right: unknown): boolean {
  if (!left && !right) return true
  if (!left || !right) return false
  return String(left).slice(0, 10) === String(right).slice(0, 10)
}

function sameDuration(left: unknown, right: unknown): boolean {
  if (left == null && right == null) return true
  return Number(left ?? 0) === Number(right ?? 0)
}

function isProjectSummaryTask(task: PoTask): boolean {
  return (
    task.TaskId === '0' ||
    task.TaskOutlineNumber === '0' ||
    task.TaskOutlineLevel === 0
  )
}

function groupByProject(tasks: PoTask[]): Map<string, PoTask[]> {
  const grouped = new Map<string, PoTask[]>()
  for (const task of tasks) {
    const current = grouped.get(task.ProjectId) ?? []
    current.push(task)
    grouped.set(task.ProjectId, current)
  }
  return grouped
}

function compareTasks(a: PoTask, b: PoTask) {
  const ao = a.TaskOutlineNumber ?? ''
  const bo = b.TaskOutlineNumber ?? ''
  return ao.localeCompare(bo, undefined, { numeric: true }) || getTaskSubject(a).localeCompare(getTaskSubject(b))
}

function getTaskSubject(task: PoTask): string {
  const name = String(task.TaskName ?? '').trim()
  return name || DEFAULT_TASK_NAME
}

/**
 * Returns the task duration in *days* as PSS expects on `msdyn_duration`.
 * Per MS docs (verified): msdyn_duration is "the duration in days for the task"
 * (double). `msdyn_scheduleddurationminutes` is the read-only, PSS-computed
 * minutes value — we never write it.
 *
 * Source is the task's duration in minutes (calendar minutes), converted to days
 * via the project's working hours-per-day. Milestones are 0.
 */
function getTaskDurationDays(task: PoTask, hoursPerDay: number): number | undefined {
  if (task.TaskIsMilestone) return 0
  return taskDurationDays(task.TaskDurationInMinutes, hoursPerDay)
}

function getCorrectionDurationDays(task: PoTask, calendar: ProjectCalendar): number {
  if (task.TaskIsMilestone) return 0
  const sourceDuration = taskDurationDays(task.TaskDurationInMinutes, calendar.hoursPerDay)
  if (sourceDuration != null) return sourceDuration
  return calendarWorkingDaysInclusive(task.TaskStartDate!, task.TaskFinishDate!, calendar)
}

function getTaskEffort(task: PoTask): number | undefined {
  const raw = task.TaskIsMilestone ? 0 : workValueToHours(task.TaskWork)
  return raw != null ? Math.round(raw * 100) / 100 : undefined
}

function isZeroDurationTask(task: PoTask): boolean {
  return !!task.TaskIsMilestone || task.TaskDurationInMinutes === 0
}

function getTaskProgress(task: PoTask): number | undefined {
  if (task.TaskPercentCompleted == null) return undefined
  const progress = Number(task.TaskPercentCompleted)
  return Number.isFinite(progress) ? progress / 100 : undefined
}

function toWorkdayStart(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value)
  if (!match) return value
  return `${match[1]}T${String(WORK_DAY_START_HOUR_UTC).padStart(2, '0')}:00:00Z`
}

function toWorkdayFinish(value: string | undefined): string | undefined {
  if (!value) return undefined
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value)
  if (!match) return value
  return `${match[1]}T17:00:00Z`
}

function toScheduledEnd(value: string | undefined, durationDays: number): string | undefined {
  return durationDays === 0 ? toWorkdayStart(value) : toWorkdayFinish(value)
}

async function findDefaultBucket(projectId: string): Promise<string | undefined> {
  const rows = await listRecords(
    'msdyn_projectbuckets',
    'msdyn_projectbucketid,msdyn_name,_msdyn_project_value',
    `_msdyn_project_value eq ${projectId}`,
    5000,
  )
  const namedDefault = rows.find(row => String(row.msdyn_name ?? '').toLowerCase() === 'bucket 1')
  const existing = namedDefault ?? rows[0]
  const existingId = cleanGuid(getRecordId(existing ?? {}, 'msdyn_projectbucketid'))
  if (existingId) return existingId

  return createBucket(projectId)
}

async function createBucket(projectId: string): Promise<string | undefined> {
  const bucketId = crypto.randomUUID()
  const operationSetId = await createOperationSet(projectId, `Create import bucket ${new Date().toISOString()}`)
  await queueScheduleCreate(operationSetId, {
    '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_projectbucket',
    msdyn_projectbucketid: bucketId,
    msdyn_name: 'Imported tasks',
    'msdyn_project@odata.bind': `/msdyn_projects(${projectId})`,
  })
  await executeOperationSet(operationSetId)
  return bucketId
}

async function clearSchedule(projectId: string): Promise<void> {
  const assignments = await listRecords(
    'msdyn_resourceassignments',
    'msdyn_resourceassignmentid,_msdyn_projectid_value',
    `_msdyn_projectid_value eq ${projectId}`,
    5000,
  )
  console.info(`[taskWriter] clearSchedule ${projectId}: deleting ${assignments.length} assignment(s)`)
  await deleteSchedulingRows(projectId, 'msdyn_resourceassignment', assignments, 'msdyn_resourceassignmentid')

  const dependencies = await listRecords(
    'msdyn_projecttaskdependencies',
    'msdyn_projecttaskdependencyid,_msdyn_project_value',
    `_msdyn_project_value eq ${projectId}`,
    5000,
  )
  console.info(`[taskWriter] clearSchedule ${projectId}: deleting ${dependencies.length} dependenc(ies)`)
  await deleteSchedulingRows(projectId, 'msdyn_projecttaskdependency', dependencies, 'msdyn_projecttaskdependencyid')

  const tasks = await listRecords(
    'msdyn_projecttasks',
    'msdyn_projecttaskid,msdyn_outlinelevel,_msdyn_project_value',
    `_msdyn_project_value eq ${projectId}`,
    5000,
  )
  console.info(`[taskWriter] clearSchedule ${projectId}: deleting ${tasks.length} task(s)`)
  const deepestFirst = [...tasks].sort((a, b) => Number(b.msdyn_outlinelevel ?? 0) - Number(a.msdyn_outlinelevel ?? 0))
  await deleteSchedulingRows(projectId, 'msdyn_projecttask', deepestFirst, 'msdyn_projecttaskid')
}

async function deleteSchedulingRows(
  projectId: string,
  entityLogicalName: string,
  rows: Record<string, unknown>[],
  primaryKey: string,
): Promise<void> {
  for (const chunk of chunks(rows, 180)) {
    const ids = chunk.map(row => cleanGuid(getRecordId(row, primaryKey))).filter((id): id is string => !!id)
    if (ids.length === 0) continue

    const operationSetId = await createOperationSet(projectId, `Clear ${entityLogicalName} ${new Date().toISOString()}`)
    for (const id of ids) {
      await queueScheduleDelete(operationSetId, entityLogicalName, id)
    }
    await executeOperationSet(operationSetId)
  }
}

function buildTaskEntity(
  task: PoTask,
  taskId: string,
  projectId: string,
  bucketId: string,
  hoursPerDay: number,
  effortHoursOverride?: number,
) {
  const effortHours = effortHoursOverride ?? getTaskEffort(task)
  const entity = {
    '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_projecttask',
    msdyn_projecttaskid: taskId,
    'msdyn_project@odata.bind': `/msdyn_projects(${projectId})`,
    'msdyn_projectbucket@odata.bind': `/msdyn_projectbuckets(${bucketId})`,
    msdyn_subject: getTaskSubject(task),
    msdyn_scheduledstart: toWorkdayStart(task.TaskStartDate),
    msdyn_start: toWorkdayStart(task.TaskStartDate),
    msdyn_duration: getTaskDurationDays(task, hoursPerDay),
    ...(effortHours != null ? { msdyn_effort: effortHours } : {}),
    ...(task.TaskOutlineLevel != null ? { msdyn_outlinelevel: task.TaskOutlineLevel } : {})
  }
  debugSchedule(`task ${task.TaskId} payload`, {
    msdyn_duration_days: entity.msdyn_duration,
    msdyn_effort_hours: effortHours,
    source_progress: task.TaskPercentCompleted,
    msdyn_scheduledstart: entity.msdyn_scheduledstart,
    source_durationMinutes: task.TaskDurationInMinutes,
    source_work: task.TaskWork,
  })
  return entity
}
