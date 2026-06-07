# Feature candidates

> Working document for evaluating what to build next. Sourced from the
> "Current pain points & opportunities" section of `migrator-project-context.md`
> plus a targeted audit done June 2026.
>
> Each candidate has: what it is, why it matters, what's already in place,
> what's missing, effort, risk, and dependencies on other candidates.
> Ordered by current bias toward shipping — reorder freely before picking.
>
> **Already done, not listed:** working time config (Step 1 + Step 4 UI, writers,
> file-upload column path), association diagnostics panel (Step 5, JSON export),
> project write diagnostics (Troubleshooting step, step 6 via header button).

---

## Quick wins (small effort, clear value)

### 1. File upload warnings wiring (AC 28–32)

**What:** Wire `LoaderResult.warnings` from `parseWorkbook()` into MigrationState and surface them in Step 1 and Step 5.

**Why it matters:** Every file upload with bad rows, dangling references, or skipped custom fields produces warnings today — but they're silently discarded. Users have no idea which rows were skipped and why. For non-trivial migrations this is a blind spot that causes silent data loss.

**Already in place:**
- `fileImportService.ts` — `parseWorkbook()` returns fully typed `LoaderResult.warnings: LoaderWarning[]`
- `fileUpload/types.ts` — all types (`LoaderWarning`, `WarningCode`, `LoaderResult`) defined
- `file-upload-spec.md` §7 — complete UI design with summary counts, expandable list grouped by sheet, Step 5 section, CSV export

**Missing:**
- `fileUploadWarnings: LoaderWarning[]` field not added to `MigrationState` in `MigrationContext.tsx`
- `SET_FILE_UPLOAD_WARNINGS` action not implemented
- Step1Connect doesn't save `parsed.warnings` anywhere (line ~442)
- Step1Connect has no warning count banner or expandable list (spec §7.1)
- Step5Report has no "File Upload Warnings" section (spec §7.4)
- No CSV export of warnings (AC 32)

**Effort:** Small — 2–3 days. Service layer is done. This is context wiring + UI rendering only.

**Risk:** Low. Additive to existing flow; ProjectOnline path unaffected.

**Depends on / blocks:** Blocks candidate 2 (error panel uses same `LoaderFileError`); blocks candidate 7 (CSV escape hatch needs warnings in state).

**Spec status:** Full spec in `docs/Active/file-upload-spec.md` §7 and §9 (AC 28–32).

---

### 2. Structured error panel for `LoaderFileError` hard fails

**What:** When `parseWorkbook()` throws `LoaderFileError`, show `err.errors: LoaderError[]` as a formatted list instead of `String(err)`.

**Why it matters:** The current error display is a single concatenated string ("LoaderFileError: This file is not a recognized migration template; Required column 'ProjectId'…"). The `LoaderFileError` already carries a typed `errors: LoaderError[]` array — a formatted list per error with sheet name and a download-template button is already designed in `file-upload-spec.md` §7.2.

**Already in place:**
- `LoaderFileError` class in `fileUpload/types.ts` with `.errors: LoaderError[]`
- `validateStructure()` in `fileImportService.ts` produces structured errors with `sheet`, `code`, `message`
- UI design in `file-upload-spec.md` §7.2

**Missing:**
- Step1Connect catch block: `setUploadError(String(err))` → needs to check `instanceof LoaderFileError`, read `err.errors`, render list
- No "Download empty template" button in the current error state
- `uploadError` is currently `string | null` — needs to be `LoaderFileError | string | null` or the errors extracted

**Effort:** Trivial — a few hours. Single component change in Step1Connect.

**Risk:** Minimal. Only touches the file upload error branch.

**Depends on / blocks:** None. Independent of candidate 1 (warnings vs errors are separate paths).

**Spec status:** Full spec in `docs/Active/file-upload-spec.md` §7.2.

---

### 3. Dependency end-to-end smoke test + concurrency dedup

**What:** Verify the dependency scope toggle works correctly through all layers, and consolidate the duplicate `runWithConcurrency` in `dependencies.ts`.

**Why it matters:** Dependency migration (`dependencyWriter.ts`) has never been smoke-tested with a real project that has known FS/SS/FF/SF links. The `dependencies.ts` file has its own copy of `runWithConcurrency` rather than using the shared implementation in `concurrency.ts` — two diverging implementations is a maintenance risk.

**Already in place:**
- `dependencyWriter.ts` — full OperationSet-based writer, 180/batch cap, FS/SS/FF/SF type mapping
- `projectOnline/dependencies.ts` — fetches task links per project
- `migrationScope.dependencies` toggle wired in Step 4

**Missing:**
- `dependencies.ts` uses a local `runWithConcurrency` (different from `concurrency.ts`); should import the shared one
- No test record / smoke-test instructions for verifying a project with known dependencies migrates correctly
- Step 4 scope description says "Dependencies" but users may not know what triggers this

**Effort:** Small — half a day for the dedup; smoke test is a manual verification pass.

**Risk:** Low. Refactoring to use the shared `runWithConcurrency` is mechanical. Dependency writing was already tested during import resilience work (see commit history).

**Depends on / blocks:** None.

**Spec status:** No separate spec — embedded in import resilience and main architecture.

---

## Bigger bets (medium-to-large effort, needs more thought)

### 4. Import resume button

**What:** After a stopped or failed import, allow the user to resume from where they left off by skipping projects that already completed successfully.

