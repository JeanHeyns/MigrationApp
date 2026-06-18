import { describe, it, expect } from 'vitest'
import { deltaDays, matchTargetTask, parsePlannedWork } from './scheduleDiagnostic'
import type { PoTask } from '../../models/projectOnline.types'

describe('deltaDays', () => {
  it('returns whole-day target − source difference, ignoring time component', () => {
    expect(deltaDays('2025-01-15', '2025-01-18T16:00:00Z')).toBe(3)
  })
  it('returns negative when target is earlier', () => {
    expect(deltaDays('2024-07-23', '2024-07-16T08:00:00')).toBe(-7)
  })
  it('returns 0 for the same date', () => {
    expect(deltaDays('2025-01-15T08:00:00', '2025-01-15T16:30:00')).toBe(0)
  })
  it('returns null when either side is missing', () => {
    expect(deltaDays(null, '2025-01-15')).toBeNull()
    expect(deltaDays('2025-01-15', undefined)).toBeNull()
  })
})

describe('matchTargetTask', () => {
  const task = (over: Partial<PoTask> = {}): PoTask => ({
    TaskId: 'AABBCCDD-1111-2222-3333-444455556666',
    ProjectId: 'P1',
    TaskName: 'Design',
    TaskStartDate: '2025-01-15',
    ...over,
  })

  it('matches by id (DV id == cleaned, lowercased PO guid)', () => {
    const targets = [
      { msdyn_projecttaskid: 'aabbccdd-1111-2222-3333-444455556666', msdyn_subject: 'Wrong subject' },
      { msdyn_projecttaskid: 'ffffffff-0000-0000-0000-000000000000', msdyn_subject: 'Design' },
    ]
    expect(matchTargetTask(task(), targets)?.msdyn_subject).toBe('Wrong subject')
  })

  it('falls back to subject + start date when id does not match', () => {
    const targets = [
      { msdyn_projecttaskid: 'no-match', msdyn_subject: 'Design', msdyn_scheduledstart: '2025-01-15T08:00:00' },
    ]
    expect(matchTargetTask(task(), targets)?.msdyn_subject).toBe('Design')
  })

  it('does not match a different subject', () => {
    const targets = [{ msdyn_projecttaskid: 'x', msdyn_subject: 'Other', msdyn_scheduledstart: '2025-01-15' }]
    expect(matchTargetTask(task(), targets)).toBeNull()
  })

  it('returns null when nothing matches', () => {
    expect(matchTargetTask(task(), [])).toBeNull()
  })
})

describe('parsePlannedWork', () => {
  it('sums Hours-shape slices', () => {
    const raw = JSON.stringify([{ Hours: 7.6 }, { Hours: 7.6 }, { Hours: 3.8 }])
    expect(parsePlannedWork(raw)).toEqual({ sliceCount: 3, totalHours: 19 })
  })
  it('sums minutes-shape slices', () => {
    const raw = JSON.stringify([{ minutes: 456 }, { minutes: 456 }])
    expect(parsePlannedWork(raw)).toEqual({ sliceCount: 2, totalHours: 15.2 })
  })
  it('returns nulls for empty/missing', () => {
    expect(parsePlannedWork(null)).toEqual({ sliceCount: null, totalHours: null })
    expect(parsePlannedWork('')).toEqual({ sliceCount: null, totalHours: null })
  })
  it('returns nulls for non-JSON', () => {
    expect(parsePlannedWork('not json')).toEqual({ sliceCount: null, totalHours: null })
  })
})
