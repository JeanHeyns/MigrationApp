import { describe, expect, it } from 'vitest'
import { applyFilter } from './projectFilter'
import type { PoProject, PoTask } from '../models/projectOnline.types'
import type { ProjectFilter } from '../app/MigrationContext'

function project(overrides: Partial<PoProject>): PoProject {
  return {
    ProjectId: 'p1',
    ProjectName: 'Project',
    ...overrides,
  } as PoProject
}

function filter(overrides: Partial<ProjectFilter>): ProjectFilter {
  return {
    searchTerm: '',
    startDateFrom: null,
    startDateTo: null,
    finishDateFrom: null,
    finishDateTo: null,
    ownerNames: [],
    taskCountMin: null,
    taskCountMax: null,
    ...overrides,
  }
}

const noTasks = new Map<string, PoTask[]>()

describe('applyFilter date ranges', () => {
  it('includes a project starting on the to-date even when the source date carries a time part', () => {
    const projects = [project({ ProjectStartDate: '2024-05-01T08:00:00' })]
    expect(applyFilter(projects, filter({ startDateTo: '2024-05-01' }), noTasks)).toHaveLength(1)
  })

  it('includes a project finishing on the to-date even when the source date carries a time part', () => {
    const projects = [project({ ProjectFinishDate: '2024-12-31T17:00:00' })]
    expect(applyFilter(projects, filter({ finishDateTo: '2024-12-31' }), noTasks)).toHaveLength(1)
  })

  it('includes a project starting on the from-date', () => {
    const projects = [project({ ProjectStartDate: '2024-05-01T08:00:00' })]
    expect(applyFilter(projects, filter({ startDateFrom: '2024-05-01' }), noTasks)).toHaveLength(1)
  })

  it('excludes a project starting after the to-date', () => {
    const projects = [project({ ProjectStartDate: '2024-05-02T00:00:00' })]
    expect(applyFilter(projects, filter({ startDateTo: '2024-05-01' }), noTasks)).toHaveLength(0)
  })

  it('excludes a project starting before the from-date', () => {
    const projects = [project({ ProjectStartDate: '2024-04-30T23:00:00' })]
    expect(applyFilter(projects, filter({ startDateFrom: '2024-05-01' }), noTasks)).toHaveLength(0)
  })

  it('keeps projects without a start date when filtering on start date (current behavior)', () => {
    const projects = [project({ ProjectStartDate: undefined })]
    expect(applyFilter(projects, filter({ startDateFrom: '2024-05-01' }), noTasks)).toHaveLength(1)
  })
})

describe('applyFilter task count', () => {
  it('treats projects without fetched tasks as 0 tasks', () => {
    const projects = [project({ ProjectId: 'p1' })]
    expect(applyFilter(projects, filter({ taskCountMin: 1 }), noTasks)).toHaveLength(0)
    expect(applyFilter(projects, filter({ taskCountMax: 0 }), noTasks)).toHaveLength(1)
  })
})
