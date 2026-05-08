/**
 * Dataverse connector — via shared_commondataserviceforapps.
 * Gebruikt de *WithOrganization operaties zodat de connector weet welke
 * Dataverse omgeving aangesproken moet worden.
 */
import { client } from '../client'
import { DATAVERSE_ORG_URL } from '../config/environment'
import type { GlobalOptionSetMeta } from '../models/dataOnly.types'

const ORG_URL = DATAVERSE_ORG_URL

type ListResult = { value?: unknown[]; '@odata.nextLink'?: string; 'odata.nextLink'?: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractDvError(res: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = res as any
  if (!r) return 'no response'
  const err = r.error
  if (!err) return `success=${r.success} (no error detail)`
  if (typeof err === 'string') return err
  if (err instanceof Error) return `${err.name}: ${err.message}`
  const msg: unknown = err.message ?? err.Message ?? err.innererror?.message ?? err.error_description
  if (msg) return String(msg)
  const code: unknown = err.code ?? err.statusCode ?? err.status
  if (code) return `Error ${code}`
  const raw = (() => { try { return JSON.stringify(err) } catch { return String(err) } })()
  return raw === '{}' ? `unknown error (success=${r.success})` : raw
}

// ─── Generieke helpers ────────────────────────────────────────────────────────

export async function listRecords(
  entityName: string,
  select?: string,
  filter?: string,
  top = 50
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  let skiptoken: string | undefined

  while (rows.length < top) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    organization: ORG_URL,
    entityName,
    prefer: 'odata.include-annotations=*',
    accept: 'application/json',
    $top: Math.min(top - rows.length, 5000),
  }
  if (select) params['$select'] = select
  if (filter) params['$filter'] = filter
  if (skiptoken) params['$skiptoken'] = skiptoken

  const res = await client.executeAsync<typeof params, ListResult>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'ListRecordsWithOrganization',
      parameters: params,
    },
  })

  if (!res.success) throw new Error(extractDvError(res))
    const data = (res.data ?? {}) as ListResult
    rows.push(...((data.value ?? []) as Record<string, unknown>[]))

    const nextLink = data['@odata.nextLink'] ?? data['odata.nextLink']
    skiptoken = nextLink ? extractSkipToken(nextLink) : undefined
    if (!skiptoken || (data.value ?? []).length === 0) break
  }

  return rows
}

function extractSkipToken(nextLink: string): string | undefined {
  try {
    const url = new URL(nextLink)
    return url.searchParams.get('$skiptoken') ?? undefined
  } catch {
    const match = nextLink.match(/[?&]\$skiptoken=([^&]+)/)
    return match ? decodeURIComponent(match[1]) : undefined
  }
}

export async function listAllRecords(
  entitySetName: string,
  selectFields: string[],
  options?: { pageSize?: number; maxRecords?: number },
): Promise<Record<string, unknown>[]> {
  const pageSize = options?.pageSize ?? 5000
  const maxRecords = options?.maxRecords ?? Infinity
  const rows: Record<string, unknown>[] = []
  let skiptoken: string | undefined

  while (rows.length < maxRecords) {
    const batchSize = isFinite(maxRecords)
      ? Math.min(pageSize, maxRecords - rows.length)
      : pageSize
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: Record<string, any> = {
      organization: ORG_URL,
      entityName: entitySetName,
      prefer: 'odata.include-annotations=*',
      accept: 'application/json',
      $top: batchSize,
      $select: selectFields.join(','),
    }
    if (skiptoken) params['$skiptoken'] = skiptoken

    const res = await client.executeAsync<typeof params, ListResult>({
      connectorOperation: {
        tableName: 'commondataserviceforapps',
        operationName: 'ListRecordsWithOrganization',
        parameters: params,
      },
    })

    if (!res.success) throw new Error(extractDvError(res))
    const data = (res.data ?? {}) as ListResult
    rows.push(...((data.value ?? []) as Record<string, unknown>[]))

    const nextLink = data['@odata.nextLink'] ?? data['odata.nextLink']
    skiptoken = nextLink ? extractSkipToken(nextLink) : undefined
    if (!skiptoken || (data.value ?? []).length === 0) break
  }

  return rows
}

