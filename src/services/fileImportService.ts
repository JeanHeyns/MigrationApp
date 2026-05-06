import * as XLSX from 'xlsx'
import type {
  PoFetchedData, PoProject, PoTask, PoResource, PoAssignment,
  PoProjectTeamMember, PoCustomField, PoLookupTable, PoCustomFieldType,
} from '../models/projectOnline.types'

// ─── Template definition ──────────────────────────────────────────────────────

const TEMPLATE_DATA: Record<string, unknown[][]> = {
  Projects: [
    ['ProjectId', 'ProjectName', 'Description', 'StartDate', 'FinishDate', 'Status', 'OwnerEmail'],
    ['P001', 'Example Project', 'A sample project', '2024-01-15', '2024-12-31', 'Active', 'owner@contoso.com'],
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
  TeamMembers: [
    ['ProjectId', 'ResourceId'],
    ['P001', 'R001'],
    ['P001', 'R002'],
  ],
  CustomFields: [
    ['FieldName', 'ColumnHeader', 'EntityType', 'FieldType', 'LookupTableName'],
    ['Department',     'Department',     'Project', 'Lookup', 'Departments'],
    ['Budget',         'Budget',         'Project', 'Cost',   ''],
    ['Priority Score', 'PriorityScore',  'Task',    'Number', ''],
  ],
  LookupValues: [
    ['LookupTableName', 'EntryValue'],
    ['Departments', 'IT'],
    ['Departments', 'Finance'],
    ['Departments', 'Operations'],
    ['Departments', 'HR'],
  ],
}

export function generateTemplate(): Blob {
  const wb = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(TEMPLATE_DATA)) {
    const ws = XLSX.utils.aoa_to_sheet(rows)
    // Bold header row
    const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1')
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c })
      if (ws[addr]) ws[addr].s = { font: { bold: true } }
    }
    XLSX.utils.book_append_sheet(wb, ws, name)
  }
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

// ─── Parsing helpers ──────────────────────────────────────────────────────────

function sheetToRows(wb: XLSX.WorkBook, name: string): Record<string, unknown>[] {
  const ws = wb.Sheets[name]
  if (!ws) return []
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: false })
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

function num(v: unknown): number | undefined {
  const n = parseFloat(String(v))
  return isNaN(n) ? undefined : n
}

function bool(v: unknown): boolean | undefined {
  if (v == null || v === '') return undefined
  const s = String(v).trim().toUpperCase()
  if (s === 'TRUE' || s === '1' || s === 'YES') return true
  if (s === 'FALSE' || s === '0' || s === 'NO') return false
  return undefined
}

// ─── Main parser ──────────────────────────────────────────────────────────────

export function parseWorkbook(file: File): Promise<PoFetchedData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target!.result as ArrayBuffer)
        const wb = XLSX.read(data, { type: 'array', cellDates: false })
        resolve(parseSheets(wb))
      } catch (err) {
        reject(err)
      }
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsArrayBuffer(file)
  })
}

function slugify(s: string): string {
  return s.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_]/g, '')
}

