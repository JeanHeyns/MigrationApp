import * as XLSX from 'xlsx'
import type {
  PoFetchedData, PoProject, PoTask, PoResource, PoAssignment, PoTaskDependency,
  PoProjectTeamMember, PoCustomField, PoLookupTable, PoCustomFieldType,
  FileUploadProjectOverride,
} from '../models/projectOnline.types'
import type { LoaderWarning, LoaderError, LoaderResult } from './fileUpload/types'
import { LoaderFileError } from './fileUpload/types'
import { FALLBACK_SCHEDULE_MODES } from './plannerPremium/scheduleMode'

// ─── Constants ────────────────────────────────────────────────────────────────

const CURRENT_TEMPLATE_VERSION = '2.0'
const WARNING_CAP = 100

// Valid FieldType values in the template (wider than PO API types)
const VALID_TEMPLATE_FIELD_TYPES = ['Text', 'Memo', 'Number', 'Cost', 'Date', 'Boolean', 'Choice', 'MultiChoice', 'Lookup'] as const
type TemplateFieldType = typeof VALID_TEMPLATE_FIELD_TYPES[number]

// Maps template FieldType vocabulary → PoCustomFieldType used downstream
const TEMPLATE_TO_PO_FIELD_TYPE: Record<TemplateFieldType, PoCustomFieldType> = {
  Text:        'Text',
  Memo:        'Memo',
  Number:      'Number',
  Cost:        'Cost',
  Date:        'Date',
  Boolean:     'Boolean',
  Choice:      'Choice',
  MultiChoice: 'MultiChoice',
  Lookup:      'Lookup',
}

const VALID_ENTITY_TYPES = ['Project', 'Task', 'Resource'] as const

// ─── Template definition ──────────────────────────────────────────────────────

const TEMPLATE_SHEETS: Record<string, unknown[][]> = {
  Projects: [
    ['ProjectId', 'ProjectName', 'Description', 'StartDate', 'FinishDate', 'Status', 'OwnerEmail', 'OwnerName', 'WorkHourTemplateName', 'ScheduleMode', 'HoursPerDay', 'HoursPerWeek', 'DaysPerMonth', 'Department', 'Budget'],
    ['P001', 'Example Project', 'A sample project', '2024-01-15', '2024-12-31', 'Active', 'jane.smith@contoso.com', 'Jane Smith', '', '', '', '', '', 'IT', 50000],
  ],
  Tasks: [
    ['TaskId', 'ProjectId', 'TaskName', 'StartDate', 'FinishDate', 'DurationDays', 'PercentComplete', 'OutlineLevel', 'OutlineNumber', 'ParentTaskId', 'IsMilestone', 'IsSummary', 'Priority'],
    ['T001', 'P001', 'Phase 1',  '2024-01-15', '2024-03-31', 75,  0,   1, '1',   '',     'FALSE', 'TRUE',  500],
    ['T002', 'P001', 'Design',   '2024-01-15', '2024-02-15', 31, 100,  2, '1.1', 'T001', 'FALSE', 'FALSE', 500],
    ['T003', 'P001', 'Kickoff',  '2024-01-15', '2024-01-15',  0,  0,   2, '1.2', 'T001', 'TRUE',  'FALSE', 500],
  ],
  Resources: [
    ['ResourceId', 'ResourceName', 'Email'],
    ['R001', 'Jane Smith',  'jane.smith@contoso.com'],
    ['R002', 'John Doe',    'john.doe@contoso.com'],
  ],
  Assignments: [
    ['ProjectId', 'TaskId', 'ResourceId', 'Units'],
    ['P001', 'T002', 'R001', 100],
    ['P001', 'T002', 'R002',  50],
  ],
  Dependencies: [
    ['DependencyId', 'ProjectId', 'PredecessorTaskId', 'SuccessorTaskId', 'DependencyType'],
    ['D001', 'P001', 'T002', 'T003', 'FS'],
  ],
  TeamMembers: [
    ['ProjectId', 'ResourceId'],
    ['P001', 'R001'],
    ['P001', 'R002'],
  ],
  CustomFields: [
    ['FieldName', 'ColumnHeader', 'EntityType', 'FieldType', 'LookupTableName', 'DataverseLogicalName'],
    ['Department',     'Department',     'Project', 'Lookup', 'Departments', ''],
    ['Budget',         'Budget',         'Project', 'Cost',   '',            ''],
    ['Priority Score', 'PriorityScore',  'Task',    'Number', '',            ''],
  ],
  LookupValues: [
    ['LookupTableName', 'EntryValue'],
    ['Departments', 'IT'],
    ['Departments', 'Finance'],
    ['Departments', 'Operations'],
    ['Departments', 'HR'],
  ],
}

const SHEET_ORDER = ['_Instructions', '_Meta', 'Projects', 'Tasks', 'Resources', 'Assignments', 'Dependencies', 'TeamMembers', 'CustomFields', 'LookupValues']

