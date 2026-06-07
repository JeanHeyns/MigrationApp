# Feature Spec: File Upload Template & Loader

> **Document type:** Implementation specification for Claude Code
> **Target codebase:** Project Online Migrator (React + TypeScript + Power Apps Code App)
> **Status:** Partially implemented — loader + template (phases 1–11) complete; UI feedback (phases 12–17) pending
> **Related specs:** `data-only-migration-spec.md`, `data-only-migration-spec-addendum-B.md`, `schema-only-migration-spec.md`, `import-control-spec.md`, `project-selection-spec.md`
> **Suggested location in repo:** `docs/file-upload-spec.md`

---

## 1. Context & doel

De app heeft twee datasources: `ProjectOnline` (live fetch via SharePoint OData) en `FileUpload` (Excel template). Het file-upload pad is volledig functioneel voor de happy path — `src/services/excelTemplate.ts` bevat een werkende `generateTemplate()` en `parseWorkbook()` die `PoFetchedData` produceert. Downstream code (Step 2 mapping, Step 4 writers) ziet geen verschil met de PO-fetch path.

Wat nog ontbreekt voordat dit pad productie-waardig is:

- **Strict structural validation** — sheet-namen en column-headers afdwingen, zodat een hernoemde tab geen silent 0-rows oplevert
- **Soft per-row validation** — typefouten in `FieldType`, ongeldige references, parse-fouten op datums leveren warnings, niet crashes
- **Excel data validation (dropdowns)** in de gegenereerde template voor velden met vaste waarden — een leek hoort de geldige waarden te kunnen kiezen, niet uit z'n hoofd te typen
- **DataOnly-bewustzijn** — optionele `DataverseLogicalName` kolom in `CustomFields` voor expliciete mapping zonder Step 2-werk
- **Filter-bewustzijn (project selection)** — `OwnerName` kolom in `Projects` zodat de owner-filter in selectie-UI werkt
- **Validation report** — pre-import banner in Step 1 met warning/error counts, doorgegeven aan Step 5 voor het uiteindelijke rapport
- **TeamMembers derivation** — als de sheet leeg is, afleiden uit Assignments
- **Robuste date-parsing** — Excel-native dates accepteren, ISO-strings als fallback

**Uitbreiding:** template v2 (backwards-incompatible voor structurele wijzigingen, backwards-compatible voor toevoegingen) + uitgebreide loader met validation-laag.

**Filosofie:**
- Strict bij **structurele wijzigingen** (sheet hernoemd, kolom hernoemd) — bestand wordt afgewezen met duidelijke melding
- Soft bij **inhoudelijke fouten** (verkeerde FieldType, dangling reference, niet-parseerbare datum) — row geskipt, warning, rest van het bestand verwerkt
- Mode-agnostisch — template levert puur data; `migrationMode` blijft een in-app keuze

---

## 1a. Implementation status

> Added June 2026. Based on code audit of `src/services/fileImportService.ts`, `src/services/fileUpload/types.ts`, `src/steps/Step1Connect/index.tsx`, `src/steps/Step5Report/index.tsx`, `src/app/MigrationContext.tsx`.

| Phase (§10) | Status | Built in | Notes |
|---|---|---|---|
| 1. `LoaderResult` shape + types | ✅ Done | `src/services/fileUpload/types.ts` | Types match spec; extra warning codes added (`UNKNOWN_SCHEDULE_MODE`, `WORKING_TIME_OUT_OF_RANGE`) |
| 2. `_Meta` sheet | ✅ Done | `fileImportService.ts` — `parseMetaSheet`, `validateStructure` | `generateTemplate()` writes `_Meta`; version check implemented |
| 3. Strict structural validation | ✅ Done | `fileImportService.ts` — `validateStructure()` | Required sheets + headers, case-insensitive rename detection |
| 4. Soft per-row validation skeleton | ✅ Done | `fileImportService.ts` — `parseSheets()` | `warnings` accumulator + `pushWarning()` cap function |
| 5. Reference integrity | ✅ Done | `fileImportService.ts` — Assignments, Dependencies, TeamMembers, Tasks.ParentTaskId |  |
| 6. Date handling | ✅ Done | `fileImportService.ts` — `toISODate()` | `cellDates: true`; ISO text fallback; warn on unparseable |
| 7. `DataverseLogicalName` + `OwnerName` | ✅ Done | `fileImportService.ts` | Both columns parsed + propagated in `PoFetchedData` |
| 8. TeamMembers derivation | ✅ Done | `fileImportService.ts` | Empty sheet → derive from Assignments with `TEAMMEMBERS_DERIVED_FROM_ASSIGNMENTS` warning |
| 9. FieldType / EntityType validation | ✅ Done | `fileImportService.ts` | `INVALID_FIELD_TYPE_SKIPPED`; EntityType defaults silently to `Project` on unknown value |
| 10. Excel data validation dropdowns | ❌ Not done | — | SheetJS confirmed unable to write `!dataValidations` (see §8.1 resolution). Requires `exceljs`. |
| 11. `_Instructions` sheet | ✅ Done | `fileImportService.ts` — `INSTRUCTIONS_ROWS` | Content includes working time columns (not in original spec) |
| 12. UI: post-upload panel | 🟡 Partial | `Step1Connect/index.tsx` | `fetchedData` is set; `LoaderResult.warnings` are **discarded** — summary panel does not show warning count |
| 13. UI: error panel for hard fails | 🟡 Partial | `Step1Connect/index.tsx` | `uploadError` shows `String(err)`, not the structured `LoaderFileError.errors[]` list |
| 14. MigrationContext integration | ❌ Not done | — | `fileUploadWarnings: LoaderWarning[]` never added to MigrationState; reducer action `SET_FILE_UPLOAD_WARNINGS` not implemented |
| 15. UI: Step 5 warnings section | ❌ Not done | — | Step5Report has no "File Upload Warnings" section |
| 16. Step 5 CSV export | ❌ Not done | — | CSV export of warnings not implemented |
| 17. End-to-end + regression tests | ⚠️ TODO | — | Manual verification only |

**Summary:** Loader is production-ready; warnings surface in `LoaderResult` but are invisible to the user. Phases 12–16 are the remaining work.

---

## 2. Scope

