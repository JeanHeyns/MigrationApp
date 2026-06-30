import { describe, expect, it } from 'vitest'
import { resolveMaterializedTaskIds } from './taskWriter'
import type { PoTask } from '../../models/projectOnline.types'

function task(TaskId: string, TaskName: string, TaskStartDate: string, TaskFinishDate: string): PoTask {
  return { TaskId, TaskName, TaskStartDate, TaskFinishDate } as unknown as PoTask
}

function row(id: string, subject: string, start: string, end: string, duration?: number): Record<string, unknown> {
  return {
    msdyn_projecttaskid: id,
    msdyn_subject: subject,
    msdyn_scheduledstart: start,
    msdyn_scheduledend: end,
    ...(duration != null ? { msdyn_duration: duration } : {}),
  }
}

describe('resolveMaterializedTaskIds', () => {
  it('keeps an id PSS actually honored', () => {
    const res = resolveMaterializedTaskIds(
      [{ poTaskId: 'po1', dvTaskId: 'real-1' }],
      [row('real-1', 'A', '2024-01-01', '2024-01-05')],
      [task('po1', 'A', '2024-01-01', '2024-01-05')],
      8,
    )
    expect(res.get('po1')).toBe('real-1')
  })

  it('remaps when PSS shifted the end date (strict miss → subject+start)', () => {
    const res = resolveMaterializedTaskIds(
      [{ poTaskId: 'po1', dvTaskId: 'src-1' }], // source GUID PSS did not honor
      [row('real-1', 'A', '2024-01-01', '2024-09-09')], // end shifted by the engine
      [task('po1', 'A', '2024-01-01', '2024-01-05')],
      8,
    )
    expect(res.get('po1')).toBe('real-1')
  })

  it('remaps on subject alone when all dates shifted', () => {
    const res = resolveMaterializedTaskIds(
      [{ poTaskId: 'po1', dvTaskId: 'src-1' }],
      [row('real-1', 'A', '2030-01-01', '2030-02-02')],
      [task('po1', 'A', '2024-01-01', '2024-01-05')],
      8,
    )
    expect(res.get('po1')).toBe('real-1')
  })

  it('maps duplicate-named tasks to distinct rows by start date', () => {
    const res = resolveMaterializedTaskIds(
      [{ poTaskId: 'po1', dvTaskId: 'src-1' }, { poTaskId: 'po2', dvTaskId: 'src-2' }],
      [
        row('real-A', 'Spec', '2024-01-01', '2024-02-02'),
        row('real-B', 'Spec', '2024-03-03', '2024-04-04'),
      ],
      [task('po1', 'Spec', '2024-01-01', '2024-01-09'), task('po2', 'Spec', '2024-03-03', '2024-03-09')],
      8,
    )
    expect(res.get('po1')).toBe('real-A')
    expect(res.get('po2')).toBe('real-B')
  })

  it('returns null (drop) when no row matches and the row set is complete', () => {
    const res = resolveMaterializedTaskIds(
      [{ poTaskId: 'po1', dvTaskId: 'src-1' }],
      [row('real-X', 'Different', '2024-01-01', '2024-01-05')],
      [task('po1', 'A', '2024-01-01', '2024-01-05')],
      8,
    )
    expect(res.get('po1')).toBeNull()
  })

  it('keeps the current id (no drop) when the row set is incomplete', () => {
    const res = resolveMaterializedTaskIds(
      [{ poTaskId: 'po1', dvTaskId: 'src-1' }, { poTaskId: 'po2', dvTaskId: 'src-2' }],
      [row('real-X', 'Z', '2024-01-01', '2024-01-05')], // 1 row < 2 results → incomplete
      [task('po1', 'A', '2024-01-01', '2024-01-05'), task('po2', 'B', '2024-02-01', '2024-02-05')],
      8,
    )
    expect(res.get('po1')).toBe('src-1')
    expect(res.get('po2')).toBe('src-2')
  })
})
