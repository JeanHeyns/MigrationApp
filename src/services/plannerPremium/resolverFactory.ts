import type { ResolverPlan, ResolverEntry, ColumnMetaType, GlobalOptionSetMeta } from '../../models/dataOnly.types'
import { listAllRecords, fetchGlobalOptionSetFull } from '../dataverseService'

// ─── Public types ─────────────────────────────────────────────────────────────

export type ResolverBuildWarningType =
  | 'duplicate_lookup_name'
  | 'large_lookup_table'
  | 'option_set_fetch_failed'
  | 'lookup_fetch_failed'
  | 'incomplete_resolver_metadata'
  | 'choice_value_unmapped'

export interface ResolverBuildWarning {
  severity: 'warn' | 'error'
  field: string
  type: ResolverBuildWarningType
  message: string
  details?: string[]
}

export interface ResolverResult {
  status: 'resolved' | 'unresolved' | 'empty'
  value?: unknown               // direct / choice / multichoice
  bindKey?: string              // e.g. "cr123_category@odata.bind"
  bindValue?: string            // e.g. "/cr123_categories(guid)"
  originalLabel?: string
  // Only set on unresolved multichoice with at least one matched label
  partialResolution?: {
    resolvedLabels: string[]
    failedLabels: string[]
  }
}

export interface FieldResolver {
  fieldType: ColumnMetaType
  resolve(poValue: unknown): ResolverResult
}

export interface BuildResolverMapResult {
  resolvers: Map<string, FieldResolver>
  warnings: ResolverBuildWarning[]
}

// ─── Module-level cache ───────────────────────────────────────────────────────
// Keyed by option set name. Cleared on solution switch via clearResolverCaches().

const optionSetCache = new Map<string, GlobalOptionSetMeta>()