**Why it matters:** A 200-project migration that stops at project 147 currently requires restarting from scratch. In practice, already-written projects get the "existing project" path in `projectWriter.ts` (idempotent), but tasks/assignments/dependencies for already-processed projects are cleared and recreated unnecessarily. A resume button would make interrupted imports far less stressful for large PWA migrations.

**Already in place:**
- `projectWriter.ts:findExistingProject()` — looks up `msdyn_project` by subject before creating; returns existing ID if found (`mode: 'existing'`). Project write is idempotent.
- `stopRequestedRef` + `requestStop()` + `importWasStopped` — stop mechanics already work; partial results survive in state for the session.
- `importResults: ImportResult[]` accumulates per-project outcomes in state.

**Missing:**
- Tasks/assignments/dependencies are **clear-and-recreate** per project, not idempotent (see `taskWriter.ts` comment: "Existing assignments, dependencies, and tasks are cleared"). Re-running a project repeats task work even if tasks were fine.
- No "resume" concept: `runImport()` always starts fresh (clears `importResults`, clears `clearProjectWriteDiagnostics()`, etc.).
- No persistence across browser sessions — MigrationContext is in-memory only. Resume only makes sense within the same session after a stop.
- No UI: the user has no "Resume" button; they can only "Start over".

**Missing (to implement in-session resume):**
- Track which `ProjectId`s reached a "fully complete" state (project + tasks + assignments + deps all succeeded)
- In `runWithConcurrency`, skip projects in the completed set
- Add a "Resume" button to Step 4 (visible only after a stopped import) that re-enters `runImport()` without clearing results
- Decide how to handle partial project state (project written, tasks failed) — probably redo everything for that project

**Effort:** Medium — 3–5 days. No new persistence layer needed (session-only). The idempotency gap for tasks means a "resume" still re-writes tasks for failed projects, which is acceptable.

**Risk:** Medium. Clear-and-recreate in taskWriter means re-running a project that previously succeeded in tasks will briefly delete and redo its tasks. This is correct behavior but could alarm users. Need clear UI messaging.

**Depends on / blocks:** None.

**Spec status:** None — would need a spec before implementation.

---

### 5. Excel dropdowns in generated template (exceljs migration)

**What:** Switch `generateTemplate()` from SheetJS to `exceljs` so that data validation dropdowns (IsMilestone, IsSummary, DependencyType, EntityType, FieldType) actually appear in Excel.

**Why it matters:** Without dropdowns, users filling in the template manually must know valid values by heart or read the Instructions sheet. FieldType especially (9 valid values) is error-prone and causes `INVALID_FIELD_TYPE_SKIPPED` warnings. The dropdowns were part of the original spec and are still listed in AC 4.

**Already in place:**
- `fileImportService.ts` — `generateTemplate()` currently uses SheetJS; confirmed in a spike that `!dataValidations` is silently dropped by SheetJS 0.18.5 community build (comment in code)
- `parseWorkbook()` uses SheetJS and does NOT need to change — parser-side is unaffected
- `file-upload-spec.md` §5 and §8.1 fully spec the implementation

**Missing:**
- `exceljs` package not in `package.json`; needs `npm install exceljs`
- `generateTemplate()` rewrite to use `exceljs` for workbook creation (SheetJS stays for parsing)
- Both libraries must coexist in the bundle — need to check bundle size impact

**Effort:** Small-medium — 1–2 days. Mostly mechanical rewrite of `generateTemplate()`. Bundle size check needed.

**Risk:** Low-medium. `exceljs` is a mature library. Risk is bundle bloat (SheetJS is ~500kB; exceljs is ~1MB+ minified). In a Power Apps Code App with bundle size constraints, this needs verification.

**Depends on / blocks:** None. Parser stays on SheetJS.

**Spec status:** Full spec in `docs/Active/file-upload-spec.md` §5, §8.1.

---

## Tech debt (no user-visible value, just hygiene)

### 6. Delete `projectOnlineService.ts` orphan

**What:** Remove `src/services/projectOnlineService.ts` — a connector-based Project Online service (`shared_projectonline`) that is not imported by any file in `src/`.

**Why it matters:** It predates the OData-direct approach and adds confusion for anyone reading the service layer. Grepping for "projectOnline" now returns this file as a false hit.

**Already in place:** Nothing — the file does nothing at runtime.

**Missing:** Just the deletion and a check that nothing outside `src/` references it.

**Effort:** Trivial — 30 minutes including the grep verification.

**Risk:** Minimal. Confirm it's not referenced in `.pcfproj`, `client.ts`, or any manifest before deleting.

**Depends on / blocks:** None.

**Spec status:** None needed.

---

### 7. Delineate `schemaOrchestrator.ts` / `schemaInspector.ts` boundary

**What:** Clarify — in code comments or by restructuring — which file owns which half of the Dataverse schema layer.

**Why it matters:** `schemaOrchestrator.ts` drives schema creation (full/schemaOnly); `schemaInspector.ts` reads existing schema (dataOnly). Both touch the same Dataverse metadata endpoints. Without a clear boundary, future schema work risks putting logic in the wrong file or duplicating it.

**Already in place:** Both files exist and work correctly; the split is functional even if the naming doesn't make the boundary obvious.

**Missing:**
- A one-paragraph comment at the top of each file stating its scope and what it deliberately does NOT do
- Possibly: rename `schemaInspector.ts` → `schemaReader.ts` to reinforce the read-only vs write split

**Effort:** Trivial-small — 1–2 hours for comments; a day if renaming with all import updates.

**Risk:** Renaming is a safe mechanical operation. Comments-only version has zero risk.

**Depends on / blocks:** None.

**Spec status:** None needed.
