# Feature: Schedule Diagnostic Export

**Type:** Implementation spec
**Goal:** Post-import diagnostic that reads back what Dataverse actually stored, side-by-side with the source PO/Excel values, exported as JSON for analysis.
**Why:** End drift diagnosis by inspection — read the real stored values instead of guessing from logs.

---

## Implementation status (built)

Implemented read-only. Files:
- [src/services/diagnostics/types.ts](../../src/services/diagnostics/types.ts) — report shapes.
- [src/services/diagnostics/scheduleDiagnostic.ts](../../src/services/diagnostics/scheduleDiagnostic.ts) — pure helpers (`deltaDays`, `matchTargetTask`, `parsePlannedWork`) + fetch helpers + `buildScheduleDiagnostic`.
- [src/services/diagnostics/scheduleDiagnostic.test.ts](../../src/services/diagnostics/scheduleDiagnostic.test.ts) — unit tests for the pure functions.
- [src/steps/Step5Report/index.tsx](../../src/steps/Step5Report/index.tsx) — "Export schedule diagnostics (JSON)" button in the Entity Results toolbar + `downloadJson`.

Deviations from the original draft:
- **Task matching uses id first** (DV task id == cleaned/lowercased PO GUID, because the writers use `sourceGuidOrNew(TaskId)`), then subject + start as fallback. More reliable than subject-only; no taskWriter refactor needed.
- **Project scope** comes from `selectedProjectIds` + `fetchedData` (not `importResults`, which is aggregated per entity and has no project ids). DV project id == cleaned PO project GUID.
- **Version** is a `MIGRATOR_VERSION` constant in the diagnostic module (package.json is outside the `src` tsconfig include; no `resolveJsonModule`). Bump together.
- **Resource calendar hours** are best-effort: `calendarrules` are read without `$select` (to avoid the 400s seen on guessed field names) and the most common positive daily working-minutes value is used. When it can't be parsed, `workingHoursPerDay` is null with an explanatory note; `calendarId` / `hasCalendar` are still reliable.

---

## 1. Problem & goal

After a migration you don't know exactly what Dataverse stored. Logs show what we *wrote* (intended); PSS recomputes post-Execute. Without a read-back comparison, drift is guesswork. The export shows, per selected project: source values, Dataverse-stored values, resource calendar info, a side-by-side diff with `delta_days`, as downloadable JSON.

## 2. Scope

In scope: button in Step 5; read-back of project/tasks/assignments/resources per migrated project; side-by-side JSON (source-from-state vs target-from-Dataverse); filter to selected projects; timestamped JSON download.

Out of scope: in-app diff table; threshold alerts; Excel export; cross-session persistence (re-run = re-fetch).

## 3. JSON output shape

Top-level `meta` (exportedAt, migratorVersion, tenantUrl, dataSource, migrationMode, projectCount, privacyNote, optional truncatedToCap) and `projects[]`. Each project: `source`, `target` (raw DV fields), `delta`, `tasks[]`, `assignments[]`, `resources[]`, `unmatchedTasks[]`, optional `fetchError`. Each task: `source`/`target`/`delta` with `startDays`, `endDays`, `durationDaysDelta`, `scheduledDurationMinutesDelta`. Each resource: `calendar` with `calendarId`, `hasCalendar`, `workingHoursPerDay`, `matchesProjectCalendar`, `note`. See [types.ts](../../src/services/diagnostics/types.ts) for exact fields.

## 4. Edge cases handled

- Task not matchable → recorded in `unmatchedTasks[]`, no crash.
- Empty `msdyn_plannedwork` → null + note "no contour written" (expected after the RC3 revert).
- Resource without calendar (`_calendarid_value` null) → `hasCalendar: false`, note "uses the project calendar (no resource-calendar drift source)" — directly tests hypothesis A.
- File-upload vs PO source: `work_hours` only included for PO (`dataSource === 'ProjectOnline'`).
- Token expiration: reuses `dataverseClient` retry.
- Privacy: `meta.privacyNote` flags that project/resource names are present.
- Per-project fetch wrapped in try/catch → `fetchError` captured, source still emitted. Hard cap 50 projects (`meta.truncatedToCap`).

## 5. What you can do with it

- **Hypothesis A (resource calendar):** inspect `projects[].resources[].calendar.matchesProjectCalendar` / `hasCalendar`. If assigned resources have a mismatching (or own) calendar → confirmed; fix by aligning resources to the project work-hour-template/calendar.
- **Effort/duration drift:** inspect `tasks[].delta.scheduledDurationMinutesDelta`. Consistently positive → PSS lengthens; negative → shortens.
- **Fixed Effort vs Fixed Duration:** compare `source.work_hours` vs `target.msdyn_effort` vs `target.msdyn_scheduleddurationminutes / 60`. Drastic effort recompute → mode issue.

## 6. Acceptance criteria

- ✅ Button in Step 5, disabled until a successful import (`importResults` non-empty + `fetchedData` present).
- ✅ Click downloads timestamped JSON with meta/projects/source/target/delta/tasks/assignments/resources.
- ✅ Per task: numeric `delta.endDays`. Per resource: `calendar.matchesProjectCalendar` (boolean when hours known, else null + note).
- ✅ Unmatched tasks land in `unmatchedTasks[]` without crashing.
- ✅ Works on file-upload migrations (PO-only fields omitted).
- ✅ `npm run build` clean; unit tests green.