### In scope
- Template v2 met `_Meta`, `_Instructions` sheets en Excel data validation (dropdowns)
- Strict validation van sheet-namen en column-headers met klare foutmeldingen
- Soft per-row validation met aggregated `LoaderWarning[]` output
- `DataverseLogicalName` kolom in `CustomFields` (optioneel)
- `OwnerName` kolom in `Projects` (optioneel, fallback op `OwnerEmail`)
- `cellDates: true` voor robust date-handling met ISO string fallback
- Reference-integrity checks (Assignments → Tasks → Projects, Dependencies, TeamMembers)
- TeamMembers afgeleid uit Assignments wanneer sheet leeg is
- Pre-import validation panel in Step 1 met expandable warnings/errors
- Validation warnings doorgegeven aan Step 5 rapport
- `templateVersion` opgeslagen in `_Meta` voor soft versie-detectie

### Out of scope (voor deze iteratie)
- CSV-only upload (alleen `.xlsx`) — kan later als single-sheet variant
- Template-editor in de app — gebruiker werkt in Excel
- Auto-migration van v1 → v2 templates — bij ontdekt v1-bestand: foutmelding met download-link naar v2
- Saved upload history / re-upload last file — geen persistence buiten de sessie
- Multi-file upload (bv. één file per project) — single workbook only

---

## 3. Architecturale beslissingen

| Beslissing | Keuze | Reden |
|---|---|---|
| Strictness model | Strict bij structuur, soft bij content | Hernoemde sheets/headers zijn waarschijnlijk fouten; verkeerde FieldType is veelvoorkomende typo |
| Template versie | `templateVersion: "2.0"` in `_Meta` sheet | Soft-detect oudere versies, geef migratie-pad |
| Sheet-name matching | Exacte case-sensitive match | Geen aliassen, geen fuzzy — voorspelbaar contract |
| Column-header matching | Exacte case-sensitive match | Idem |
| Date handling | `cellDates: true` (Excel-native) + ISO string fallback | Lekenvriendelijk: gebruiker typt datum in Excel-format, loader haalt JS Date eruit |
| Reference integrity | Pre-import warning + write-time skip | Dubbele zekerheid; gebruiker ziet issue vroeg, writer blijft robust |
| Loader output shape | `LoaderResult { fetchedData, warnings, errors }` | Aggregated feedback; UI rendert beide categories |
| Errors vs warnings | Errors stoppen het bestand, warnings niet | Errors = "kan niet verder", warnings = "rij geskipt, rest doorgaan" |
| TeamMembers derivation | Auto-afleiden uit Assignments als sheet leeg | Vermindert verplichte input voor leken; sluit aan op PO-gedrag |
| Custom field values in Tasks | Niet ondersteund | Task custom fields worden niet gemigreerd (OperationSet-limit); kolommen worden gelezen + genegeerd met warning |
| FieldType dropdown waarden | `Text | Memo | Number | Cost | Date | Boolean | Choice | MultiChoice | Lookup` | Volledige set die de writers ondersteunen |
| Onbekende FieldType waarde | Skip row + warning | Strict per-row, niet per-bestand |
| DataverseLogicalName lege cel | Loader leeglaten; Step 2 doet auto-match | Backwards compat met huidige flow |

---

## 4. Template v2 structuur

### 4.1 Overzicht alle sheets

| # | Sheet | Verplicht | Verandert tov v1 |
|---|---|---|---|
| 1 | `_Instructions` | Optioneel (read-only voor gebruiker) | **Nieuw** |
| 2 | `_Meta` | Verplicht (1 row met versie info) | **Nieuw** |
| 3 | `Projects` | Min. 1 row aanbevolen | +`OwnerName`, +dynamische custom field kolommen |
| 4 | `Tasks` | Optioneel | Custom field kolommen worden genegeerd met warning |
| 5 | `Resources` | Optioneel | Ongewijzigd |
| 6 | `Assignments` | Optioneel | Ongewijzigd |
| 7 | `Dependencies` | Optioneel | Ongewijzigd |
| 8 | `TeamMembers` | Optioneel (afgeleid uit Assignments indien leeg) | Ongewijzigd |
| 9 | `CustomFields` | Optioneel | +`DataverseLogicalName` kolom |
| 10 | `LookupValues` | Optioneel | Ongewijzigd |

### 4.2 Sheet `_Meta`

Eén header rij + één data rij. Wordt automatisch gegenereerd door `generateTemplate()`.

| Kolom | Type | Voorbeeld | Doel |
|---|---|---|---|
| `templateVersion` | string | `"2.0"` | Hoofdversie van de template structuur |
| `generatedAt` | ISO date | `"2026-05-11T14:30:00Z"` | Wanneer gedownload |
| `generatedBy` | string | `"Project Online Migrator"` | Bron-identificatie |

**Loader-gedrag:**
- Geen `_Meta` sheet of geen `templateVersion` veld → `error` "This file is not a recognized migration template. Please download a fresh template from the app."
- `templateVersion` < `"2.0"` (bv. v1.x) → `error` "This template is from an older app version. Please download the current template and copy your data into it."
- `templateVersion` >= `"2.0"` en major-match → laden, eventueel met versie-mismatch warning

### 4.3 Sheet `_Instructions`

Read-only sheet (technisch wel editable, gebruiker geadviseerd om niet aan te raken). Plain prose met opmaak. Inhoud:

```
How to use this template
─────────────────────────

1. Fill in your data on the data sheets (Projects, Tasks, Resources, etc.)
2. Save the file as .xlsx
3. In the Migration app, choose "File upload" as data source and upload this file

Which sheets do I need?
───────────────────────

You don't need to fill in everything. Use what you have:

- Projects: at least one row recommended. Add custom field values as columns.
- Tasks: only fill in if you want to migrate tasks and the schedule.
- Resources: people working on projects. Required if you fill in Assignments or TeamMembers.
- Assignments: which resources are working on which tasks. Requires both Tasks and Resources.
- Dependencies: task predecessor/successor links. Requires Tasks.
- TeamMembers: project membership. Can be left empty — will be derived from Assignments.
- CustomFields: definitions of custom columns. Lookup-type fields need entries in LookupValues.
- LookupValues: values that lookup-type custom fields can pick from.

Rules
─────

- Do not rename sheets or columns. The app will refuse files with renamed structure.
- Empty rows are fine — they will be skipped.
- Dates can be in any Excel date format; ISO (YYYY-MM-DD) also works.
- Boolean values: TRUE or FALSE. Empty means "not set".
- IDs (ProjectId, TaskId, ResourceId) must be unique within their sheet.
- References (e.g. TaskId in Assignments) must match an ID elsewhere in the file.
```

Loader negeert deze sheet volledig (geen parsing).

### 4.4 Sheet `Projects`

