# Project Online Migrator — Context File

> **Purpose:** Drop this file into any new Claude chat to skip the "explain everything from scratch" phase.
> **Last updated:** June 2026

---

## What the app does

A 5-step Power Apps Code App that migrates data from **Microsoft Project Online** (SharePoint-based) to **Planner Premium** (Dataverse / Project for the Web).

Steps:
1. **Connect & Fetch** — pick migration mode, configure source (PWA URL or Excel/CSV upload) + target Dataverse solution, then fetch
2. **Field Mapping** — map PO fields to Dataverse columns; configure custom field choices; project selection / bulk controls
3. **Create Columns / Validate Schema** — create target columns + global option sets (full/schemaOnly modes) or read-only validation (dataOnly mode)
4. **Import Data** — write records: resources → projects → tasks → assignments; scope toggles, parallel processing, ETA, stop control
5. **Validation Report** — summary, errors, skipped fields report, downloadable CSV

---

## Tech stack

- React + TypeScript Power Apps Code App (PCF-style)
- Dataverse REST API for writes (msdyn_* unbound actions, OperationSet API)
- SharePoint OData API for reads
- Power Apps CLI (`pac code push`) for deployment — requires `npm run build` first
- Custom connector operations registered in `client.ts` singleton

---

## Deploy

```
npm run build
"C:\Users\jan-l\AppData\Local\Microsoft\PowerAppsCLI\pac.cmd" code push
```
The `pac` on PATH is a broken npm shim (Node 24 incompatible). Always use the full path above.
Target: https://dev-jehe.crm4.dynamics.com — published as jean.heyns@exerti.com

Git remote: https://github.com/JeanHeyns/MigrationApp — branch `main`

---

## Migration modes

| Modus | Schema | Data |
|---|---|---|
| `full` | ✅ create | ✅ migrate |
| `dataOnly` | ⏭ reuse | ✅ migrate |
| `schemaOnly` | ✅ create | ⏭ skip |

`migrationMode: 'full' | 'dataOnly' | 'schemaOnly'` is the **single source of truth**. `skipColumnCreation` is derived from it. Mode is chosen **first** in Step 1; source/target config and the fetch follow (fetch scope is mode-dependent — `schemaOnly` only needs custom fields + lookup tables, no project/task data).

### Full mode
Creates custom columns + global option sets in Dataverse, then writes data. Use when target schema is empty or being built fresh.

### DataOnly mode
Uses existing Dataverse schema. Step 3 is read-only. Resolvers translate PO labels → Dataverse values (option set integers, lookup GUIDs). Skipped fields surface in Step 5. Use for second PWA, prod after test, customer-prepared schema.

### SchemaOnly mode
Creates columns + option sets + custom lookup entities + lookup entries. Step 4 skipped. Use to prepare a target environment before someone else (or you) does the data import later via `dataOnly`.

---

## Shared state (MigrationContext)

```typescript
MigrationState {
  currentStep: 1–5
  pwaUrl: string
  dataverseOrgUrl: string | null            // resolved org URL; null until resolved
  dataverseUrlSource: 'loading' | 'localStorage' | 'environmentVariable' | 'manualInput' | 'error'
  dataverseUrlError: string | null
  dataSource: 'ProjectOnline' | 'FileUpload'
  selectedSolution: DvSolution | null
  migrationMode: 'full' | 'dataOnly' | 'schemaOnly'
  skipColumnCreation: boolean              // derived from mode
  fetchedData: PoFetchedData | null         // projects, tasks, resources, assignments, customFields, dependencies
  selectedProjectIds: Set<string>           // project-selection filter (Set, not array)
  projectFilter: ProjectFilter              // { searchTerm, date ranges, ownerNames, taskCount min/max }
  migrationScope: { projects: true; tasks, dependencies, assignments, resources: boolean }
  mappingConfig: MappingConfiguration | null
  optionSetMappings: OptionSetMapping[]
  schemaSnapshot: SchemaSnapshot | null     // dataOnly: scan of target solution
  resolverPlan: ResolverPlan | null         // dataOnly: built at end of Step 2
  skippedFieldInstances: SkippedFieldInstance[]  // dataOnly: aggregated from writers
  schemaCreationResults: SchemaCreationResults | null  // full/schemaOnly: column + option set create results
  projectWriteDiagnostics: ProjectWriteDiagnostic[]    // per-project write outcome details
  associationDiagnostics: AssociationAttempt[]         // N:N association attempt results (multi-lookup)
  importResults: ImportResult[]
  logs: LogEntry[]
  importProgress: ImportProgress | null     // { startedAt, projectsCompleted, projectsTotal, concurrency }
  stopRequested: boolean                    // set by "Stop" button; checked by writers between projects
  importWasStopped: boolean
  workHourTemplates: WorkHourTemplate[]     // fetched from msdyn_workhourtemplates
  scheduleModeOptions: ScheduleModeOption[] // fetched from msdyn_project attribute metadata
  projectDefaults: ProjectDefaults          // global work hour template + schedule mode + h/d/h/w/d/m
  projectOverrides: Map<string, ProjectOverride>  // per-project overrides (Step 2 modal or file upload)
}
```

