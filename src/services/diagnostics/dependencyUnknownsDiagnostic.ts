/**
 * One-shot READ-ONLY diagnostic to resolve the three open questions from
 * docs/diagnostics/dependency-migration-audit.md:
 *
 *   1. msdyn_projecttaskdependencylinktype option-set integer values
 *   2. msdyn_projecttaskdependencylinklag unit (seconds vs minutes vs hours)
 *   3. The raw PO `TaskLinks` row shape (which fields exist, what values they hold)
 *
 * It deliberately does NOT translate the linktype integer to a label and does NOT
 * convert the lag number. Raw numbers only — the whole point is to bypass the
 * writer's current assumptions ({FF:0,FS:1,SF:2,SS:3} and Lag*6) so the output can
 * be judged against the values the user entered in the Project for the Web UI.
 *
 * No POST/PATCH/DELETE, no OperationSet. The report is downloaded as JSON by the
 * caller and is not committed to the repo.
 */
import { listRecords } from '../plannerPremium/dataverseClient'
import { debugFetchAttributeOptionSetMetadata } from '../dataverseService'
import { odataGetAll } from '../projectOnline/odataClient'
// One-shot debug tool: reuse the same connector client dataverseService uses,
// rather than building a parallel HTTP layer, to read raw attribute metadata for
// system attributes (the existing typed helpers all filter IsCustomAttribute eq true).
import { client } from '../../client'
import { getDataverseOrgUrl } from '../../config/environment'

const ENTITY_LOGICAL_NAME = 'msdyn_projecttaskdependency'
const ENTITY_SET_NAME = 'msdyn_projecttaskdependencies'
const LINK_TYPE_ATTR = 'msdyn_projecttaskdependencylinktype'
const LINK_LAG_ATTR = 'msdyn_projecttaskdependencylinklag'

// Casts tried for the numeric lag attribute. We do not know in advance whether
// Dataverse models it as Integer, BigInt, Decimal or Double, so we try each and
// keep the first that returns Format/MinValue/MaxValue.
const LINK_LAG_CASTS = [
  'Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
  'Microsoft.Dynamics.CRM.BigIntAttributeMetadata',
  'Microsoft.Dynamics.CRM.DecimalAttributeMetadata',
  'Microsoft.Dynamics.CRM.DoubleAttributeMetadata',
]

export interface DependencyUnknownsDataverseRow {
  msdyn_projecttaskdependencyid: unknown
  msdyn_projecttaskdependencylinktype: unknown
  msdyn_projecttaskdependencylinklag: unknown
  _msdyn_predecessortask_value: unknown
  _msdyn_successortask_value: unknown
  msdyn_description: unknown
  /** Every msdyn-prefixed field on the row, so we catch fields the writer is unaware of. */
  allMsdynFields: Record<string, unknown>
  /** The entire row verbatim, including annotations and @odata.etag. */
  rawRow: Record<string, unknown>
  '@odata.etag': unknown
}

export interface DependencyUnknownsOptionSetEntry {
  value: number
  labels: Record<string, string>
}

export interface DependencyUnknownsLagAttempt {
  cast: string | null
  success: boolean
  error?: string
}

export interface DependencyUnknownsReport {
  generatedAt: string
  projectId: string
  projectName: string | null
  poProjectId: string | null
  dataverseRowCount: number
  dataverseRows: DependencyUnknownsDataverseRow[]
  /** Ground truth for Open Question 1: integer value → labels per locale. */
  linkTypeOptionSet: DependencyUnknownsOptionSetEntry[]
  /** Full raw metadata blob for the linktype attribute, verbatim. */
  linkTypeRawMetadata: unknown
  linkTypeMetadataAttempts: unknown
  /** Ground truth for Open Question 2: first successful cast metadata for the lag attribute. */
  linkLagAttributeMetadata: unknown
  linkLagBaseMetadata: unknown
  linkLagMetadataAttempts: DependencyUnknownsLagAttempt[]
  /** Ground truth for Open Question 3: raw PO TaskLinks rows, untouched. */
  poRows: Array<{ rawOData: Record<string, unknown> }>
  poFetchNote: string | null
  matches: Array<{ poRow: Record<string, unknown>; dvRow: Record<string, unknown>; note: string }>
  errors: string[]
}

export interface DependencyUnknownsOptions {
  /** Dataverse msdyn_projectid of the reference project. */
  dvProjectId: string
  /** PWA site URL (MigrationContext.pwaUrl); omit to skip the PO source read. */
  pwaUrl?: string
  /** PO source ProjectId; omit to skip the PO source read. */
  poProjectId?: string
  /** Optional display name; resolved from Dataverse if not provided. */
  projectName?: string
}