| Kolom | Verplicht | Type | Validatie |
|---|---|---|---|
| `ProjectId` | Ja | string | Uniek binnen sheet |
| `ProjectName` | Ja | string | |
| `Description` | Nee | string | |
| `StartDate` | Nee | date | Excel date of ISO |
| `FinishDate` | Nee | date | Excel date of ISO |
| `Status` | Nee | string | |
| `OwnerEmail` | Nee | string | Email match tegen Resources voor `ProjectOwnerResourceId` |
| `OwnerName` | Nee | string | **Nieuw**: fallback display name; gebruikt door selection-filter |
| *extra kolommen* | Nee | varies | Behandeld als project custom field; header moet matchen met `FieldName` in `CustomFields` sheet |

**Validatie:**
- Lege `ProjectId` én lege `ProjectName` → row geskipt zonder warning (heel rij leeg)
- Lege `ProjectId` maar `ProjectName` ingevuld → auto-gegenereerde ID (`p_<slug>`), warning
- Duplicate `ProjectId` binnen sheet → tweede entry geskipt met warning
- Custom field kolom waarvan header niet voorkomt in `CustomFields` sheet → kolom genegeerd met warning per kolom (één keer, niet per row)

### 4.5 Sheet `Tasks`

| Kolom | Verplicht | Type | Validatie |
|---|---|---|---|
| `TaskId` | Ja | string | Uniek binnen sheet |
| `ProjectId` | Ja | string | Moet matchen met Projects.ProjectId |
| `TaskName` | Ja | string | |
| `StartDate` | Nee | date | |
| `FinishDate` | Nee | date | |
| `DurationDays` | Nee | number | |
| `PercentComplete` | Nee | number | 0–100 |
| `OutlineLevel` | Nee | number | |
| `OutlineNumber` | Nee | string | |
| `ParentTaskId` | Nee | string | Moet matchen met Tasks.TaskId binnen zelfde project (of leeg voor top-level) |
| `IsMilestone` | Nee | TRUE/FALSE | Dropdown |
| `IsSummary` | Nee | TRUE/FALSE | Dropdown |
| `Priority` | Nee | number | |

**Validatie:**
- `ProjectId` verwijst naar niet-bestaande project → row geskipt + warning
- `ParentTaskId` verwijst naar niet-bestaande task → row meegenomen maar `ParentTaskId` cleared + warning
- Extra (custom field) kolommen → genegeerd met één-keer warning per kolom: *"Custom field column 'X' detected in Tasks sheet — task custom fields are not migrated and will be ignored."*

### 4.6 Sheet `Resources`

| Kolom | Verplicht | Type |
|---|---|---|
| `ResourceId` | Ja | string |
| `ResourceName` | Ja | string |
| `Email` | Nee | string |

**Validatie:**
- Duplicate `ResourceId` → tweede entry geskipt + warning

### 4.7 Sheet `Assignments`

| Kolom | Verplicht | Type | Validatie |
|---|---|---|---|
| `ProjectId` | Ja | string | Moet matchen met Projects |
| `TaskId` | Ja | string | Moet matchen met Tasks van zelfde project |
| `ResourceId` | Ja | string | Moet matchen met Resources |
| `Units` | Nee | number | 0–∞, typisch 0–100 (%) |

**Validatie:**
- Niet-bestaande `ProjectId`, `TaskId`, of `ResourceId` → row geskipt + warning (één warning per row, met reden)
- Task hoort bij ander project dan opgegeven `ProjectId` → row geskipt + warning

### 4.8 Sheet `Dependencies`

| Kolom | Verplicht | Type | Validatie |
|---|---|---|---|
| `DependencyId` | Nee | string | Auto-gegenereerd indien leeg |
| `ProjectId` | Ja | string | |
| `PredecessorTaskId` | Ja | string | Moet matchen, zelfde project |
| `SuccessorTaskId` | Ja | string | Moet matchen, zelfde project |
| `DependencyType` | Nee | `FS|SS|FF|SF` | Dropdown, default `FS` indien leeg, warning bij onbekende waarde |

### 4.9 Sheet `TeamMembers`

| Kolom | Verplicht | Type |
|---|---|---|
| `ProjectId` | Ja | string |
| `ResourceId` | Ja | string |

**Validatie:**
- Beide refs moeten bestaan → row geskipt + warning indien niet
- **Lege sheet (geen data rows) → afgeleid uit Assignments:** voor elke unieke `(ProjectId, ResourceId)` combinatie in Assignments wordt automatisch een team member entry aangemaakt. Info-log: *"TeamMembers sheet empty — derived N memberships from Assignments."*

### 4.10 Sheet `CustomFields`

| Kolom | Verplicht | Type | Validatie |
|---|---|---|---|
| `FieldName` | Ja | string | PO-style naam, gebruikt als display name |
| `ColumnHeader` | Ja | string | Header die in Projects/Tasks sheet gebruikt wordt om values aan te leveren |
| `EntityType` | Ja | `Project|Task|Resource` | Dropdown |
| `FieldType` | Ja | `Text|Memo|Number|Cost|Date|Boolean|Choice|MultiChoice|Lookup` | Dropdown, onbekende waarde → row skip + warning |
| `LookupTableName` | Voorwaardelijk | string | Verplicht als `FieldType=Lookup`, moet matchen met `LookupValues.LookupTableName` |
| `DataverseLogicalName` | Nee | string | **Nieuw**: optionele expliciete mapping naar bestaande Dataverse kolom (dataOnly mode) |

**Validatie:**
- Onbekende `FieldType` → row geskipt + warning
- `FieldType=Lookup` zonder `LookupTableName` → row geskipt + warning
- `LookupTableName` ingevuld maar tabel bestaat niet in `LookupValues` → row meegenomen maar lookup-koppeling onbruikbaar + warning
- `EntityType=Task` → custom field gelezen, maar bij parsing van Tasks worden de waarden genegeerd (zie 4.5). Geen aparte warning hier; warning komt bij Tasks-parsing.
- `DataverseLogicalName` is informational; loader doet er geen validatie op (Dataverse-side wordt het in Step 2/4 gevalideerd)

### 4.11 Sheet `LookupValues`

| Kolom | Verplicht | Type |
|---|---|---|
| `LookupTableName` | Ja | string |
| `EntryValue` | Ja | string |

**Validatie:**
- Duplicate `(LookupTableName, EntryValue)` → tweede geskipt + warning
- Lege waarden → row geskipt zonder warning (whitespace cleanup)

---

## 5. Excel data validation (dropdowns)

Toegevoegd in `generateTemplate()` per relevante kolom. Gebruikt openpyxl-equivalent in `xlsx` library: `DataValidation` met `type: 'list'` en `formulae` met de toegestane waarden.

