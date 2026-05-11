# Project Online Migrator — Context File

> **Purpose:** Drop this file into any new Claude chat to skip the "explain everything from scratch" phase.
> **Last updated:** May 2026

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
  dataSource: 'ProjectOnline' | 'FileUpload'
  selectedSolution: DvSolution | null
  migrationMode: 'full' | 'dataOnly' | 'schemaOnly'
  skipColumnCreation: boolean              // derived from mode
  fetchedData: PoFetchedData | null         // projects, tasks, resources, assignments, customFields
  selectedProjectIds: string[]              // project-selection filter
  migrationScope: { tasks, dependencies, assignments, resources: boolean }
  mappingConfig: MappingConfiguration | null
  optionSetMappings: OptionSetMapping[]
  schemaSnapshot: SchemaSnapshot | null     // dataOnly: scan of target solution
  resolverPlan: ResolverPlan | null         // dataOnly: built at end of Step 2
  skippedFieldInstances: SkippedFieldInstance[]  // dataOnly: aggregated from writers
  importResults: ImportResult[]
  logs: LogEntry[]
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
| `src/services/excelTemplate.ts` | Excel template generation + parsing (file-upload data source) |
| `src/services/plannerPremium/` | All Dataverse write logic (projects, tasks, resources, assignments) |
| `src/services/projectOnline/` | All Project Online fetch logic |
| `src/steps/Step*/index.tsx` | One component per wizard step |

### Service layer — Dataverse writes (`services/plannerPremium/`)

| File | Purpose |
|---|---|
| `projectWriter.ts` | `msdyn_CreateProjectV1` unbound action; skip duplicates; dataOnly branch via `resolvers` param |
| `taskWriter.ts` | OperationSet API; clear & recreate tasks; **task custom fields intentionally not migrated** (OperationSet limitation) |
| `assignmentWriter.ts` | `msdyn_CreateTeamMemberV1`; assignments via OperationSet |
| `resourceWriter.ts` | Team member records |
| `scheduleApi.ts` | Wrapper: CreateOperationSetV1 → PssCreateV1 × N → ExecuteOperationSetV1 |
| `columnManager.ts` | Text/memo/integer/decimal columns on entities |
| `choiceSetManager.ts` | Global option sets via CreateGlobalOptionSet custom operation |
| `dataverseClient.ts` | `listRecords`, `patchRecord`, `performUnboundAction`, `listAllRecords` (paged) |
| `schemaInspector.ts` | (dataOnly) Inspect target solution custom attributes + lookup nav properties |
| `resolverFactory.ts` | (dataOnly) Direct/Choice/MultiChoice/Lookup resolvers; module-level option set cache |
| `recordResolverApplier.ts` | (dataOnly) `applyResolvers()` — payload + skipped fields per record |

### Service layer — Project Online reads (`services/projectOnline/`)

| File | Purpose |
|---|---|
| `projects.ts` | `_api/ProjectData/Projects` |
| `tasks.ts` | `_api/ProjectData/Tasks` |
| `resources.ts` | Team members |
| `assignments.ts` | Task assignments + project team members |
| `customFields.ts` | Custom field metadata via ProjectServer API; `toLogicalName()` helper for Dataverse naming |
| `lookupTables.ts` | Lookup table / choice set definitions; OData `$expand` to nest entries |
| `odataClient.ts` | OData wrapper with paging (dual response format support) |

---

## Architecture rules

- `client.ts` is a **singleton** — custom connector operations must be registered there, once
- SharePoint URL must be **single-encoded**; SDK re-encodes it (double-encoding lands correctly at SP)
- Dataverse metadata API uses custom operations: `CreateGlobalOptionSet`, `CreateEntityAttribute`, `GetGlobalOptionSetByName`
- Task/assignment writes use Project schedule OperationSet API (**max 180 per batch**): `msdyn_CreateOperationSetV1` → `msdyn_PssCreateV1` × N → `msdyn_ExecuteOperationSetV1`
- Projects created via `msdyn_CreateProjectV1` unbound action
- Team members created via `msdyn_CreateTeamMemberV1` unbound action

### Entity mapping

- Project → `msdyn_project`
- Task → `msdyn_projecttask`
- Team member → `msdyn_projectteam`

---

## Known constraints & gotchas

- **Task custom fields**: not migrated (OperationSet API limitation, intentional — `void mappingConfig` in `taskWriter.ts` is deliberate)
- **OperationSet batch limit**: max 180 operations per batch
- **"Already exists" errors** (`0x80044331`, `0x80060891`): treated as success/skip, not failures
- **SharePoint URLs**: single-encode them, SDK re-encodes
- **Build before deploy**: `npm run build` must run before `pac code push`
- **Lookup navigation property** ≠ logical name: `cr123_category` (logical) vs `cr123_Category` (nav prop). Always fetch via `ManyToOneRelationships` metadata.
- **Polymorphic lookups**: only first `Targets[]` entry used
- **Localization**: option set labels matched against `UserLocalizedLabel` + all `LocalizedLabels`
- **Lookup tables > 5000 records**: pre-load with cap + warning; lazy resolver not yet implemented
- **PO summary task** (the implicit project-root task) is excluded from migration
- **Custom field API**: use ProjectServer API for custom fields/lookup tables, NOT ProjectData API

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

---

## Active / pending features

- **File upload template & loader** (`file-upload-spec.md`) — happy-path parser exists in `excelTemplate.ts`; spec covers strict validation, soft per-row validation, Excel dropdowns, dataOnly-awareness via optional `DataverseLogicalName` column

---

## Common debug toggles

```js
// Verbose dataOnly writer logging
localStorage.setItem('DEBUG_DATAONLY_WRITER', '1')
```

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