export async function buildDependencyUnknownsDiagnostic(
  opts: DependencyUnknownsOptions,
): Promise<DependencyUnknownsReport> {
  const errors: string[] = []
  const dvProjectId = cleanGuid(opts.dvProjectId)

  // ── Project name (best effort) ───────────────────────────────────────────
  let projectName = opts.projectName ?? null
  if (!projectName) {
    try {
      const rows = await listRecords('msdyn_projects', 'msdyn_projectid,msdyn_subject', `msdyn_projectid eq ${dvProjectId}`, 1)
      projectName = (rows[0]?.['msdyn_subject'] as string | undefined) ?? null
    } catch (e) {
      errors.push(`project name lookup failed: ${String(e)}`)
    }
  }

  // ── 1. Raw Dataverse dependency rows (no $select → full payload) ──────────
  let dataverseRows: DependencyUnknownsDataverseRow[] = []
  try {
    const rows = await listRecords(ENTITY_SET_NAME, undefined, `_msdyn_project_value eq ${dvProjectId}`, 5000)
    dataverseRows = rows.map(toDataverseRow)
  } catch (e) {
    errors.push(`Dataverse dependency read failed: ${String(e)}`)
  }

  // ── 2. linktype option-set metadata (raw, not translated) ────────────────
  let linkTypeOptionSet: DependencyUnknownsOptionSetEntry[] = []
  let linkTypeRawMetadata: unknown = null
  let linkTypeMetadataAttempts: unknown = null
  try {
    const debug = await debugFetchAttributeOptionSetMetadata(ENTITY_LOGICAL_NAME, '', 'Picklist', LINK_TYPE_ATTR)
    linkTypeRawMetadata = debug.selected?.raw ?? null
    linkTypeMetadataAttempts = debug.attempts
    linkTypeOptionSet = buildOptionSet(debug.selected?.raw)
    if (linkTypeOptionSet.length === 0 && debug.selected?.options?.length) {
      // Fallback: parsed options without per-locale LCID keys
      linkTypeOptionSet = debug.selected.options.map(o => ({
        value: o.value,
        labels: { default: o.label },
      }))
    }
  } catch (e) {
    errors.push(`linktype metadata fetch failed: ${String(e)}`)
  }

  // ── 3. linklag attribute metadata (base + casts, raw) ────────────────────
  let linkLagBaseMetadata: unknown = null
  try {
    linkLagBaseMetadata = await fetchAttributeBaseMetadata(ENTITY_LOGICAL_NAME, LINK_LAG_ATTR)
  } catch (e) {
    errors.push(`linklag base metadata fetch failed: ${String(e)}`)
  }

  let linkLagAttributeMetadata: unknown = null
  const linkLagMetadataAttempts: DependencyUnknownsLagAttempt[] = []
  for (const cast of LINK_LAG_CASTS) {
    try {
      const meta = await fetchAttributeCastMetadata(ENTITY_LOGICAL_NAME, LINK_LAG_ATTR, cast)
      linkLagMetadataAttempts.push({ cast, success: true })
      if (linkLagAttributeMetadata == null) linkLagAttributeMetadata = meta
    } catch (e) {
      linkLagMetadataAttempts.push({ cast, success: false, error: String(e) })
    }
  }

  // ── 4. Raw PO source rows ────────────────────────────────────────────────
  let poRows: Array<{ rawOData: Record<string, unknown> }> = []
  let poFetchNote: string | null = null
  if (opts.pwaUrl && opts.poProjectId) {
    const poId = String(opts.poProjectId).replace(/[{}]/g, '').trim()
    const uris = [
      `_api/ProjectServer/Projects('${poId}')/TaskLinks?$expand=Start,End`,
      `_api/ProjectServer/Projects(guid'${poId}')/TaskLinks?$expand=Start,End`,
    ]
    let lastError: unknown
    for (const uri of uris) {
      try {
        const rows = await odataGetAll<Record<string, unknown>>(opts.pwaUrl, uri)
        poRows = rows.map(r => ({ rawOData: r }))
        lastError = undefined
        break
      } catch (e) {
        lastError = e
      }
    }
    if (poRows.length === 0 && lastError) {
      poFetchNote = `PO TaskLinks fetch failed for project ${poId}: ${String(lastError)}`
    }
  } else {
    poFetchNote = 'No PWA URL or PO source project id supplied — PO rows not fetched (the project may have been created manually in P4W, which is fine; the Dataverse rows + metadata still answer Q1/Q2).'
  }

  // ── 5. Match source ↔ target by predecessor/successor task pair ───────────
  const matches: DependencyUnknownsReport['matches'] = []
  for (const po of poRows) {
    const pred = poSideId(po.rawOData, 'Start')
    const succ = poSideId(po.rawOData, 'End')
    if (!pred || !succ) continue
    const dv = dataverseRows.find(row =>
      cleanGuid(String(row._msdyn_predecessortask_value ?? '')) === pred &&
      cleanGuid(String(row._msdyn_successortask_value ?? '')) === succ,
    )
    if (dv) {
      matches.push({ poRow: po.rawOData, dvRow: dv.rawRow, note: 'matched on predecessor+successor task pair' })
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    projectId: dvProjectId,
    projectName,
    poProjectId: opts.poProjectId ?? null,
    dataverseRowCount: dataverseRows.length,
    dataverseRows,
    linkTypeOptionSet,
    linkTypeRawMetadata,
    linkTypeMetadataAttempts,
    linkLagAttributeMetadata,
    linkLagBaseMetadata,
    linkLagMetadataAttempts,
    poRows,
    poFetchNote,
    matches,
    errors,
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function cleanGuid(value: string): string {
  return value.replace(/[{}]/g, '').trim().toLowerCase()
}

function toDataverseRow(row: Record<string, unknown>): DependencyUnknownsDataverseRow {
  const allMsdynFields: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('msdyn_') || key.startsWith('_msdyn')) allMsdynFields[key] = value
  }
  return {
    msdyn_projecttaskdependencyid: row['msdyn_projecttaskdependencyid'],
    msdyn_projecttaskdependencylinktype: row['msdyn_projecttaskdependencylinktype'],
    msdyn_projecttaskdependencylinklag: row['msdyn_projecttaskdependencylinklag'],
    _msdyn_predecessortask_value: row['_msdyn_predecessortask_value'],
    _msdyn_successortask_value: row['_msdyn_successortask_value'],
    msdyn_description: row['msdyn_description'],
    allMsdynFields,
    rawRow: row,
    '@odata.etag': row['@odata.etag'],
  }
}

/** Builds value → per-locale-label map from a raw picklist metadata blob, without assuming a mapping. */
function buildOptionSet(raw: unknown): DependencyUnknownsOptionSetEntry[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = raw as any
  const options: unknown[] =
    r?.OptionSet?.Options ?? r?.GlobalOptionSet?.Options ?? r?.Options ?? r?.options ?? []
  if (!Array.isArray(options)) return []
  return options.map(opt => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const o = opt as any
    const rawValue = o?.Value ?? o?.value
    const value = typeof rawValue === 'number' ? rawValue : Number(rawValue)
    const labels: Record<string, string> = {}
    const localized = o?.Label?.LocalizedLabels ?? o?.label?.localizedLabels ?? []
    if (Array.isArray(localized)) {
      for (const ll of localized) {
        const code = ll?.LanguageCode ?? ll?.languageCode
        const label = ll?.Label ?? ll?.label
        if (code != null && typeof label === 'string') labels[String(code)] = label
      }
    }
    const userLabel = o?.Label?.UserLocalizedLabel
    if (userLabel && typeof userLabel.Label === 'string' && userLabel.LanguageCode != null) {
      labels[String(userLabel.LanguageCode)] = userLabel.Label
    }
    return { value, labels }
  })
}