export function clearResolverCaches(): void {
  optionSetCache.clear()
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function buildResolverMap(
  resolverPlan: ResolverPlan,
): Promise<BuildResolverMapResult> {
  const resolvers = new Map<string, FieldResolver>()
  const warnings: ResolverBuildWarning[] = []

  await Promise.all(
    resolverPlan.fields.map(async entry => {
      try {
        const resolver = await buildResolver(entry, warnings)
        resolvers.set(entry.poFieldName, resolver)
      } catch (e) {
        warnings.push({
          severity: 'error',
          field: entry.poFieldName,
          type: 'lookup_fetch_failed',
          message: `Failed to build resolver for "${entry.poFieldName}": ${String(e)}`,
        })
      }
    }),
  )

  return { resolvers, warnings }
}

// ─── Resolver dispatch ────────────────────────────────────────────────────────

async function buildResolver(entry: ResolverEntry, warnings: ResolverBuildWarning[]): Promise<FieldResolver> {
  switch (entry.dvType) {
    case 'Picklist':          return buildChoiceResolver(entry, warnings)
    case 'MultiSelectPicklist': return buildMultiChoiceResolver(entry, warnings)
    case 'Lookup':            return buildLookupResolver(entry, warnings)
    default:                  return buildDirectResolver(entry)
  }
}

// ─── Direct resolver ──────────────────────────────────────────────────────────

function buildDirectResolver(entry: ResolverEntry): FieldResolver {
  return {
    fieldType: entry.dvType,
    resolve: (poValue) => {
      if (poValue == null || poValue === '') return { status: 'empty' }
      if (entry.dvType === 'Decimal' || entry.dvType === 'Money') {
        const value = toNumber(poValue)
        return value == null
          ? { status: 'unresolved', originalLabel: String(poValue) }
          : { status: 'resolved', value }
      }
      if (entry.dvType === 'Integer') {
        const value = toNumber(poValue)
        return value == null
          ? { status: 'unresolved', originalLabel: String(poValue) }
          : { status: 'resolved', value: Math.trunc(value) }
      }
      return { status: 'resolved', value: poValue }
    },
  }
}

// ─── Option set helpers ───────────────────────────────────────────────────────

const normalize = (s: string) => s.toLowerCase().trim()

async function fetchOptionSet(
  name: string,
  field: string,
  warnings: ResolverBuildWarning[],
): Promise<GlobalOptionSetMeta | null> {
  if (optionSetCache.has(name)) return optionSetCache.get(name)!

  const optionSet = await fetchGlobalOptionSetFull(name)
  if (!optionSet) {
    warnings.push({
      severity: 'error',
      field,
      type: 'option_set_fetch_failed',
      message: `Could not fetch global option set "${name}" for field "${field}". All values will be unresolvable.`,
    })
    return null
  }
  optionSetCache.set(name, optionSet)
  return optionSet
}

function buildNormalizedOptionMap(optionSet: GlobalOptionSetMeta): Map<string, number> {
  const map = new Map<string, number>()
  for (const opt of optionSet.options) {
    const labels = opt.labels?.length ? opt.labels : [opt.label]
    for (const label of labels) {
      const key = normalize(label)
      if (!map.has(key)) map.set(key, opt.value)
    }
  }
  return map
}

function buildChoiceValueMap(
  entry: ResolverEntry,
  optionSet: GlobalOptionSetMeta,
  warnings: ResolverBuildWarning[],
): Map<string, number> {
  const optionLabels = buildNormalizedOptionMap(optionSet)
  const valueMap = new Map(optionLabels)
  const unmapped: string[] = []

  for (const source of entry.sourceOptions ?? []) {
    const matched = source.labels
      .map(label => optionLabels.get(normalize(label)))
      .find((value): value is number => value !== undefined)

    if (matched === undefined) {
      unmapped.push(source.labels[0] ?? source.id)
      continue
    }

    valueMap.set(normalize(source.id), matched)
    for (const label of source.labels) {
      valueMap.set(normalize(label), matched)
    }
  }

  if (unmapped.length > 0) {
    warnings.push({
      severity: 'warn',
      field: entry.poFieldName,
      type: 'choice_value_unmapped',
      message: `${unmapped.length} Project Online choice value(s) could not be matched in global option set "${optionSet.name}".`,
      details: unmapped,
    })
  }

  return valueMap
}

// ─── Choice resolver (Picklist) ───────────────────────────────────────────────

async function buildChoiceResolver(entry: ResolverEntry, warnings: ResolverBuildWarning[]): Promise<FieldResolver> {
  const optionSet = entry.optionSetName
    ? await fetchOptionSet(entry.optionSetName, entry.poFieldName, warnings)
    : missingOptionSetResolverMetadata(entry, warnings)
  const map = optionSet ? buildChoiceValueMap(entry, optionSet, warnings) : new Map<string, number>()

  return {
    fieldType: 'Picklist',
    resolve: (poValue) => {
      if (poValue == null || poValue === '') return { status: 'empty' }
      const label = String(poValue)
      const value = map.get(normalize(label))
      return value !== undefined
        ? { status: 'resolved', value, originalLabel: label }
        : { status: 'unresolved', originalLabel: label }
    },
  }
}

// ─── MultiChoice resolver (MultiSelectPicklist) ───────────────────────────────

async function buildMultiChoiceResolver(entry: ResolverEntry, warnings: ResolverBuildWarning[]): Promise<FieldResolver> {
  const optionSet = entry.optionSetName
    ? await fetchOptionSet(entry.optionSetName, entry.poFieldName, warnings)
    : missingOptionSetResolverMetadata(entry, warnings)
  const map = optionSet ? buildChoiceValueMap(entry, optionSet, warnings) : new Map<string, number>()

  return {
    fieldType: 'MultiSelectPicklist',
    resolve: (poValue) => {
      if (poValue == null || poValue === '') return { status: 'empty' }
      const raw = String(poValue)
      const labels = raw.split(/[;,]/).map(s => s.trim()).filter(Boolean)
      const resolvedLabels: string[] = []
      const failedLabels: string[] = []
      const values: number[] = []

      for (const label of labels) {
        const v = map.get(normalize(label))
        if (v !== undefined) {
          values.push(v)
          resolvedLabels.push(label)
        } else {
          failedLabels.push(label)
        }
      }

      if (values.length === labels.length) {
        return { status: 'resolved', value: values.join(','), originalLabel: raw }
      }
      if (failedLabels.length === labels.length) {
        return { status: 'unresolved', originalLabel: raw }
      }
      // Partial: some resolved, some not — strict unresolved with detail for Step 5
      return {
        status: 'unresolved',
        originalLabel: raw,
        partialResolution: { resolvedLabels, failedLabels },
      }
    },
  }
}

// ─── Lookup resolver ──────────────────────────────────────────────────────────

function missingOptionSetResolverMetadata(
  entry: ResolverEntry,
  warnings: ResolverBuildWarning[],
): null {
  warnings.push({
    severity: 'error',
    field: entry.poFieldName,
    type: 'incomplete_resolver_metadata',
    message: `Choice field "${entry.poFieldName}" is missing global option set metadata for Dataverse field "${entry.dvLogicalName}". All values will be unresolvable.`,
  })
  return null
}

const LARGE_TABLE_THRESHOLD = 5000

async function buildLookupResolver(entry: ResolverEntry, warnings: ResolverBuildWarning[]): Promise<FieldResolver> {
  const { poFieldName, targetEntity, targetEntitySet, primaryNameField, navigationProperty } = entry

  if (!targetEntity || !targetEntitySet || !primaryNameField || !navigationProperty) {
    warnings.push({
      severity: 'error',
      field: poFieldName,
      type: 'incomplete_resolver_metadata',
      message: `Lookup field "${poFieldName}" is missing metadata (need: targetEntity, targetEntitySet, primaryNameField, navigationProperty).`,
    })
    return unresolvedResolver('Lookup')
  }

  const idField = `${targetEntity}id`
  let records: Record<string, unknown>[]

  try {
    records = await listAllRecords(
      targetEntitySet,
      [idField, primaryNameField],
      { maxRecords: LARGE_TABLE_THRESHOLD + 1 },
    )
  } catch (e) {
    warnings.push({
      severity: 'error',
      field: poFieldName,
      type: 'lookup_fetch_failed',
      message: `Failed to load lookup table "${targetEntitySet}" for field "${poFieldName}": ${String(e)}`,
    })
    return unresolvedResolver('Lookup')
  }

  if (records.length > LARGE_TABLE_THRESHOLD) {
    warnings.push({
      severity: 'warn',
      field: poFieldName,
      type: 'large_lookup_table',
      message: `Lookup table "${targetEntitySet}" exceeds ${LARGE_TABLE_THRESHOLD} records. Only first ${LARGE_TABLE_THRESHOLD} used for resolution.`,
      details: [`Field: ${poFieldName}`, `Entity set: ${targetEntitySet}`],
    })
    records = records.slice(0, LARGE_TABLE_THRESHOLD)
  }

  const nameMap = new Map<string, string>()
  const duplicates = new Set<string>()

  for (const rec of records) {
    const name = normalize(String(rec[primaryNameField] ?? ''))
    if (!name) continue
    if (nameMap.has(name)) {
      duplicates.add(name)
      continue
    }
    nameMap.set(name, String(rec[idField] ?? '').replace(/[{}]/g, ''))
  }

  if (duplicates.size > 0) {
    warnings.push({
      severity: 'warn',
      field: poFieldName,
      type: 'duplicate_lookup_name',
      message: `Lookup table "${targetEntitySet}" has ${duplicates.size} duplicate name(s). First match wins.`,
      details: [...duplicates],
    })
  }

  return {
    fieldType: 'Lookup',
    resolve: (poValue) => {
      if (poValue == null || poValue === '') return { status: 'empty' }
      const label = String(poValue)
      const guid = nameMap.get(normalize(label))
      if (!guid) return { status: 'unresolved', originalLabel: label }
      return {
        status: 'resolved',
        bindKey: `${navigationProperty}@odata.bind`,
        bindValue: `/${targetEntitySet}(${guid})`,
        originalLabel: label,
      }
    },
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function unresolvedResolver(fieldType: ColumnMetaType): FieldResolver {
  return {
    fieldType,
    resolve: () => ({ status: 'unresolved', originalLabel: undefined }),
  }
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  let text = String(value).trim().replace(/\s/g, '').replace(/[^\d.,-]/g, '')
  if (!text) return undefined

  const comma = text.lastIndexOf(',')
  const dot = text.lastIndexOf('.')
  if (comma >= 0 && dot >= 0) {
    const decimalSeparator = comma > dot ? ',' : '.'
    const thousandSeparator = decimalSeparator === ',' ? '.' : ','
    text = text.replaceAll(thousandSeparator, '').replace(decimalSeparator, '.')
  } else if (comma >= 0) {
    text = text.replace(',', '.')
  }

  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}