const INSTRUCTIONS_ROWS: string[][] = [
  ['How to use this template'],
  ['─────────────────────────'],
  [''],
  ['1. Fill in your data on the data sheets (Projects, Tasks, Resources, etc.)'],
  ['2. Save the file as .xlsx'],
  ['3. In the Migration app, choose "File upload" as data source and upload this file'],
  [''],
  ['Which sheets do I need?'],
  ['───────────────────────'],
  [''],
  ['You don\'t need to fill in everything. Use what you have:'],
  [''],
  ['- Projects: at least one row recommended. Add custom field values as extra columns. Five optional columns control scheduling:'],
  ['    WorkHourTemplateName — name of an existing work hour template in the target Dataverse (case-insensitive match).'],
  ['    ScheduleMode — one of: Fixed Effort, Fixed Duration, Fixed Units, Fixed Duration / Effort Driven, Fixed Units / Effort Driven.'],
  ['    HoursPerDay — hours per working day (0 < value ≤ 24).'],
  ['    HoursPerWeek — hours per working week (0 < value ≤ 168).'],
  ['    DaysPerMonth — working days per month (0 < value ≤ 31).'],
  ['    Leave any of these blank to use the global defaults configured in Step 1.'],
  ['- Tasks: fill in if you want to migrate tasks and the schedule.'],
  ['- Resources: people working on projects. Required for Assignments and TeamMembers.'],
  ['- Assignments: which resources work on which tasks. Requires Tasks and Resources.'],
  ['- Dependencies: task predecessor/successor links. Requires Tasks.'],
  ['- TeamMembers: project membership. Can be left empty — derived from Assignments.'],
  ['- CustomFields: definitions of custom columns. Lookup fields need LookupValues.'],
  ['- LookupValues: values that lookup-type custom fields can pick from.'],
  [''],
  ['Rules'],
  ['─────'],
  [''],
  ['- Do not rename sheets or columns. The app will refuse files with renamed structure.'],
  ['- Empty rows are fine — they will be skipped.'],
  ['- If you type dates, use the format YYYY-MM-DD. Otherwise use Excel\'s date cell type.'],
  ['- Boolean values: TRUE or FALSE. Empty means "not set".'],
  ['- IDs (ProjectId, TaskId, ResourceId) must be unique within their sheet.'],
  ['- References (e.g. TaskId in Assignments) must match an ID in the file.'],
  [''],
  ['FieldType values for CustomFields sheet:'],
  ['  Text, Memo, Number, Cost, Date, Boolean, Choice, MultiChoice, Lookup'],
  [''],
  ['EntityType values for CustomFields sheet:'],
  ['  Project, Task, Resource'],
  [''],
  ['DependencyType values for Dependencies sheet:'],
  ['  FS (Finish-to-Start), SS (Start-to-Start), FF (Finish-to-Finish), SF (Start-to-Finish)'],
]

export function generateTemplate(): Blob {
  const wb = XLSX.utils.book_new()

  // _Instructions sheet
  const instrWs = XLSX.utils.aoa_to_sheet(INSTRUCTIONS_ROWS)
  instrWs['!cols'] = [{ wch: 80 }]
  boldCell(instrWs, 'A1')
  boldCell(instrWs, 'A9')
  boldCell(instrWs, 'A23')
  boldCell(instrWs, 'A32')
  boldCell(instrWs, 'A36')
  boldCell(instrWs, 'A40')
  XLSX.utils.book_append_sheet(wb, instrWs, '_Instructions')

  // _Meta sheet
  const metaRows = [
    ['templateVersion', 'generatedAt', 'generatedBy'],
    [CURRENT_TEMPLATE_VERSION, new Date().toISOString(), 'Project Online Migrator'],
  ]
  const metaWs = XLSX.utils.aoa_to_sheet(metaRows)
  boldHeaderRow(metaWs)
  XLSX.utils.book_append_sheet(wb, metaWs, '_Meta')

  // Data sheets
  // NOTE: SheetJS 0.18.5 community build does NOT write !dataValidations — silently dropped.
  // Dropdowns for IsMilestone, IsSummary, DependencyType, EntityType, FieldType require
  // switching generateTemplate() to exceljs. Confirmed via spike: round-trip test returned
  // undefined for !dataValidations. Decision deferred to user — see file-upload-spec §8.1.
  for (const sheetName of SHEET_ORDER.filter(n => !['_Instructions', '_Meta'].includes(n))) {
    const rows = TEMPLATE_SHEETS[sheetName]
    if (!rows) continue
    const ws = XLSX.utils.aoa_to_sheet(rows)
    boldHeaderRow(ws)
    XLSX.utils.book_append_sheet(wb, ws, sheetName)
  }

  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

function boldHeaderRow(ws: XLSX.WorkSheet): void {
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')
  for (let c = range.s.c; c <= range.e.c; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c })
    if (ws[addr]) ws[addr].s = { font: { bold: true } }
  }
}

function boldCell(ws: XLSX.WorkSheet, addr: string): void {
  if (ws[addr]) ws[addr].s = { font: { bold: true } }
}

// ─── Structural validation ────────────────────────────────────────────────────

const REQUIRED_SHEETS = ['Projects'] as const

