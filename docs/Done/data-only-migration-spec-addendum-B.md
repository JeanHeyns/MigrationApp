# Spec Addendum: Direction B — Mode-first Step 1 ordering

> **Append to:** `data-only-migration-spec.md`
> **Related:** `data-only-migration-spec-addendum-A.md`, `schema-only-migration-spec.md`
> **Reason:** With three migration modes (`full`, `dataOnly`, `schemaOnly`), the current "fetch first, choose mode later" flow is wasteful and conceptually inverted. `schemaOnly` only needs custom fields + lookup tables; fetching projects/tasks/resources/assignments before the mode is known is pure overhead.
> **Decision:** Migration mode becomes the **first** input in Step 1. Source and target configuration follow. The fetch is triggered explicitly (button), only after all three are set, and its scope is mode-dependent.

---

## B.1 Principle

> **The migration mode determines what data is needed. Therefore the mode must be chosen before any fetch happens.**

Step 1 stops being a single "Connect & Fetch" action and becomes a **configure-then-fetch** flow:

1. Pick mode
2. Configure source (PWA URL or file upload)
3. Configure target (solution + publisher prefix)
4. Click "Fetch" — scope of fetch is determined by mode

The fetch button is disabled until all three of mode, source, target are valid.

---

## B.2 Step 1 layout (overrides §6.2 of base spec and §6.2 of schema-only spec)

Top-to-bottom in Step 1:

### Section 1 — Migration mode

Radio group, three options:

- **Full migration** — create columns + migrate data (use when target schema is empty)
- **Data only** — reuse existing schema, migrate data (use when schema already exists)
- **Schema only** — create schema, no data import (use to prepare a target solution for later)