function extractError(res: { success?: boolean; error?: unknown }): string {
  const err = res?.error
  if (!err) return `success=${res?.success}`
  if (typeof err === 'string') return err
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyErr = err as any
  return String(anyErr?.message ?? anyErr?.Message ?? JSON.stringify(err))
}

/** Raw base attribute metadata via a single-attribute EntityDefinition expand. */
async function fetchAttributeBaseMetadata(entityLogicalName: string, attributeLogicalName: string): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    organization: getDataverseOrgUrl(),
    accept: 'application/json',
    entityLogicalName,
    '$select': 'LogicalName',
    '$expand': `Attributes($filter=LogicalName eq '${attributeLogicalName}')`,
  }
  const res = await client.executeAsync<typeof params, Record<string, unknown>>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'GetEntityDefinition',
      parameters: params,
    },
  })
  if (!res.success) throw new Error(extractError(res))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = res.data as any
  const attrs = (raw?.Attributes ?? raw?.attributes ?? []) as unknown[]
  return Array.isArray(attrs) ? (attrs[0] ?? raw) : raw
}

/** Raw cast attribute metadata (Integer/BigInt/Decimal/Double) — carries Format/MinValue/MaxValue. */
async function fetchAttributeCastMetadata(
  entityLogicalName: string,
  attributeLogicalName: string,
  attributeCast: string,
): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const params: Record<string, any> = {
    organization: getDataverseOrgUrl(),
    accept: 'application/json',
    entityLogicalName,
    attributeLogicalName,
    attributeCast,
  }
  const res = await client.executeAsync<typeof params, Record<string, unknown>>({
    connectorOperation: {
      tableName: 'commondataserviceforapps',
      operationName: 'GetEntityAttributeByLogicalNameCast',
      parameters: params,
    },
  })
  if (!res.success) throw new Error(extractError(res))
  return res.data
}

/** Extracts a PO task id from a raw TaskLinks row, mirroring projectOnline/dependencies.ts. */
function poSideId(row: Record<string, unknown>, side: 'Start' | 'End'): string {
  const obj = (row[side] ?? row[side.toLowerCase()]) as Record<string, unknown> | undefined
  const fromObj = obj && typeof obj === 'object'
    ? (obj.Id ?? obj.id ?? obj.TaskId ?? obj.taskId ?? obj.TaskGuid ?? obj.taskGuid)
    : undefined
  const fallback = side === 'Start'
    ? (row.StartId ?? row.startId ?? row.StartTaskId ?? row.startTaskId)
    : (row.EndId ?? row.endId ?? row.EndTaskId ?? row.endTaskId)
  const value = fromObj ?? fallback
  return value == null ? '' : cleanGuid(String(value))
}