function parseSheets(wb: XLSX.WorkBook): PoFetchedData {
  // ── 1. CustomFields sheet (schema metadata) ──────────────────────────────
  const cfRows = sheetToRows(wb, 'CustomFields')
  const customFields: PoCustomField[] = cfRows
    .filter(r => str(r.FieldName))
    .map((r, i) => {
      const fieldType = str(r.FieldType) as PoCustomFieldType
      const columnHeader = str(r.ColumnHeader) || str(r.FieldName)
      return {
        CustomFieldId: `cf_${i}_${slugify(str(r.FieldName))}`,
        CustomFieldName: str(r.FieldName),
        CustomFieldEntityType: (str(r.EntityType) as 'Project' | 'Task' | 'Resource') || 'Project',
        CustomFieldType: fieldType || 'Text',
        CustomFieldTypeValue: 0,
        LookupTableName: str(r.LookupTableName) || undefined,
        // ODataFieldName doubles as the column header key in Projects/Tasks sheets
        ODataFieldName: columnHeader,
      }
    })

  // ── 2. LookupValues sheet ────────────────────────────────────────────────
  const lvRows = sheetToRows(wb, 'LookupValues')
  const lookupEntriesMap = new Map<string, string[]>()
  for (const r of lvRows) {
    const table = str(r.LookupTableName)
    const val   = str(r.EntryValue)
    if (!table || !val) continue
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

  // Wire LookupTableUID into custom fields that reference a lookup table
  const ltByName = new Map(lookupTables.map(lt => [lt.LookupTableName, lt]))
  for (const cf of customFields) {
    if (cf.LookupTableName && ltByName.has(cf.LookupTableName)) {
      cf.CustomFieldLookupTableUID = ltByName.get(cf.LookupTableName)!.LookupTableUID
    }
  }

  // ── 3. Resources ─────────────────────────────────────────────────────────
  const resources: PoResource[] = sheetToRows(wb, 'Resources')
    .filter(r => str(r.ResourceId) || str(r.ResourceName))
    .map(r => ({
      ResourceId:           str(r.ResourceId),
      ResourceUID:          str(r.ResourceId),
      ResourceName:         str(r.ResourceName),
      ResourceEmailAddress: str(r.Email) || undefined,
    }))

  // ── 4. Projects ──────────────────────────────────────────────────────────
  const projectCFs = customFields.filter(cf => cf.CustomFieldEntityType === 'Project')
  const projects: PoProject[] = sheetToRows(wb, 'Projects')
    .filter(r => str(r.ProjectId) || str(r.ProjectName))
    .map(r => {
      const ownerEmail = str(r.OwnerEmail)
      const ownerResource = resources.find(
        res => res.ResourceEmailAddress?.toLowerCase() === ownerEmail.toLowerCase()
      )
      const proj: PoProject = {
        ProjectId:             str(r.ProjectId) || `p_${slugify(str(r.ProjectName))}`,
        ProjectName:           str(r.ProjectName),
        ProjectDescription:    str(r.Description) || undefined,
        ProjectStartDate:      str(r.StartDate)   || undefined,
        ProjectFinishDate:     str(r.FinishDate)  || undefined,
        ProjectStatus:         str(r.Status)      || undefined,
        ProjectOwnerResourceId:  (ownerResource?.ResourceId  ?? ownerEmail) || undefined,
        ProjectOwnerResourceUid: (ownerResource?.ResourceUID ?? ownerEmail) || undefined,
      }
      for (const cf of projectCFs) {
        const col = cf.ODataFieldName!
        if (col in r) proj[col] = r[col]
      }
      return proj
    })

  // ── 5. Tasks ─────────────────────────────────────────────────────────────
  const taskCFs = customFields.filter(cf => cf.CustomFieldEntityType === 'Task')
  const tasks: PoTask[] = sheetToRows(wb, 'Tasks')
    .filter(r => str(r.TaskId) || str(r.TaskName))
    .map(r => {
      const durationDays = num(r.DurationDays)
      const task: PoTask = {
        TaskId:                str(r.TaskId) || `t_${slugify(str(r.TaskName))}`,
        ProjectId:             str(r.ProjectId),
        TaskName:              str(r.TaskName),
        TaskStartDate:         str(r.StartDate)       || undefined,
        TaskFinishDate:        str(r.FinishDate)      || undefined,
        TaskDurationInMinutes: durationDays != null ? Math.round(durationDays * 8 * 60) : undefined,
        TaskPercentCompleted:  num(r.PercentComplete),
        TaskOutlineLevel:      num(r.OutlineLevel),
        TaskOutlineNumber:     str(r.OutlineNumber)   || undefined,
        TaskParentId:          str(r.ParentTaskId)    || undefined,
        TaskIsMilestone:       bool(r.IsMilestone),
        TaskIsSummary:         bool(r.IsSummary),
        TaskPriority:          num(r.Priority),
      }
      for (const cf of taskCFs) {
        const col = cf.ODataFieldName!
        if (col in r) task[col] = r[col]
      }
      return task
    })

  // ── 6. Assignments ───────────────────────────────────────────────────────
  const assignments: PoAssignment[] = sheetToRows(wb, 'Assignments')
    .filter(r => str(r.ProjectId) && str(r.TaskId) && str(r.ResourceId))
    .map((r, i) => ({
      AssignmentId:        `a_${i}`,
      ProjectId:           str(r.ProjectId),
      TaskId:              str(r.TaskId),
      ResourceUID:         str(r.ResourceId),
      ResourceId:          str(r.ResourceId),
      AssignmentUnits:     num(r.Units),
    }))

  // ── 7. TeamMembers ───────────────────────────────────────────────────────
  const teamMembers: PoProjectTeamMember[] = sheetToRows(wb, 'TeamMembers')
    .filter(r => str(r.ProjectId) && str(r.ResourceId))
    .map(r => {
      const res = resources.find(re => re.ResourceId === str(r.ResourceId))
      return {
        ProjectId:    str(r.ProjectId),
        ResourceUID:  str(r.ResourceId),
        ResourceId:   str(r.ResourceId),
        ResourceName: res?.ResourceName,
      }
    })

  return {
    pwaUrl: '',
    projects,
    tasks,
    resources,
    assignments,
    teamMembers,
    customFields,
    lookupTables,
  }
}