export async function createRecord(
  entityName: string,
  item: Record<string, unknown>
): Promise<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    organization: ORG_URL,
    entityName,
    prefer: 'return=representation',
    accept: 'application/json',
    item,
  }

  const res = await client.executeAsync<typeof params, Record<string, unknown>>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'CreateRecordWithOrganization',
      parameters: params,
    },
  })

  if (!res.success) throw new Error(extractDvError(res))
  return (res.data ?? {}) as Record<string, unknown>
}

export async function updateRecord(
  entityName: string,
  id: string,
  item: Record<string, unknown>
): Promise<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    organization: ORG_URL,
    prefer: 'return=representation',
    accept: 'application/json',
    entityName,
    recordId: id,
    item,
  }

  const res = await client.executeAsync<typeof params, Record<string, unknown>>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'UpdateRecordWithOrganization',
      parameters: params,
    },
  })

  if (!res.success) throw new Error(extractDvError(res))
  return (res.data ?? {}) as Record<string, unknown>
}

export async function performUnboundAction(
  actionName: string,
  item?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const params = {
    organization: ORG_URL,
    actionName,
    item,
  }

  const res = await client.executeAsync<typeof params, Record<string, unknown>>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'PerformUnboundActionWithOrganization',
      parameters: params,
    },
  })

  if (!res.success) throw new Error(extractDvError(res))
  return (res.data ?? {}) as Record<string, unknown>
}

export async function createGlobalOptionSet(
  item: Record<string, unknown>,
  solutionUniqueName?: string,
): Promise<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    organization: ORG_URL,
    prefer: 'return=representation',
    accept: 'application/json',
    item,
  }
  if (solutionUniqueName) params['MSCRM.SolutionUniqueName'] = solutionUniqueName

  const res = await client.executeAsync<typeof params, Record<string, unknown>>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'CreateGlobalOptionSet',
      parameters: params,
    },
  })

  if (!res.success) throw new Error(extractDvError(res))
  return (res.data ?? {}) as Record<string, unknown>
}

export async function createEntityAttribute(
  entityLogicalName: string,
  item: Record<string, unknown>,
  solutionUniqueName?: string,
): Promise<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    organization: ORG_URL,
    prefer: 'return=representation',
    accept: 'application/json',
    entityLogicalName,
    item,
  }
  if (solutionUniqueName) params['MSCRM.SolutionUniqueName'] = solutionUniqueName

  const res = await client.executeAsync<typeof params, Record<string, unknown>>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'CreateEntityAttribute',
      parameters: params,
    },
  })

  if (!res.success) throw new Error(extractDvError(res))
  return (res.data ?? {}) as Record<string, unknown>
}

export async function createEntityDefinition(
  item: Record<string, unknown>,
  solutionUniqueName?: string,
): Promise<Record<string, unknown>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    organization: ORG_URL,
    prefer: 'return=representation',
    accept: 'application/json',
    item,
  }
  if (solutionUniqueName) params['MSCRM.SolutionUniqueName'] = solutionUniqueName

  const res = await client.executeAsync<typeof params, Record<string, unknown>>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'CreateEntityDefinition',
      parameters: params,
    },
  })

  if (!res.success) throw new Error(extractDvError(res))
  return (res.data ?? {}) as Record<string, unknown>
}

export async function fetchEntityDefinition(entityLogicalName: string): Promise<{
  logicalName: string
  entitySetName: string
  primaryNameField: string
  metadataId?: string
} | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: Record<string, any> = {
      organization: ORG_URL,
      accept: 'application/json',
      entityLogicalName,
      '$select': 'LogicalName,EntitySetName,PrimaryNameAttribute,MetadataId',
    }

    const res = await client.executeAsync<typeof params, Record<string, unknown>>({
      connectorOperation: {
        tableName: 'commondataserviceforapps',
        operationName: 'GetEntityDefinition',
        parameters: params,
      },
    })

    if (!res.success) throw new Error(extractDvError(res))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = res.data as any
    return {
      logicalName: raw?.LogicalName ?? entityLogicalName,
      entitySetName: raw?.EntitySetName ?? `${entityLogicalName}s`,
      primaryNameField: raw?.PrimaryNameAttribute ?? 'name',
      metadataId: raw?.MetadataId,
    }
  } catch {
    return null
  }
}

