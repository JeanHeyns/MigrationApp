import type { FieldMapping, MultiLookupMapping } from '../../models/mapping.types'
import type { FieldResolver } from './resolverFactory'
import { toDateOnly } from './importHelpers'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SkippedField {
  poField: string
  dvField: string
  reason: string
  originalValue: unknown
  /** Set when a MultiSelectPicklist had some labels matched and some not. */
  partialResolution?: {
    resolvedLabels: string[]
    failedLabels: string[]
  }
}

export interface PendingAssociation {
  poFieldName: string
  navigationPropertyName: string
  targetEntitySetName: string
  guids: string[]
  failedLabels: string[]
  resolvedLabels: string[]
}

export interface AppliedRecord {
  payload: Record<string, unknown>
  skippedFields: SkippedField[]
  pendingAssociations: PendingAssociation[]
}

export interface SourceValueResult {
  key?: string
  value: unknown
}

export function getMappedSourceValue(
  poRecord: Record<string, unknown>,
  customField: FieldMapping['customField'],
): SourceValueResult {
  const exactKeys = [
    customField.ODataFieldName,
    customField.CustomFieldName,
    customField.CustomFieldName?.replace(/[^a-zA-Z0-9]/g, ''),
    customField.CustomFieldName?.replace(/\s+/g, ''),
  ].filter((key, index, keys): key is string =>
    typeof key === 'string' && key.length > 0 && keys.indexOf(key) === index
  )

  const candidateKeys: string[] = []
  const addCandidateKey = (key: string) => {
    if (!candidateKeys.includes(key)) candidateKeys.push(key)
  }
  for (const key of exactKeys) {
    if (poRecord[key] !== undefined) addCandidateKey(key)
  }
  const normalizedCandidates = new Set(exactKeys.map(normalizeSourceKey))
  for (const key of Object.keys(poRecord)) {
    if (normalizedCandidates.has(normalizeSourceKey(key))) {
      addCandidateKey(key)
    }
  }

  let firstDefined: SourceValueResult | undefined
  for (const key of candidateKeys) {
    const value = poRecord[key]
    if (!firstDefined) firstDefined = { key, value }
    if (isMeaningfulSourceValue(value)) return { key, value }
  }

  return firstDefined ?? { value: undefined }
}

function isMeaningfulSourceValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

function normalizeSourceKey(key: string): string {
  return key
    .replace(/_x[0-9a-fA-F]{4}_/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
}

// ─── Main function ────────────────────────────────────────────────────────────

/**
 * Applies resolver map to a single PO record and returns a Dataverse-ready payload.
 *
 * Key contract:
 * - `resolvers` is keyed by ODataFieldName when present, otherwise CustomFieldName
 * - Fields without a resolver entry use direct pass-through (non-special types)
 * - Unresolved values → field omitted from payload, added to skippedFields
 * - LookupMulti resolvers produce associateGuids → collected in pendingAssociations
 */
export function applyResolvers(
  poRecord: Record<string, unknown>,
  fieldMappings: FieldMapping[],
  resolvers: Map<string, FieldResolver>,
  multiLookupMappings?: MultiLookupMapping[],
): AppliedRecord {
  const payload: Record<string, unknown> = {}
  const skippedFields: SkippedField[] = []
  const pendingAssociations: PendingAssociation[] = []

  for (const mapping of fieldMappings) {
    if (mapping.skip || !mapping.migrateValue) continue

    const fieldKey = mapping.customField.ODataFieldName || mapping.customField.CustomFieldName
    if (!fieldKey) continue

    const dvField = mapping.targetLogicalName
    const poValue = getMappedSourceValue(poRecord, mapping.customField).value
    const resolver = resolvers.get(fieldKey)

    if (!resolver) {
      // No resolver registered → direct pass-through for non-special types
      if (poValue != null && poValue !== '') {
        payload[dvField] = mapping.targetColumnType === 'Date' ? toDateOnly(poValue) : poValue
      }
      continue
    }

    const result = resolver.resolve(poValue)
    const originalLabel = result.originalLabel ?? (poValue == null ? undefined : String(poValue))

      switch (result.status) {
      case 'empty':
        break

      case 'resolved':
        if (result.bindKey && result.bindValue) {
          payload[result.bindKey] = result.bindValue
        } else {
          payload[dvField] = mapping.targetColumnType === 'Date' ? toDateOnly(result.value) : result.value
        }
        break

      case 'unresolved': {
        const skipped: SkippedField = {
          poField: fieldKey,
          dvField,
          reason: result.failureReason
            ?? buildUnresolvedReason(resolver.fieldType, originalLabel, result.partialResolution),
          originalValue: poValue,
        }
        if (result.partialResolution) {
          skipped.partialResolution = result.partialResolution
        }
        skippedFields.push(skipped)
        break
      }
    }
  }

  const activeLookupMultiFields = new Set(
    fieldMappings
      .filter(m => !m.skip && m.customField.CustomFieldType === 'LookupMulti')
      .map(m => m.customField.ODataFieldName || m.customField.CustomFieldName),
  )
  const fieldMappingByKey = new Map(
    fieldMappings
      .filter(m => m.customField.CustomFieldType === 'LookupMulti')
      .map(m => [m.customField.ODataFieldName || m.customField.CustomFieldName, m]),
  )

  // Separate loop for active N:N multi-lookup fields (not in fieldMappings due to skip/no-column)
  for (const mlMapping of (multiLookupMappings ?? [])) {
    if (!activeLookupMultiFields.has(mlMapping.poFieldName)) continue
    if (mlMapping.targetShape === 'MultiChoice') continue

    const resolver = resolvers.get(mlMapping.poFieldName)
    if (!resolver) continue

    const fieldMapping = fieldMappingByKey.get(mlMapping.poFieldName)
    const poValue = fieldMapping
      ? getMappedSourceValue(poRecord, fieldMapping.customField).value
      : poRecord[mlMapping.poFieldName]
    const result = resolver.resolve(poValue)
    if (result.status === 'empty') continue

    if (result.associateGuids && result.associateGuids.length > 0) {
      if (!mlMapping.navigationPropertyName || !mlMapping.targetEntitySetName) {
        skippedFields.push({
          poField: mlMapping.poFieldName,
          dvField: mlMapping.poFieldName,
          reason: 'N:N mapping is missing navigation property or target entity set name',
          originalValue: poValue,
        })
        continue
      }
      pendingAssociations.push({
        poFieldName: mlMapping.poFieldName,
        navigationPropertyName: mlMapping.navigationPropertyName,
        targetEntitySetName: mlMapping.targetEntitySetName,
        guids: result.associateGuids,
        failedLabels: result.partialResolution?.failedLabels ?? [],
        resolvedLabels: result.partialResolution?.resolvedLabels ?? [],
      })
    }

    if (result.status === 'unresolved') {
      skippedFields.push({
        poField: mlMapping.poFieldName,
        dvField: mlMapping.poFieldName,
        reason: result.failureReason ?? buildUnresolvedReason('MultiLookup', String(poValue ?? ''), undefined),
        originalValue: poValue,
      })
    }
  }

  return { payload, skippedFields, pendingAssociations }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildUnresolvedReason(
  fieldType: string,
  originalLabel: string | undefined,
  partial: SkippedField['partialResolution'],
): string {
  if (partial) {
    return (
      `Partial ${fieldType} match for "${originalLabel}": ` +
      `resolved [${partial.resolvedLabels.join(', ')}], ` +
      `missing [${partial.failedLabels.join(', ')}]`
    )
  }
  return `No matching ${fieldType} value for "${originalLabel ?? ''}"`
}
