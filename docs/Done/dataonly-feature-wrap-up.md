# Data-Only Migration Mode — Implementation Wrap-up

> **Feature status:** Implemented across 7 sessions
> **Date completed:** May 2026
> **Spec references:** `data-only-migration-spec.md` + `data-only-migration-spec-addendum-A.md`

---

## 1. What was built

A second migration mode (`dataOnly`) alongside the existing `full` mode. In `dataOnly` mode, the migrator uses an **existing** Dataverse schema (custom columns + global option sets) instead of creating new ones. Only data is migrated.

**Use cases:**
- Second PWA site migrating to same target solution
- Production run following a test run
- Customer prepared schema manually in Dataverse beforehand
- Re-running migration without rebuilding schema

---

## 2. Architecture overview

### Mode selection
- User picks `'full'` or `'dataOnly'` in Step 1
- `migrationMode` is single source of truth
- `skipColumnCreation` is **derived** from mode, no longer a UI toggle

### Schema inspection (dataOnly only)
- Auto-triggered when solution selected in dataOnly mode
- Fetches custom attributes from `msdyn_project`, `msdyn_projecttask`, `msdyn_projectteam`
- Resolves lookup `navigationProperty` via `ManyToOneRelationships` metadata
- Detects global option set names per Picklist column
- Cached in `MigrationState.schemaSnapshot` for the session

### Field mapping (Step 2)
- In `dataOnly`: dropdown shows **only existing** custom columns, no "create new" option
- Auto-match strategies: logical name → prefix-stripped logical name → display name
- Status indicators: 🟢 auto-matched / 🟡 unmapped / 🔴 unmappable (no compatible column)
- Type-compatibility warnings (non-blocking)
- Per-row "Skip" option for explicit non-migration
- Banner above Next: "N fields have no mapping" with click-to-scroll
- `ResolverPlan` built when leaving Step 2

### Resolution & writing (Step 4)
- `buildResolverMap(resolverPlan)` runs once before writers
- Build-time warnings (duplicate lookup names, large tables) → `addLog`
- Resolvers passed to writers as 5th param (only in dataOnly)
- Per-record: `applyResolvers` produces payload + skippedFields list
- Skipped fields aggregated to `MigrationState.skippedFieldInstances`

### Reporting (Step 5)
- New "Skipped Fields" section (dataOnly only)
- Grouped by `(poField, reason)`, sorted by record count desc
- 5 unique example values per group with "+N more"
- CSV export: one row per instance, filename includes solution + date
- Empty state: "✓ All fields migrated successfully"

---

## 3. New files

| File | Purpose |
|---|---|
| `src/models/dataOnly.types.ts` | `MigrationMode`, `ColumnMeta`, `EntitySchema`, `SchemaSnapshot`, `ResolverPlan`, `ResolverEntry`, `SkippedFieldInstance` |
| `src/services/plannerPremium/schemaInspector.ts` | `inspectSolution()` — parallel entity scan + nav property resolution |
| `src/services/plannerPremium/resolverFactory.ts` | Direct/Choice/MultiChoice/Lookup resolvers + module-level option set cache |
| `src/services/plannerPremium/recordResolverApplier.ts` | `applyResolvers()` — payload builder + skipped field tracking |

---

## 4. Modified files

| File | Change |
|---|---|
| `src/app/MigrationContext.tsx` | +5 state fields, +5 actions for migrationMode, schemaSnapshot, resolverPlan, skippedFieldInstances |
| `src/client.ts` | +3 metadata operations: GetEntityAttributes, GetEntityAttributesByCast, GetEntityManyToOneRelationships |
| `src/services/dataverseService.ts` | +6 metadata helpers + `listAllRecords()` paging |
| `src/models/mapping.types.ts` | `MappingConfiguration.migrationMode` added |
| `src/steps/Step1Connect/index.tsx` | Mode toggle, auto-scan trigger, scan summary with refresh |
| `src/steps/Step2Mapping/index.tsx` | DataOnly dropdown, auto-match, banner, conditional column 5 hiding, mode-aware Next label, JSON save/load with mode |
| `src/steps/Step3CreateColumns/index.tsx` | Read-only summary in dataOnly mode |
| `src/steps/Step4Import/index.tsx` | `buildResolverMap` orchestration, warnings to log, resolvers to writers, skippedFields aggregation |
| `src/steps/Step5Report/index.tsx` | Skipped Fields section with grouping + CSV export |
| `src/services/plannerPremium/projectWriter.ts` | DataOnly branch via 5th `resolvers` param, debug logging via localStorage |

