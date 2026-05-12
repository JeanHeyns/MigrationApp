export interface DvProject {
  msdyn_projectid?: string
  msdyn_subject: string
  msdyn_description?: string
  msdyn_scheduledstart?: string
  msdyn_scheduledend?: string
  [key: string]: unknown
}

export interface DvTask {
  msdyn_projecttaskid?: string
  msdyn_subject: string
  msdyn_scheduledstart?: string
  msdyn_scheduledend?: string
  msdyn_duration?: number
  msdyn_effort?: number
  msdyn_progress?: number
  msdyn_outlinelevel?: number
  msdyn_ismilestone?: boolean
  [key: string]: unknown
}

export interface DvBookableResource {
  bookableresourceid?: string
  name: string
  resourcetype: number
}

export interface DvSystemUser {
  systemuserid: string
  fullname: string
  internalemailaddress?: string
  domainname?: string
}

export interface DvSolution {
  solutionid: string
  uniquename: string
  friendlyname: string
  publisherId: string
  publisherPrefix: string
}

export interface DvProjectTeamMember {
  msdyn_projectteammemberid?: string
  msdyn_name?: string
  'msdyn_project@odata.bind'?: string
  'msdyn_bookableresourceid@odata.bind'?: string
}

export interface DvResourceAssignment {
  msdyn_resourceassignmentid?: string
  msdyn_name?: string
  'msdyn_projectid@odata.bind'?: string
  'msdyn_taskid@odata.bind'?: string
  'msdyn_projectteammemberid@odata.bind'?: string
}

export interface ImportResult {
  entity: string
  total: number
  succeeded: number
  failed: number
  errors: ImportError[]
}

export interface ImportError {
  entity: string
  sourceId: string
  message: string
  timestamp: string
}

export interface LogEntry {
  timestamp: string
  level: 'info' | 'success' | 'error' | 'warning'
  message: string
}
