import type { PoProject } from '../../models/projectOnline.types'
import type { MappingConfiguration, OptionSetMapping } from '../../models/mapping.types'
import type { ImportError } from '../../models/plannerPremium.types'
import type { FieldResolver } from './resolverFactory'
import type { SkippedField } from './recordResolverApplier'
import { listRecords, performUnboundAction, patchRecord } from './dataverseClient'
import { cleanGuid, customFieldPayload, escapeODataString, getRecordId, nowError, sourceGuidOrNew } from './importHelpers'
import { projectOnlineIdColumnName } from './columnManager'
import { applyResolvers } from './recordResolverApplier'

// Toggle in DevTools: localStorage.setItem('DEBUG_DATAONLY_WRITER', '1')
const isDebug = (): boolean => {
  try { return localStorage.getItem('DEBUG_DATAONLY_WRITER') === '1' } catch { return false }
}

export interface ProjectWriteResult {
  poProjectId: string
  dvProjectId?: string
  success: boolean
  /** Set when the project record was created but the custom-field patch failed (dataOnly mode). success stays true. */
  error?: ImportError
  skippedFields?: SkippedField[]
}

/**
 * Creates msdyn_project records using the Project schedule API.
 * Existing projects with the same subject are skipped and mapped.
 *
 * In dataOnly mode: pass `resolvers` (from buildResolverMap). Presence of resolvers
 * activates the resolver pipeline for custom fields. `optionSetMappings` is ignored in that case.
 */
export async function writeProjects(
  projects: PoProject[],
  mappingConfig: MappingConfiguration,
  optionSetMappings: OptionSetMapping[] = [],
  onProgress?: (result: ProjectWriteResult) => void,
  resolvers?: Map<string, FieldResolver>,
): Promise<ProjectWriteResult[]> {
  const results: ProjectWriteResult[] = []
  const sourceIdColumn = projectOnlineIdColumnName(mappingConfig.publisherPrefix)
  const dataOnly = mappingConfig.migrationMode === 'dataOnly' && !!resolvers

  if (dataOnly && isDebug()) {
    console.group('[dataOnly] projectWriter — resolver summary')
    console.log(`Resolvers built: ${resolvers!.size}`)
    for (const [field, resolver] of resolvers!) {
      console.log(`  ${field} → ${resolver.fieldType}`)
    }
    console.groupEnd()
  }

  let isFirstProject = true

  for (const project of projects) {
    try {
      const existing = await findExistingProject(project, sourceIdColumn)
      const existingId = cleanGuid(getRecordId(existing[0] ?? {}, 'msdyn_projectid'))

      if (existingId) {
        const { error, skippedFields } = await applyProjectPatch(
          existingId, project, mappingConfig, optionSetMappings,
          dataOnly ? resolvers : undefined,
          dataOnly && isFirstProject,
        )
        isFirstProject = false
        const result: ProjectWriteResult = {
          poProjectId: project.ProjectId,
          dvProjectId: existingId,
          success: true,
          ...(error ? { error } : {}),
          ...(skippedFields?.length ? { skippedFields } : {}),
        }
        results.push(result)
        onProgress?.(result)
        continue
      }

      const body = {
        Project: {
          '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_project',
          msdyn_projectid: sourceGuidOrNew(project.ProjectId),
          msdyn_subject: project.ProjectName,
          msdyn_description: project.ProjectDescription,
          msdyn_scheduledstart: project.ProjectStartDate,
          [sourceIdColumn]: project.ProjectId,
        },
      }

      const response = await performUnboundAction('msdyn_CreateProjectV1', body)
      const dvProjectId = cleanGuid((response.ProjectId ?? response.projectId ?? response.msdyn_projectid) as string | undefined)

      let patchError: ImportError | undefined
      let skippedFields: SkippedField[] | undefined

      if (dvProjectId) {
        const patchResult = await applyProjectPatch(
          dvProjectId, project, mappingConfig, optionSetMappings,
          dataOnly ? resolvers : undefined,
          dataOnly && isFirstProject,
        )
        patchError = patchResult.error
        skippedFields = patchResult.skippedFields
      }
      isFirstProject = false

      const result: ProjectWriteResult = {
        poProjectId: project.ProjectId,
        dvProjectId,
        success: !!dvProjectId,
        ...((!dvProjectId)
          ? { error: nowError('Project', project.ProjectId, 'CreateProjectV1 did not return a ProjectId') }
          : patchError
            ? { error: patchError }
            : {}),
        ...(skippedFields?.length ? { skippedFields } : {}),
      }
      results.push(result)
      onProgress?.(result)
    } catch (e) {
      const result: ProjectWriteResult = {
        poProjectId: project.ProjectId,
        success: false,
        error: nowError('Project', project.ProjectId, String(e)),
      }
      results.push(result)
      onProgress?.(result)
    }
  }

  return results
}

