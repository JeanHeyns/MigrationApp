# Fixes: Full-mode custom fields, Lookup column creation, State reset

> **Document type:** Bugfix prompt for Claude Code
> **Target codebase:** Project Online Migrator (React + TypeScript + Power Apps Code App)
> **Status:** Ready for implementation
> **Suggested location in repo:** `docs/fixes/2026-05-fixes-full-mode-customfields-lookup-reset.md`

This document bundles three independent issues observed during end-to-end testing in May 2026. They can be tackled in one session or split per fix. Recommended order is **Issue 3 → Issue 1 → Issue 2** (Issue 3 first so re-testing the others is clean).

---

## Issue 1: In `full` mode, project custom fields are not populated on project creation

### Symptom
- Run a `full` migration end-to-end against an empty target solution
- Step 3 successfully creates custom columns on `msdyn_project`
- Step 4 creates project records, but **custom field values are empty** in Dataverse
- Re-running the same projects in `dataOnly` mode against the now-existing schema **does** populate the custom fields correctly

### Hypothesis
There is a payload-build divergence between the two modes:

- `dataOnly` builds the payload via `applyResolvers(poRecord, mappingConfig, resolvers, logger)` in `recordResolverApplier.ts` — this iterates the full `mappingConfig.fieldMap` and writes every mapped field
- `full` mode uses a separate "direct mapping" path in `projectWriter.ts` (per addendum A §A.5)

Likely root causes (in order of probability):

