import { performUnboundAction } from './dataverseClient'
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

  for (let attempt = 0; attempt < maxAttempts && working.length > 0; attempt++) {
    try {
      const opSetId = await createOperationSet(projectId, description)
      for (const op of working) {
        await queueScheduleCreate(opSetId, op.entity)
      }
      await executeOperationSet(opSetId)
      succeeded.push(...working)
      working = []
    } catch (e) {
      const idx = extractFailedBatchIndex(e)
      const cls = classifyDataverseError(e)

      if (idx !== null && idx >= 0 && idx < working.length) {
        // Pinpointed failure — exclude this element and retry the rest
        const failedOp = working[idx]
        failed.push({ op: failedOp, reason: String(e), errorClass: cls })
        working = working.filter((_, i) => i !== idx)
        continue
      }

      // Cannot pinpoint — fail all remaining
      for (const op of working) {
        failed.push({ op, reason: String(e), errorClass: cls })
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
