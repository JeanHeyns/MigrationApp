/**
 * Project Online connector — via shared_projectonline.
 * Operaties: ListProjects, ListProject, ListTasks, CheckoutProject, PublishProject
 */
import { client } from '../client'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PoProject {
  Id: string
  Name: string
  Description?: string
  StartDate?: string
  FinishDate?: string
}

export interface PoTask {
  Id: string
  Name: string
  Start?: string
  Finish?: string
  Duration?: string
  PercentComplete?: number
  IsManual?: boolean
  IsMilestone?: boolean
  Priority?: number
  ParentId?: string
  OutlineLevel?: number
  OutlineNumber?: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ODataList<T> = { value?: T[] }

// ─── Publieke API ─────────────────────────────────────────────────────────────

export async function listProjects(siteUrl: string): Promise<PoProject[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = { siteUrl }

  const res = await client.executeAsync<typeof params, ODataList<PoProject>>({
    connectorOperation: {
      tableName: 'projectonline',
      operationName: 'ListProjects',
      parameters: params,
    },
  })

  if (!res.success) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    throw new Error(JSON.stringify((res as any).error))
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((res.data as any)?.value ?? []) as PoProject[]
}

export async function listTasks(siteUrl: string, projectId: string): Promise<PoTask[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = { siteUrl, project_id: projectId }

  const res = await client.executeAsync<typeof params, ODataList<PoTask>>({
    connectorOperation: {
      tableName: 'projectonline',
      operationName: 'ListTasks',
      parameters: params,
    },
  })

  if (!res.success) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    throw new Error(JSON.stringify((res as any).error))
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((res.data as any)?.value ?? []) as PoTask[]
}

export async function testProjectOnlineConnection(siteUrl: string): Promise<{
  ok: boolean
  detail: string
  projects: PoProject[]
}> {
  try {
    const projects = await listProjects(siteUrl)
    return { ok: true, detail: `${projects.length} projecten gevonden`, projects }
  } catch (e) {
    return { ok: false, detail: String(e), projects: [] }
  }
}
