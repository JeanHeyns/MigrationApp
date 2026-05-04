import { performUnboundAction } from './dataverseClient'
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
