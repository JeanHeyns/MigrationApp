/**
 * Dataverse connector — via shared_commondataserviceforapps.
 * Gebruikt de *WithOrganization operaties zodat de connector weet welke
 * Dataverse omgeving aangesproken moet worden.
 */
import { client } from '../client'
import { DATAVERSE_ORG_URL } from '../config/environment'

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

export interface DvEntityAttribute {
  logicalName: string
  displayName: string
  attributeType: string
}

export async function fetchEntityAttributes(entityLogicalName: string): Promise<DvEntityAttribute[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    organization: ORG_URL,
    accept: 'application/json',
    entityLogicalName,
    '$select': 'LogicalName,DisplayName,AttributeType',
    '$filter': "AttributeType ne 'Virtual' and AttributeType ne 'EntityName' and AttributeType ne 'Uniqueidentifier' and AttributeType ne 'CalendarRules'",
  }

  const res = await client.executeAsync<typeof params, { value?: unknown[] }>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'GetEntityAttributes',
      parameters: params,
    },
  })

  if (!res.success) throw new Error(extractDvError(res))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((res.data?.value ?? []) as any[]).map(a => ({
    logicalName: (a.LogicalName ?? a.logicalname ?? '') as string,
    displayName: (a.DisplayName?.UserLocalizedLabel?.Label ?? a.LogicalName ?? '') as string,
    attributeType: (a.AttributeType ?? '') as string,
  }))
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
