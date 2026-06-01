import type { ProjectDefaults, ProjectOverride } from '../types/projectDefaults'

export function effectiveSettings(
  projectId: string,
  defaults: ProjectDefaults,
  overrides: Map<string, ProjectOverride>,
): ProjectDefaults {
  const override = overrides.get(projectId)
  if (!override) return defaults
  return {
    workHourTemplateId: override.workHourTemplateId ?? defaults.workHourTemplateId,
    workHourTemplateName: override.workHourTemplateName ?? defaults.workHourTemplateName,
    scheduleMode: override.scheduleMode ?? defaults.scheduleMode,
    hoursPerDay: override.hoursPerDay ?? defaults.hoursPerDay,
    hoursPerWeek: override.hoursPerWeek ?? defaults.hoursPerWeek,
    daysPerMonth: override.daysPerMonth ?? defaults.daysPerMonth,
  }
}