| Sheet | Kolom | Toegestane waarden |
|---|---|---|
| Tasks | `IsMilestone` | `TRUE, FALSE` |
| Tasks | `IsSummary` | `TRUE, FALSE` |
| Dependencies | `DependencyType` | `FS, SS, FF, SF` |
| CustomFields | `EntityType` | `Project, Task, Resource` |
| CustomFields | `FieldType` | `Text, Memo, Number, Cost, Date, Boolean, Choice, MultiChoice, Lookup` |

**Implementatie hint:**
```typescript
// In xlsx package syntax (SheetJS):
ws['!dataValidations'] = [
  {
    ref: 'D2:D1000',  // FieldType column, rows 2 onwards
    type: 'list',
    formula1: '"Text,Memo,Number,Cost,Date,Boolean,Choice,MultiChoice,Lookup"',
    showDropDown: false,
    error: 'Invalid field type. Pick from the dropdown.',
    errorTitle: 'Invalid value',
    showErrorMessage: true,
  }
]
```

Verifieer of `xlsx` (SheetJS) `!dataValidations` echt schrijft — sommige versies schrijven dit alleen onder `xlsx-style` of `xlsx-js-style`. Als blokker: switch naar `exceljs` voor `generateTemplate` (parsing blijft `xlsx`/SheetJS). Loader-kant verandert niet.

---

## 6. Loader uitbreidingen

### 6.1 Output shape

Vervang het huidige return type van `parseWorkbook` met:

```typescript
export interface LoaderResult {
  fetchedData: PoFetchedData
  warnings: LoaderWarning[]
  errors: LoaderError[]   // Always empty on successful return; errors are thrown
}

export interface LoaderWarning {
  sheet: string
  row?: number             // 1-indexed Excel row (header = row 1, first data = row 2)
  column?: string          // Column header name
  code: WarningCode
  message: string          // Human-readable
  details?: Record<string, unknown>
}

export interface LoaderError {
  sheet?: string
  code: ErrorCode
  message: string
}

export type WarningCode =
  | 'MISSING_ID_GENERATED'
  | 'DUPLICATE_ID_SKIPPED'
  | 'INVALID_REFERENCE_SKIPPED'
  | 'INVALID_REFERENCE_CLEARED'
  | 'INVALID_FIELD_TYPE_SKIPPED'
  | 'MISSING_LOOKUP_TABLE'
  | 'TASK_CUSTOM_FIELD_IGNORED'
  | 'UNRECOGNIZED_PROJECT_CF_COLUMN'
  | 'INVALID_DATE_CLEARED'
  | 'DEPENDENCY_TYPE_DEFAULTED'
  | 'TEAMMEMBERS_DERIVED_FROM_ASSIGNMENTS'
  | 'TEMPLATE_VERSION_NEWER'  // soft: forward-compat warning

export type ErrorCode =
  | 'MISSING_META_SHEET'
  | 'UNRECOGNIZED_TEMPLATE_VERSION'
  | 'TEMPLATE_TOO_OLD'
  | 'MISSING_REQUIRED_SHEET'   // sheet absent that has data references elsewhere
  | 'RENAMED_SHEET_DETECTED'   // closest-match heuristic gives hint
  | 'MISSING_REQUIRED_COLUMN'
  | 'CORRUPTED_FILE'
```

`parseWorkbook` retourneert `LoaderResult` bij succes, throwt een typed error (`LoaderFileError extends Error`) met `errors: LoaderError[]` payload bij hard fail.

### 6.2 Strict structural validation (nieuw)

Vóór de huidige row-parsing, voeg een validatie-fase toe:

```typescript
function validateStructure(wb: XLSX.WorkBook): { errors: LoaderError[]; warnings: LoaderWarning[] } {
  const errors: LoaderError[] = []
  const warnings: LoaderWarning[] = []

  // 1. _Meta sheet present + parseable version
  if (!wb.SheetNames.includes('_Meta')) {
    errors.push({ code: 'MISSING_META_SHEET', message: '...' })
    return { errors, warnings }
  }
  const meta = parseMetaSheet(wb)
  if (!meta.templateVersion) {
    errors.push({ code: 'MISSING_META_SHEET', message: '...' })
    return { errors, warnings }
  }
  const major = parseMajorVersion(meta.templateVersion)
  if (major < 2) {
    errors.push({ code: 'TEMPLATE_TOO_OLD', message: '...' })
    return { errors, warnings }
  }
  if (major > 2) {
    warnings.push({ sheet: '_Meta', code: 'TEMPLATE_VERSION_NEWER', message: '...' })
  }

  // 2. Required sheet names present (exact match, case-sensitive)
  const REQUIRED = ['Projects'] // _Meta already checked; others optional
  const KNOWN = ['_Meta', '_Instructions', 'Projects', 'Tasks', 'Resources', 'Assignments',
                  'Dependencies', 'TeamMembers', 'CustomFields', 'LookupValues']
  for (const req of REQUIRED) {
    if (!wb.SheetNames.includes(req)) {
      // Try to detect rename via lowercase match
      const candidate = wb.SheetNames.find(s => s.toLowerCase() === req.toLowerCase())
      if (candidate) {
        errors.push({
          code: 'RENAMED_SHEET_DETECTED',
          sheet: candidate,
          message: `Sheet "${candidate}" found but expected "${req}". Sheet names must match exactly.`,
        })
      } else {
        errors.push({ code: 'MISSING_REQUIRED_SHEET', message: `Required sheet "${req}" not found.` })
      }
    }
  }

  // 3. Per-sheet required column headers
  const REQUIRED_HEADERS: Record<string, string[]> = {
    Projects: ['ProjectId', 'ProjectName'],
    Tasks: ['TaskId', 'ProjectId', 'TaskName'],
    Resources: ['ResourceId', 'ResourceName'],
    Assignments: ['ProjectId', 'TaskId', 'ResourceId'],
    Dependencies: ['ProjectId', 'PredecessorTaskId', 'SuccessorTaskId'],
    TeamMembers: ['ProjectId', 'ResourceId'],
    CustomFields: ['FieldName', 'ColumnHeader', 'EntityType', 'FieldType'],
    LookupValues: ['LookupTableName', 'EntryValue'],
  }
  for (const [sheet, headers] of Object.entries(REQUIRED_HEADERS)) {
    if (!wb.SheetNames.includes(sheet)) continue  // optional sheets
    const actualHeaders = getSheetHeaders(wb.Sheets[sheet])
    for (const required of headers) {
      if (!actualHeaders.includes(required)) {
        const candidate = actualHeaders.find(h => h.toLowerCase() === required.toLowerCase())
        errors.push({
          code: 'MISSING_REQUIRED_COLUMN',
          sheet,
          message: candidate
            ? `Column "${candidate}" found but expected "${required}" in sheet ${sheet}. Column names must match exactly.`
            : `Required column "${required}" missing in sheet ${sheet}.`,
        })
      }
    }
  }

  return { errors, warnings }
}
```