const REQUIRED_HEADERS: Record<string, string[]> = {
  Projects:     ['ProjectId', 'ProjectName'],
  Tasks:        ['TaskId', 'ProjectId', 'TaskName'],
  Resources:    ['ResourceId', 'ResourceName'],
  Assignments:  ['ProjectId', 'TaskId', 'ResourceId'],
  Dependencies: ['ProjectId', 'PredecessorTaskId', 'SuccessorTaskId'],
  TeamMembers:  ['ProjectId', 'ResourceId'],
  CustomFields: ['FieldName', 'ColumnHeader', 'EntityType', 'FieldType'],
  LookupValues: ['LookupTableName', 'EntryValue'],
}

function getSheetHeaders(ws: XLSX.WorkSheet): string[] {
  if (!ws || !ws['!ref']) return []
  const range = XLSX.utils.decode_range(ws['!ref'])
  const headers: string[] = []
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c })]
    headers.push(cell ? String(cell.v ?? '').trim() : '')
  }
  return headers
}

function parseMajorVersion(version: string): number {
  const major = parseInt(version.split('.')[0] ?? '', 10)
  return isNaN(major) ? -1 : major
}

function parseMetaSheet(wb: XLSX.WorkBook): { templateVersion: string; generatedAt?: string } {
  const ws = wb.Sheets['_Meta']
  if (!ws) return { templateVersion: '' }
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: false })
  const first = rows[0]
  if (!first) return { templateVersion: '' }
  return {
    templateVersion: String(first['templateVersion'] ?? '').trim(),
    generatedAt: String(first['generatedAt'] ?? '').trim() || undefined,
  }
}

function validateStructure(wb: XLSX.WorkBook): { errors: LoaderError[]; warnings: LoaderWarning[] } {
  const errors: LoaderError[] = []
  const warnings: LoaderWarning[] = []

  // 1. _Meta presence + version
  if (!wb.SheetNames.includes('_Meta')) {
    errors.push({
      code: 'MISSING_META_SHEET',
      message: 'This file is not a recognized migration template. Please download a fresh template from the app.',
    })
    return { errors, warnings }
  }

  const meta = parseMetaSheet(wb)
  if (!meta.templateVersion) {
    errors.push({
      code: 'MISSING_META_SHEET',
      sheet: '_Meta',
      message: 'Template version not found in _Meta sheet. Please download a fresh template.',
    })
    return { errors, warnings }
  }

  const major = parseMajorVersion(meta.templateVersion)
  if (major < 0) {
    errors.push({
      code: 'UNRECOGNIZED_TEMPLATE_VERSION',
      sheet: '_Meta',
      message: `Unrecognized templateVersion "${meta.templateVersion}". Please download a fresh template.`,
    })
    return { errors, warnings }
  }
  if (major < 2) {
    errors.push({
      code: 'TEMPLATE_TOO_OLD',
      sheet: '_Meta',
      message: `This template is from an older app version (v${meta.templateVersion}). Please download the current template and copy your data into it.`,
    })
    return { errors, warnings }
  }
  if (major > 2) {
    warnings.push({
      sheet: '_Meta',
      code: 'TEMPLATE_VERSION_NEWER',
      message: `Template version ${meta.templateVersion} is newer than this app version (v${CURRENT_TEMPLATE_VERSION}). Some fields may be ignored.`,
    })
  }

  // 2. Required sheets (exact, case-sensitive)
  for (const req of REQUIRED_SHEETS) {
    if (!wb.SheetNames.includes(req)) {
      const candidate = wb.SheetNames.find(s => s.toLowerCase() === req.toLowerCase())
      if (candidate) {
        errors.push({
          code: 'RENAMED_SHEET_DETECTED',
          sheet: candidate,
          message: `Sheet "${candidate}" found but expected "${req}". Sheet names must match exactly — do not rename sheets.`,
        })
      } else {
        errors.push({
          code: 'MISSING_REQUIRED_SHEET',
          message: `Required sheet "${req}" not found.`,
        })
      }
    }
  }

  // 3. Per-sheet required column headers (only sheets that are present)
  for (const [sheet, requiredCols] of Object.entries(REQUIRED_HEADERS)) {
    if (!wb.SheetNames.includes(sheet)) continue
    const actual = getSheetHeaders(wb.Sheets[sheet])
    for (const required of requiredCols) {
      if (!actual.includes(required)) {
        const candidate = actual.find(h => h.toLowerCase() === required.toLowerCase())
        errors.push({
          code: 'MISSING_REQUIRED_COLUMN',
          sheet,
          message: candidate
            ? `Column "${candidate}" found but expected "${required}" in sheet "${sheet}". Column names must match exactly.`
            : `Required column "${required}" missing in sheet "${sheet}".`,
        })
      }
    }
  }

  return { errors, warnings }
}

// ─── Parsing helpers ──────────────────────────────────────────────────────────

function sheetToRows(wb: XLSX.WorkBook, name: string): Record<string, unknown>[] {
  const ws = wb.Sheets[name]
  if (!ws) return []
  // raw: true preserves Date objects (from cellDates: true) and numbers as-is
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: true })
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return isNaN(v) ? undefined : v
  const n = parseFloat(String(v))
  return isNaN(n) ? undefined : n
}

