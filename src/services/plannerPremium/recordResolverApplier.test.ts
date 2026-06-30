import { describe, expect, it } from 'vitest'
import { applyResolvers } from './recordResolverApplier'
import type { FieldMapping } from '../../models/mapping.types'
import type { FieldResolver } from './resolverFactory'

function dateMapping(overrides: Partial<FieldMapping> = {}): FieldMapping {
  return {
    customField: {
      CustomFieldId: 'cf1',
      CustomFieldName: 'Go Live',
      CustomFieldEntityType: 'Project',
      CustomFieldType: 'DATE',
      CustomFieldTypeValue: 0,
      ODataFieldName: 'GoLive',
    },
    targetColumnType: 'Date',
    targetLogicalName: 'new_golive',
    skip: false,
    migrateValue: true,
    useExistingField: false,
    ...overrides,
  } as unknown as FieldMapping
}

describe('applyResolvers — Date column coercion', () => {
  it('truncates a datetime literal to date-only on the pass-through path (full mode)', () => {
    const result = applyResolvers({ GoLive: '2025-09-25T17:00:00' }, [dateMapping()], new Map())
    expect(result.payload.new_golive).toBe('2025-09-25')
  })

  it('truncates a datetime via a direct resolver (dataOnly mode)', () => {
    const resolver = { fieldType: 'DateTime', resolve: (v: unknown) => ({ status: 'resolved' as const, value: v }) }
    const result = applyResolvers(
      { GoLive: '2025-09-25T17:00:00' },
      [dateMapping()],
      new Map([['GoLive', resolver as unknown as FieldResolver]]),
    )
    expect(result.payload.new_golive).toBe('2025-09-25')
  })

  it('leaves an already date-only value unchanged', () => {
    const result = applyResolvers({ GoLive: '2025-09-25' }, [dateMapping()], new Map())
    expect(result.payload.new_golive).toBe('2025-09-25')
  })

  it('does not truncate DateTime columns', () => {
    const result = applyResolvers(
      { GoLive: '2025-09-25T17:00:00' },
      [dateMapping({ targetColumnType: 'DateTime' })],
      new Map(),
    )
    expect(result.payload.new_golive).toBe('2025-09-25T17:00:00')
  })
})