Als `errors.length > 0`: throw `LoaderFileError` met die errors. UI rendert lijst met clear messages.

### 6.3 Soft per-row validation

In de bestaande parse-functies (`parseSheets` interior), maak `warnings: LoaderWarning[]` accumulator en push warnings bij elke skip / default / clear actie.

Concrete plekken:

**`CustomFields`:**
```typescript
.map((r, i) => {
  const fieldName = str(r.FieldName)
  if (!fieldName) return null  // skip silently, empty row

  const rawType = str(r.FieldType)
  const validTypes = ['Text', 'Memo', 'Number', 'Cost', 'Date', 'Boolean', 'Choice', 'MultiChoice', 'Lookup']
  if (!validTypes.includes(rawType)) {
    warnings.push({
      sheet: 'CustomFields',
      row: i + 2,
      column: 'FieldType',
      code: 'INVALID_FIELD_TYPE_SKIPPED',
      message: `Field "${fieldName}" has unknown FieldType "${rawType}". Skipped.`,
    })
    return null
  }

  if (rawType === 'Lookup' && !str(r.LookupTableName)) {
    warnings.push({
      sheet: 'CustomFields',
      row: i + 2,
      column: 'LookupTableName',
      code: 'MISSING_LOOKUP_TABLE',
      message: `Lookup field "${fieldName}" has no LookupTableName. Skipped.`,
    })
    return null
  }

  // ... build the PoCustomField, include DataverseLogicalName if present
  return { /* ... */, DataverseLogicalName: str(r.DataverseLogicalName) || undefined }
})
.filter((cf): cf is PoCustomField => cf !== null)
```

**`Projects` (custom field columns):**
```typescript
// Before mapping rows: detect which extra columns exist in the sheet
const projectCFs = customFields.filter(cf => cf.CustomFieldEntityType === 'Project')
const expectedCFHeaders = new Set(projectCFs.map(cf => cf.ODataFieldName))
const standardHeaders = new Set(['ProjectId', 'ProjectName', 'Description', 'StartDate', 'FinishDate', 'Status', 'OwnerEmail', 'OwnerName'])

const actualHeaders = getSheetHeaders(wb.Sheets['Projects'])
for (const h of actualHeaders) {
  if (!standardHeaders.has(h) && !expectedCFHeaders.has(h)) {
    warnings.push({
      sheet: 'Projects',
      column: h,
      code: 'UNRECOGNIZED_PROJECT_CF_COLUMN',
      message: `Column "${h}" in Projects sheet is not defined in CustomFields. Values will be ignored.`,
    })
  }
}
```

**`Tasks` (custom field columns warning):**
```typescript
const standardHeaders = new Set(['TaskId', 'ProjectId', 'TaskName', 'StartDate', 'FinishDate', 'DurationDays', 'PercentComplete', 'OutlineLevel', 'OutlineNumber', 'ParentTaskId', 'IsMilestone', 'IsSummary', 'Priority'])

const actualHeaders = getSheetHeaders(wb.Sheets['Tasks'])
for (const h of actualHeaders) {
  if (!standardHeaders.has(h)) {
    warnings.push({
      sheet: 'Tasks',
      column: h,
      code: 'TASK_CUSTOM_FIELD_IGNORED',
      message: `Column "${h}" in Tasks sheet looks like a custom field. Task custom fields are not migrated and will be ignored.`,
    })
  }
}
```

**Reference integrity (Assignments, Dependencies, TeamMembers, Tasks.ParentTaskId):**

Build index sets once after primary entities are parsed:

```typescript
const projectIds = new Set(projects.map(p => p.ProjectId))
const taskIds = new Set(tasks.map(t => t.TaskId))
const taskByProject = new Map<string, Set<string>>()
for (const t of tasks) {
  if (!taskByProject.has(t.ProjectId)) taskByProject.set(t.ProjectId, new Set())
  taskByProject.get(t.ProjectId)!.add(t.TaskId)
}
const resourceIds = new Set(resources.map(r => r.ResourceId))
```

Then validate each row of dependent sheets:

```typescript
// Assignments
const validAssignments: PoAssignment[] = []
assignmentRows.forEach((r, i) => {
  const pid = str(r.ProjectId), tid = str(r.TaskId), rid = str(r.ResourceId)
  if (!projectIds.has(pid)) {
    warnings.push({ sheet: 'Assignments', row: i + 2, code: 'INVALID_REFERENCE_SKIPPED',
      message: `ProjectId "${pid}" not found.` })
    return
  }
  if (!taskByProject.get(pid)?.has(tid)) {
    warnings.push({ sheet: 'Assignments', row: i + 2, code: 'INVALID_REFERENCE_SKIPPED',
      message: `TaskId "${tid}" not in project "${pid}".` })
    return
  }
  if (!resourceIds.has(rid)) {
    warnings.push({ sheet: 'Assignments', row: i + 2, code: 'INVALID_REFERENCE_SKIPPED',
      message: `ResourceId "${rid}" not found.` })
    return
  }
  validAssignments.push(buildAssignment(r, i))
})
```

Idem voor Dependencies en TeamMembers.

**TeamMembers derivation:**
```typescript
if (teamMembers.length === 0 && assignments.length > 0) {
  const derived = new Map<string, PoProjectTeamMember>()
  for (const a of assignments) {
    const key = `${a.ProjectId}__${a.ResourceId}`
    if (derived.has(key)) continue
    const res = resources.find(r => r.ResourceId === a.ResourceId)
    derived.set(key, {
      ProjectId: a.ProjectId,
      ResourceUID: a.ResourceId,
      ResourceId: a.ResourceId,
      ResourceName: res?.ResourceName,
    })
  }
  teamMembers = [...derived.values()]
  warnings.push({
    sheet: 'TeamMembers',
    code: 'TEAMMEMBERS_DERIVED_FROM_ASSIGNMENTS',
    message: `TeamMembers sheet empty — derived ${teamMembers.length} memberships from Assignments.`,
  })
}
```

**Tasks.ParentTaskId:**
```typescript
// Two-pass: first parse all tasks ignoring parent validity, then clean up
for (const t of tasks) {
  if (t.TaskParentId && !taskByProject.get(t.ProjectId)?.has(t.TaskParentId)) {
    warnings.push({
      sheet: 'Tasks',
      row: /* lookup */,
      column: 'ParentTaskId',
      code: 'INVALID_REFERENCE_CLEARED',
      message: `Task "${t.TaskId}" references unknown ParentTaskId "${t.TaskParentId}". Cleared.`,
    })
    t.TaskParentId = undefined
  }
}
```

