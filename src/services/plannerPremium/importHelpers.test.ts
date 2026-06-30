import { describe, expect, it } from 'vitest'
import { toDateOnly } from './importHelpers'

describe('toDateOnly', () => {
  it('truncates an ISO datetime literal to date-only', () => {
    expect(toDateOnly('2025-09-25T17:00:00')).toBe('2025-09-25')
  })

  it('truncates a datetime with timezone offset/Z', () => {
    expect(toDateOnly('2025-09-25T17:00:00Z')).toBe('2025-09-25')
    expect(toDateOnly('2025-09-25T17:00:00+02:00')).toBe('2025-09-25')
  })

  it('truncates a space-separated datetime', () => {
    expect(toDateOnly('2025-09-25 17:00:00')).toBe('2025-09-25')
  })

  it('passes through an already date-only value', () => {
    expect(toDateOnly('2025-09-25')).toBe('2025-09-25')
  })

  it('passes through non-string values unchanged', () => {
    expect(toDateOnly(42)).toBe(42)
    expect(toDateOnly(null)).toBe(null)
    expect(toDateOnly(undefined)).toBe(undefined)
  })

  it('passes through unrecognized strings unchanged', () => {
    expect(toDateOnly('not a date')).toBe('not a date')
  })
})