Selection is required. Default: `full` (preserves existing UX for users who don't read).

Each option has a one-line description below the label so the user understands the trade-off without docs.

### Section 2 — Source

PWA URL input or file upload (existing controls, unchanged).

### Section 3 — Target

Dataverse solution dropdown + publisher prefix display (existing controls, unchanged).

### Section 4 — Fetch action

Single button, label depends on mode:

| Mode | Button label | Scope |
|---|---|---|
| `full` | "Fetch PWA data" | All: projects, tasks, resources, assignments, customFields, lookupTables (+entries) |
| `dataOnly` | "Fetch PWA data and scan target schema" | All PO data + `inspectSolution()` |
| `schemaOnly` | "Fetch schema metadata" | Only customFields + lookupTables (+entries) |

Button is `disabled` until: mode is set AND source is valid AND target solution is selected.

After successful fetch: show summary panel with mode-appropriate counts. In `schemaOnly`: "Fetched 12 custom fields, 4 lookup tables (78 entries)." In `full`/`dataOnly`: existing full summary.

---

## B.3 Conditional fetch implementation

A new orchestrator function in the Step 1 component (or a Step 1 helper module):

```typescript
async function runFetch(state: MigrationState): Promise<FetchResult> {
  const { migrationMode, pwaUrl, dataSource, selectedSolution } = state

  if (migrationMode === 'schemaOnly') {
    const data = await fetchSchemaOnlyData(pwaUrl)  // see schema-only spec §6.8
    return { fetchedData: { ...emptyDataShape(), ...data } }
  }

  // full and dataOnly: full PO fetch
  const fetchedData = await fetchAllPoData(pwaUrl)

  // dataOnly additionally scans the target schema
  if (migrationMode === 'dataOnly') {
    const schemaSnapshot = await inspectSolution(selectedSolution.id)
    return { fetchedData, schemaSnapshot }
  }

  return { fetchedData }
}
```

`emptyDataShape()` returns `{ projects: [], tasks: [], resources: [], assignments: [] }` so downstream array iterations don't break in `schemaOnly` (resolves §7.11 of schema-only spec defensively).

---

## B.4 Mode-switch handling after fetch

Switching mode after data is already fetched is now an edge case (because the user picks mode upfront), but still possible. Behavior:

| From → To | Action | UX |
|---|---|---|
| `full` → `dataOnly` | Keep `fetchedData`, clear `schemaSnapshot` if present, show "Re-fetch needed" banner with button to trigger schema scan. PO data is still valid. | Re-fetch button only triggers the schema scan, not the full re-fetch. |
| `dataOnly` → `full` | Keep `fetchedData`, clear `schemaSnapshot` and `resolverPlan`. No re-fetch needed. | Banner: "Schema scan discarded." |
| `full`/`dataOnly` → `schemaOnly` | Keep `fetchedData` (the schema-relevant subset is still valid). Clear `schemaSnapshot`/`resolverPlan`. | No re-fetch needed; banner: "Switched to schema-only mode." |
| `schemaOnly` → `full`/`dataOnly` | `fetchedData` lacks projects/tasks/resources/assignments. Show "Re-fetch needed" banner with button. Disable Next until re-fetch completes. | Re-fetch runs full PO fetch (and schema scan if dataOnly). |

**Key rule:** never auto-re-fetch on mode change. Always require explicit user action via a re-fetch button. Auto-re-fetching is destructive (slow, surprising, can fail).

---

## B.5 State changes

No new fields needed beyond what addendum A and the schema-only spec already introduce. But two derived flags become explicit:

```typescript
// Already from addendum A:
const skipColumnCreation = migrationMode === 'dataOnly'

// From schema-only spec:
const skipDataImport = migrationMode === 'schemaOnly'
const skipPoDataFetch = migrationMode === 'schemaOnly'  // partial: only customFields + lookupTables fetched
```

A new derived flag for Step 1 UI:

```typescript
const fetchButtonEnabled =
  !!migrationMode &&
  isSourceValid(state) &&
  !!selectedSolution &&
  !isFetching
```

A new flag for "data is fetched but mode changed and current data is insufficient":

```typescript
const needsRefetch = (() => {
  if (!fetchedData) return false
  if (migrationMode === 'schemaOnly') return false  // schemaOnly works with any subset
  // full and dataOnly need full PO data
  return fetchedData.projects.length === 0 && fetchedData.lookupTables.length > 0
  // proxy: if we have lookup tables but no projects, last fetch was schemaOnly
})()
```

The `needsRefetch` flag drives the banner in §B.4.

---

## B.6 Validation rules for Next button

Replaces the existing "fetch must have happened" check with mode-aware validation:

```typescript
function canProceedToStep2(state: MigrationState): boolean {
  if (!state.migrationMode || !state.selectedSolution) return false
  if (!state.fetchedData) return false
  if (needsRefetch) return false

  if (state.migrationMode === 'schemaOnly') {
    // At least one of customFields or lookupTables must be non-empty
    return state.fetchedData.customFields.length > 0
        || state.fetchedData.lookupTables.length > 0
  }

  if (state.migrationMode === 'dataOnly') {
    return state.fetchedData.projects.length > 0 && !!state.schemaSnapshot
  }

  // full
  return state.fetchedData.projects.length > 0
}
```

---

## B.7 Migration path for existing code

If the current Step 1 implementation triggers fetch automatically on PWA URL blur or solution selection:

1. **Remove auto-fetch triggers.** Fetch happens only via the explicit button.
2. **Wrap the existing full fetch** in `fetchAllPoData()` and add `fetchSchemaOnlyData()` as a sibling.
3. **Reorder the JSX** so the mode radio is the first interactive element. Source and target sections move below.
4. **Move existing solution-selection side effects** (e.g., auto-triggering schema scan in dataOnly) into the unified `runFetch()` orchestrator.
5. **Update tests / e2e flows** that assumed fetch fired implicitly. They now need an explicit button click.

---

## B.8 Updated acceptance criteria

Adds to the existing acceptance criteria of the base spec and schema-only spec:

> ✅ Step 1 toont migration mode als eerste keuze, vóór source en target.
> ✅ Fetch button is disabled tot mode, source en target alle drie geldig zijn.
> ✅ In `schemaOnly`: fetch laadt alleen customFields + lookupTables; geen projects/tasks/resources/assignments calls in network log.
> ✅ In `full`/`dataOnly`: fetch laadt zoals voor deze addendum (geen regressies in fetch scope).
> ✅ Mode-switch na fetch toont banner als re-fetch nodig is; geen automatische re-fetch.
> ✅ Mode-switch waarbij bestaande data nog volstaat (bv. `full` → `schemaOnly`) toont info-banner zonder re-fetch knop.
> ✅ Next-knop validatie respecteert mode-specifieke fetch-vereisten (zie §B.6).

---

## B.9 What to verify before next chat

After implementing this addendum:

- [ ] Step 1 opens met mode radio group bovenaan
- [ ] Fetch button disabled bij ontbrekende mode/source/target
- [ ] `schemaOnly` fetch in network tab toont alleen `CustomFields` + `LookupTables` requests, geen `Projects` of `Tasks`
- [ ] `full` mode fetch is identiek aan voor deze wijziging
- [ ] `dataOnly` mode fetch combineert PO data + `inspectSolution` in één button click
- [ ] Mode switch `full` → `schemaOnly` na fetch: geen re-fetch banner (data volstaat)
- [ ] Mode switch `schemaOnly` → `full` na fetch: re-fetch banner met disabled Next
- [ ] Mode switch `full` → `dataOnly` na fetch: banner met "scan target schema" knop, niet volledige re-fetch
- [ ] Empty PWA (geen custom fields, geen lookup tables) in `schemaOnly`: Next blijft disabled met duidelijke foutmelding
