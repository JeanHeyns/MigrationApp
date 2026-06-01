# Multi-Lookup Feature — Discovery Checklist

> **Purpose:** Gather the answers needed to write `multi-lookup-spec.md`.
> Hand this to a new Claude chat (with the project knowledge) or work through it yourself before specifying.
> **Context:** Project Online Migrator — adds support for PO multi-value lookup custom fields, mapped to Dataverse N:N relationships against a custom lookup entity (instead of `MultiChoice` global option sets, which are unmaintainable at 900+ entries).

---

## 1. Scope confirmation

Before anything else, lock down what this feature covers.

1. **Entity scope** — does multi-lookup apply only to **Project** custom fields, or also **Task** and **Resource**? (Note: task custom fields are currently not migrated per OperationSet limitation. Confirm whether that limitation extends to N:N associates on tasks, or only to the inline custom-column payload.)
2. **Migration modes** — should multi-lookup work in `full`, `dataOnly`, and `schemaOnly`? (Default assumption: all three. Confirm.)
3. **Data sources** — both `ProjectOnline` fetch and `FileUpload`? Template syntax for multi-value cells is a separate sub-decision (see §3.3).
4. **N:N shape** — pure N:N (intersect table without own columns) sufficient, or is a manual intersect entity (two 1:N relationships + an entity) needed because the link itself carries metadata (weight, role, added-by, date, …)?
5. **Bundling with lazy lookup resolver** — the existing constraint *"Lookup tables > 5000 records: pre-load with cap + warning; lazy resolver not yet implemented"* lives in the same resolver layer. Tackle together or keep separate?

---

## 2. Project Online side — what does the source actually expose?

The loader needs to detect that a PO custom field is multi-value. Verify in `src/services/projectOnline/customFields.ts` and against the ProjectServer API.

1. **Multi-value flag** — does the PO custom field metadata response include a property like `IsMultivalued`, `AllowMultipleValues`, or similar? What is its exact name and shape?
2. **Field type code** — what `FieldType` integer does PO return for a multi-value lookup? Is it the same as single-value lookup (21?), or distinct?
3. **Storage format** — when a project has a multi-value lookup field populated, how do the entry IDs arrive in the OData response? Comma-separated string of GUIDs? Array? Repeated field? Lookup-entry expansion?
4. **Entry identity** — is each lookup table entry identified by GUID, integer ID, full hierarchical path (e.g. `Department.Engineering.Backend`), or label? Confirm what we read today in `lookupTables.ts`.
5. **Hierarchical lookup tables** — does PO support nested lookup entries (parent/child)? If yes: do we flatten on import to Dataverse, or replicate the hierarchy as a self-referencing field on the lookup entity? Likely a separate spec, but flag it.
6. **Empty multi-value** — how is "no values selected" represented? Empty string, null, empty array? Affects loader normalization.
7. **Current behaviour** — what does the existing loader do today with a multi-value lookup field? Crash, silently pick one value, return raw string? Knowing the current behaviour clarifies the regression surface.

---

## 3. Dataverse side — N:N feasibility

Verify what's possible with the metadata + data APIs available in a Code App.

### 3.1 Schema creation (full, schemaOnly modes)

1. **N:N creation API** — can the metadata API create a `ManyToManyRelationship` from inside the Code App? Confirm endpoint, payload shape, and whether it requires a custom unbound action (analogous to `CreateGlobalOptionSet`, `CreateEntityAttribute`) or works via standard `/api/data/v9.2/RelationshipDefinitions`.
2. **Naming conventions** — schema name, intersect entity name, both navigation property names. Document the convention we'll use (e.g. `cr123_msdyn_project_cr123_departments`).
3. **Solution association** — does the N:N land in the selected solution automatically, or do we need to add it explicitly?
4. **Permissions** — does the calling user need any role beyond the existing `System Customizer` we already assume?
5. **Idempotency** — what does the API return if the relationship already exists? Same `0x80044331` / `0x80060891` pattern we treat as success/skip, or a different code? Update the "already exists" handler list.

### 3.2 Data writes — associate after project create

The big architectural question. `msdyn_CreateProjectV1` returns the project ID. Then we need to associate N entries.

