/**
 * Shapes for the post-import schedule diagnostic export — a side-by-side of
 * source (PO/Excel, from MigrationState) vs target (read back fresh from
 * Dataverse) so drift can be diagnosed from real stored values, not logs.
 */

export interface ProjectSettingsLite {
  hoursPerDay: number
  scheduleMode: number | null
  scheduleModeLabel: string | null
}

/** Source-side inputs the builder needs; target side is fetched from Dataverse. */
export interface DiagnosticInput {
  dataSource: string
  migrationMode: string
  tenantUrl: string
  /** PO project ids selected for this run; empty = all projects in fetchedData. */
  selectedProjectIds: Set<string>
  projects: import('../../models/projectOnline.types').PoProject[]
  tasks: import('../../models/projectOnline.types').PoTask[]
  dependencies: import('../../models/projectOnline.types').PoTaskDependency[]
  assignments: import('../../models/projectOnline.types').PoAssignment[]
  resources: import('../../models/projectOnline.types').PoResource[]
  /** Effective working-time per PO project id. */
  settingsByProject: Map<string, ProjectSettingsLite>
  /** Schedule-mode option value → label, for labelling the target mode. */
  scheduleModeLabels: Map<number, string>
}

export interface ScheduleDiagnosticReport {
  meta: {
    exportedAt: string
    migratorVersion: string
    tenantUrl: string
    dataSource: string
    migrationMode: string
    projectCount: number
    privacyNote: string
    truncatedToCap?: number
  }
  projects: ProjectDiagnostic[]
}

export interface ProjectDiagnostic {
  projectId: string
  projectName: string
  source: {
    projectId: string
    startDate: string | null
    finishDate: string | null
    workHoursPerDay: number
    scheduleMode: string | null
  }
  target: Record<string, unknown> | null
  delta: {
    startDays: number | null
    finishDays: number | null
    hoursPerDayMatch: boolean | null
    scheduleModeMatch: boolean | null
  }
  tasks: TaskDiagnostic[]
  dependencies: DependencyDiagnostic[]
  assignments: AssignmentDiagnostic[]
  resources: ResourceDiagnostic[]
  unmatchedTasks: string[]
  fetchError?: string
}

export interface DependencyDiagnostic {
  dependencyId_source: string | null
  dependencyId_target: string | null
  source: {
    predecessorTaskId: string | null
    successorTaskId: string | null
    predecessorTargetTaskId: string | null
    successorTargetTaskId: string | null
    dependencyType: string | null
    lagTenthsOfMinute: number | null
    expectedLagSeconds: number | null
  } | null
  target: (Record<string, unknown> & {
    dependencyTypeLabel: string | null
    lagSeconds: number | null
  }) | null
  match: {
    status: 'matched' | 'missingSourceTaskMapping' | 'missingTargetDependency' | 'targetOnly'
    predecessorMatches: boolean | null
    successorMatches: boolean | null
    typeMatches: boolean | null
    lagMatches: boolean | null
    note: string
  }
}

export interface TaskDiagnostic {
  taskId_source: string
  taskId_target: string | null
  subject: string
  isAssigned: boolean
  isLeaf: boolean
  source: {
    startDate: string | null
    finishDate: string | null
    durationDays: number | null
    durationMinutes_source: number | null
    work_hours?: number | null
  }
  /** Full Dataverse msdyn_projecttask row (no $select), or null when unmatched. */
  target: Record<string, unknown> | null
  delta: {
    startDays: number | null
    endDays: number | null
    durationDaysDelta: number | null
    scheduledDurationMinutesDelta: number | null
  } | null
}

export interface AssignmentDiagnostic {
  assignmentId_source: string | null
  assignmentId_target: string | null
  taskId_target: string | null
  resourceName: string | null
  source: {
    units: number | null
  }
  /** Full Dataverse msdyn_resourceassignment row (no $select) plus computed contour fields. */
  target: (Record<string, unknown> & {
    msdyn_plannedwork_sliceCount: number | null
    msdyn_plannedwork_totalHours: number | null
    note?: string
  }) | null
}

export interface ResourceDiagnostic {
  resourceName: string | null
  bookableresourceId: string
  /** Full Dataverse bookableresource row (no $select). */
  raw: Record<string, unknown> | null
  calendar: {
    calendarId: string | null
    hasCalendar: boolean
    workingHoursPerDay: number | null
    matchesProjectCalendar: boolean | null
    note: string
  }
}