function bool(v: unknown): boolean | undefined {
  if (v == null || v === '') return undefined
  if (typeof v === 'boolean') return v
  const s = String(v).trim().toUpperCase()
  if (s === 'TRUE' || s === '1' || s === 'YES') return true
  if (s === 'FALSE' || s === '0' || s === 'NO') return false
  return undefined
}

function toISODate(
  v: unknown,
  sheet: string,
  row: number,
  column: string,
  warnings: LoaderWarning[],
  capCounts: Map<string, number>,
): string | undefined {
  if (v == null || v === '') return undefined
  if (v instanceof Date) {
    if (isNaN(v.getTime())) {
      pushWarning(warnings, capCounts, {
        sheet, row, column,
        code: 'INVALID_DATE_CLEARED',
        message: `Invalid date in column "${column}". Field cleared.`,
      })
      return undefined
    }
    return v.toISOString().split('T')[0]
  }
  const s = String(v).trim()
  if (!s) return undefined
  // ISO date prefix
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.split('T')[0]
  // Last-resort parse
  const parsed = new Date(s)
  if (!isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0]
  pushWarning(warnings, capCounts, {
    sheet, row, column,
    code: 'INVALID_DATE_CLEARED',
    message: `Could not parse date "${s}" in column "${column}". Field cleared.`,
  })
  return undefined
}

function pushWarning(
  warnings: LoaderWarning[],
  capCounts: Map<string, number>,
  w: LoaderWarning,
): void {
  const key = `${w.sheet}:${w.code}`
  const n = (capCounts.get(key) ?? 0) + 1
  capCounts.set(key, n)
  if (n <= WARNING_CAP) {
    warnings.push(w)
  } else if (n === WARNING_CAP + 1) {
    warnings.push({
      sheet: w.sheet,
      code: w.code,
      message: `(${w.sheet} / ${w.code}): further warnings suppressed after ${WARNING_CAP} entries.`,
    })
  }
}

// ─── Main parser ──────────────────────────────────────────────────────────────

export function parseWorkbook(file: File): Promise<LoaderResult> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer)
        const wb = XLSX.read(data, { type: 'array', cellDates: true })

        const { errors, warnings: structuralWarnings } = validateStructure(wb)
        if (errors.length > 0) {
          reject(new LoaderFileError(errors))
          return
        }

        const { fetchedData, warnings: parseWarnings } = parseSheets(wb)
        resolve({
          fetchedData,
          warnings: [...structuralWarnings, ...parseWarnings],
          errors: [],
        })
      } catch (err) {
        if (err instanceof LoaderFileError) {
          reject(err)
        } else {
          reject(new LoaderFileError([{
            code: 'CORRUPTED_FILE',
            message: `Could not parse file: ${String(err)}`,
          }]))
        }
      }
    }
    reader.onerror = () => reject(new LoaderFileError([{
      code: 'CORRUPTED_FILE',
      message: 'Failed to read file.',
    }]))
    reader.readAsArrayBuffer(file)
  })
}

function slugify(s: string): string {
  return s.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_]/g, '')
}

