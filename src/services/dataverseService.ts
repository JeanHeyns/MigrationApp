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
    '$expand': 'Attributes($filter=IsCustomAttribute eq true;$select=LogicalName,DisplayName,AttributeType,AttributeTypeName)',
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

interface RawPicklistAttributeMeta {
  LogicalName: string
  OptionSet?: { Name?: string; IsGlobal?: boolean }
}

async function fetchAttributesByCast(
  entityLogicalName: string,
  attributeCast: string,
): Promise<RawPicklistAttributeMeta[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    organization: ORG_URL,
    accept: 'application/json',
    entityLogicalName,
    attributeCast,
    '$filter': 'IsCustomAttribute eq true',
    '$select': 'LogicalName',
    '$expand': 'OptionSet($select=Name,IsGlobal)',
  }

  const res = await client.executeAsync<typeof params, Record<string, unknown>>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'GetEntityAttributesByCast',
      parameters: params,
    },
  })

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options = ((raw?.Options ?? []) as any[]).map(o => ({
      value: o.Value as number,
      label: (o.Label?.UserLocalizedLabel?.Label ?? String(o.Value)) as string,
    }))
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
