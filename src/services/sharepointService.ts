/**
 * SharePoint Online connector — via shared_sharepointonline.
 *
 * Uses the shared singleton client from client.ts which registers HttpRequestForSite
 * with {siteDataset} as a regular path parameter. We double-encode the site URL so
 * the API hub router (which decodes %2F as a path separator) receives a
 * single-encoded URL after its first decode pass.
 */
import { client } from '../client'

const DS = 'sharepointonline'

function extractSpError(res: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = res as any
  if (!r) return 'no response'
  const err = r.error
  if (!err) return `success=${r.success} (no error detail)`
  if (typeof err === 'string') return err
  if (err instanceof Error) return `${err.name}: ${err.message}`
  const msg: unknown = err.message ?? err.Message ?? err.error_description ?? err.errorDescription
  if (msg) return String(msg)
  const status: unknown = err.statusCode ?? err.status ?? err.code
  if (status) return `HTTP ${status}`
  const raw = (() => { try { return JSON.stringify(err) } catch { return String(err) } })()
  return raw === '{}' ? `unknown connector error (res.success=${r.success})` : raw
}

export async function spHttpGet(siteUrl: string, relativeUri: string): Promise<unknown> {
  // Single-encode the URL. The SDK re-encodes % as %25 when substituting path
  // parameters, producing double-encoding in the actual request. The API hub
  // decodes once (back to single-encoded) and the SP connector decodes once more
  // to arrive at the plain site URL.
  const siteDataset = encodeURIComponent(siteUrl)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    siteDataset,
    parameters: { method: 'GET', uri: relativeUri },
  }

  const res = await client.executeAsync<typeof params, unknown>({
    connectorOperation: { tableName: DS, operationName: 'HttpRequestForSite', parameters: params },
  })

  if (!res.success) {
    throw new Error(extractSpError(res))
  }
  return res.data
}

// ─── Legacy helpers (kept for other potential uses) ──────────────────────────

export interface SpList {
  Id: string
  Title: string
  BaseType?: number
  Hidden?: boolean
}

export async function getLists(siteUrl: string): Promise<SpList[]> {
  const data = await spHttpGet(siteUrl, '_api/web/lists?$select=Id,Title,BaseType,Hidden&$format=json')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as any
  return (d?.d?.results ?? d?.value ?? []) as SpList[]
}

export async function testSharePointConnection(siteUrl: string): Promise<{
  ok: boolean
  detail: string
}> {
  try {
    await spHttpGet(siteUrl, '_api/web/title?$format=json')
    return { ok: true, detail: 'SharePoint connection OK' }
  } catch (e) {
    return { ok: false, detail: String(e) }
  }
}
