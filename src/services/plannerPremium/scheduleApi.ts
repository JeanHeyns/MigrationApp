import { listRecords, performUnboundAction } from './dataverseClient'
import { classifyDataverseError, extractFailedBatchIndex } from './errorClassifier'
import { cleanGuid } from './importHelpers'

export async function createOperationSet(projectId: string, description: string): Promise<string> {
  const response = await performUnboundAction('msdyn_CreateOperationSetV1', {
    ProjectId: projectId,
    Description: description,
  })
  const operationSetId = cleanGuid((response.OperationSetId ?? response.operationSetId) as string | undefined)
  if (!operationSetId) throw new Error('CreateOperationSetV1 did not return an OperationSetId')
  return operationSetId
}

export async function executeOperationSet(operationSetId: string): Promise<void> {
  await performUnboundAction('msdyn_ExecuteOperationSetV1', { OperationSetId: operationSetId })
}

/** Failed operation sets stay open on the project unless abandoned; orphaned sets can break later PSS calls. */
export async function abandonOperationSet(operationSetId: string): Promise<void> {
  try {
    await performUnboundAction('msdyn_AbandonOperationSetV1', { OperationSetId: operationSetId })
  } catch {
    // best-effort cleanup
  }
}

export async function queueScheduleCreate(
  operationSetId: string,
  entity: Record<string, unknown>,
): Promise<void> {
  await performUnboundAction('msdyn_PssCreateV1', {
    Entity: entity,
    OperationSetId: operationSetId,
  })
}

export async function queueScheduleDelete(
  operationSetId: string,
  entityLogicalName: string,
  recordId: string,
): Promise<void> {
  await performUnboundAction('msdyn_PssDeleteV1', {
    RecordId: recordId,
    EntityLogicalName: entityLogicalName,
    OperationSetId: operationSetId,
  })
}

/**
 * Queues an update of a scheduling entity inside an OperationSet (msdyn_PssUpdateV1).
 * `entity` must carry its '@odata.type' and primary-key id alongside the changed fields.
 */
export async function queueScheduleUpdate(
  operationSetId: string,
  entity: Record<string, unknown>,
): Promise<void> {
  await performUnboundAction('msdyn_PssUpdateV1', {
    Entity: entity,
    OperationSetId: operationSetId,
  })
}

/**
 * Queues an update of a resource assignment's planned-work contour.
 * This is intentionally separate from PssUpdateV1: Project Schedule API rejects
 * `msdyn_plannedwork` on normal resource-assignment create/update calls.
 */
export async function queueResourceAssignmentContourUpdate(
  operationSetId: string,
  resourceAssignmentId: string,
  updatedContours: string,
): Promise<void> {
  const payload = {
    ResourceAssignmentId: resourceAssignmentId,
    UpdatedContours: updatedContours,
    OperationSetId: operationSetId,
  }
  try {
    await performUnboundAction('msdyn_PssUpdateResourceAssignmentContourV1', payload)
  } catch (e) {
    if (!isMissingResourceAssignmentContourAction(e)) {
      throw e
    }
    await performUnboundAction('msdyn_PssUpdateResourceAssignmentV1', payload)
  }
}

export function isMissingResourceAssignmentContourAction(raw: unknown): boolean {
  const message = String(raw).toLowerCase()
  return (
    message.includes('resource not found for the segment') &&
    (
      message.includes('msdyn_pssupdateresourceassignmentcontourv1') ||
      message.includes('msdyn_pssupdateresourceassignmentv1')
    )
  )
}

export interface PssCreateOperation {
  id: string
  entity: Record<string, unknown>
}

export interface BatchExecuteResult {
  succeeded: PssCreateOperation[]
  failed: Array<{ op: PssCreateOperation; reason: string; errorClass: string }>
}