### 6.4 Date handling

Wijzig `XLSX.read(data, { type: 'array', cellDates: false })` naar `cellDates: true`. Cellen met date-formatting komen dan binnen als JavaScript `Date` objects.

Helper:

```typescript
function toISODate(v: unknown, sheet: string, row: number, column: string, warnings: LoaderWarning[]): string | undefined {
  if (v == null || v === '') return undefined
  if (v instanceof Date) {
    return v.toISOString().split('T')[0]  // YYYY-MM-DD
  }
  const s = String(v).trim()
  // ISO?
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.split('T')[0]
  // Try Date parser as fallback
  const parsed = new Date(s)
  if (!isNaN(parsed.getTime())) return parsed.toISOString().split('T')[0]
  // Unparseable
  warnings.push({
    sheet, row, column,
    code: 'INVALID_DATE_CLEARED',
    message: `Could not parse date "${s}". Field cleared.`,
  })
  return undefined
}
```

Vervang elke `str(r.StartDate) || undefined` etc. door `toISODate(r.StartDate, sheet, row, 'StartDate', warnings)`.

### 6.5 `_Meta` parsing

```typescript
function parseMetaSheet(wb: XLSX.WorkBook): { templateVersion: string; generatedAt?: string } {
  const ws = wb.Sheets['_Meta']
  if (!ws) return { templateVersion: '' }
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: false })
  const first = rows[0]
  if (!first) return { templateVersion: '' }
  return {
    templateVersion: String(first.templateVersion ?? '').trim(),
    generatedAt: String(first.generatedAt ?? '').trim() || undefined,
  }
}
```

### 6.6 Updated `generateTemplate()`

Wijzigingen:

1. Voeg `_Meta` sheet toe (1 header rij, 1 data rij)
2. Voeg `_Instructions` sheet toe (multi-row prose, kolom A wide enough)
3. Voeg `OwnerName` kolom toe in Projects (na `OwnerEmail`)
4. Voeg `DataverseLogicalName` kolom toe in CustomFields (na `LookupTableName`)
5. Voeg data validation toe aan `IsMilestone`, `IsSummary`, `DependencyType`, `EntityType`, `FieldType`
6. Sheet order: `_Instructions`, `_Meta`, `Projects`, `Tasks`, `Resources`, `Assignments`, `Dependencies`, `TeamMembers`, `CustomFields`, `LookupValues`

Bewaar de bold header styling.

`templateVersion`: hard-code `"2.0"` in de generator.

---

## 7. UI changes in Step1Connect

### 7.1 Upload feedback paneel

Na een succesvolle upload (= loader retourneert zonder error throw), toon onder de upload control:

```
✓ Loaded migration-template.xlsx
  · 200 projects · 16,000 tasks · 47 resources · 12,800 assignments
  · 12 custom fields · 4 lookup tables

  ⚠ 23 warnings  [View details ▼]
```

`View details` klapt een lijst open:

```
Warnings (23)
─────────────
[Assignments] Row 47: ResourceId "R999" not found. Skipped.
[Assignments] Row 89: TaskId "T504" not in project "P012". Skipped.
[CustomFields] Row 8: Field "Mystery Type" has unknown FieldType "Numbr". Skipped.
[Tasks] Column "Department": Custom field column detected — task custom fields not migrated.
[TeamMembers] (sheet-level): TeamMembers sheet empty — derived 38 memberships from Assignments.
...
```

Group-by-sheet collapsible. Cap initial render at 50 entries with "Show all" expand if more.

### 7.2 Errors paneel (when loader throws)

Bij `LoaderFileError`:

```
✗ Could not load migration-template.xlsx

  · Required sheet "Projects" not found. Sheet "Project" exists — did you rename it?
  · Required column "TaskId" missing in sheet Tasks.

Download a fresh template and copy your data into it:
[Download empty template]
```

Download-knop is dezelfde `handleDownloadTemplate()`.

### 7.3 Validation status doorgegeven aan context

Sla warnings op in `MigrationState`:

```typescript
interface MigrationState {
  // ... existing
  fileUploadWarnings: LoaderWarning[]  // empty if data source is ProjectOnline
}
```

Reducer action: `SET_FILE_UPLOAD_WARNINGS`.

### 7.4 Step 5 integration

In Step 5 rapport, voeg een sectie "File Upload Warnings" toe (alleen zichtbaar als `state.dataSource === 'FileUpload' && fileUploadWarnings.length > 0`):

```
File Upload Warnings (23)
─────────────────────────
Grouped by sheet:
  · Assignments: 14 warnings — [Expand]
  · CustomFields: 2 warnings — [Expand]
  · Tasks: 5 warnings — [Expand]
  · TeamMembers: 1 info — [Expand]
  · Projects: 1 warning — [Expand]

[Export warnings as CSV]
```

Dit is parallel aan de bestaande "Skipped Fields" sectie uit dataOnly mode.

---

## 8. Edge cases & gotchas

### 8.1 Excel data validation niet ondersteund door SheetJS write
SheetJS schrijft `!dataValidations` niet altijd correct. Verifieer tijdens implementatie via een download+open-in-Excel test. Als blokker: gebruik `exceljs` library voor `generateTemplate()` (parseWorkbook blijft op SheetJS). Beide libraries kunnen in dezelfde bundle co-existeren.

### 8.2 Excel locale-specific date display
Excel toont `2024-01-15` als `15/01/2024` of `1/15/2024` afhankelijk van de Windows locale van de gebruiker. Met `cellDates: true` krijgt de loader een echte Date object — locale-onafhankelijk. Mits de Excel-cel als Date geformatteerd is. Als de gebruiker een datum als plain text invoert (`"15 jan 2024"`), valt het terug op de string-parser, die met name niet-Engelse maandnamen niet kent.

**Mitigatie:** in `_Instructions`, advies: "If you type dates, use the format YYYY-MM-DD. Otherwise, use Excel's date cell type."

### 8.3 Bestand zonder `_Meta` sheet
Mogelijk gevolg van: oude template, handmatig gemaakt bestand, of een kopie waar de gebruiker `_Meta` heeft verwijderd. Error: `MISSING_META_SHEET` met advies om verse template te downloaden.

### 8.4 Custom field met FieldType=Choice maar geen LookupTableName
Choice en MultiChoice zijn picklist-types die niet naar lookup tables wijzen. De LookupTableName kolom is voor hen leeg. Validatie alleen `FieldType=Lookup` vereist `LookupTableName`. Choice/MultiChoice picklist values worden in Step 2 (mapping) ingevoerd, niet in de template.