export async function getGlobalOptionSetMetadataId(name: string): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: Record<string, any> = {
      organization: ORG_URL,
      accept: 'application/json',
      '$select': 'MetadataId,Name',
      optionSetName: name,
    }

    const res = await client.executeAsync<typeof params, Record<string, unknown>>({
      connectorOperation: {
        tableName: 'commondataserviceforapps',
        operationName: 'GetGlobalOptionSetByName',
        parameters: params,
      },
    })

    if (!res.success) throw new Error(extractDvError(res))
    return ((res.data ?? {})['MetadataId'] as string | undefined) ?? null
  } catch {
    return null
  }
}

export interface DvEntityDefinition {
  logicalName: string
  logicalCollectionName: string
  displayName: string
  metadataId?: string
}

export async function fetchEntityDefinitions(): Promise<DvEntityDefinition[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    organization: ORG_URL,
    accept: 'application/json',
    '$select': 'LogicalName,LogicalCollectionName,DisplayName,IsCustomEntity,MetadataId',
  }

  const res = await client.executeAsync<typeof params, Record<string, unknown>>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'ListEntityDefinitions',
      parameters: params,
    },
  })

  if (!res.success) throw new Error(extractDvError(res))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = res.data as any
  const items = ((raw?.value ?? raw?.d?.results ?? []) as any[])
  return items
    .map(e => ({
      logicalName:           (e.LogicalName ?? '') as string,
      logicalCollectionName: (e.LogicalCollectionName ?? `${e.LogicalName}s`) as string,
      displayName:           (e.DisplayName?.UserLocalizedLabel?.Label ?? e.LogicalName ?? '') as string,
      metadataId:            (e.MetadataId ?? '') as string,
    }))
    .filter(e => e.logicalName)
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
}

export async function fetchSolutionEntityIds(solutionId: string): Promise<Set<string>> {
  const rows = await listRecords(
    'solutioncomponents',
    'objectid',
    `_solutionid_value eq ${solutionId} and componenttype eq 1`,
    5000,
  )
  return new Set(rows.map(r => String(r['objectid'] ?? '').toLowerCase().replace(/[{}]/g, '')))
}

export async function fetchSolutionComponentIds(solutionId: string, componentType: number): Promise<Set<string>> {
  const rows = await listRecords(
    'solutioncomponents',
    'objectid',
    `_solutionid_value eq ${solutionId} and componenttype eq ${componentType}`,
    5000,
  )
  return new Set(rows.map(r => String(r['objectid'] ?? '').toLowerCase().replace(/[{}]/g, '')))
}

export interface DvGlobalOptionSetDefinition {
  name: string
  displayName: string
  metadataId: string
}

export async function fetchGlobalOptionSetDefinitions(): Promise<DvGlobalOptionSetDefinition[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    organization: ORG_URL,
    accept: 'application/json',
    '$select': 'Name,DisplayName,MetadataId',
  }

  const res = await client.executeAsync<typeof params, Record<string, unknown>>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'ListGlobalOptionSetDefinitions',
      parameters: params,
    },
  })

  if (!res.success) throw new Error(extractDvError(res))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = res.data as any
  return (((raw?.value ?? []) as any[])
    .map(os => ({
      name: (os.Name ?? '') as string,
      displayName: (os.DisplayName?.UserLocalizedLabel?.Label ?? os.Name ?? '') as string,
      metadataId: (os.MetadataId ?? '') as string,
    }))
    .filter(os => os.name && os.metadataId)
    .sort((a, b) => a.displayName.localeCompare(b.displayName)))
}

export interface DvEntityAttribute {
  logicalName: string
  displayName: string
  attributeType: string
}

const EXCLUDED_ATTR_TYPES = new Set(['Virtual', 'EntityName', 'Uniqueidentifier', 'CalendarRules', 'ManagedProperty'])

