# Spec Addendum: Direction A — Strict DataOnly Mode

> **Append to:** `data-only-migration-spec.md`
> **Reason:** Resolves overlap between `migrationMode` and `skipColumnCreation`
> **Decision:** In `dataOnly` mode, only existing columns can be selected. No "create new" option. `skipColumnCreation` becomes a derived value, not a user-facing toggle.

---

## A.1 Principle

`migrationMode` is the **single source of truth** for whether columns get created. Everything else is derived:

```typescript
const skipColumnCreation = migrationMode === 'dataOnly'
```

The user's mode choice in Step 1 fully determines the behavior of Steps 2, 3, and 4 — no further toggles needed.

---

## A.2 Step 2 changes (overrides §6.3 of base spec)

In `dataOnly` mode:

- **No "+ Create new column" option** in the right-side dropdown
- Dropdown shows **only existing custom columns** of compatible type for the target entity
- Per row status indicator:
  - 🟢 **Auto-matched** to existing column (logical name or display name match)
  - 🟡 **Manual selection required** (no auto-match, user must pick from dropdown)
  - 🔴 **Unmappable** (no compatible column exists in schema for this PO field)
- For 🔴 rows: show inline guidance:
  > *"No matching {type} column found in {entity}. Create the column manually in Dataverse, or switch to Full migration mode in Step 1."*
- Allow user to **explicitly skip** a PO field (don't migrate it) via a "Skip" option per row. This is different from "no match" — it's an intentional choice.

In `full` mode: behavior unchanged from current implementation.

### Mapping shape consistency

The mapping object structure stays the same across both modes, so writers don't need mode-awareness:

```typescript
interface FieldMapping {
  poFieldName: string
  dvLogicalName: string | null   // null = skipped
  action: 'use_existing' | 'create_new' | 'skip'
}
```

In `dataOnly` mode, `action` is always `'use_existing'` or `'skip'` — never `'create_new'`.

---

## A.3 Step 3 changes (overrides §6.4 of base spec)

In `dataOnly` mode:

**Option 1 — Auto-skip (recommended):**
- Step 3 is bypassed entirely in the wizard navigation
- Step indicator goes from Step 2 → Step 4 directly
- Show a brief confirmation banner on Step 4 entry: *"Schema validated. Skipped column creation."*

**Option 2 — Read-only confirmation:**
- Step 3 shows a read-only summary:
  - "✓ N columns will be reused from existing schema"
  - "✓ No columns or option sets need to be created"
- "Create" button is hidden, "Next" button is immediately enabled
- Useful if you want to keep the 5-step visual flow consistent

**Recommendation:** go with Option 2 for visual consistency. The wizard always shows 5 steps regardless of mode. In `dataOnly`, Step 3 becomes a "validation summary" instead of an "action" step.

In `full` mode: behavior unchanged.

---

## A.4 State changes (overrides §4 of base spec)

### Remove user-facing `skipColumnCreation` toggle

- `skipColumnCreation` stays in `MigrationState` for backwards compatibility with existing writer logic
- It is no longer set by user UI — it is **derived** whenever `migrationMode` changes:

```typescript
// In MigrationContext, when migrationMode is set:
setMigrationMode(mode: MigrationMode) {
  setMigrationModeState(mode)
  setSkipColumnCreation(mode === 'dataOnly')
}
```

- Remove any UI element (checkbox, toggle) in Step 3 that exposes `skipColumnCreation` to the user

### Keep ResolverPlan derivation in Step 2

`ResolverPlan` is built when leaving Step 2, only in `dataOnly` mode. In `full` mode, `resolverPlan` stays `null` and writers use the original direct-mapping path.

---

## A.5 Writer logic (overrides §6.5 of base spec)

Writers branch on `migrationMode`, not on `skipColumnCreation`:

```typescript
async function writeProject(poRecord, state) {
  const payload = state.migrationMode === 'dataOnly'
    ? applyResolvers(poRecord, state.mappingConfig, resolvers, logger).payload
    : buildPayloadDirect(poRecord, state.mappingConfig)  // existing full-mode logic

  await dataverseClient.performUnboundAction('msdyn_CreateProjectV1', payload)
}
```

Reason: `skipColumnCreation` historically meant "don't create columns this run." But the writers' actual behavior in `dataOnly` is fundamentally different (resolver pipeline), so checking `migrationMode` is more honest.

---

## A.6 Migration path for existing code

If `skipColumnCreation` is currently used in any conditional logic in writers or Step 3:

1. **Audit usage:** grep for `skipColumnCreation` across codebase
2. **For UI conditionals** (e.g., "should I show the Create button?"): replace with `migrationMode === 'dataOnly'`
3. **For writer conditionals**: replace with `migrationMode === 'dataOnly'` if the branch concerns resolver pipeline; keep `skipColumnCreation` if it's purely about Step 3 column-creation API calls
4. **Default value**: `skipColumnCreation: false` for `full` mode, `true` for `dataOnly` (auto-set on mode change)

---

## A.7 Updated acceptance criteria (replaces criterion #5)

Old:
> ✅ Step 3 wordt overgeslagen of toont read-only samenvatting

New (more specific):
> ✅ In `dataOnly` mode: Step 3 toont read-only samenvatting met disabled "Create" actie, "Next" is direct enabled. Geen `skipColumnCreation` checkbox zichtbaar.
> ✅ In `full` mode: Step 3 gedraagt zich exact als voor deze feature (geen regressies).
> ✅ `skipColumnCreation` is geen UI-keuze meer; wordt afgeleid uit `migrationMode`.

---

## A.8 What to verify before next chat

After implementing this addendum:

- [ ] In Step 1 selecting "Data only" → schema scan triggers
- [ ] In Step 2 dropdown shows only existing columns (no "+ Create" option) when in dataOnly
- [ ] In Step 2 unmappable PO fields (no compatible column) show clear inline guidance
- [ ] In Step 3 (dataOnly): no Create button visible, no skipColumnCreation checkbox, Next is enabled
- [ ] In Step 3 (full): unchanged from before this feature
- [ ] Switching mode back from dataOnly → full clears `schemaSnapshot` and `resolverPlan` (and resets `skipColumnCreation` to false)
- [ ] No grep hits for `skipColumnCreation` checkbox/toggle in any UI component