**Open vraag voor toekomst:** zou een `ChoiceValues` sheet (analoog aan LookupValues) handig zijn voor template-gebruikers? Niet in deze iteratie; voor nu: choice values worden in Step 2 manueel toegevoegd.

### 8.5 Lege Resources sheet maar wel Assignments / TeamMembers
Hoort niet, want elke Assignment/TeamMember ResourceId moet matchen. Bij lege Resources sheet → alle Assignments/TeamMembers worden geskipt met "ResourceId not found" warnings (één per row, kan veel zijn). Cap warnings per code+sheet bij 100 entries met "... and 47 more" toevoeging om de UI niet te overspoelen.

### 8.6 Project zonder enkele task
Volstrekt geldig — sommige migrations betreffen alleen project-metadata. Geen warning.

### 8.7 Custom field met EntityType=Resource
Resources hebben momenteel geen custom field kolommen in de template (Resources sheet heeft alleen Id/Name/Email). Een `EntityType=Resource` custom field wordt wel geparsed, maar er is nergens een waarde voor in te vullen. Warning: `Custom field "X" with EntityType=Resource is defined but Resources sheet has no matching column. Field will be created in schema but never have values.`

### 8.8 `OwnerName` zonder matching Resource
Als `OwnerEmail` matched: `OwnerName` wordt genegeerd (resource is leidend). Als `OwnerEmail` leeg of niet-matched: `OwnerName` wordt gebruikt als display name in selection-filter, en `ProjectOwnerResourceId` blijft leeg / fallback op email-string zoals huidige code doet.

### 8.9 DataverseLogicalName in non-dataOnly mode
Loader leest `DataverseLogicalName` altijd. Step 2 gebruikt het alleen wanneer `migrationMode === 'dataOnly'`. In `full` mode wordt het genegeerd zonder warning.

### 8.10 Templates groter dan browser memory
Niet gesignaleerd in praktijk, maar 50k+ rows × 50 columns kan zwaar worden. SheetJS leest streaming-gewijs maar bouwt wel een full WorkBook object in memory. Voor MVP: geen guard. Toekomstige optimalisatie: paged parse.

### 8.11 Onbekende kolommen in andere sheets dan Projects/Tasks
Bv. een extra kolom in Resources sheet. Loader negeert silently — geen warning. (We waarschuwen alleen voor Projects/Tasks omdat daar custom-field-confusion mogelijk is.)

### 8.12 Re-upload van bestand met zelfde naam
Loader is stateless. Re-upload triggert volledige re-parse. Vorige `fileUploadWarnings` worden vervangen, niet samengevoegd.

### 8.13 Wisselen tussen `ProjectOnline` en `FileUpload` mid-flow
Per addendum B is fetch een expliciete actie. Switching `dataSource` zou bestaande `fetchedData` moeten clearen (huidig gedrag, verifieer). `fileUploadWarnings` moet ook gecleard worden bij switch.

---

## 9. Acceptance criteria

De feature is klaar wanneer:

### Template generation
1. ✅ `generateTemplate()` produceert een v2 xlsx met sheets in volgorde: `_Instructions`, `_Meta`, `Projects`, `Tasks`, `Resources`, `Assignments`, `Dependencies`, `TeamMembers`, `CustomFields`, `LookupValues`
2. ✅ `_Meta` bevat `templateVersion: "2.0"`, `generatedAt: <ISO>`, `generatedBy: "Project Online Migrator"`
3. ✅ `_Instructions` bevat human-readable guidance zoals beschreven in §4.3
4. ✅ Excel data validation dropdowns aanwezig op `IsMilestone`, `IsSummary`, `DependencyType`, `EntityType`, `FieldType` (verifieer door file in Excel te openen)
5. ✅ `Projects` heeft kolom `OwnerName` (tussen `OwnerEmail` en eventuele custom field kolommen)
6. ✅ `CustomFields` heeft kolom `DataverseLogicalName` (na `LookupTableName`)

### Strict structural validation
7. ✅ Upload van bestand zonder `_Meta` → error "This file is not a recognized migration template"
8. ✅ Upload van bestand met `templateVersion: "1.x"` → error "This template is from an older app version"
9. ✅ Upload van bestand met sheet `Project` (single, in plaats van `Projects`) → error "Sheet 'Project' found but expected 'Projects'"
10. ✅ Upload van bestand met kolom `Project ID` (spatie, in plaats van `ProjectId`) → error "Column 'Project ID' found but expected 'ProjectId'"
11. ✅ Upload van bestand zonder verplichte kolom → error met klare melding

### Soft per-row validation
12. ✅ Onbekende `FieldType` → row geskipt + warning in `LoaderResult.warnings`
13. ✅ Lookup type zonder `LookupTableName` → row geskipt + warning
14. ✅ Assignment met onbekende `TaskId` → row geskipt + warning
15. ✅ Task met onbekende `ParentTaskId` → row meegenomen, parent cleared, warning
16. ✅ Custom field kolom in Tasks → warning "task custom fields not migrated"
17. ✅ Custom field kolom in Projects niet in CustomFields → warning "column not defined in CustomFields"
18. ✅ Duplicate `ProjectId` → tweede geskipt + warning
19. ✅ Niet-parseerbare datum → veld cleared + warning
20. ✅ TeamMembers leeg + Assignments aanwezig → auto-afgeleid + info-warning

### Date handling
21. ✅ Excel cell met date formatting (geen string) komt als ISO string in `PoProject.ProjectStartDate`
22. ✅ Excel cell met `"2024-01-15"` als plain text wordt ISO geparsed
23. ✅ Excel cell met `"foo"` → warning + veld cleared
24. ✅ Lege date cel → veld undefined (geen warning)

### DataOnly integration
25. ✅ Custom field met `DataverseLogicalName: "cr123_priority"` ingevuld → veld doorgegeven in `PoCustomField`
26. ✅ In Step 2 dataOnly mode: PO custom field met `DataverseLogicalName` matched direct (geen handmatige selectie nodig)
27. ✅ In Step 2 full mode: `DataverseLogicalName` wordt genegeerd

### UI feedback
28. ✅ Step 1 toont post-upload summary panel met counts per categorie
29. ✅ Warning list expandable, gegroepeerd per sheet
30. ✅ Error panel bij hard fail met klare meldingen + download knop voor verse template
31. ✅ Step 5 rapport bevat "File Upload Warnings" sectie als dataSource = FileUpload en warnings > 0
32. ✅ CSV export van warnings beschikbaar in Step 5