export async function executeOperationSetWithRetry(
  projectId: string,
  operations: PssCreateOperation[],
  description: string,
): Promise<BatchExecuteResult> {
  const succeeded: BatchExecuteResult['succeeded'] = []
  const failed: BatchExecuteResult['failed'] = []
  let working = [...operations]
  // Worst-case: each op fails individually; cap to avoid infinite loops
  const maxAttempts = working.length + 1
  // Systemic failures (e.g. PSS "Object reference not set") hit every op with the
  // same error; per-op retry would degrade into O(n²) PSS calls. Bail instead.
  const MAX_IDENTICAL_FAILURES = 3
  let lastErrorText = ''
  let identicalFailures = 0

  for (let attempt = 0; attempt < maxAttempts && working.length > 0; attempt++) {
    let opSetId: string | undefined
    try {
      opSetId = await createOperationSet(projectId, description)
      for (const op of working) {
        await queueScheduleCreate(opSetId, op.entity)
      }
      await executeOperationSet(opSetId)
      succeeded.push(...working)
      working = []
    } catch (e) {
      const operationSetFailure = opSetId ? await fetchOperationSetFailureDetails(opSetId) : null
      if (opSetId) await abandonOperationSet(opSetId)
      const rawErrorText = appendOperationSetFailure(String(e), operationSetFailure?.log)
      const idx = extractFailedBatchIndex(rawErrorText)
      const cls = classifyDataverseError(rawErrorText)
      // Compare shape, not literal text: indices/GUIDs/timestamps differ per attempt
      const errorText = errorSignature(rawErrorText)
      console.warn(`[scheduleApi] OperationSet attempt ${attempt + 1} failed (${working.length} ops remaining, class=${cls}, failedIndex=${idx ?? 'n/a'}): ${rawErrorText.slice(0, 500)}`)

      if (errorText === lastErrorText) {
        identicalFailures++
      } else {
        lastErrorText = errorText
        identicalFailures = 1
      }
      if (idx !== null && idx >= 0 && idx < working.length) {
        // Pinpointed failure — exclude this element and retry the rest
        const failedOp = working[idx]
        failed.push({ op: failedOp, reason: rawErrorText, errorClass: cls })
        working = working.filter((_, i) => i !== idx)
        continue
      }

      // AlreadyExists is a legitimate per-op condition (re-runs), not systemic — keep pinpoint-retrying those.
      if (cls !== 'AlreadyExists' && identicalFailures >= MAX_IDENTICAL_FAILURES) {
        console.warn(`[scheduleApi] Same error ${MAX_IDENTICAL_FAILURES}× in a row — treating as systemic, failing ${working.length} remaining op(s)`)
        for (const op of working) {
          failed.push({ op, reason: rawErrorText, errorClass: cls })
        }
        working = []
        break
      }

      // Cannot pinpoint — fail all remaining
      for (const op of working) {
        failed.push({ op, reason: rawErrorText, errorClass: cls })
      }
      working = []
    }
  }

  // Any remaining in working after max attempts — fail them
  for (const op of working) {
    failed.push({ op, reason: 'Max retry attempts reached', errorClass: 'Other' })
  }

  return { succeeded, failed }
}

/** Collapses GUIDs and numbers so per-attempt noise (batch index, ids, timestamps) doesn't defeat repeat detection. */
function errorSignature(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<guid>')
    .replace(/\d+/g, '<n>')
    .slice(0, 400)
}

interface OperationSetFailureDetails {
  log: string
}

async function fetchOperationSetFailureDetails(operationSetId: string): Promise<OperationSetFailureDetails | null> {
  try {
    const operationSets = await listRecords(
      'msdyn_operationsets',
      '_msdyn_psserrorlog_value,msdyn_correlationid,msdyn_status',
      `msdyn_operationsetid eq ${cleanGuid(operationSetId)}`,
      1,
    )
    const errorLogId = stringValue(operationSets[0]?.['_msdyn_psserrorlog_value'])
    if (!errorLogId) return null

    const errorLogs = await listRecords(
      'msdyn_psserrorlogs',
      'msdyn_errorcode,msdyn_log,msdyn_callstack,msdyn_correlationid',
      `msdyn_psserrorlogid eq ${cleanGuid(errorLogId)}`,
      1,
    )
    const log = stringValue(errorLogs[0]?.['msdyn_log'])
    return log ? { log } : null
  } catch (error) {
    console.warn(`[scheduleApi] Could not read PSS error log for OperationSet ${operationSetId}: ${String(error)}`)
    return null
  }
}

function appendOperationSetFailure(rawError: string, pssLog: string | undefined): string {
  return pssLog ? `${rawError}\nPSS error log: ${pssLog}` : rawError
}

function stringValue(value: unknown): string {
  return value == null ? '' : String(value).replace(/[{}]/g, '').trim()
}