export async function fetchEntityAttributes(entityLogicalName: string): Promise<DvEntityAttribute[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    organization: ORG_URL,
    accept: 'application/json',
    entityLogicalName,
    '$select': 'LogicalName',
    '$expand': 'Attributes($select=LogicalName,DisplayName,AttributeType)',
  }

  const res = await client.executeAsync<typeof params, Record<string, unknown>>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'GetEntityDefinition',
      parameters: params,
    },
  })

  if (!res.success) throw new Error(extractDvError(res))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = res.data as any
  const items = ((raw?.Attributes ?? raw?.attributes ?? raw?.value ?? []) as any[])
  return items
    .map(a => ({
      logicalName: (a.LogicalName ?? a.logicalname ?? '') as string,
      displayName: (a.DisplayName?.UserLocalizedLabel?.Label ?? a.LogicalName ?? '') as string,
      attributeType: (a.AttributeType ?? '') as string,
    }))
    .filter(a => a.logicalName && !EXCLUDED_ATTR_TYPES.has(a.attributeType))
}

// ─── Schema inspection helpers ────────────────────────────────────────────────

export interface EntityWithCustomAttributes {
  logicalName: string
  entitySetName: string
  primaryNameField: string
  rawAttrs: Array<{
    LogicalName: string
    MetadataId?: string
    DisplayName?: { UserLocalizedLabel?: { Label?: string } }
    AttributeType: string
    AttributeTypeName?: { Value?: string }
  }>
}

export async function fetchEntityWithCustomAttributes(entityLogicalName: string): Promise<EntityWithCustomAttributes> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    organization: ORG_URL,
    accept: 'application/json',
    entityLogicalName,
    '$select': 'LogicalName,EntitySetName,PrimaryNameAttribute',
    '$expand': 'Attributes($filter=IsCustomAttribute eq true;$select=LogicalName,MetadataId,DisplayName,AttributeType,AttributeTypeName)',
  }

  const res = await client.executeAsync<typeof params, Record<string, unknown>>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'GetEntityDefinition',
      parameters: params,
    },
  })

  if (!res.success) throw new Error(extractDvError(res))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = res.data as any
  return {
    logicalName:      (raw?.LogicalName ?? entityLogicalName) as string,
    entitySetName:    (raw?.EntitySetName ?? `${entityLogicalName}s`) as string,
    primaryNameField: (raw?.PrimaryNameAttribute ?? 'name') as string,
    rawAttrs:         (raw?.Attributes ?? []) as EntityWithCustomAttributes['rawAttrs'],
  }
}

interface RawAttributeMeta {
  LogicalName: string
  DisplayName?: { UserLocalizedLabel?: { Label?: string } }
  AttributeType: string
  AttributeTypeName?: { Value?: string }
}

export async function fetchCustomEntityAttributes(entityLogicalName: string): Promise<RawAttributeMeta[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    organization: ORG_URL,
    accept: 'application/json',
    entityLogicalName,
    '$filter': 'IsCustomAttribute eq true',
    '$select': 'LogicalName,DisplayName,AttributeType,AttributeTypeName',
  }

  const res = await client.executeAsync<typeof params, Record<string, unknown>>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'GetEntityAttributes',
      parameters: params,
    },
  })

  if (!res.success) throw new Error(extractDvError(res))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (((res.data as any)?.value ?? []) as RawAttributeMeta[])
}

export interface RawPicklistAttributeMeta {
  LogicalName: string
  OptionSet?: { Name?: string; IsGlobal?: boolean; MetadataId?: string; Options?: RawOptionMetadata[] }
  GlobalOptionSet?: { Name?: string; IsGlobal?: boolean; MetadataId?: string; Options?: RawOptionMetadata[] }
}

export type RawLocalizedLabel = { Label?: unknown }
export type RawOptionMetadata = {
  Value?: unknown
  value?: unknown
  Label?: {
    UserLocalizedLabel?: { Label?: unknown }
    LocalizedLabels?: RawLocalizedLabel[]
  }
  label?: {
    userLocalizedLabel?: { label?: unknown }
    localizedLabels?: Array<{ label?: unknown }>
  }
}