### Integration
33. ✅ Bestaande `ProjectOnline` fetch flow onveranderd
34. ✅ FileUpload met v2 template flow loopt end-to-end door alle 5 steps in full mode
35. ✅ FileUpload met v2 template + dataOnly mode werkt; `DataverseLogicalName` driedn auto-mapping
36. ✅ FileUpload + schemaOnly mode werkt (skipt automatisch data sheets, gebruikt alleen CustomFields + LookupValues)
37. ✅ FileUpload + scope toggles (import-control-spec) werken; data uit unchecked categorieën wordt genegeerd in Step 4
38. ✅ FileUpload + project selection (project-selection-spec) werkt op fetched data
39. ✅ `npm run build` slaagt; `pac code push` deployed cleanly

---

## 10. Implementatie volgorde (aanbevolen)

Fasering minimaliseert risico door incrementeel testen, en eindigt met de UI-verbeteringen die de feature af maken.

1. **`LoaderResult` shape + types** (`LoaderWarning`, `LoaderError`, error codes) — fundament voor de rest. Geen functionele wijziging, alleen typing.
2. **`_Meta` sheet** — toevoegen aan `generateTemplate()` + `parseMetaSheet()` helper + versie-validatie in nieuwe `validateStructure()`. Test: oude v1 template wordt geweigerd.
3. **Strict structural validation** — required sheets + headers met case-insensitive rename detection. Test: hernoemd `Projects` → `Projecten` geeft duidelijke error.
4. **Soft per-row validation skeleton** — warnings accumulator door `parseSheets`, push-points voor bestaande skip/default acties. Test: een file met bekende issues levert correcte warnings.
5. **Reference integrity** — index sets bouwen, validatie in Assignments/Dependencies/TeamMembers/Tasks.ParentTaskId.
6. **Date handling** — `cellDates: true` + `toISODate` helper. Test met Excel-native date cells en string dates.
7. **`DataverseLogicalName` + `OwnerName`** — kolommen toevoegen aan generateTemplate, parsing in loader, doorgeven in PoFetchedData.
8. **TeamMembers derivation** — fallback wanneer sheet leeg + assignments aanwezig.
9. **FieldType / EntityType validatie** — strict per row, warning on unknown.
10. **Excel data validation dropdowns** — testen of SheetJS dit schrijft; switch naar `exceljs` als nodig.
11. **`_Instructions` sheet** — content vullen, kolombreedte instellen voor leesbaarheid.
12. **UI: post-upload panel** in Step1Connect — summary counts + warning list.
13. **UI: error panel** voor hard fails met download-link.
14. **MigrationContext integration** — `fileUploadWarnings` state + reducer action.
15. **UI: Step 5 file upload warnings sectie** + CSV export.
16. **End-to-end test** — alle scope/mode combinaties.
17. **Backwards-compat regression test** — alle bestaande PO fetch flows ongewijzigd.

Geschatte effort: 3–4 dagen development voor een ervaren dev op deze codebase. Stappen 1–8 dekken de loader-laag (~2 dagen). Stappen 9–14 zijn UI + integratie (~1 dag). Resterende tijd voor testing + Excel data validation library check.

---

## 11a. Deviations from original spec

Changes made during implementation that differ from what this document originally specified:

| Deviation | Original spec | Actual implementation | Why |
|---|---|---|---|
| `excelTemplate.ts` renamed | Spec assumes `src/services/excelTemplate.ts` | Renamed to `src/services/fileImportService.ts`; types split to `src/services/fileUpload/types.ts` | Better name; types needed in a separate module to avoid circular imports |
| Working time columns in template | Not in original spec | `Projects` sheet has `WorkHourTemplateName`, `ScheduleMode`, `HoursPerDay`, `HoursPerWeek`, `DaysPerMonth` | Added when working-time-spec was implemented; file upload template is the per-project override mechanism |
| Working time warning codes | Not in original `WarningCode` union | `UNKNOWN_SCHEDULE_MODE`, `WORKING_TIME_OUT_OF_RANGE` added to `WarningCode` in `fileUpload/types.ts` | Required by working time parsing in `fileImportService.ts` |
| `fileUploadProjectOverrides` in `PoFetchedData` | Not in spec | `PoFetchedData` optionally carries `fileUploadProjectOverrides: FileUploadProjectOverride[]` | Mechanism to pass per-project working time overrides from loader to context |
| `EntityType` unknown → silent default | Spec says "dropdown, unknown = row skip + warning" | Unknown `EntityType` defaults silently to `Project` | EntityType has a dropdown in the template; in practice unknown values are likely empty cells, not typos. Row-level skip was deemed too aggressive. |
| `fileUploadWarnings` in MigrationState | Spec §7.3 adds this field | **Not added**. `parseWorkbook` returns warnings but Step1Connect discards them. | Not implemented yet — this is the key gap in the remaining phases. |

---

## 11b. Resolved questions

Questions from §11 that have been answered during implementation:

1. **SheetJS data validation support** (§11 Q1) — **Resolved: SheetJS 0.18.5 community build does NOT write `!dataValidations`.** Confirmed via spike: `generateTemplate()` produces the file, but opening in Excel shows no dropdowns. Switch to `exceljs` for `generateTemplate()` is the accepted path (parser stays on SheetJS). Deferred.

2. **`CustomFieldTypeValue: 0` hardcoded** (§11 Q2) — **Resolved: value is unused in the file-upload write path.** Grep confirms writers don't reference `CustomFieldTypeValue` when processing FileUpload data. Documented with a FIXME comment in `fileImportService.ts`. Safe to leave as-is.

---

## 11. Open vragen (nog onopgelost)

> Q1 en Q2 zijn beantwoord — zie §11b Resolved questions.

3. **`_Instructions` sheet styling:** wide column A, wrapped text, gekleurde headers? Of plain en bare? — **Geïmplementeerd als plain met bold section headers.** Geen aanvullend werk nodig.

4. **Choice/MultiChoice values aanleveren via template:** out of scope voor v2 zoals beschreven (gebruiker doet dit in Step 2). Indien klanten vragen om template-side definitie: voeg `ChoiceValues` sheet toe in v2.1 (analoog aan LookupValues, met `(ChoiceSetName, OptionLabel)` kolommen). Niet nu.

5. **Warning cap per code+sheet:** geïmplementeerd op 100 (`WARNING_CAP` in `fileImportService.ts`). CSV export (AC 32) zou de volledige set moeten bevatten — maar die is nog niet gebouwd. Tot die tijd kan de cap een blinde vlek zijn bij zeer grote files.

6. **Template-versie bump strategy:** geïmplementeerd via major-version check in `validateStructure()`: major < 2 → error; major > 2 → `TEMPLATE_VERSION_NEWER` warning; onbekende kolommen worden stil genegeerd. Schema voor v2.1 is dus backwards-compatible.
