import type { PoProject } from '../../models/projectOnline.types'
import type { MappingConfiguration, OptionSetMapping } from '../../models/mapping.types'
import type { ImportError } from '../../models/plannerPremium.types'
import { listRecords, performUnboundAction, patchRecord } from './dataverseClient'
import { cleanGuid, customFieldPayload, escapeODataString, getRecordId, nowError } from './importHelpers'
import { projectOnlineIdColumnName } from './columnManager'

export interface ProjectWriteResult {
  poProjectId: string
  dvProjectId?: string
  success: boolean
  error?: ImportError
}

/**
 * Creates msdyn_project records using the Project schedule API.
 * Existing projects with the same subject are skipped and mapped.
 */
export async function writeProjects(
  projects: PoProject[],
  mappingConfig: MappingConfiguration,
  optionSetMappings: OptionSetMapping[] = [],
  onProgress?: (result: ProjectWriteResult) => void,
): Promise<ProjectWriteResult[]> {
  const results: ProjectWriteResult[] = []
  const sourceIdColumn = projectOnlineIdColumnName(mappingConfig.publisherPrefix)

  for (const project of projects) {
    try {
      const existing = await findExistingProject(project, sourceIdColumn)

      const existingId = cleanGuid(getRecordId(existing[0] ?? {}, 'msdyn_projectid'))
      if (existingId) {
        await applyProjectPatch(existingId, project, mappingConfig, optionSetMappings)
        const result = { poProjectId: project.ProjectId, dvProjectId: existingId, success: true }
        results.push(result)
        onProgress?.(result)
        continue
      }

      const body = {
        Project: {
          '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_project',
          msdyn_subject: project.ProjectName,
          msdyn_description: project.ProjectDescription,
          msdyn_scheduledstart: project.ProjectStartDate,
          [sourceIdColumn]: project.ProjectId,
        },
      }

      const response = await performUnboundAction('msdyn_CreateProjectV1', body)
      const dvProjectId = cleanGuid((response.ProjectId ?? response.projectId ?? response.msdyn_projectid) as string | undefined)

      if (dvProjectId) {
        await applyProjectPatch(dvProjectId, project, mappingConfig, optionSetMappings)
      }

      const result: ProjectWriteResult = { poProjectId: project.ProjectId, dvProjectId, success: !!dvProjectId }
      if (!dvProjectId) result.error = nowError('Project', project.ProjectId, 'CreateProjectV1 did not return a ProjectId')
      results.push(result)
      onProgress?.(result)
    } catch (e) {
      const result = {
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

async function applyProjectPatch(
  dvProjectId: string,
  project: PoProject,
  mappingConfig: MappingConfiguration,
  optionSetMappings: OptionSetMapping[],
): Promise<void> {
  const ownerMapping = project.ProjectOwnerResourceUid
    ? mappingConfig.ownerMappings.find(
        m => m.poResourceUid === project.ProjectOwnerResourceUid && m.matched && m.dataverseSystemUserId,
      )
    : undefined

  const patch: Record<string, unknown> = {
    ...customFieldPayload(project, 'Project', mappingConfig, optionSetMappings),
    ...(ownerMapping?.dataverseSystemUserId
      ? { 'msdyn_projectmanager@odata.bind': `/systemusers(${ownerMapping.dataverseSystemUserId})` }
      : {}),
  }

  if (Object.keys(patch).length > 0) {
    try {
      await patchRecord('msdyn_projects', dvProjectId, patch)
    } catch {
      // Patch failed — custom fields / owner may need manual correction
    }
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
    // The tracking column may not exist yet in older deployments; fall back to name matching.
  }

  return listRecords(
    'msdyn_projects',
    'msdyn_projectid,msdyn_subject',
    `msdyn_subject eq '${escapeODataString(project.ProjectName)}'`,
    1,
  )
}
