import { fetchEntityAttributes, patchRecord } from './dataverseClient'

const APPLIED_TEMPLATE_FIELD = 'ppm_appliedtemplate'
let hasAppliedTemplateFieldPromise: Promise<boolean> | null = null

export type ProjectCompletionMarkerResult = 'updated' | 'fieldMissing'

export async function markProjectMigrationCompleted(projectId: string): Promise<ProjectCompletionMarkerResult> {
  if (!(await hasAppliedTemplateField())) return 'fieldMissing'

  await patchRecord('msdyn_projects', projectId, {
    [APPLIED_TEMPLATE_FIELD]: 'Migration',
  })

  return 'updated'
}

async function hasAppliedTemplateField(): Promise<boolean> {
  hasAppliedTemplateFieldPromise ??= fetchEntityAttributes('msdyn_project')
    .then(attributes => attributes.some(attribute => attribute.logicalName === APPLIED_TEMPLATE_FIELD))
    .catch(error => {
      console.warn(`[projectCompletionMarker] Could not inspect ${APPLIED_TEMPLATE_FIELD}: ${String(error).slice(0, 300)}`)
      return false
    })

  return hasAppliedTemplateFieldPromise
}
