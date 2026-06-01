import type { FieldMapping, MultiLookupMapping } from '../../models/mapping.types'
import type { FieldResolver } from './resolverFactory'

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
    const poValue = poRecord[fieldKey] !== undefined
      ? poRecord[fieldKey]
      : (mapping.customField.ODataFieldName ? poRecord[mapping.customField.CustomFieldName] : undefined)
    const resolver = resolvers.get(fieldKey)

    if (!resolver) {
      // No resolver registered → direct pass-through for non-special types
      if (poValue != null && poValue !== '') {
        payload[dvField] = poValue
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
          payload[dvField] = result.value
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

  // Separate loop for N:N multi-lookup fields (not in fieldMappings due to skip/no-column)
  for (const mlMapping of (multiLookupMappings ?? [])) {
    if (mlMapping.targetShape === 'MultiChoice') continue

    const resolver = resolvers.get(mlMapping.poFieldName)
    if (!resolver) continue

    const poValue = poRecord[mlMapping.poFieldName]
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
