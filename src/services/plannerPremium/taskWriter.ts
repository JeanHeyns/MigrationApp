import type { PoTask } from '../../models/projectOnline.types'
import type { MappingConfiguration, OptionSetMapping } from '../../models/mapping.types'
import type { ImportError } from '../../models/plannerPremium.types'
import { listRecords } from './dataverseClient'
import { chunks, cleanGuid, getRecordId, nowError, sourceGuidOrNew } from './importHelpers'
import { createOperationSet, executeOperationSet, queueScheduleCreate, queueScheduleDelete } from './scheduleApi'

const TASK_MATERIALIZATION_MAX_ATTEMPTS = 5
const TASK_MATERIALIZATION_DELAY_MS = 20000
const DEFAULT_TASK_NAME = 'No Task Name'

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
  onProgress?: (result: TaskWriteResult) => void,
): Promise<TaskWriteResult[]> {
  void mappingConfig
  void optionSetMappings
  const results: TaskWriteResult[] = []
  const tasksByProject = groupByProject(tasks)

  for (const [poProjectId, projectTasks] of tasksByProject) {
    const dvProjectId = projectIdMap[poProjectId]
    if (!dvProjectId) {
      for (const task of projectTasks) {
        const result = { poTaskId: task.TaskId, success: false, error: nowError('Task', task.TaskId, 'Project was not imported') }
        results.push(result)
        onProgress?.(result)
      }
      continue
    }

    const bucket = await findDefaultBucket(dvProjectId)
    if (!bucket) {
      for (const task of projectTasks) {
        const result = { poTaskId: task.TaskId, success: false, error: nowError('Task', task.TaskId, 'Default project bucket was not found') }
        results.push(result)
        onProgress?.(result)
      }
      continue
    }

    await clearSchedule(dvProjectId)
    const taskIdMap: Record<string, string> = {}
    const pending = projectTasks.filter(task => !isProjectSummaryTask(task)).sort(compareTasks)

    for (const chunk of chunks(pending, 180)) {
      if (chunk.length === 0) continue
      const operationSetId = await createOperationSet(dvProjectId, `Project Online task import ${new Date().toISOString()}`)
      let queued = 0
      const queuedResults: TaskWriteResult[] = []

      for (const task of chunk) {
        try {
          const taskId = sourceGuidOrNew(task.TaskId)
          taskIdMap[task.TaskId] = taskId
          await queueScheduleCreate(operationSetId, buildTaskEntity(task, taskId, dvProjectId, bucket))
          queued += 1
          queuedResults.push({ poTaskId: task.TaskId, dvTaskId: taskId, success: true })
        } catch (e) {
          const result = { poTaskId: task.TaskId, success: false, error: nowError('Task', task.TaskId, String(e)) }
          results.push(result)
          onProgress?.(result)
        }
      }

      if (queued > 0) {
        try {
          await executeOperationSet(operationSetId)
          for (const result of queuedResults) {
            results.push(result)
            onProgress?.(result)
          }
        } catch (e) {
          for (const result of queuedResults) {
            const failed = {
              poTaskId: result.poTaskId,
              success: false,
              error: nowError('Task', result.poTaskId, String(e)),
            }
            results.push(failed)
            onProgress?.(failed)
          }
        }
      }
    }

    await remapMaterializedTaskIds(dvProjectId, pending, results)
  }

  return results
}

async function remapMaterializedTaskIds(
  projectId: string,
  tasks: PoTask[],
  results: TaskWriteResult[],
): Promise<void> {
  const poTaskIds = new Set(tasks.map(task => task.TaskId))
  const projectResults = results.filter(result => result.success && result.dvTaskId && poTaskIds.has(result.poTaskId))
  if (projectResults.length === 0) return

  const rows = await waitForMaterializedTasks(projectId, projectResults.length)
  const existingIds = new Set(rows.map(row => cleanGuid(getRecordId(row, 'msdyn_projecttaskid'))).filter(Boolean))
  const usedIds = new Set<string>()

  for (const result of projectResults) {
    const currentId = cleanGuid(result.dvTaskId)
    if (currentId && existingIds.has(currentId)) {
      usedIds.add(currentId)
      continue
    }

    const task = tasks.find(t => t.TaskId === result.poTaskId)
    if (!task) continue

    const match = rows.find(row => {
      const id = cleanGuid(getRecordId(row, 'msdyn_projecttaskid'))
      return !!id &&
        !usedIds.has(id) &&
        String(row.msdyn_subject ?? '') === getTaskSubject(task) &&
        sameDate(row.msdyn_scheduledstart, task.TaskStartDate) &&
        sameDate(row.msdyn_scheduledend, task.TaskFinishDate) &&
        sameDuration(row.msdyn_duration, getTaskDuration(task))
    })

    const materializedId = cleanGuid(getRecordId(match ?? {}, 'msdyn_projecttaskid'))
    if (materializedId) {
      result.dvTaskId = materializedId
      usedIds.add(materializedId)
    }
  }
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

function getTaskDuration(task: PoTask): number | undefined {
  return task.TaskIsMilestone ? 0 : task.TaskDurationInMinutes
}

function getTaskEffort(task: PoTask): number | undefined {
  const raw = task.TaskIsMilestone ? 0 : toMinutes(task.TaskWork)
  return raw != null ? Math.round(raw * 100) / 100 : undefined
}

function getTaskProgress(task: PoTask): number | undefined {
  if (task.TaskPercentCompleted == null) return undefined
  const progress = Number(task.TaskPercentCompleted)
  return Number.isFinite(progress) ? progress / 100 : undefined
}

function toMinutes(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined

  const text = String(value).trim()
  const iso = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(text)
  if (iso) {
    const hours = Number(iso[1] ?? 0)
    const minutes = Number(iso[2] ?? 0)
    const seconds = Number(iso[3] ?? 0)
    return Math.round(hours * 60 + minutes + seconds / 60)
  }

  const numeric = Number(text)
  return Number.isFinite(numeric) ? numeric : undefined
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
  await deleteSchedulingRows(projectId, 'msdyn_resourceassignment', assignments, 'msdyn_resourceassignmentid')

  const dependencies = await listRecords(
    'msdyn_projecttaskdependencies',
    'msdyn_projecttaskdependencyid,_msdyn_project_value',
    `_msdyn_project_value eq ${projectId}`,
    5000,
  )
  await deleteSchedulingRows(projectId, 'msdyn_projecttaskdependency', dependencies, 'msdyn_projecttaskdependencyid')

  const tasks = await listRecords(
    'msdyn_projecttasks',
    'msdyn_projecttaskid,msdyn_outlinelevel,_msdyn_project_value',
    `_msdyn_project_value eq ${projectId}`,
    5000,
  )
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
) {
  return {
    '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_projecttask',
    msdyn_projecttaskid: taskId,
    'msdyn_project@odata.bind': `/msdyn_projects(${projectId})`,
    'msdyn_projectbucket@odata.bind': `/msdyn_projectbuckets(${bucketId})`,
    msdyn_subject: getTaskSubject(task),
    msdyn_scheduledstart: task.TaskStartDate,
    msdyn_scheduledend: task.TaskFinishDate,
    msdyn_start: task.TaskStartDate,
    msdyn_duration: getTaskDuration(task),
    ...(getTaskEffort(task) != null ? { msdyn_effort: getTaskEffort(task) } : {}),
    ...(getTaskProgress(task) != null ? { msdyn_progress: getTaskProgress(task) } : {}),
    ...(task.TaskOutlineLevel != null ? { msdyn_outlinelevel: task.TaskOutlineLevel } : {})
  }
}
