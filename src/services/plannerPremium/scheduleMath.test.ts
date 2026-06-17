import { describe, it, expect } from 'vitest'
import {
  MON_FRI_MASK,
  calendarWorkingDaysInclusive,
  isWorkingDay,
  listWorkingDays,
  taskDurationDays,
  type ProjectCalendar,
} from './scheduleMath'

// 2026-07-06 is a Monday; the work week 07-06..07-10 is Mon–Fri.
const cal = (holidays: string[] = []): ProjectCalendar => ({
  workingDayMask: MON_FRI_MASK,
  holidays: new Set(holidays),
  hoursPerDay: 7.6,
})

describe('calendarWorkingDaysInclusive', () => {
  it('counts a single working day as 1', () => {
    expect(calendarWorkingDaysInclusive('2026-07-06', '2026-07-06', cal())).toBe(1)
  })

  it('counts a full Mon–Fri week as 5', () => {
    expect(calendarWorkingDaysInclusive('2026-07-06', '2026-07-10', cal())).toBe(5)
  })

  it('excludes the weekend', () => {
    // Sat 07-11 .. Sun 07-12
    expect(calendarWorkingDaysInclusive('2026-07-11', '2026-07-12', cal())).toBe(0)
  })

  it('drops a holiday inside the range', () => {
    // Wed 07-08 is a holiday → 4 of the 5 weekdays
    expect(calendarWorkingDaysInclusive('2026-07-06', '2026-07-10', cal(['2026-07-08']))).toBe(4)
  })

  it('drops a holiday landing on the start date', () => {
    expect(calendarWorkingDaysInclusive('2026-07-06', '2026-07-10', cal(['2026-07-06']))).toBe(4)
  })

  it('drops a holiday landing on the finish date', () => {
    expect(calendarWorkingDaysInclusive('2026-07-06', '2026-07-10', cal(['2026-07-10']))).toBe(4)
  })

  it('returns 0 when finish precedes start', () => {
    expect(calendarWorkingDaysInclusive('2026-07-10', '2026-07-06', cal())).toBe(0)
  })

  it('returns 0 for invalid input', () => {
    expect(calendarWorkingDaysInclusive('', '2026-07-06', cal())).toBe(0)
  })
})

describe('isWorkingDay', () => {
  it('is false on Saturday and Sunday', () => {
    expect(isWorkingDay(new Date(2026, 6, 11), cal())).toBe(false) // Sat
    expect(isWorkingDay(new Date(2026, 6, 12), cal())).toBe(false) // Sun
  })
  it('is true on a weekday', () => {
    expect(isWorkingDay(new Date(2026, 6, 6), cal())).toBe(true) // Mon
  })
  it('is false on a holiday weekday', () => {
    expect(isWorkingDay(new Date(2026, 6, 8), cal(['2026-07-08']))).toBe(false)
  })
})

describe('listWorkingDays', () => {
  it('lists each working day, skipping weekends and holidays', () => {
    const days = listWorkingDays('2026-07-06', '2026-07-13', cal(['2026-07-08']))
    // Mon,Tue,(Wed holiday),Thu,Fri,(Sat,Sun),Mon → 5 days
    expect(days.map(d => d.getDate())).toEqual([6, 7, 9, 10, 13])
  })

  it('returns empty for an all-weekend range', () => {
    expect(listWorkingDays('2026-07-11', '2026-07-12', cal())).toEqual([])
  })
})

describe('taskDurationDays', () => {
  it('converts 2280 minutes at 7.6 h/day to 5 days', () => {
    expect(taskDurationDays(2280, 7.6)).toBe(5)
  })
  it('converts 2400 minutes at 8 h/day to 5 days', () => {
    expect(taskDurationDays(2400, 8)).toBe(5)
  })
  it('returns undefined for null minutes', () => {
    expect(taskDurationDays(null, 7.6)).toBeUndefined()
    expect(taskDurationDays(undefined, 7.6)).toBeUndefined()
  })
  it('falls back to the default hours-per-day for a non-positive value', () => {
    expect(taskDurationDays(2280, 0)).toBe(5) // 2280/60/7.6
  })
  it('rounds to two decimals', () => {
    // 3 hours at 7.6 h/day = 0.3947… → 0.39
    expect(taskDurationDays(180, 7.6)).toBe(0.39)
  })
})
