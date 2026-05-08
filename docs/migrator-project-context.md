# Project Online Migrator — Context File

> **Purpose:** Drop this file into any new Claude chat to skip the "explain everything from scratch" phase.
> **Last updated:** May 2026

---

## What the app does

A 5-step Power Apps Code App that migrates data from **Microsoft Project Online** (SharePoint-based) to **Planner Premium** (Dataverse / Project for the Web).

Steps:
1. **Connect & Fetch** — connect PWA URL or upload Excel/CSV, choose target Dataverse solution, pick migration mode (full or dataOnly)
2. **Field Mapping** — map PO fields to Dataverse columns; configure custom field choices
3. **Create Columns / Validate Schema** — create target columns + global option sets (full mode) or read-only validation (dataOnly mode)
4. **Import Data** — write records: resources → projects → tasks → assignments
5. **Validation Report** — summary, errors, skipped fields report, downloadable CSV

---

## Tech stack

- React + TypeScript Power Apps Code App (PCF-style)
- Dataverse REST API for writes (msdyn_* unbound actions, OperationSet API)
- SharePoint OData API for reads
- Power Apps CLI (`pac code push`) for deployment — requires `npm run build` first
- Custom connector operations registered in `client.ts` singleton

---

## Migration modes

### Full mode (original)
Creates custom columns + global option sets in Dataverse, then writes data. Use when target schema is empty or being built fresh.

### DataOnly mode (added 2026)
Uses existing Dataverse schema. Step 3 is read-only. Resolvers translate PO labels → Dataverse values (option set integers, lookup GUIDs). Skipped fields surface in Step 5. Use when schema already exists (second PWA, prod after test, customer-prepared schema).

`migrationMode: 'full' | 'dataOnly'` is the single source of truth. `skipColumnCreation` is derived from it.

---

## Shared state (MigrationContext)

```typescript
MigrationState {
  currentStep: 1–5
  pwaUrl: string
  dataSource: 'ProjectOnline' | 'FileUpload'
  selectedSolution: DvSolution | null
  migrationMode: 'full' | 'dataOnly'
  skipColumnCreation: boolean              // derived from mode
  fetchedData: PoFetchedData | null         // projects, tasks, resources, assignments, customFields
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

## Service layer — Dataverse writes (`services/plannerPremium/`)

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

## Service layer — Project Online reads (`services/projectOnline/`)

| File | Purpose |
|---|---|
| `projects.ts` | `_api/ProjectData/Projects` |
| `tasks.ts` | `_api/ProjectData/Tasks` |
| `resources.ts` | Team members |
| `assignments.ts` | Task assignments + project team members |
| `customFields.ts` | Custom field metadata; `toLogicalName()` helper for Dataverse naming |
| `lookupTables.ts` | Lookup table / choice set definitions |
| `odataClient.ts` | OData wrapper with paging |

---

## Entity mapping

- Project → `msdyn_project`
- Task → `msdyn_projecttask`
- Team member → `msdyn_projectteam`

---

## Known constraints & gotchas

- **Task custom fields**: not migrated (OperationSet API limitation, intentional)
- **OperationSet batch limit**: max 180 operations per batch
- **"Already exists" errors** (`0x80044331`, `0x80060891`): treated as success/skip
- **SharePoint URLs**: single-encode them, SDK re-encodes
- **Build before deploy**: `npm run build` must run before `pac code push`
- **Lookup navigation property** ≠ logical name: `cr123_category` (logical) vs `cr123_Category` (nav prop). Always fetch via `ManyToOneRelationships` metadata.
- **Polymorphic lookups**: only first `Targets[]` entry used
- **Localization**: option set labels matched against `UserLocalizedLabel` + all `LocalizedLabels`
- **Lookup tables > 5000 records**: pre-load with cap + warning; lazy resolver not yet implemented
- **Custom connector operations**: registered once in `client.ts` singleton

---

## Documentation

Project docs live in `docs/`:
- `data-only-migration-spec.md` — DataOnly feature spec
- `data-only-migration-spec-addendum-A.md` — Direction A clarification (mode as single source of truth)
- `dataonly-feature-wrap-up.md` — implementation summary of DataOnly

When starting work on a new feature, follow the same pattern: write a spec → addenda for course corrections → wrap-up at the end. Keeps architectural reasoning traceable.

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
