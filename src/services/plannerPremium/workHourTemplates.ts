import { listRecords } from '../dataverseService'
import type { WorkHourTemplate } from '../../types/projectDefaults'

export async function listWorkHourTemplates(): Promise<WorkHourTemplate[]> {
  const records = await listRecords(
    'msdyn_workhourtemplates',
    'msdyn_workhourtemplateid,msdyn_name',
    'statecode eq 0',
    1000,
  )
  return records
    .map(r => ({
      id: String(r['msdyn_workhourtemplateid'] ?? ''),
      name: String(r['msdyn_name'] ?? '(unnamed)'),
      isDefault: String(r['msdyn_name'] ?? '').trim().toLowerCase() === 'standard',
    }))
    .filter(t => t.id)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function findTemplateByName(
  templates: WorkHourTemplate[],
  name: string,
): WorkHourTemplate | undefined {
  const target = name.trim().toLowerCase()
  return templates.find(t => t.name.trim().toLowerCase() === target)
}

export function pickInitialTemplate(templates: WorkHourTemplate[]): WorkHourTemplate | null {
  if (templates.length === 0) return null
  return templates.find(t => t.isDefault) ?? templates[0]
}