---

## Key files

| Path | Purpose |
|------|---------|
| `src/client.ts` | Power Apps SDK singleton — all custom API operations registered here, once |
| `src/app/MigrationContext.tsx` | All shared wizard state |
| `src/config/environment.ts` | Dataverse org URL |
| `src/services/dataverseService.ts` | Dataverse REST wrapper (list/create/update/metadata) |
| `src/services/sharepointService.ts` | SharePoint OData wrapper |
| `src/services/fileImportService.ts` | Excel template generation (`generateTemplate`) + full v2 parsing (`parseWorkbook`) with strict/soft validation |
| `src/services/fileUpload/types.ts` | `LoaderWarning`, `LoaderError`, `LoaderResult`, `LoaderFileError` — shared types for file-upload validation |
| `src/services/environmentResolver.ts` | Resolve Dataverse org URL: env variable → localStorage → manual input; `EnvironmentResolveResult`, `MissingDataverseUrlError` |
| `src/services/plannerPremium/` | All Dataverse write logic (projects, tasks, resources, assignments) |
| `src/services/projectOnline/` | All Project Online fetch logic |
| `src/steps/Step*/index.tsx` | One component per wizard step |

### Service layer — Dataverse writes (`services/plannerPremium/`)

| File | Purpose |
|---|---|
| `projectWriter.ts` | `msdyn_CreateProjectV1` unbound action; skip duplicates; dataOnly branch via `resolvers` param; applies working time settings (work hour template, schedule mode, h/d/h/w/d/m) |
| `taskWriter.ts` | OperationSet API; clear & recreate tasks; **task custom fields intentionally not migrated** (OperationSet limitation) |
| `assignmentWriter.ts` | `msdyn_CreateTeamMemberV1`; assignments via OperationSet |
| `dependencyWriter.ts` | Task dependencies via OperationSet; 180/batch cap; FS/SS/FF/SF → Dataverse link type values; per-project grouping |
| `resourceWriter.ts` | Team member records |
| `scheduleApi.ts` | Wrapper: CreateOperationSetV1 → PssCreateV1 × N → ExecuteOperationSetV1; batch-fail partial retry (excludes failing element, retries rest) |
| `schemaOrchestrator.ts` | Orchestrate full schema creation: columns + option sets + lookup entities + M2M relationships; central entry point for Step 3 |
| `columnManager.ts` | Text/memo/integer/decimal/lookup columns on entities |
| `choiceSetManager.ts` | Global option sets via CreateGlobalOptionSet custom operation |
| `lookupEntityManager.ts` | Create/ensure custom Dataverse entities for PO lookup tables (full/schemaOnly mode); resolves entity set name + primary name field |
| `dataverseClient.ts` | `listRecords`, `patchRecord`, `performUnboundAction`, `listAllRecords` (paged) |
| `schemaInspector.ts` | (dataOnly) Inspect target solution custom attributes + lookup nav properties, including N:N relationships |
| `resolverFactory.ts` | (dataOnly) Direct/Choice/MultiChoice/Lookup/MultiLookup(N:N) resolvers; module-level option set cache |
| `recordResolverApplier.ts` | (dataOnly) `applyResolvers()` — payload + skipped fields per record |
| `errorClassifier.ts` | Classify Dataverse errors: `AlreadyExists`, `OutlineDemoteTooFar`, `BatchFailed`, `Timeout`, `Throttled`, `NonFSDependency`, `PredecessorMissing` |
| `concurrency.ts` | `runWithConcurrency()` — concurrent task executor; default 3, max 8 via `CONCURRENCY_LIMIT` localStorage |
| `importHelpers.ts` | Shared utilities: `escapeODataString`, `nowError`, `getRecordId`, `chunks` |
| `workHourTemplates.ts` | Fetch `msdyn_workhourtemplates` records from Dataverse |
| `scheduleMode.ts` | Fetch `msdyn_schedulemode` option set from Dataverse attribute metadata; module-level cache; static fallback list |