1. **Association endpoint** — confirm shape: `POST {org}/api/data/v9.2/msdyn_projects({pid})/{navprop}/$ref` with body `{ "@odata.id": "{org}/api/data/v9.2/cr123_departments({eid})" }`. Is this the right pattern from a Code App?
2. **Batching** — does `$batch` work from the Code App, or must we POST sequentially? Per project with 5–10 multi-value entries × 200 projects = 1000–2000 calls. Affects total runtime and rate-limit risk.
3. **Rate limits** — known Dataverse limits per-user per-minute? Do we need throttling like the existing inter-batch delay for OperationSet?
4. **Failure modes** — if one associate fails mid-project, do we roll back the others, or accept partial state and report? (Existing pattern: track skipped, never roll back. Confirm consistency.)
5. **Disassociate before write** — on re-run, do we clear existing associations first? Aligns with task writer's "clear & recreate". Or accept duplicates being silently deduped by Dataverse?

### 3.3 Excel template syntax (FileUpload path)

1. **Multi-value cell format** — pipe-separated (`A|B|C`), semicolon (`A;B;C`), or JSON array (`["A","B","C"]`)? Pipe is least likely to collide with label content; semicolon is closer to Excel locale conventions. Recommend: **pipe**, with whitespace trimmed around each value.
2. **Empty cell** — empty cell = no entries selected (no warning).
3. **Single value in multi-lookup field** — `"A"` is valid (treated as `["A"]`).
4. **Unknown entries in cell** — `"A|UnknownX|B"` → associate A and B, warn that `UnknownX` not found. Skip the whole cell, or partial associate?

---

## 4. Schema inspector (dataOnly mode)

`src/services/plannerPremium/schemaInspector.ts` today scans 1:N nav properties on `msdyn_project` / `msdyn_projecttask`. For dataOnly multi-lookup, it also needs N:N.

1. **N:N detection** — how does the metadata API expose existing N:N relationships on an entity? `ManyToManyRelationships` collection on the EntityMetadata? Confirm the request URL and property names (`SchemaName`, `IntersectEntityName`, both navigation property names, target entity).
2. **Distinguishing PO-originated N:N** — if the target solution has unrelated N:N relationships, how do we surface only the relevant ones in Step 2 mapping UI? Suggest: filter by target entity being a custom entity (non-`msdyn_` prefix), and let the user pick. Or rely on naming convention from §3.1.
3. **Schema snapshot extension** — `SchemaSnapshot` type needs an `availableNNRelationships` collection per entity. Confirm shape.

---

## 5. Resolver layer

`src/services/plannerPremium/resolverFactory.ts` has `Direct`, `Choice`, `MultiChoice`, `Lookup` resolvers. Add `MultiLookup`.

1. **Input shape** — resolver receives `string[]` (already-split labels from loader) or `string` (raw cell value)? Recommend: loader normalizes to `string[]`; resolver only sees the array.
2. **Output shape** — array of entry GUIDs `string[]`, or already-formatted as associate-payload objects `{ "@odata.id": "..." }[]`? Recommend: GUIDs from resolver, payload formatting in writer.
3. **Caching** — entries-by-label cache per lookup table already exists for `Lookup`. Same cache reusable for `MultiLookup`? Confirm.
4. **Per-entry skipped tracking** — if a project has multi-lookup with 5 values, 1 unresolvable, today's `SkippedFieldInstance` shape (per-field, per-record) needs extension to support per-entry granularity. Or: collapse to one skipped entry per project per field with all unresolved labels listed. Pick one.

---

## 6. Writer integration

1. **Where does the associate run** — `projectWriter.ts` after `msdyn_CreateProjectV1` returns the ID, before moving to the next project? Or in a second pass over all created projects? Affects retry/resume logic.
2. **OperationSet compatibility** — task multi-lookup (if in scope per §1.1) cannot go through OperationSet. Need a separate post-pass over tasks, similar to projects. Confirm or rule out.
3. **Existing "already exists" error handling** — confirm associate errors fold into the same handler list, or need their own codes.

---

## 7. Mapping UI (Step 2)

