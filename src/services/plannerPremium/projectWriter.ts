import type { PoProject } from '../../models/projectOnline.types'
import type { FieldMapping, MappingConfiguration, OptionSetMapping } from '../../models/mapping.types'
import type { AssociationAttempt, ImportError, ProjectFieldWriteDiagnostic, ProjectWriteDiagnostic } from '../../models/plannerPremium.types'
import type { FieldResolver } from './resolverFactory'
import type { SkippedField } from './recordResolverApplier'
import type { ProjectDefaults, ProjectOverride } from '../../types/projectDefaults'
import { DEFAULT_PROJECT_DEFAULTS } from '../../types/projectDefaults'
import { effectiveSettings } from '../../utils/effectiveProjectSettings'
import { listRecords, performUnboundAction, patchRecord, associateNNRecord, disassociateNNRecord, listAssociatedNNRecords } from './dataverseClient'
import { cleanGuid, escapeODataString, getRecordId, nowError, sourceGuidOrNew } from './importHelpers'
import { classifyDataverseError } from './errorClassifier'
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
  associationsCreated?: number
  associationDiagnostics?: AssociationAttempt[]
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
  projectDefaults?: ProjectDefaults,
  projectOverridesMap?: Map<string, ProjectOverride>,
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
    : await buildFullModeResolverMap(mappingConfig.fieldMappings, optionSetMappings, mappingConfig.multiLookups)

  let isFirstProject = true

  for (const project of projects) {
    try {
      const existing = await findExistingProject(project)
      const existingId = cleanGuid(getRecordId(existing[0] ?? {}, 'msdyn_projectid'))

      if (existingId) {
        const { error, skippedFields, diagnostic, associationsCreated, associationDiagnostics } = await applyProjectPatch(
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
          ...(associationsCreated > 0 ? { associationsCreated } : {}),
          ...(associationDiagnostics.length > 0 ? { associationDiagnostics } : {}),
        }
        results.push(result)
        onProgress?.(result)
        continue
      }

      const settings = effectiveSettings(
        project.ProjectId,
        projectDefaults ?? DEFAULT_PROJECT_DEFAULTS,
        projectOverridesMap ?? new Map(),
      )
      const projectPayload: Record<string, unknown> = {
        '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_project',
        msdyn_projectid: sourceGuidOrNew(project.ProjectId),
        msdyn_subject: project.ProjectName,
        msdyn_description: project.ProjectDescription,
        msdyn_scheduledstart: project.ProjectStartDate,
        msdyn_hoursperday: settings.hoursPerDay,
        msdyn_hoursperweek: settings.hoursPerWeek,
        msdyn_dayspermonth: settings.daysPerMonth,
      }
      if (settings.workHourTemplateId) {
        projectPayload['msdyn_workhourtemplate@odata.bind'] =
          `/msdyn_workhourtemplates(${settings.workHourTemplateId})`
      }
      if (settings.scheduleMode !== null) {
        projectPayload['msdyn_schedulemode'] = settings.scheduleMode
      }
      const body = { Project: projectPayload }

      const response = await performUnboundAction('msdyn_CreateProjectV1', body)
      const dvProjectId = cleanGuid((response.ProjectId ?? response.projectId ?? response.msdyn_projectid) as string | undefined)

      let patchError: ImportError | undefined
      let skippedFields: SkippedField[] | undefined
      let diagnostic: ProjectWriteDiagnostic | undefined
      let associationsCreated = 0
      let associationDiagnostics: AssociationAttempt[] = []

      if (dvProjectId) {
        const patchResult = await applyProjectPatch(
          dvProjectId, project, mappingConfig, effectiveResolvers, isFirstProject,
          ownerOverrides?.[project.ProjectId],
        )
        patchError = patchResult.error
        skippedFields = patchResult.skippedFields
        associationsCreated = patchResult.associationsCreated
        associationDiagnostics = patchResult.associationDiagnostics
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
        ...(associationsCreated > 0 ? { associationsCreated } : {}),
        ...(associationDiagnostics.length > 0 ? { associationDiagnostics } : {}),
      }
      results.push(result)
      onProgress?.(result)
    } catch (e) {
      const errorClass = classifyDataverseError(e)
      const result: ProjectWriteResult = {
        poProjectId: project.ProjectId,
        success: false,
        error: nowError('Project', project.ProjectId, String(e), errorClass !== 'Other' ? errorClass : undefined, project.ProjectId),
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
  associationsCreated: number
  associationDiagnostics: AssociationAttempt[]
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
  const applied = applyResolvers(
    project as Record<string, unknown>,
    projectFieldMappings,
    resolvers,
    mappingConfig.multiLookups,
  )
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

  let patchSucceeded: boolean | undefined
  let patchErrorMsg: string | undefined

  if (Object.keys(patch).length === 0) {
    patchSucceeded = undefined
  } else {
    try {
      await patchRecord('msdyn_projects', dvProjectId, patch)
      patchSucceeded = true
    } catch (e) {
      patchErrorMsg = `Custom field patch failed: ${String(e)}`
    }
  }

  // Process N:N associations
  let associationsCreated = 0
  const isReRun = mappingConfig.migrationMode === 'dataOnly'
  const assocDiagnostics: AssociationAttempt[] = []

  for (const assoc of applied.pendingAssociations) {
    const diagEntry: AssociationAttempt = {
      projectId: project.ProjectId,
      projectName: project.ProjectName,
      poFieldName: assoc.poFieldName,
      targetEntitySetName: assoc.targetEntitySetName,
      navigationPropertyName: assoc.navigationPropertyName,
      requestedLabels: [...assoc.resolvedLabels, ...assoc.failedLabels],
      matchedGuids: assoc.guids,
      failedLabels: assoc.failedLabels,
      attempts: [],
    }

    if (isReRun) {
      try {
        const targetIdField = `${assoc.targetEntitySetName.replace(/s$/, '')}id`
        const existing = await listAssociatedNNRecords('msdyn_projects', dvProjectId, assoc.navigationPropertyName, targetIdField)
        for (const targetId of existing) {
          try {
            await disassociateNNRecord('msdyn_projects', dvProjectId, assoc.navigationPropertyName, targetId)
          } catch { /* best-effort */ }
        }
      } catch { /* best-effort */ }
    }

    for (const targetGuid of assoc.guids) {
      const start = Date.now()
      const url = `/api/data/v9.2/msdyn_projects(${dvProjectId})/${assoc.navigationPropertyName}/$ref`
      const body = { '@odata.id': `/api/data/v9.1.0/${assoc.targetEntitySetName}(${targetGuid})` }
      try {
        await associateNNRecord('msdyn_projects', dvProjectId, assoc.navigationPropertyName, assoc.targetEntitySetName, targetGuid)
        associationsCreated++
        diagEntry.attempts.push({ targetGuid, url, body, httpStatus: 204, durationMs: Date.now() - start, timestamp: new Date().toISOString() })
      } catch (err) {
        const cls = classifyDataverseError(err)
        if (cls === 'AlreadyExists') {
          associationsCreated++
          diagEntry.attempts.push({ targetGuid, url, body, httpStatus: 204, errorCode: 'AlreadyExists', durationMs: Date.now() - start, timestamp: new Date().toISOString() })
          continue
        }
        if (isDebug()) console.warn(`[projectWriter] associate failed for ${assoc.poFieldName}/${targetGuid}:`, err)
        diagEntry.attempts.push({
          targetGuid, url, body,
          httpStatus: (err as Record<string, unknown>)['status'] as number | undefined,
          errorCode: cls !== 'Other' ? cls : undefined,
          errorMessage: String((err as Record<string, unknown>)['message'] ?? err),
          durationMs: Date.now() - start,
          timestamp: new Date().toISOString(),
        })
      }
    }

    assocDiagnostics.push(diagEntry)
  }

  if (patchErrorMsg) {
    return {
      error: nowError('Project', dvProjectId, patchErrorMsg),
      skippedFields,
      diagnostic: { ...diagnosticBase, patchSucceeded: false, patchError: patchErrorMsg },
      associationsCreated,
      associationDiagnostics: assocDiagnostics,
    }
  }

  return {
    skippedFields,
    diagnostic: { ...diagnosticBase, patchSucceeded },
    associationsCreated,
    associationDiagnostics: assocDiagnostics,
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
