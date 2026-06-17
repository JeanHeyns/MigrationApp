import { describe, it, expect } from 'vitest'
import { buildAssignmentContour } from './assignmentContour'
import { MON_FRI_MASK, type ProjectCalendar } from './scheduleMath'
import type { PoAssignment, PoTask } from '../../models/projectOnline.types'

const cal = (holidays: string[] = []): ProjectCalendar => ({
  workingDayMask: MON_FRI_MASK,
  holidays: new Set(holidays),
  hoursPerDay: 7.6,
})

// Mon 2026-07-06 .. Fri 2026-07-10
const task = (over: Partial<PoTask> = {}): PoTask => ({
  TaskId: 'T1',
  ProjectId: 'P1',
  TaskName: 'Task',
  TaskStartDate: '2026-07-06',
  TaskFinishDate: '2026-07-10',
  ...over,
})

const assignment = (units?: number): PoAssignment => ({
  ProjectId: 'P1',
  TaskId: 'T1',
  ResourceUID: 'R1',
  AssignmentUnits: units,
})

describe('buildAssignmentContour', () => {
  it('produces one slice per working day at full units by default', () => {
    const { slices } = buildAssignmentContour(task(), assignment(undefined), cal())
    expect(slices).toHaveLength(5)
    expect(slices.every(s => s.Hours === 7.6)).toBe(true)
  })

  it('scales hours by units (50% → 3.8 per slice)', () => {
    const { slices } = buildAssignmentContour(task(), assignment(50), cal())
    expect(slices).toHaveLength(5)
    expect(slices.every(s => s.Hours === 3.8)).toBe(true)
  })

  it('skips holidays — slice count equals working days', () => {
    const { slices } = buildAssignmentContour(task(), assignment(100), cal(['2026-07-08']))
    expect(slices).toHaveLength(4)
  })

  it('caps units above 100 and warns', () => {
    const { slices, warning } = buildAssignmentContour(task(), assignment(120), cal())
    expect(slices.every(s => s.Hours === 7.6)).toBe(true)
    expect(warning).toMatch(/capped to 100/)
  })

  it('returns no slices and a warning for non-positive units', () => {
    const { slices, warning } = buildAssignmentContour(task(), assignment(0), cal())
    expect(slices).toHaveLength(0)
    expect(warning).toMatch(/≤ 0/)
  })

  it('returns no slices for a milestone', () => {
    const { slices } = buildAssignmentContour(task({ TaskIsMilestone: true }), assignment(100), cal())
    expect(slices).toHaveLength(0)
  })

  it('returns a warning when the task has no start date', () => {
    const { slices, warning } = buildAssignmentContour(task({ TaskStartDate: undefined }), assignment(100), cal())
    expect(slices).toHaveLength(0)
    expect(warning).toMatch(/no start date/)
  })

  it('emits a single slice for a one-day task', () => {
    const { slices } = buildAssignmentContour(
      task({ TaskStartDate: '2026-07-06', TaskFinishDate: '2026-07-06' }),
      assignment(100),
      cal(),
    )
    expect(slices).toHaveLength(1)
  })

  it('serializes Start/End as /Date(ms)/ strings', () => {
    const { slices } = buildAssignmentContour(task(), assignment(100), cal())
    expect(slices[0].Start).toMatch(/^\/Date\(\d+\)\/$/)
    expect(slices[0].End).toMatch(/^\/Date\(\d+\)\/$/)
  })
})