1. The `full`-mode payload builder iterates only **standard** PO fields (subject, start date, finish date, etc.) and skips the **custom** field entries in `mappingConfig.fieldMap`
2. `mappingConfig.fieldMap` entries for newly-created columns lack a populated `dvLogicalName` after Step 3 (Step 3 creates columns but doesn't write the prefixed logical name back into the mapping state)
3. Schema replication delay — newly-created attributes are not yet visible to data writes within the same session, and Dataverse silently drops unknown attribute keys

### Investigation steps

1. **Inspect `mappingConfig.fieldMap` at Step 4 entry.**
   In `Step4Import/index.tsx`, log the mapping config just before writers are invoked:
   ```typescript
   console.table(state.mappingConfig?.fieldMap)
   ```
   Confirm every custom field entry has a non-null `dvLogicalName` containing the publisher prefix (e.g. `cr123_priority`).

2. **Log the full payload sent to `msdyn_CreateProjectV1` in `full` mode.**
   In `projectWriter.ts`, in the `full`-mode branch, add a one-line `console.debug` of the payload object before the unbound action call:
   ```typescript
   console.debug('[projectWriter:full] payload', JSON.stringify(payload, null, 2))
   ```
   Compare side-by-side with the equivalent `dataOnly` payload for the same PO project.

3. **If custom field keys are missing from the `full` payload:** the payload builder is the bug. Find the function that constructs the payload (likely `buildPayloadDirect` or inline in `projectWriter.ts`) and verify it iterates *all* `mappingConfig.fieldMap` entries, not just hardcoded standard fields.

4. **If custom field keys are present but values are empty in Dataverse:** the bug is in Step 3's column-creation feedback loop. Step 3 must update `mappingConfig.fieldMap[i].dvLogicalName` after each successful column creation. Check `Step3CreateColumns/index.tsx` and `columnManager.ts` for whether the resulting logical name is written back to the mapping state.

5. **If both look correct:** add a 5-second sleep between Step 3 completion and Step 4 start (temporarily, just to test) — if that fixes it, schema replication delay is the cause. Permanent fix: poll `EntityDefinitions(LogicalName='msdyn_project')/Attributes` until all expected attributes appear, before allowing Step 4 to start.

### Implementation requirement

Produce a unified write path so `full` and `dataOnly` cannot diverge again:

- Refactor the `full`-mode payload build to use the same field-iteration loop as `applyResolvers()`, with a "passthrough" resolver for non-special types (string/number/date/boolean/memo/money). The passthrough resolver is essentially the existing direct resolver in `resolverFactory.ts` — reuse it.
- Result: there is one code path that walks `mappingConfig.fieldMap` and produces the payload. The only difference between modes is which resolvers are in the resolver map.

This was already foreshadowed in `data-only-migration-spec.md` §6.5:
> *"Refactor zo dat de resolver-laag een aparte stap is die alleen in `dataOnly` mode draait, of zo dat `full` mode een trivial passthrough resolver gebruikt."*

The refactor is the second option, and it's the right one because it makes future divergence impossible.

### Acceptance criteria

- Running a `full` migration end-to-end populates custom fields on the project record
- Running the same migration in `dataOnly` mode produces an identical Dataverse state (verify by spot-checking 3 records)
- `console.debug` payload logs in both modes show the same custom field keys (with mode-specific values, e.g. integer for `dataOnly` choice, raw string for `full` if the column type is string)
- No regressions in existing `dataOnly` flow

---

## Issue 2: Lookup column creation fails with `0x80040203`

### Symptom
Step 3 (in `full` or `schemaOnly` mode) reports for lookup-typed custom fields:

```
msdyn_project.new_budget_status failed:
Error: { "error": { "code": "0x80040203",
  "message": "Attribute of type LookupAttributeMetadata cannot be created through the SDK" } }

Schema setup complete - 0 created, 1 skipped, 1 error(s).
```

### Root cause
Dataverse does not allow creating Lookup attributes via the standard `EntityDefinitions(...)/Attributes` POST endpoint. Lookup attributes are created **as a side effect** of creating a OneToMany relationship between two entities. The relationship endpoint generates the lookup attribute on the referencing entity automatically.

This is a Dataverse platform constraint, not a bug in our SDK call shape.

### Correct API

Endpoint:
```
POST /api/data/v9.2/CreateOneToManyRequest
```

Payload shape:
```json
{
  "OneToManyRelationship": {
    "@odata.type": "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
    "SchemaName": "<prefix>_<referencedEntity>_<referencingEntity>_<lookupName>",
    "ReferencedEntity": "<lookup target entity logical name>",
    "ReferencingEntity": "msdyn_project",
    "AssociatedMenuConfiguration": {
      "Behavior": "UseCollectionName",
      "Group": "Details",
      "Order": 10000
    },
    "CascadeConfiguration": {
      "Assign": "NoCascade",
      "Delete": "RemoveLink",
      "Merge": "NoCascade",
      "Reparent": "NoCascade",
      "Share": "NoCascade",
      "Unshare": "NoCascade"
    }
  },
  "Lookup": {
    "@odata.type": "Microsoft.Dynamics.CRM.LookupAttributeMetadata",
    "SchemaName": "<prefix>_<LookupName>",
    "DisplayName": {
      "LocalizedLabels": [{ "Label": "<display name>", "LanguageCode": 1033 }]
    },
    "RequiredLevel": { "Value": "None" }
  },
  "SolutionUniqueName": "<solution unique name>"
}
```

Notes:
- `SchemaName` on the relationship must be globally unique in the environment. Use `<prefix>_<referencedEntity>_<referencingEntity>_<lookupName>` to avoid collisions if the same lookup target is referenced by multiple entities.
- `ReferencedEntity` is the lookup-table entity (created by `lookupEntityManager.ensureLookupEntity` in `schemaOnly`/`full` flows, or pre-existing in `dataOnly`).
- `ReferencingEntity` is `msdyn_project`, `msdyn_projecttask`, or `msdyn_projectteam` depending on where the field lives.
- `SolutionUniqueName` is required — without it the relationship lands in the default solution.
- `Lookup.SchemaName` PascalCase becomes the lookup attribute logical name in lowercase. So `new_BudgetStatus` produces logical name `new_budgetstatus` — same convention as other custom attributes.

### Implementation requirement

1. **Register a new custom connector operation in `src/client.ts`:**
   ```typescript
   // CreateOneToManyRelationship — Dataverse Metadata API
   client.registerOperation('CreateOneToManyRelationship', { /* ... */ })
   ```
   Follow the same pattern as the existing `CreateGlobalOptionSet`, `CreateEntityAttribute`, etc. registrations.

2. **Add a helper in `src/services/dataverseService.ts`** (or a new `relationshipManager.ts` if it gets long):
   ```typescript
   export async function createOneToManyRelationship(
     params: {
       referencedEntity: string
       referencingEntity: string
       lookupSchemaName: string         // PascalCase, e.g. "new_BudgetStatus"
       lookupDisplayName: string
       relationshipSchemaName: string   // globally unique
       solutionUniqueName: string
     }
   ): Promise<{ lookupLogicalName: string; navigationProperty: string }>
   ```
   The function should also fetch back the navigation property name via a `ManyToOneRelationships` metadata query, since callers downstream need it for `@odata.bind` writes.

3. **Branch in `columnManager.ts` on column type:**
   ```typescript
   if (column.type === 'Lookup') {
     return createOneToManyRelationship({...})
   }
   // existing path for other types
   ```

4. **In `schemaOrchestrator.ts` (schema-only mode):** ensure lookup entities are created **before** lookup columns on `msdyn_project`/etc., because the relationship endpoint requires `ReferencedEntity` to already exist. The orchestrator volgorde in the schema-only spec is already correct (option sets → entities → entries → kolommen) — verify the implementation matches.

5. **Handle "already exists" errors** consistently with the rest of the codebase: error codes `0x80044331`, `0x80060891`, plus any relationship-specific code (likely `0x8004F049` or HTTP 412) should be treated as `skipped: already_exists`, not `failed`.

### Edge cases

- **Lookup target entity does not exist yet.** In `full` mode, the lookup target is typically a custom lookup table entity that was created earlier in the orchestration. If somehow not, the `CreateOneToManyRelationship` call will fail with a clear error. Surface this with a useful message: `"Cannot create lookup column 'X' because target entity 'Y' does not exist. Create the lookup table first."`
- **Polymorphic lookups.** Out of scope — single target only. If a PO field maps to a polymorphic Dataverse lookup, that's a `dataOnly`-only scenario and not relevant for column creation.
- **Re-run after partial failure.** First run creates the lookup entity and entries but fails on the relationship. Second run: entity exists (skipped), entries exist (skipped), relationship endpoint should succeed. Verify idempotency.

### Acceptance criteria

- Step 3 in `full` mode successfully creates a lookup column on `msdyn_project` pointing to a custom lookup entity
- Step 3 in `schemaOnly` mode does the same
- Re-running Step 3 against a solution that already has the lookup column reports `skipped: already_exists`, not `failed`
- The created lookup column is correctly linked: a follow-up `dataOnly` migration can resolve PO label values to GUIDs and write them via `@odata.bind` (this is the existing dataOnly resolver path — verify end-to-end)
- `SchemaCreationResults.columns.created` includes the lookup column entry; no `failed` entry for `0x80040203`

---

## Issue 3: Wizard state is not reset when starting a new migration

### Symptom
After completing (or partially completing) a migration, navigating back to Step 1 retains the previous run's selections: `selectedSolution`, `migrationMode`, `pwaUrl`, `fetchedData`, `mappingConfig`, etc. There is no clean way to start a fresh migration without a full page reload (F5).

### Root cause
`MigrationContext` lacks a `RESET_STATE` reducer action, and any "Start new migration" UI affordance in Step 5 (or elsewhere) does not reset the state.

There may also be persisted state in `localStorage` or `sessionStorage` (e.g. mapping JSON save/load, debug toggles) that re-hydrates on mount.

### Investigation steps

1. **Audit state persistence:**
   ```bash
   grep -rn "localStorage" src/
   grep -rn "sessionStorage" src/
   ```
   List every key that gets written. Decide per key whether it should be cleared on reset (mapping save/load: probably keep; runtime state: clear).

2. **Audit `initialState` in `MigrationContext.tsx`:**
   Confirm that every field in the `MigrationState` type appears in `initialState`. Fields added later (per addendums: `migrationMode`, `schemaSnapshot`, `resolverPlan`, `skippedFieldInstances`, `schemaCreationResults`) are commonly forgotten in `initialState`, which makes a `RESET_STATE` action that does `return { ...initialState }` only partially effective.

### Implementation requirement

1. **Add a `RESET_STATE` action to the `MigrationContext` reducer:**
   ```typescript
   case 'RESET_STATE':
     return { ...initialState }
   ```

2. **Ensure `initialState` is complete.** Walk the `MigrationState` interface field by field; every key must be initialized:
   ```typescript
   const initialState: MigrationState = {
     currentStep: 1,
     pwaUrl: '',
     dataSource: 'ProjectOnline',
     selectedSolution: null,
     migrationMode: 'full',
     skipColumnCreation: false,
     fetchedData: null,
     mappingConfig: null,
     optionSetMappings: [],
     schemaSnapshot: null,
     resolverPlan: null,
     skippedFieldInstances: [],
     importResults: [],
     logs: [],
     schemaCreationResults: null,
   }
   ```
   (Adapt to the actual current shape; this list is illustrative.)

3. **Expose a `resetState()` method on the context:**
   ```typescript
   const resetState = useCallback(() => {
     dispatch({ type: 'RESET_STATE' })
     // Also clear any localStorage/sessionStorage entries that should not survive
     // (do NOT clear mapping save/load entries — those are explicit user artifacts)
     localStorage.removeItem('DEBUG_DATAONLY_WRITER')
     // ... add others as discovered in investigation step 1
   }, [])
   ```

4. **Add a "Start new migration" button in `Step5Report/index.tsx`.**
   Placement: bottom of the report, after CSV exports. Style: secondary button, with a confirm dialog (`window.confirm` or your existing confirm component) since it's destructive of in-memory results.
   ```typescript
   <button onClick={() => {
     if (window.confirm('Start a new migration? Current results will be cleared.')) {
       resetState()
       navigateToStep(1)
     }
   }}>
     Start new migration
   </button>
   ```

5. **Optional but recommended: also add the reset action in the wizard header / step indicator** as a "Reset" link, for users who want to start over mid-flow without completing all 5 steps.

### Acceptance criteria

- Clicking "Start new migration" in Step 5 returns to Step 1 with all selections cleared (mode reverts to default `full`, solution dropdown empty, PWA URL empty, fetched data gone, mapping gone)
- No state from the previous run leaks into Step 2 onwards (check `mappingConfig` is `null`, `schemaSnapshot` is `null`, etc.)
- `localStorage` debug toggles are cleared; user-saved mapping JSON files are NOT auto-cleared (those are explicit artifacts)
- A reset followed by a full migration in either mode runs cleanly with no stale state artifacts

---

## Suggested commit strategy

One commit per issue, clean and reviewable:

1. `fix(reset): add RESET_STATE action and Start new migration button`
2. `fix(full-mode): unify project payload build via passthrough resolver path`
3. `feat(schema): create lookup columns via CreateOneToManyRelationship API`

Issue 2 is technically a feature (new API endpoint integration) more than a bug fix — the original code attempted an impossible operation. The commit type `feat` is more honest than `fix` here.

---

## Verification checklist (run before closing the session)

- [ ] Issue 3: reset works from Step 5; no residual state in any field after reset
- [ ] Issue 1: `full` mode populates custom fields on project records (verify in Dataverse UI for at least 3 records)
- [ ] Issue 1: `dataOnly` mode unchanged (no regressions; spot-check 3 records produce identical state to full-mode equivalent)
- [ ] Issue 2: lookup column creation succeeds in `full` mode for at least one project lookup field
- [ ] Issue 2: lookup column creation succeeds in `schemaOnly` mode
- [ ] Issue 2: re-running schema creation reports `already_exists`, not failure
- [ ] Issue 2: end-to-end `schemaOnly` followed by `dataOnly` resolves and writes the lookup value correctly via `@odata.bind`
- [ ] All three issues: `npm run build` passes; `pac code push` deploys cleanly