export function parseOptionSetOptions(rawOptions: RawOptionMetadata[] = []): GlobalOptionSetMeta['options'] {
  return rawOptions.map(o => {
    const userLabel = typeof o.Label?.UserLocalizedLabel?.Label === 'string'
      ? o.Label.UserLocalizedLabel.Label
      : typeof o.label?.userLocalizedLabel?.label === 'string'
        ? o.label.userLocalizedLabel.label
      : undefined
    const localizedLabels = [
      ...(o.Label?.LocalizedLabels ?? []).map(l => l.Label),
      ...(o.label?.localizedLabels ?? []).map(l => l.label),
    ]
      .filter((label): label is string => typeof label === 'string' && label.length > 0)
    const labels = Array.from(new Set([userLabel, ...localizedLabels].filter((label): label is string => !!label)))
    const rawValue = o.Value ?? o.value
    const value = typeof rawValue === 'number' ? rawValue : Number(rawValue)
    return {
      value,
      label: labels[0] ?? String(value),
      labels,
    }
  })
}

async function fetchAttributesByCast(
  entityLogicalName: string,
  attributeCast: string,
): Promise<RawPicklistAttributeMeta[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const baseParams: Record<string, any> = {
    organization: ORG_URL,
    accept: 'application/json',
    entityLogicalName,
    attributeCast,
    '$filter': 'IsCustomAttribute eq true',
    '$select': 'LogicalName',
  }

  async function execute(expand: string) {
    const params = { ...baseParams, '$expand': expand }
    return client.executeAsync<typeof params, Record<string, unknown>>({
      connectorOperation: {
        tableName: 'commondataserviceforapps',
        operationName: 'GetEntityAttributesByCast',
        parameters: params,
      },
    })
  }

  let res = await execute('OptionSet($select=Name,IsGlobal,Options),GlobalOptionSet($select=Name,IsGlobal)')
  if (!res.success) {
    res = await execute('OptionSet($select=Name,IsGlobal),GlobalOptionSet($select=Name,IsGlobal)')
  }

  if (!res.success) throw new Error(extractDvError(res))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (((res.data as any)?.value ?? []) as RawPicklistAttributeMeta[])
}