interface PatchResult {
  error?: ImportError
  skippedFields?: SkippedField[]
}

async function applyProjectPatch(
  dvProjectId: string,
  project: PoProject,
  mappingConfig: MappingConfiguration,
  optionSetMappings: OptionSetMapping[],
  resolvers: Map<string, FieldResolver> | undefined,
  logPayload: boolean,
): Promise<PatchResult> {
  const ownerResourceId = project.ProjectOwnerResourceId ?? project.ProjectOwnerResourceUid
  const ownerMapping = ownerResourceId
    ? mappingConfig.ownerMappings.find(
        m => m.poResourceUid === ownerResourceId && m.matched && m.dataverseSystemUserId,
      )
    : undefined

  const ownerBind = ownerMapping?.dataverseSystemUserId
    ? { 'msdyn_projectmanager@odata.bind': `/systemusers(${ownerMapping.dataverseSystemUserId})` }
    : {}

  let customPayload: Record<string, unknown>
  let skippedFields: SkippedField[] | undefined

  if (resolvers) {
    const projectFieldMappings = mappingConfig.fieldMappings.filter(
      m => m.customField.CustomFieldEntityType === 'Project',
    )
    const applied = applyResolvers(project as Record<string, unknown>, projectFieldMappings, resolvers)
    customPayload = applied.payload
    skippedFields = applied.skippedFields.length > 0 ? applied.skippedFields : undefined

    if (isDebug()) {
      if (logPayload) {
        console.group(`[dataOnly] First project payload — "${project.ProjectName}"`)
        console.log('Custom field payload:', JSON.stringify(customPayload, null, 2))
        console.log('Owner bind:', ownerBind)
        if (skippedFields?.length) {
          console.warn(`Skipped fields (${skippedFields.length}):`, skippedFields.map(s => s.poField))
        }
        console.groupEnd()
      } else if (skippedFields?.length) {
        console.warn(`[dataOnly] "${project.ProjectName}" — ${skippedFields.length} skipped field(s)`)
      }
    }
  } else {
    customPayload = customFieldPayload(project, 'Project', mappingConfig, optionSetMappings)
  }

  const patch: Record<string, unknown> = { ...customPayload, ...ownerBind }

  if (Object.keys(patch).length === 0) return { skippedFields }

  try {
    await patchRecord('msdyn_projects', dvProjectId, patch)
    return { skippedFields }
  } catch (e) {
    if (resolvers) {
      // dataOnly: surface patch failure — project exists but custom fields not written
      return {
        error: nowError('Project', dvProjectId, `Custom field patch failed: ${String(e)}`),
        skippedFields,
      }
    }
    // full mode: swallow as before
    return { skippedFields }
  }
}

async function findExistingProject(project: PoProject, sourceIdColumn: string): Promise<Record<string, unknown>[]> {
  try {
    const bySourceId = await listRecords(
      'msdyn_projects',
      `msdyn_projectid,msdyn_subject,${sourceIdColumn}`,
      `${sourceIdColumn} eq '${escapeODataString(project.ProjectId)}'`,
      1,
    )
    if (bySourceId.length > 0) return bySourceId
  } catch {
    // Tracking column may not exist in older deployments; fall back to name matching.
  }

  return listRecords(
    'msdyn_projects',
    'msdyn_projectid,msdyn_subject',
    `msdyn_subject eq '${escapeODataString(project.ProjectName)}'`,
    1,
  )
}
