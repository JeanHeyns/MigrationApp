import type { PoProject } from '../../models/projectOnline.types'
import type { FieldMapping, MappingConfiguration, OptionSetMapping } from '../../models/mapping.types'
import type { ImportError, ProjectFieldWriteDiagnostic, ProjectWriteDiagnostic } from '../../models/plannerPremium.types'
import type { FieldResolver } from './resolverFactory'
import type { SkippedField } from './recordResolverApplier'
import { listRecords, performUnboundAction, patchRecord } from './dataverseClient'
import { cleanGuid, escapeODataString, getRecordId, nowError, sourceGuidOrNew } from './importHelpers'
import { applyResolvers } from './recordResolverApplier'
import { buildFullModeResolverMap } from './resolverFactory'

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
  diagnostic?: ProjectWriteDiagnostic
}

/**
 * Creates msdyn_project records using the Project schedule API.
 * Existing projects with the same subject are skipped and mapped.
 *
 * Both modes use applyResolvers() for the custom-field patch:
 * - full mode: resolvers are built from optionSetMappings (passthrough per field type)
 * - dataOnly mode: pass the pre-built resolver map from buildResolverMap()
 */
export async function writeProjects(
  projects: PoProject[],
  mappingConfig: MappingConfiguration,
  optionSetMappings: OptionSetMapping[] = [],
  onProgress?: (result: ProjectWriteResult) => void,
  resolvers?: Map<string, FieldResolver>,
  ownerOverrides?: Record<string, string>,
): Promise<ProjectWriteResult[]> {
  const results: ProjectWriteResult[] = []
  const dataOnly = mappingConfig.migrationMode === 'dataOnly' && !!resolvers

  if (dataOnly && isDebug()) {
    console.group('[dataOnly] projectWriter — resolver summary')
    console.log(`Resolvers built: ${resolvers!.size}`)
    for (const [field, resolver] of resolvers!) {
      console.log(`  ${field} → ${resolver.fieldType}`)
    }
    console.groupEnd()
  }

  const effectiveResolvers = dataOnly
    ? resolvers!
    : await buildFullModeResolverMap(mappingConfig.fieldMappings, optionSetMappings)

  let isFirstProject = true

  for (const project of projects) {
    try {
      const existing = await findExistingProject(project)
      const existingId = cleanGuid(getRecordId(existing[0] ?? {}, 'msdyn_projectid'))

      if (existingId) {
        const { error, skippedFields, diagnostic } = await applyProjectPatch(
          existingId, project, mappingConfig, effectiveResolvers, isFirstProject,
          ownerOverrides?.[project.ProjectId],
        )
        isFirstProject = false
        diagnostic.mode = 'existing'
        const result: ProjectWriteResult = {
          poProjectId: project.ProjectId,
          dvProjectId: existingId,
          success: true,
          ...(error ? { error } : {}),
          ...(skippedFields?.length ? { skippedFields } : {}),
          diagnostic,
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
        },
      }

      const response = await performUnboundAction('msdyn_CreateProjectV1', body)
      const dvProjectId = cleanGuid((response.ProjectId ?? response.projectId ?? response.msdyn_projectid) as string | undefined)

      let patchError: ImportError | undefined
      let skippedFields: SkippedField[] | undefined
      let diagnostic: ProjectWriteDiagnostic | undefined

      if (dvProjectId) {
        const patchResult = await applyProjectPatch(
          dvProjectId, project, mappingConfig, effectiveResolvers, isFirstProject,
          ownerOverrides?.[project.ProjectId],
        )
        patchError = patchResult.error
        skippedFields = patchResult.skippedFields
        diagnostic = {
          ...patchResult.diagnostic,
          mode: 'created',
          createPayload: body.Project,
          createResponse: response as Record<string, unknown>,
        }
      } else {
        diagnostic = {
          poProjectId: project.ProjectId,
          poProjectName: project.ProjectName,
          mode: 'createFailed',
          createPayload: body.Project,
          createResponse: response as Record<string, unknown>,
          patchPayload: {},
          ownerBind: {},
          mappedFields: [],
          skippedFields: [],
          patchAttempted: false,
        }
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
        ...(diagnostic ? { diagnostic } : {}),
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
  diagnostic: ProjectWriteDiagnostic
}

async function applyProjectPatch(
  dvProjectId: string,
  project: PoProject,
  mappingConfig: MappingConfiguration,
  resolvers: Map<string, FieldResolver>,
  logPayload: boolean,
  ownerOverride?: string,
): Promise<PatchResult> {
  const ownerResourceId = project.ProjectOwnerResourceId ?? project.ProjectOwnerResourceUid
  const mappingUserId = ownerResourceId
    ? mappingConfig.ownerMappings.find(
        m => m.poResourceUid === ownerResourceId && m.matched && m.dataverseSystemUserId,
      )?.dataverseSystemUserId
    : undefined
  const resolvedOwnerId = ownerOverride ?? mappingUserId

  const ownerBind = resolvedOwnerId
    ? {
        'msdyn_projectmanager@odata.bind': `/systemusers(${resolvedOwnerId})`,
        'ownerid@odata.bind': `/systemusers(${resolvedOwnerId})`,
      }
    : {}

  const projectFieldMappings = mappingConfig.fieldMappings.filter(
    m => m.customField.CustomFieldEntityType === 'Project',
  )
  const applied = applyResolvers(project as Record<string, unknown>, projectFieldMappings, resolvers)
  const customPayload = applied.payload
  const skippedFields = applied.skippedFields.length > 0 ? applied.skippedFields : undefined

  if (isDebug()) {
    if (logPayload) {
      console.group(`[projectWriter] First project payload — "${project.ProjectName}"`)
      console.log('Custom field payload:', JSON.stringify(customPayload, null, 2))
      console.log('Owner bind:', ownerBind)
      if (skippedFields?.length) {
        console.warn(`Skipped fields (${skippedFields.length}):`, skippedFields.map(s => s.poField))
      }
      console.groupEnd()
    } else if (skippedFields?.length) {
      console.warn(`[projectWriter] "${project.ProjectName}" — ${skippedFields.length} skipped field(s)`)
    }
  }

  const patch: Record<string, unknown> = { ...customPayload, ...ownerBind }
  const diagnosticBase: ProjectWriteDiagnostic = {
    poProjectId: project.ProjectId,
    poProjectName: project.ProjectName,
    dvProjectId,
    mode: 'created',
    patchPayload: patch,
    ownerBind,
    mappedFields: buildProjectFieldDiagnostics(project, projectFieldMappings, customPayload, applied.skippedFields),
    skippedFields: applied.skippedFields,
    patchAttempted: Object.keys(patch).length > 0,
  }

  if (Object.keys(patch).length === 0) {
    return {
      skippedFields,
      diagnostic: { ...diagnosticBase, patchSucceeded: undefined },
    }
  }

  try {
    await patchRecord('msdyn_projects', dvProjectId, patch)
    return {
      skippedFields,
      diagnostic: { ...diagnosticBase, patchSucceeded: true },
    }
  } catch (e) {
    const message = `Custom field patch failed: ${String(e)}`
    return {
      error: nowError('Project', dvProjectId, message),
      skippedFields,
      diagnostic: { ...diagnosticBase, patchSucceeded: false, patchError: message },
    }
  }
}

function buildProjectFieldDiagnostics(
  project: PoProject,
  mappings: FieldMapping[],
  customPayload: Record<string, unknown>,
  skippedFields: SkippedField[],
): ProjectFieldWriteDiagnostic[] {
  return mappings.map(mapping => {
    const sourceKey = mapping.customField.ODataFieldName || mapping.customField.CustomFieldName
    const sourceValue = getProjectSourceValue(project, mapping)
    const skipped = skippedFields.find(sf => sf.poField === sourceKey || sf.poField === mapping.customField.CustomFieldName)
    const targetLogicalName = mapping.targetLogicalName
    return {
      poField: mapping.customField.CustomFieldName,
      sourceKey,
      targetLogicalName,
      targetColumnType: mapping.targetColumnType,
      sourceValue,
      hasSourceValue: sourceValue !== undefined && sourceValue !== null && sourceValue !== '',
      migrateValue: mapping.migrateValue,
      skipped: mapping.skip,
      resolvedInPatch: Object.prototype.hasOwnProperty.call(customPayload, targetLogicalName)
        || Object.prototype.hasOwnProperty.call(customPayload, `${targetLogicalName}@odata.bind`),
      ...(skipped ? { skipReason: skipped.reason } : {}),
    }
  })
}

function getProjectSourceValue(project: PoProject, mapping: FieldMapping): unknown {
  const fieldName = mapping.customField.ODataFieldName
  if (fieldName && project[fieldName] !== undefined) return project[fieldName]
  return project[mapping.customField.CustomFieldName]
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function findExistingProject(project: PoProject): Promise<Record<string, unknown>[]> {
  const guid = cleanGuid(project.ProjectId)
  if (guid && GUID_RE.test(guid)) {
    const byId = await listRecords(
      'msdyn_projects',
      'msdyn_projectid,msdyn_subject',
      `msdyn_projectid eq ${guid.toLowerCase()}`,
      1,
    )
    if (byId.length > 0) return byId
  }

  return listRecords(
    'msdyn_projects',
    'msdyn_projectid,msdyn_subject',
    `msdyn_subject eq '${escapeODataString(project.ProjectName)}'`,
    1,
  )
}