export function fetchCustomPicklistAttributes(entityLogicalName: string) {
  return fetchAttributesByCast(entityLogicalName, 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata')
}

export function fetchCustomMultiPicklistAttributes(entityLogicalName: string) {
  return fetchAttributesByCast(entityLogicalName, 'Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata')
}

export interface AttributeOptionSetMetadata {
  name?: string
  metadataId?: string
  isGlobal?: boolean
  options: GlobalOptionSetMeta['options']
  raw: Record<string, unknown>
  source: 'explicit-picklist-cast' | 'explicit-multiselect-cast' | 'attribute-logical-name-cast' | 'attribute-cast' | 'connector-enum-with-organization'
}

export interface OptionSetDebugAttempt {
  label: string
  operationName: string
  intendedUrl: string
  success: boolean
  selected?: boolean
  error?: string
  responseKeys?: string[]
  optionSetName?: string
  optionSetMetadataId?: string
  isGlobal?: boolean
  optionCount?: number
  raw?: unknown
}

export interface OptionSetDebugResult {
  selected: AttributeOptionSetMetadata | null
  attempts: OptionSetDebugAttempt[]
}

type OptionSetRawResult = Omit<AttributeOptionSetMetadata, 'source'> & { source?: AttributeOptionSetMetadata['source'] }

function parseAttributeOptionSetRaw(raw: Record<string, unknown>): OptionSetRawResult | null {
  const optionSet = raw.OptionSet as ({ Name?: string; IsGlobal?: boolean; MetadataId?: string; Options?: RawOptionMetadata[] } | undefined)
  const globalOptionSet = raw.GlobalOptionSet as ({ Name?: string; IsGlobal?: boolean; MetadataId?: string; Options?: RawOptionMetadata[] } | undefined)
  const rawOptions = (
    optionSet?.Options ??
    globalOptionSet?.Options ??
    (Array.isArray(raw.value) ? raw.value :
      Array.isArray(raw.Options) ? raw.Options :
      Array.isArray(raw.options) ? raw.options :
      [])
  ) as RawOptionMetadata[]
  const options = parseOptionSetOptions(rawOptions)
  const name = globalOptionSet?.Name ?? optionSet?.Name ?? (raw.Name ?? raw.name) as string | undefined
  const metadataId = globalOptionSet?.MetadataId ?? optionSet?.MetadataId ?? (raw.MetadataId ?? raw.metadataId) as string | undefined
  const isGlobal = globalOptionSet?.Name ? true : optionSet?.IsGlobal ?? (raw.IsGlobal ?? raw.isGlobal) as boolean | undefined

  if (!name && !metadataId && options.length === 0) return null
  return { name, metadataId, isGlobal, options, raw }
}

function optionSetCastName(type: 'Picklist' | 'MultiSelectPicklist'): string {
  return type === 'MultiSelectPicklist'
    ? 'Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata'
    : 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata'
}

function debugAttemptFromRaw(
  label: string,
  operationName: string,
  intendedUrl: string,
  raw: Record<string, unknown>,
  parsed: OptionSetRawResult | null,
): OptionSetDebugAttempt {
  return {
    label,
    operationName,
    intendedUrl,
    success: true,
    responseKeys: Object.keys(raw),
    optionSetName: parsed?.name,
    optionSetMetadataId: parsed?.metadataId,
    isGlobal: parsed?.isGlobal,
    optionCount: parsed?.options.length ?? 0,
    raw,
  }
}

export async function fetchAttributeOptionSetMetadata(
  entityLogicalName: string,
  attributeMetadataId: string,
  type: 'Picklist' | 'MultiSelectPicklist',
  attributeLogicalName?: string,
): Promise<AttributeOptionSetMetadata | null> {
  const debug = await debugFetchAttributeOptionSetMetadata(entityLogicalName, attributeMetadataId, type, attributeLogicalName)
  return debug.selected
}

export async function debugFetchAttributeOptionSetMetadata(
  entityLogicalName: string,
  attributeMetadataId: string,
  type: 'Picklist' | 'MultiSelectPicklist',
  attributeLogicalName?: string,
): Promise<OptionSetDebugResult> {
  const attempts: OptionSetDebugAttempt[] = []

  async function run(
    label: string,
    operationName: string,
    intendedUrl: string,
    parameters: Record<string, unknown>,
    source: AttributeOptionSetMetadata['source'],
  ): Promise<AttributeOptionSetMetadata | null> {
    try {
      const res = await client.executeAsync<typeof parameters, Record<string, unknown>>({
        connectorOperation: {
          tableName: 'commondataserviceforapps',
          operationName,
          parameters,
        },
      })

      if (!res.success) {
        attempts.push({
          label,
          operationName,
          intendedUrl,
          success: false,
          error: extractDvError(res),
          raw: res,
        })
        return null
      }

      const raw = (res.data ?? {}) as Record<string, unknown>
      const parsed = parseAttributeOptionSetRaw(raw)
      const attempt = debugAttemptFromRaw(label, operationName, intendedUrl, raw, parsed)
      attempts.push(attempt)
      if (!parsed || parsed.options.length === 0) return null

      attempt.selected = true
      return { ...parsed, source }
    } catch (e) {
      attempts.push({
        label,
        operationName,
        intendedUrl,
        success: false,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      })
      return null
    }
  }

  const attributeCast = optionSetCastName(type)

  if (attributeLogicalName) {
    const operationName = type === 'MultiSelectPicklist'
      ? 'GetMultiSelectPicklistAttribute'
      : 'GetPicklistAttribute'
    const selected = await run(
      type === 'MultiSelectPicklist'
        ? 'Explicit MultiSelectPicklist attribute cast'
        : 'Explicit Picklist attribute cast',
      operationName,
      `${ORG_URL}/api/data/v9.2/EntityDefinitions(LogicalName='${entityLogicalName}')` +
      `/Attributes(LogicalName='${attributeLogicalName}')/${attributeCast}?$expand=OptionSet,GlobalOptionSet`,
      {
        organization: ORG_URL,
        accept: 'application/json',
        entityLogicalName,
        attributeLogicalName,
        '$expand': 'OptionSet,GlobalOptionSet',
      },
      type === 'MultiSelectPicklist' ? 'explicit-multiselect-cast' : 'explicit-picklist-cast',
    )
    if (selected) return { selected, attempts }
  }

  const connectorEnumUrl = `Connector enum metadata: ${ORG_URL}/${entityLogicalName}/${attributeMetadataId}/${type}`
  const selectedByConnectorEnum = await run(
    'Connector enum metadata with organization',
    'GetOptionSetMetadataWithOrganization',
    connectorEnumUrl,
    {
      organization: ORG_URL,
      body: {
        entityName: entityLogicalName,
        attributeMetadataId,
        type,
      },
    },
    'connector-enum-with-organization',
  )
  if (selectedByConnectorEnum) return { selected: selectedByConnectorEnum, attempts }

  if (attributeLogicalName) {
    const intendedUrl =
      `${ORG_URL}/api/data/v9.2/EntityDefinitions(LogicalName='${entityLogicalName}')` +
      `/Attributes(LogicalName='${attributeLogicalName}')/${attributeCast}?$expand=OptionSet,GlobalOptionSet`
    const selected = await run(
      'Attribute cast by logical name',
      'GetEntityAttributeByLogicalNameCast',
      intendedUrl,
      {
        organization: ORG_URL,
        accept: 'application/json',
        entityLogicalName,
        attributeLogicalName,
        attributeCast,
        '$expand': 'OptionSet,GlobalOptionSet',
      },
      'attribute-logical-name-cast',
    )
    if (selected) return { selected, attempts }
  }

  const byMetadataIdUrl =
    `${ORG_URL}/api/data/v9.1.0/EntityDefinitions(LogicalName='${entityLogicalName}')` +
    `/Attributes(${attributeMetadataId})/${attributeCast}?$expand=OptionSet,GlobalOptionSet`
  const selectedByMetadataId = await run(
    'Attribute cast by MetadataId',
    'GetEntityAttributeByMetadataIdCast',
    byMetadataIdUrl,
    {
      organization: ORG_URL,
      accept: 'application/json',
      entityLogicalName,
      attributeMetadataId,
      attributeCast,
      '$expand': 'OptionSet,GlobalOptionSet',
    },
    'attribute-cast',
  )
  if (selectedByMetadataId) return { selected: selectedByMetadataId, attempts }

  return { selected: null, attempts }
}

interface RawRelationshipMeta {
  ReferencingAttribute: string
  ReferencingEntityNavigationPropertyName: string
  ReferencedEntity: string
}

export async function fetchEntityManyToOneRelationships(entityLogicalName: string): Promise<RawRelationshipMeta[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    organization: ORG_URL,
    accept: 'application/json',
    entityLogicalName,
    '$select': 'ReferencingAttribute,ReferencingEntityNavigationPropertyName,ReferencedEntity',
  }

  const res = await client.executeAsync<typeof params, Record<string, unknown>>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'GetEntityManyToOneRelationships',
      parameters: params,
    },
  })

  if (!res.success) throw new Error(extractDvError(res))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (((res.data as any)?.value ?? []) as RawRelationshipMeta[])
}