### Service layer — Project Online reads (`services/projectOnline/`)

| File | Purpose |
|---|---|
| `projects.ts` | `_api/ProjectData/Projects` |
| `tasks.ts` | `_api/ProjectData/Tasks` |
| `resources.ts` | Team members |
| `assignments.ts` | Task assignments + project team members |
| `dependencies.ts` | Task dependencies (`TaskLinks`) per project; concurrent fetch (default 6, max 12 via localStorage) |
| `customFields.ts` | Custom field metadata via ProjectServer API; `toLogicalName()` helper for Dataverse naming; `IsMultiValue` detection for LookupMulti |
| `lookupTables.ts` | Lookup table / choice set definitions; OData `$expand` to nest entries |
| `odataClient.ts` | OData wrapper with paging (dual response format support) |

---

## Architecture rules

- `client.ts` is a **singleton** — custom connector operations must be registered there, once
- SharePoint URL must be **single-encoded**; SDK re-encodes it (double-encoding lands correctly at SP)
- Dataverse metadata API uses custom operations: `CreateGlobalOptionSet`, `CreateEntityAttribute`, `GetGlobalOptionSetByName`
- Task/assignment/**dependency** writes use Project schedule OperationSet API (**max 180 per batch**): `msdyn_CreateOperationSetV1` → `msdyn_PssCreateV1` × N → `msdyn_ExecuteOperationSetV1`
- Projects created via `msdyn_CreateProjectV1` unbound action
- Team members created via `msdyn_CreateTeamMemberV1` unbound action
- Schema creation goes through `schemaOrchestrator.ts` — do not call `columnManager`, `choiceSetManager`, or `lookupEntityManager` directly from steps
- Dataverse org URL is resolved in `environmentResolver.ts`; Step 1 calls it on mount; URL flows through `MigrationContext` as `dataverseOrgUrl`

### Entity mapping

- Project → `msdyn_project`
- Task → `msdyn_projecttask`
- Team member → `msdyn_projectteam`

---

## Known constraints & gotchas

- **Task custom fields**: not migrated (OperationSet API limitation, intentional — `void mappingConfig` in `taskWriter.ts` is deliberate)
- **OperationSet batch limit**: max 180 operations per batch (tasks, assignments, and dependencies all share this limit)
- **"Already exists" errors** (`0x80044331`, `0x80060891`, `0x80040265`, `0x8004f049`, `0x80048408`): treated as success/skip by `errorClassifier.ts`
- **Non-FS dependency types** (SS, FF, SF): only supported on Project Plan 3+ licenses; classified as `NonFSDependency` by `errorClassifier.ts`, logged as warnings, not failures
- **SharePoint URLs**: single-encode them, SDK re-encodes
- **Build before deploy**: `npm run build` must run before `pac code push`
- **Lookup navigation property** ≠ logical name: `cr123_category` (logical) vs `cr123_Category` (nav prop). Always fetch via `ManyToOneRelationships` metadata.
- **Polymorphic lookups**: only first `Targets[]` entry used
- **Localization**: option set labels matched against `UserLocalizedLabel` + all `LocalizedLabels`
- **Lookup tables > 5000 records**: pre-load with cap + warning; lazy resolver not yet implemented
- **PO summary task** (the implicit project-root task) is excluded from migration
- **Custom field API**: use ProjectServer API for custom fields/lookup tables, NOT ProjectData API
- **SheetJS `!dataValidations`**: confirmed NOT written by SheetJS 0.18.5 community build (spike done, comment in `fileImportService.ts`); Excel dropdowns in the template require switching `generateTemplate()` to `exceljs`
- **`CustomFieldTypeValue` in file-upload path**: hardcoded to `0` in `fileImportService.ts`; writers don't use this value in the FileUpload path — documented with a FIXME
- **`CONCURRENCY_LIMIT` localStorage override**: `concurrency.ts` reads this; default 3, max 8; useful for debugging throttle issues
- **File upload warnings not persisted**: `parseWorkbook()` returns `LoaderResult.warnings` but Step1Connect discards them — not stored in MigrationState, not shown in Step 5

---

## Implemented features (history)

These features have been built and merged. Full specs archived; summarize here so context is preserved.

| Feature | What it adds | Key spec |
|---|---|---|
| **DataOnly mode** | Second migration mode using existing schema; resolvers for choice/lookup; skipped fields report | `data-only-migration-spec.md` + addendum A |
| **Mode-first Step 1** | Migration mode picked before fetch; fetch scope mode-dependent | addendum B |
| **SchemaOnly mode** | Third migration mode; creates schema (+ custom lookup entities + entries) without data | `schema-only-migration-spec.md` |
| **Import control** | Step 4 scope toggles, parallel project processing, smart inter-batch delay, ETA, stop migration, browser-close guard | `import-control-spec.md` |
| **Project selection** | Bulk-select controls, range/shift-click, filters, CSV import of project IDs, "X of Y selected" header | `project-selection-spec.md` |
| **May 2026 fixes** | Full-mode custom field population, lookup column creation, state reset on wizard restart | `2026-05-fixes-full-mode-customfields-lookup-reset.md` |
| **Multi-lookup (N:N)** | `LookupMulti` PO fields → Dataverse N:N relationships; configurable match-field; full/dataOnly/schemaOnly support; `associationDiagnostics` in Step 5 | `multi-lookup-spec.md` + addendum A |
| **Dependency migration** | Fetch task links from PO (`dependencies.ts`); write `msdyn_projecttaskdependency` via OperationSet (`dependencyWriter.ts`); FS/SS/FF/SF type mapping; scope toggle | — |
| **Working time config** | Global + per-project work hour template, schedule mode, h/d/h/w/d/m; fetched from Dataverse; file upload template columns (`WorkHourTemplateName`, `ScheduleMode`, etc.); applied in `projectWriter.ts` | `working-time-spec.md` |
| **Import resilience** | Per-record error classification (`errorClassifier.ts`); batch-fail partial retry in `scheduleApi.ts`; dependency batch cap + retry-on-timeout; `0x80040265` added to skip-as-success | `import-resilience-spec.md` |
| **File upload v2 (loader)** | Template v2 (`_Meta`, `_Instructions`, working time columns); strict structural validation; soft per-row validation with `LoaderWarning[]`; date handling; reference integrity; TeamMembers derivation | `file-upload-spec.md` (partial — see Active) |
| **Environment URL resolution** | `environmentResolver.ts` — env variable → localStorage → manual input; stored in MigrationContext as `dataverseOrgUrl` / `dataverseUrlSource` | — |

---

## Active / pending features

- **File upload UI feedback** (`file-upload-spec.md` §7, AC 28–32) — the loader (`fileImportService.ts`) is complete and returns `LoaderResult.warnings`, but Step1Connect discards warnings and shows only a basic error string on hard fail. Missing: structured error panel (`LoaderFileError.errors` list), warning count + expandable list, `fileUploadWarnings` in MigrationState, Step 5 "File Upload Warnings" section, CSV export. These are the remaining phases (12–17) from the spec.
- **Excel dropdown validations** (`file-upload-spec.md` §5, AC 4) — SheetJS can't write `!dataValidations`; requires switching `generateTemplate()` to `exceljs`. Deferred per spec §8.1.

---

## Common debug toggles

```js
// Verbose dataOnly writer logging
localStorage.setItem('DEBUG_DATAONLY_WRITER', '1')

// Override parallel project concurrency (default 3, max 8)
localStorage.setItem('CONCURRENCY_LIMIT', '1')  // set to 1 to serialize for debugging

// Override dependency fetch concurrency (default 6, max 12)
// Set via DEPENDENCY_FETCH_CONCURRENCY key in localStorage
```

---

## Current pain points & opportunities

Concrete candidates for future work, grounded in code observations (June 2026):

- **File upload warnings are silently discarded** — `parseWorkbook()` in `fileImportService.ts` returns `LoaderResult.warnings[]`, but `Step1Connect/index.tsx` only uses `.fetchedData` and throws the warnings away. The loader did all the work; the UX value is missing. `fileUploadWarnings` was never added to MigrationState. Straightforward wiring job (AC 28–32 from `file-upload-spec.md`). High user-facing impact.

- **Hard-fail error panel shows raw string, not structured list** — when `parseWorkbook` throws a `LoaderFileError`, Step1Connect catches it with `setUploadError(String(err))`, which loses the typed `errors: LoaderError[]` array. User sees "LoaderFileError: This file is not a recognized migration template; Required column 'ProjectId'..." as one blob. Structured display is already designed in spec §7.2.

- **`projectOnlineService.ts` is an orphan** — `src/services/projectOnlineService.ts` (connector-based PO operations using `shared_projectonline`) is not imported by any other file. It either predates the OData-direct approach or was scaffolded but never wired. Should be confirmed and deleted if unused, to avoid confusion.

- **No end-to-end smoke test for dependency scope toggle** — `dependencyWriter.ts` exists and the scope toggle wires to `migrationScope.dependencies`, but the dependency fetch in `projectOnline/dependencies.ts` uses `runWithConcurrency` defined locally (not the shared one in `concurrency.ts`). Worth verifying the two implementations stay in sync, and adding a smoke-test project with known dependencies.

- **Working time per-project override in Step 2** — the spec and MigrationState include `projectOverrides: Map<string, ProjectOverride>` and `setProjectOverride` action, but it's unclear if the Step 2 UI actually renders the per-project settings modal. `projectWriter.ts` applies the overrides if they exist. If the Step 2 modal is missing, the file-upload column path is the only way to set per-project overrides.

- **`schemaOrchestrator.ts` vs `schemaInspector.ts` boundary is blurry** — orchestrator centralizes schema creation; inspector does dataOnly reads. Both deal with the Dataverse schema layer but from opposite directions. If the project moves toward a unified schema service, these are the two files to merge or clearly delineate.

- **Warning cap (100/code+sheet) with no CSV escape hatch** — `fileImportService.ts` caps warnings at 100 per sheet+code combination. For a large upload (50k+ rows with many bad references) the user can't see all warnings. The CSV export of warnings (AC 32) was designed to bypass this cap but is not yet implemented.

---

## How I prefer to work (Jean's preferences)

- **Direct, concise communication.** No unnecessary clarifying questions when context is clear.
- **Dutch ↔ English mix** is fine. Code/technical terms in English, discussion in Dutch where natural.
- **Spec-first for non-trivial features.** Write a markdown spec, hand to Claude Code, work in phased sessions (UI / services / orchestration / reporting).
- **Verification per phase**, not all at the end. Skip occasionally if the risk is acceptable.
- **Commit per session** for clean review.
- **Architectural decisions get comments in code** so future-me doesn't undo them as "fixes".
- **Backwards compat is non-negotiable.** New features branch on mode/flag; existing paths stay untouched.
- **Spec pattern:** base spec → addenda for course corrections → wrap-up at the end. Keeps architectural reasoning traceable.