**Unchanged (intentional):** `taskWriter.ts`, `assignmentWriter.ts`, `resourceWriter.ts` — task custom fields not migrated (OperationSet API limitation, documented).

---

## 5. Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Mode selection | Explicit toggle in Step 1 | User knows their intent; clear mental model |
| `skipColumnCreation` | Derived from mode, no UI | Eliminates two-source-of-truth conflict |
| Lookup resolver strategy | Pre-load all target records | Simple, works for <5000 records (warn above) |
| Onresolvable choice/lookup | Skip field, log WARN | Pragmatic: completeness > perfection; record still migrated |
| Pre-flight validation | None | Errors surface in Step 4 logs and Step 5 report |
| MultiChoice partial match | `unresolved` (not `resolved` with partial value) | Symmetric with single-choice; prevents silent data loss |
| Resolver build location | Once at Step 4 entry, not per record | Performance; option sets and lookup tables fetched once |
| Resolver map key | `ODataFieldName` | Matches `getSourceValue()` in `importHelpers`, no double-mapping |
| Build-time warnings | Return value `{ resolvers, warnings }` | Pure function, caller controls logging |
| Option set cache | Module-level Map in resolverFactory + `clearResolverCaches()` | No state pollution, easy invalidation |
| Debug logging | `localStorage.getItem('DEBUG_DATAONLY_WRITER') === '1'` | Toggle without rebuild in browser context |
| Patch failure in dataOnly | `success: true` + error in result | Project record exists; failure visible but not blocking |

---

## 6. Known limitations

- **Task custom fields**: not migrated (OperationSet API, intentional, predates this feature)
- **Lookup tables > 5000 records**: pre-load with cap, warning in Step 5
- **Polymorphic lookups**: only first `Targets[]` entry used
- **Localization**: option set labels matched against `UserLocalizedLabel` AND all `LocalizedLabels` (not configurable)
- **Schema staleness**: snapshot lives one session, manual refresh button available
- **Hybrid mode**: not supported (full create + reuse mix per field) — out of scope
- **Mapping persistence across sessions**: only via JSON save/load, no automatic store

---

## 7. Out-of-scope (for future iterations)

These were considered and explicitly deferred:

1. **Hybrid mode** — mix `create_new` and `use_existing` per field
2. **Pre-flight validation step** — Step 2.5 dry-run resolution report
3. **Mapping persistence** — auto-save mapping per (PWA, solution) combo
4. **Schema diff** — detect option set value changes between runs
5. **Lazy lookup resolver** — for tables >5000, fetch on demand with `$filter`
6. **Re-run failed records only** — recovery without full re-migration
7. **Auto-fix suggestions** — "Add 'Critical' to option set" actionable links

---

## 8. Testing notes

End-to-end validation scenarios performed (or to perform):

- ✅ Full mode regression: existing functionality unchanged
- ✅ DataOnly happy path: matching schema, all records through
- ⏳ DataOnly with mismatches: choice/lookup/multichoice failures all surface in Step 5
- ⏳ DataOnly at scale: 50+ projects with mixed validity
- ⏳ Mode-switch state clean: full ↔ dataOnly without artifacts
- ⏳ JSON save/load with mode: preserved correctly across sessions

---

## 9. Debug & troubleshooting

**Enable verbose dataOnly writer logging:**
```js
// In browser DevTools console:
localStorage.setItem('DEBUG_DATAONLY_WRITER', '1')
// Reload, run import. To disable:
localStorage.removeItem('DEBUG_DATAONLY_WRITER')
```

**Common issues:**
- Lookup write fails with `@odata.bind` error → verify `navigationProperty` was correctly resolved (PascalCase, not logical name)
- Choice values silently empty → check `UserLocalizedLabel` vs `LocalizedLabels` matching, possibly localization mismatch
- All records in one entity skipped with same reason → option set name mismatch, verify `optionSetName` in schemaSnapshot
- Step 4 hangs at "Building resolvers" → likely large lookup table, check Network tab for paged calls

---

## 10. Architectural record

Spec documents are committed at:
- `docs/data-only-migration-spec.md` — original specification
- `docs/data-only-migration-spec-addendum-A.md` — direction A clarification

Keep these for future reference. They explain not just *what* but *why* — useful when someone (you in 6 months, or a colleague) wonders why the architecture is shaped a certain way.