export async function fetchGlobalOptionSetFull(name: string): Promise<GlobalOptionSetMeta | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const params: Record<string, any> = {
      organization: ORG_URL,
      accept: 'application/json',
      optionSetName: name,
    }

    const res = await client.executeAsync<typeof params, Record<string, unknown>>({
      connectorOperation: {
        tableName: 'commondataserviceforapps',
        operationName: 'GetGlobalOptionSetByName',
        parameters: params,
      },
    })

    if (!res.success) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = res.data as any
    const displayName = (raw?.DisplayName?.UserLocalizedLabel?.Label ?? name) as string
    const options = parseOptionSetOptions((raw?.Options ?? []) as RawOptionMetadata[])
    return { name, displayName, options }
  } catch {
    return null
  }
}

// ─── Test ─────────────────────────────────────────────────────────────────────

export async function testDataverseConnection(): Promise<{
  ok: boolean
  detail: string
  users: { id: string; name: string }[]
}> {
  try {
    const rows = await listRecords('systemusers', 'systemuserid,fullname', 'islicensed eq true', 5)
    const users = rows.map(r => ({ id: r['systemuserid'] as string, name: r['fullname'] as string }))
    return { ok: true, detail: `${rows.length} gelicenseerde gebruikers geladen`, users }
  } catch (e) {
    return { ok: false, detail: String(e), users: [] }
  }
}
