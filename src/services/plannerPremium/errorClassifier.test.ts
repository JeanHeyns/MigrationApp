import { describe, expect, it } from 'vitest'
import { extractFailedBatchIndex } from './errorClassifier'

describe('extractFailedBatchIndex', () => {
  it('extracts the failed batch index from escaped Dataverse/PSS error JSON', () => {
    const error = new Error(
      'OperationSet failed: {\\"errorId\\":-1945829329,\\"errorKey\\":\\"E_BATCHFAILED\\",\\"failedBatchRequestIndex\\":42,\\"failedBatchRequestError\\":{\\"errorKey\\":\\"E_INVALID_LINK\\"}}',
    )

    expect(extractFailedBatchIndex(error)).toBe(42)
  })
})