function parseSheets(wb: XLSX.WorkBook): { fetchedData: PoFetchedData; warnings: LoaderWarning[] } {
  const warnings: LoaderWarning[] = []
  const capCounts = new Map<string, number>()

  // ── 1. CustomFields sheet ────────────────────────────────────────────────
  const cfRows = sheetToRows(wb, 'CustomFields')
  const customFields: PoCustomField[] = cfRows
    .map((r, i): PoCustomField | null => {
      const fieldName = str(r['FieldName'])
      if (!fieldName) return null // silently skip empty row

      const rawType = str(r['FieldType'])
      if (!VALID_TEMPLATE_FIELD_TYPES.includes(rawType as TemplateFieldType)) {
        pushWarning(warnings, capCounts, {
          sheet: 'CustomFields', row: i + 2, column: 'FieldType',
          code: 'INVALID_FIELD_TYPE_SKIPPED',
          message: `Field "${fieldName}" has unknown FieldType "${rawType}". Valid values: ${VALID_TEMPLATE_FIELD_TYPES.join(', ')}. Row skipped.`,
        })
        return null
      }

      const fieldType = rawType as TemplateFieldType
      if (fieldType === 'Lookup' && !str(r['LookupTableName'])) {
        pushWarning(warnings, capCounts, {
          sheet: 'CustomFields', row: i + 2, column: 'LookupTableName',
          code: 'MISSING_LOOKUP_TABLE',
          message: `Lookup field "${fieldName}" has no LookupTableName. Row skipped.`,
        })
        return null
      }

      const entityTypeRaw = str(r['EntityType'])
      const entityType = VALID_ENTITY_TYPES.includes(entityTypeRaw as typeof VALID_ENTITY_TYPES[number])
        ? (entityTypeRaw as 'Project' | 'Task' | 'Resource')
        : 'Project' // default silently — EntityType has a dropdown; unknown values treated as Project

      const columnHeader = str(r['ColumnHeader']) || fieldName

      return {
        CustomFieldId: `cf_${i}_${slugify(fieldName)}`,
        CustomFieldName: fieldName,
        CustomFieldEntityType: entityType,
        CustomFieldType: TEMPLATE_TO_PO_FIELD_TYPE[fieldType],
        // FIXME: CustomFieldTypeValue unused by writers in the file-upload path; 0 is intentional
        CustomFieldTypeValue: 0,
        LookupTableName: str(r['LookupTableName']) || undefined,
        ODataFieldName: columnHeader,
        DataverseLogicalName: str(r['DataverseLogicalName']) || undefined,
      }
    })
    .filter((cf): cf is PoCustomField => cf !== null)

  // ── 2. LookupValues sheet ────────────────────────────────────────────────
  const lvRows = sheetToRows(wb, 'LookupValues')
  const lookupEntriesMap = new Map<string, string[]>()
  const lvSeen = new Set<string>()
  for (const r of lvRows) {
    const table = str(r['LookupTableName'])
    const val   = str(r['EntryValue'])
    if (!table || !val) continue
    const key = `${table}||${val}`
    if (lvSeen.has(key)) continue // silently skip duplicate (whitespace-cleaned empty also skipped above)
    lvSeen.add(key)
    const arr = lookupEntriesMap.get(table) ?? []
    arr.push(val)
    lookupEntriesMap.set(table, arr)
  }
  const lookupTables: PoLookupTable[] = [...lookupEntriesMap.entries()].map(([tableName, vals]) => {
    const uid = `lt_${slugify(tableName)}`
    return {
      LookupTableUID: uid,
      LookupTableName: tableName,
      entries: vals.map((val, i) => ({
        LookupTableUID: uid,
        LookupEntryUID: `${uid}_${i}`,
        LookupEntryFullValue: val,
        LookupEntryValue: val,
        SortIndex: i,
      })),
    }
  })

  // Wire LookupTableUID into custom fields
  const ltByName = new Map(lookupTables.map(lt => [lt.LookupTableName, lt]))
  for (const cf of customFields) {
    if (cf.LookupTableName) {
      if (ltByName.has(cf.LookupTableName)) {
        cf.CustomFieldLookupTableUID = ltByName.get(cf.LookupTableName)!.LookupTableUID
      } else {
        // Table name referenced but not present in LookupValues — warn but keep the CF
        pushWarning(warnings, capCounts, {
          sheet: 'CustomFields',
          column: 'LookupTableName',
          code: 'MISSING_LOOKUP_TABLE',
          message: `Custom field "${cf.CustomFieldName}" references LookupTable "${cf.LookupTableName}" which has no entries in LookupValues. Lookup binding will be unavailable.`,
        })
      }
    }
  }

  // ── 3. Resources ─────────────────────────────────────────────────────────
  const resourceSeenIds = new Set<string>()
  const resources: PoResource[] = sheetToRows(wb, 'Resources')
    .map((r, i): PoResource | null => {
      const id = str(r['ResourceId'])
      const name = str(r['ResourceName'])
      if (!id && !name) return null
      if (id && resourceSeenIds.has(id)) {
        pushWarning(warnings, capCounts, {
          sheet: 'Resources', row: i + 2, column: 'ResourceId',
          code: 'DUPLICATE_ID_SKIPPED',
          message: `Duplicate ResourceId "${id}". Row skipped.`,
        })
        return null
      }
      if (id) resourceSeenIds.add(id)
      return {
        ResourceId:           id,
        ResourceUID:          id,
        ResourceName:         name,
        ResourceEmailAddress: str(r['Email']) || undefined,
      }
    })
    .filter((r): r is PoResource => r !== null)

  // ── 4. Projects ──────────────────────────────────────────────────────────
  const projectCFs = customFields.filter(cf => cf.CustomFieldEntityType === 'Project')
  const expectedProjectCFHeaders = new Set(projectCFs.map(cf => cf.ODataFieldName!))
  const standardProjectHeaders = new Set(['ProjectId', 'ProjectName', 'Description', 'StartDate', 'FinishDate', 'Status', 'OwnerEmail', 'OwnerName', 'WorkHourTemplateName', 'ScheduleMode', 'HoursPerDay', 'HoursPerWeek', 'DaysPerMonth'])

  // Warn once per unrecognized extra column (before row iteration)
  if (wb.Sheets['Projects']) {
    for (const h of getSheetHeaders(wb.Sheets['Projects'])) {
      if (h && !standardProjectHeaders.has(h) && !expectedProjectCFHeaders.has(h)) {
        pushWarning(warnings, capCounts, {
          sheet: 'Projects', column: h,
          code: 'UNRECOGNIZED_PROJECT_CF_COLUMN',
          message: `Column "${h}" in Projects sheet is not a standard field and not defined in CustomFields. Values will be ignored.`,
        })
      }
    }
  }

  const projectSeenIds = new Set<string>()
  const fileUploadProjectOverrides: FileUploadProjectOverride[] = []

  const projects: PoProject[] = sheetToRows(wb, 'Projects')
    .map((r, i) => {
      const rawId = str(r['ProjectId'])
      const name  = str(r['ProjectName'])
      if (!rawId && !name) return null // fully empty row

      let projectId = rawId
      if (!projectId) {
        projectId = `p_${slugify(name)}`
        pushWarning(warnings, capCounts, {
          sheet: 'Projects', row: i + 2, column: 'ProjectId',
          code: 'MISSING_ID_GENERATED',
          message: `Project "${name}" has no ProjectId. Auto-generated: "${projectId}".`,
        })
      }

      if (projectSeenIds.has(projectId)) {
        pushWarning(warnings, capCounts, {
          sheet: 'Projects', row: i + 2, column: 'ProjectId',
          code: 'DUPLICATE_ID_SKIPPED',
          message: `Duplicate ProjectId "${projectId}". Row skipped.`,
        })
        return null
      }
      projectSeenIds.add(projectId)

      const ownerEmail = str(r['OwnerEmail'])
      const ownerName  = str(r['OwnerName'])
      const ownerResource = ownerEmail
        ? resources.find(res => res.ResourceEmailAddress?.toLowerCase() === ownerEmail.toLowerCase())
        : undefined

      const proj: PoProject = {
        ProjectId:              projectId,
        ProjectName:            name,
        ProjectDescription:     str(r['Description'])  || undefined,
        ProjectStartDate:       toISODate(r['StartDate'],  'Projects', i + 2, 'StartDate',  warnings, capCounts),
        ProjectFinishDate:      toISODate(r['FinishDate'], 'Projects', i + 2, 'FinishDate', warnings, capCounts),
        ProjectStatus:          str(r['Status'])        || undefined,
        ProjectOwnerName:       ownerName               || undefined,
        ProjectOwnerResourceId:  (ownerResource?.ResourceId  ?? (ownerEmail || undefined)),
        ProjectOwnerResourceUid: (ownerResource?.ResourceUID ?? (ownerEmail || undefined)),
      }

      for (const cf of projectCFs) {
        const col = cf.ODataFieldName!
        if (col in r) proj[col] = r[col]
      }

      // ── Working time override columns ─────────────────────────────────────
      const whtName = str(r['WorkHourTemplateName'])
      const smLabel = str(r['ScheduleMode'])
      const hpd = num(r['HoursPerDay'])
      const hpw = num(r['HoursPerWeek'])
      const dpm = num(r['DaysPerMonth'])

      const hasOverride = whtName || smLabel || hpd !== undefined || hpw !== undefined || dpm !== undefined
      if (hasOverride) {
        const override: FileUploadProjectOverride = { projectId }

        if (whtName) {
          override.workHourTemplateName = whtName
        }

        if (smLabel) {
          const match = FALLBACK_SCHEDULE_MODES.find(
            o => o.label.trim().toLowerCase() === smLabel.trim().toLowerCase(),
          )
          if (match) {
            override.scheduleModeLabel = smLabel
          } else {
            pushWarning(warnings, capCounts, {
              sheet: 'Projects', row: i + 2, column: 'ScheduleMode',
              code: 'UNKNOWN_SCHEDULE_MODE',
              message: `Unknown schedule mode "${smLabel}" for project "${name}". Field ignored. Valid values: ${FALLBACK_SCHEDULE_MODES.map(o => o.label).join(', ')}.`,
            })
          }
        }

        if (hpd !== undefined) {
          if (hpd <= 0 || hpd > 24) {
            pushWarning(warnings, capCounts, {
              sheet: 'Projects', row: i + 2, column: 'HoursPerDay',
              code: 'WORKING_TIME_OUT_OF_RANGE',
              message: `HoursPerDay ${hpd} out of range (0 < value ≤ 24) for project "${name}". Field ignored.`,
            })
          } else {
            override.hoursPerDay = hpd
          }
        }

        if (hpw !== undefined) {
          if (hpw <= 0 || hpw > 168) {
            pushWarning(warnings, capCounts, {
              sheet: 'Projects', row: i + 2, column: 'HoursPerWeek',
              code: 'WORKING_TIME_OUT_OF_RANGE',
              message: `HoursPerWeek ${hpw} out of range (0 < value ≤ 168) for project "${name}". Field ignored.`,
            })
          } else {
            override.hoursPerWeek = hpw
          }
        }

        if (dpm !== undefined) {
          if (dpm <= 0 || dpm > 31) {
            pushWarning(warnings, capCounts, {
              sheet: 'Projects', row: i + 2, column: 'DaysPerMonth',
              code: 'WORKING_TIME_OUT_OF_RANGE',
              message: `DaysPerMonth ${dpm} out of range (0 < value ≤ 31) for project "${name}". Field ignored.`,
            })
          } else {
            override.daysPerMonth = dpm
          }
        }

        if (override.workHourTemplateName || override.scheduleModeLabel || override.hoursPerDay !== undefined || override.hoursPerWeek !== undefined || override.daysPerMonth !== undefined) {
          fileUploadProjectOverrides.push(override)
        }
      }

      return proj
    })
    .filter((p): p is PoProject => p !== null)

  // ── 5. Tasks ─────────────────────────────────────────────────────────────
  const projectIds = new Set(projects.map(p => p.ProjectId))

  const standardTaskHeaders = new Set(['TaskId', 'ProjectId', 'TaskName', 'StartDate', 'FinishDate', 'DurationDays', 'PercentComplete', 'OutlineLevel', 'OutlineNumber', 'ParentTaskId', 'IsMilestone', 'IsSummary', 'Priority'])

  // Warn once per unrecognized task column
  if (wb.Sheets['Tasks']) {
    for (const h of getSheetHeaders(wb.Sheets['Tasks'])) {
      if (h && !standardTaskHeaders.has(h)) {
        pushWarning(warnings, capCounts, {
          sheet: 'Tasks', column: h,
          code: 'TASK_CUSTOM_FIELD_IGNORED',
          message: `Column "${h}" in Tasks sheet looks like a custom field. Task custom fields are not migrated and will be ignored.`,
        })
      }
    }
  }

  const tasks: PoTask[] = sheetToRows(wb, 'Tasks')
    .map((r, i): PoTask | null => {
      const id   = str(r['TaskId'])
      const name = str(r['TaskName'])
      const pid  = str(r['ProjectId'])
      if (!id && !name) return null

      const taskId = id || `t_${slugify(name)}`

      if (!projectIds.has(pid)) {
        pushWarning(warnings, capCounts, {
          sheet: 'Tasks', row: i + 2, column: 'ProjectId',
          code: 'INVALID_REFERENCE_SKIPPED',
          message: `Task "${taskId}" references unknown ProjectId "${pid}". Row skipped.`,
        })
        return null
      }

      const durationDays = num(r['DurationDays'])
      return {
        TaskId:                taskId,
        ProjectId:             pid,
        TaskName:              name,
        TaskStartDate:         toISODate(r['StartDate'],  'Tasks', i + 2, 'StartDate',  warnings, capCounts),
        TaskFinishDate:        toISODate(r['FinishDate'], 'Tasks', i + 2, 'FinishDate', warnings, capCounts),
        TaskDurationInMinutes: durationDays != null ? Math.round(durationDays * 8 * 60) : undefined,
        TaskPercentCompleted:  num(r['PercentComplete']),
        TaskOutlineLevel:      num(r['OutlineLevel']),
        TaskOutlineNumber:     str(r['OutlineNumber'])  || undefined,
        TaskParentId:          str(r['ParentTaskId'])   || undefined,
        TaskIsMilestone:       bool(r['IsMilestone']),
        TaskIsSummary:         bool(r['IsSummary']),
        TaskPriority:          num(r['Priority']),
      }
    })
    .filter((t): t is PoTask => t !== null)

  // Index tasks per project for reference checks
  const taskByProject = new Map<string, Set<string>>()
  for (const t of tasks) {
    if (!taskByProject.has(t.ProjectId)) taskByProject.set(t.ProjectId, new Set())
    taskByProject.get(t.ProjectId)!.add(t.TaskId)
  }
  // Build row index for ParentTaskId warning (taskId → rowIndex+2)
  const taskRowIndex = new Map<string, number>()
  sheetToRows(wb, 'Tasks').forEach((r, i) => {
    const id = str(r['TaskId'])
    if (id) taskRowIndex.set(id, i + 2)
  })

  // Two-pass: clean up invalid ParentTaskId references
  for (const t of tasks) {
    if (t.TaskParentId && !taskByProject.get(t.ProjectId)?.has(t.TaskParentId)) {
      pushWarning(warnings, capCounts, {
        sheet: 'Tasks', row: taskRowIndex.get(t.TaskId), column: 'ParentTaskId',
        code: 'INVALID_REFERENCE_CLEARED',
        message: `Task "${t.TaskId}" references unknown ParentTaskId "${t.TaskParentId}". Field cleared.`,
      })
      t.TaskParentId = undefined
    }
  }

  const resourceIds = new Set(resources.map(r => r.ResourceId).filter(Boolean) as string[])

  // ── 6. Assignments ───────────────────────────────────────────────────────
  const assignments: PoAssignment[] = sheetToRows(wb, 'Assignments')
    .map((r, i): PoAssignment | null => {
      const pid = str(r['ProjectId'])
      const tid = str(r['TaskId'])
      const rid = str(r['ResourceId'])
      if (!pid && !tid && !rid) return null

      if (!projectIds.has(pid)) {
        pushWarning(warnings, capCounts, {
          sheet: 'Assignments', row: i + 2,
          code: 'INVALID_REFERENCE_SKIPPED',
          message: `ProjectId "${pid}" not found. Row skipped.`,
        })
        return null
      }
      if (!taskByProject.get(pid)?.has(tid)) {
        pushWarning(warnings, capCounts, {
          sheet: 'Assignments', row: i + 2,
          code: 'INVALID_REFERENCE_SKIPPED',
          message: `TaskId "${tid}" not in project "${pid}". Row skipped.`,
        })
        return null
      }
      if (!resourceIds.has(rid)) {
        pushWarning(warnings, capCounts, {
          sheet: 'Assignments', row: i + 2,
          code: 'INVALID_REFERENCE_SKIPPED',
          message: `ResourceId "${rid}" not found. Row skipped.`,
        })
        return null
      }

      return {
        AssignmentId:    `a_${i}`,
        ProjectId:       pid,
        TaskId:          tid,
        ResourceUID:     rid,
        ResourceId:      rid,
        AssignmentUnits: num(r['Units']),
      }
    })
    .filter((a): a is PoAssignment => a !== null)

  // ── 7. Dependencies ──────────────────────────────────────────────────────
  const dependencies: PoTaskDependency[] = sheetToRows(wb, 'Dependencies')
    .map((r, i): PoTaskDependency | null => {
      const pid  = str(r['ProjectId'])
      const pred = str(r['PredecessorTaskId'])
      const succ = str(r['SuccessorTaskId'])
      if (!pid && !pred && !succ) return null

      if (!projectIds.has(pid)) {
        pushWarning(warnings, capCounts, {
          sheet: 'Dependencies', row: i + 2,
          code: 'INVALID_REFERENCE_SKIPPED',
          message: `ProjectId "${pid}" not found. Row skipped.`,
        })
        return null
      }
      if (!taskByProject.get(pid)?.has(pred)) {
        pushWarning(warnings, capCounts, {
          sheet: 'Dependencies', row: i + 2, column: 'PredecessorTaskId',
          code: 'INVALID_REFERENCE_SKIPPED',
          message: `PredecessorTaskId "${pred}" not in project "${pid}". Row skipped.`,
        })
        return null
      }
      if (!taskByProject.get(pid)?.has(succ)) {
        pushWarning(warnings, capCounts, {
          sheet: 'Dependencies', row: i + 2, column: 'SuccessorTaskId',
          code: 'INVALID_REFERENCE_SKIPPED',
          message: `SuccessorTaskId "${succ}" not in project "${pid}". Row skipped.`,
        })
        return null
      }

      const rawDepType = str(r['DependencyType']).toUpperCase()
      const validDepTypes = ['FS', 'SS', 'FF', 'SF']
      let depType = normalizeDependencyType(str(r['DependencyType']))
      if (rawDepType && !validDepTypes.includes(rawDepType)) {
        pushWarning(warnings, capCounts, {
          sheet: 'Dependencies', row: i + 2, column: 'DependencyType',
          code: 'DEPENDENCY_TYPE_DEFAULTED',
          message: `Unknown DependencyType "${str(r['DependencyType'])}". Defaulted to "FS".`,
        })
        depType = 'FS'
      }

      return {
        DependencyId:      str(r['DependencyId']) || `d_${i}`,
        ProjectId:         pid,
        PredecessorTaskId: pred,
        SuccessorTaskId:   succ,
        DependencyType:    depType,
      }
    })
    .filter((d): d is PoTaskDependency => d !== null)

  // ── 8. TeamMembers ───────────────────────────────────────────────────────
  let teamMembers: PoProjectTeamMember[] = sheetToRows(wb, 'TeamMembers')
    .map((r, i): PoProjectTeamMember | null => {
      const pid = str(r['ProjectId'])
      const rid = str(r['ResourceId'])
      if (!pid && !rid) return null

      if (!projectIds.has(pid)) {
        pushWarning(warnings, capCounts, {
          sheet: 'TeamMembers', row: i + 2, column: 'ProjectId',
          code: 'INVALID_REFERENCE_SKIPPED',
          message: `ProjectId "${pid}" not found. Row skipped.`,
        })
        return null
      }
      if (!resourceIds.has(rid)) {
        pushWarning(warnings, capCounts, {
          sheet: 'TeamMembers', row: i + 2, column: 'ResourceId',
          code: 'INVALID_REFERENCE_SKIPPED',
          message: `ResourceId "${rid}" not found. Row skipped.`,
        })
        return null
      }

      const res = resources.find(re => re.ResourceId === rid)
      return {
        ProjectId:    pid,
        ResourceUID:  rid,
        ResourceId:   rid,
        ResourceName: res?.ResourceName,
      }
    })
    .filter((tm): tm is PoProjectTeamMember => tm !== null)

  // TeamMembers derivation: if sheet empty but assignments exist, derive from assignments
  if (teamMembers.length === 0 && assignments.length > 0) {
    const derived = new Map<string, PoProjectTeamMember>()
    for (const a of assignments) {
      const key = `${a.ProjectId}__${a.ResourceId}`
      if (derived.has(key)) continue
      const res = resources.find(r => r.ResourceId === a.ResourceId)
      derived.set(key, {
        ProjectId:    a.ProjectId,
        ResourceUID:  a.ResourceId!,
        ResourceId:   a.ResourceId,
        ResourceName: res?.ResourceName,
      })
    }
    teamMembers = [...derived.values()]
    warnings.push({
      sheet: 'TeamMembers',
      code: 'TEAMMEMBERS_DERIVED_FROM_ASSIGNMENTS',
      message: `TeamMembers sheet empty — derived ${teamMembers.length} membership(s) from Assignments.`,
    })
  }

  return {
    fetchedData: {
      pwaUrl: '',
      projects,
      tasks,
      dependencies,
      resources,
      assignments,
      teamMembers,
      customFields,
      lookupTables,
      ...(fileUploadProjectOverrides.length > 0 ? { fileUploadProjectOverrides } : {}),
    },
    warnings,
  }
}

function normalizeDependencyType(value: string): PoTaskDependency['DependencyType'] {
  const normalized = value.toUpperCase()
  if (normalized === 'FF' || normalized === 'FS' || normalized === 'SF' || normalized === 'SS') return normalized
  return 'FS'
}
