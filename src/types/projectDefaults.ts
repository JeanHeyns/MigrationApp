export interface WorkHourTemplate {
  id: string
  name: string
  isDefault?: boolean
}

export interface ScheduleModeOption {
  value: number
  label: string
}

export interface ProjectDefaults {
  workHourTemplateId: string | null
  workHourTemplateName: string | null
  scheduleMode: number | null
  hoursPerDay: number
  hoursPerWeek: number
  daysPerMonth: number
}

export interface ProjectOverride {
  projectId: string
  workHourTemplateId?: string | null
  workHourTemplateName?: string | null
  scheduleMode?: number | null
  hoursPerDay?: number
  hoursPerWeek?: number
  daysPerMonth?: number
}

export const DEFAULT_PROJECT_DEFAULTS: ProjectDefaults = {
  workHourTemplateId: null,
  workHourTemplateName: null,
  scheduleMode: null,
  hoursPerDay: 8,
  hoursPerWeek: 40,
  daysPerMonth: 20,
}