1. **Field type detection** — once loader sets `FieldType: 'MultiLookup'`, Step 2 needs a new mapping UI for it. In `full` mode: same "create new lookup entity + entries" flow, plus implicit N:N creation. In `dataOnly` mode: pick from existing N:N relationships on the target entity.
2. **UI affordance for "I want N:N, not MultiChoice"** — full mode only. Today a PO multi-value field with FieldType=Lookup would presumably get treated as `MultiChoice` (or break). New default: `MultiLookup`. Should there be a per-field override "treat as MultiChoice instead" for small lookup tables, or is N:N always the right answer once we have it? Recommend: always N:N for multi-value lookups; if the user wants MultiChoice they can change the type in PO or in the template.
3. **Lookup entry preview** — at 900 entries the existing entry-list UI may be slow. Reuse existing pagination/virtualization or note as separate UI ticket.

---

## 8. Step 5 report

1. **Skipped tracking** — multi-lookup adds a new dimension: not "field skipped" but "entry within field skipped". CSV export columns to support this? Recommend: existing CSV gets two extra columns `EntryLabel` and `Reason` for multi-lookup rows; for other field types these stay empty.
2. **Counts** — "X associations created" as a new top-level counter alongside projects/tasks/resources/assignments? Useful for verifying parity with PO.

---

## 9. Edge cases to define

1. **Same entry-label appears twice in one cell** (`A|B|A`) — dedupe silently, or warn?
2. **Lookup entry deleted between fetch and write** — same handling as single-value Lookup (skip + warn). Confirm.
3. **Project re-migration** — does re-running over an already-migrated project clear existing N:N associations first, or append? Likely "clear & recreate" to match task writer semantics. Confirm.
4. **Hierarchical PO lookup tables** (§2.5) — out of scope for first iteration? If yes, document the limitation and what we do with a multi-value lookup whose entries have parents.
5. **Empty lookup table** — PO multi-lookup pointing at a table with 0 entries. Schema creation should still succeed (creates empty entity + N:N), data writes skip with warning.
6. **Mixed selection** — what if a value in the cell matches multiple entries (label collision, e.g. two "Engineering" entries under different parents)? Match-by-label is the current Lookup contract; document that collisions resolve to first-match + warning, or fail-row + error.

---

## 10. Backwards compatibility verification

1. **Single-value Lookup behaviour** — completely unchanged after this feature lands. Confirm by checking that loader, resolver, writer for `FieldType: 'Lookup'` is in a separate code path from new `MultiLookup` path.
2. **MultiChoice behaviour** — unchanged. Existing migrations using `MultiChoice` (global option set) for multi-value still work.
3. **Template v2 forward compat** — `MultiLookup` becomes a valid `FieldType` dropdown value. Older app reading newer template with `MultiLookup` rows: warning + skip (handled by existing `INVALID_FIELD_TYPE_SKIPPED` path).
4. **Existing fetched data** — any cached PO fetch result (none persisted, but verify) won't have multi-lookup detection. Re-fetch required after upgrade — document.

---

## 11. Sanity-check questions for Jean

To answer before spec is written, not by Claude:

1. The 900-entry lookup — does it sit on one custom field, or are there several large lookup tables in the same migration? Affects whether lazy/streaming entry fetch is critical-path.
2. Are customers in the dataOnly target tenant expected to **pre-create** the custom lookup entity and N:N relationship (entirely manual schema setup)? Or do we expect the schemaOnly run to have built it? Affects how strict the dataOnly schema inspector should be.
3. Is there any business case where the link itself needs metadata (= manual intersect entity)? If "not yet, but maybe later", design the spec so manual intersect can be added without breaking the pure-N:N path.

---

## How to use this checklist

1. **Investigation phase (~half a day):** grep the codebase, hit the ProjectServer API once with a multi-value field, and probe the Dataverse metadata API for N:N creation + association from a Code App context. Most questions in §2 and §3 answer themselves quickly.
2. **Decisions phase (~1 hour):** Jean answers §1, §9, §11; defaults are proposed throughout, so this is mostly confirmation.
3. **Spec phase:** write `multi-lookup-spec.md` following the same pattern as `data-only-migration-spec.md` / `file-upload-spec.md` — context, scope, architectural decisions, per-layer changes, edge cases, acceptance criteria, implementation order.

Expected spec size: comparable to `file-upload-spec.md` (10–12 sections). Implementation effort: 3–5 days for an experienced dev, depending on how messy the N:N association batching turns out to be.
