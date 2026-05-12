export type PoCustomFieldType =
  | 'Text'
  | 'Memo'
  | 'Number'
  | 'Cost'
  | 'Duration'
  | 'Date'
  | 'Flag'
  | 'Boolean'
  | 'Choice'
  | 'MultiChoice'
  | 'Lookup'
  | 'LookupMulti'

export interface PoProject {
  ProjectId: string
  ProjectName: string
  ProjectDescription?: string
  ProjectStartDate?: string
  ProjectFinishDate?: string
  ProjectStatus?: string
  ProjectType?: number
  ProjectIsAdministrative?: boolean
  ProjectOwnerName?: string
  ProjectOwnerResourceId?: string   // _api/ProjectData/Projects field name
  ProjectOwnerResourceUid?: string  // fallback alias some tenants return
  [key: string]: unknown
}

export interface PoTask {
  TaskId: string
  ProjectId: string
  TaskName: string
  TaskStartDate?: string
  TaskFinishDate?: string
  TaskDurationInMinutes?: number
  TaskWork?: number | string
  TaskPercentCompleted?: number
  TaskOutlineLevel?: number
  TaskOutlineNumber?: string
  TaskParentId?: string
  TaskIsMilestone?: boolean
  TaskIsSummary?: boolean
  TaskPriority?: number
  [key: string]: unknown
}

export interface PoResource {
  ResourceUID?: string
  ResourceId?: string
  ResourceName: string
  ResourceEmailAddress?: string
  ResourceNTAccount?: string
  ResourceType?: number
  ResourceIsTeam?: boolean
}

export interface PoAssignment {
  AssignmentId?: string
  ProjectId: string
  TaskId: string
  ResourceUID: string
  ResourceId?: string
  AssignmentStartDate?: string
  AssignmentFinishDate?: string
  AssignmentUnits?: number
  [key: string]: unknown
}

export type PoDependencyType = 'FF' | 'FS' | 'SF' | 'SS'

export interface PoTaskDependency {
  DependencyId: string
  ProjectId: string
  PredecessorTaskId: string
  SuccessorTaskId: string
  DependencyType?: PoDependencyType
  Lag?: number
  [key: string]: unknown
}

export interface PoProjectTeamMember {
  ProjectId: string
  ResourceUID: string
  ResourceId?: string
  ResourceName?: string
}

export interface PoCustomField {
  CustomFieldId: string
  CustomFieldName: string
  CustomFieldEntityType: 'Project' | 'Task' | 'Resource'
  CustomFieldType: PoCustomFieldType
  CustomFieldTypeValue: number
  CustomFieldLookupTableUID?: string
  LookupTableName?: string
  ODataFieldName?: string
  DataverseLogicalName?: string // file-upload only: explicit mapping to existing DV column (dataOnly mode)
}

export interface PoLookupEntry {
  LookupTableUID: string
  LookupEntryUID: string
  LookupEntryFullValue: string
  LookupEntryValue?: string
  SortIndex?: number
}

export interface PoLookupTable {
  LookupTableUID: string
  LookupTableName: string
  entries: PoLookupEntry[]
}

export interface PoFetchedData {
  pwaUrl: string
  projects: PoProject[]
  tasks: PoTask[]
  dependencies: PoTaskDependency[]
  resources: PoResource[]
  assignments: PoAssignment[]
  teamMembers: PoProjectTeamMember[]
  customFields: PoCustomField[]
  lookupTables: PoLookupTable[]
}
