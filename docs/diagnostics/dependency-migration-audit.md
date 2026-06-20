# Dependency migration audit — PO → Dataverse `msdyn_projecttaskdependency`

**Type:** Read-only investigation. No code changed.
**Scope clarified by author:** focus is the **Project Online** fetch/write path (file-upload covered briefly in §3).
**Date:** 2026-06-20 · **Branch:** `dev-nieuwe-features`

---

## TL;DR / executive summary

> **Important framing.** The working tree contains substantial *uncommitted* changes to the two
> central files. The symptom in the brief ("non-FS silently become FS, lag dropped, deps missing")
> matches the **committed HEAD baseline**, not the current working-tree code. This audit documents
> the **current working-tree code** (that is "the code" now) and contrasts it with HEAD where the
> behaviour differs, because the brief's symptom originates from HEAD.
>
> - `git diff --stat HEAD`: `dependencyWriter.ts` +188/−92 (256 lines touched), `dependencies.ts` 24 lines touched.
> - New untracked files: `dependencyWriter.test.ts`, `projectCompletionMarker.ts`, plus two docs.

| Finding | Verdict |
|---|---|
| Link type **read** from PO source | ✅ Yes — `dependencies.ts` maps numeric code → `FS/SS/FF/SF` |
| Link type **written** to Dataverse | ✅ Yes — working tree sets `msdyn_projecttaskdependencylinktype` from source |
| Link type **integer mapping is correct** | ❓ **INDETERMINATE — and HEAD vs working tree disagree.** This is the #1 risk. |
| Lag **read** from PO source | ✅ Yes — `dependencies.ts:69` reads `Lag` |
| Lag **written** to Dataverse | ⚠️ Only when the UI opt-in `includeDependencyLag` is on — **default OFF** |
| Lag **unit conversion** | ❓ Working tree assumes seconds (`×6`), HEAD assumed minutes (`×60`) — **disagree** |
| "Missing" deps from silent drops | ⚠️ Several silent-drop paths exist at fetch; writer-side misses are logged |
| Post-Execute verification | ✅ Exists, but only as a **separate diagnostic export** (`scheduleDiagnostic.ts`), not in the import's own success accounting |

**The single most important finding:** the Dataverse option-set integer values for
`msdyn_projecttaskdependencylinktype` are **hard-coded with no authoritative source**, and the two
versions of the code disagree:

```
HEAD (committed):        FS:1, SS:2, FF:3, SF:4
Working tree (current):  FF:0, FS:1, SF:2, SS:3
```

If the working-tree integers are wrong, a source `SS` is written as whatever Dataverse maps `3` to
(working tree sends `3` for SS) — which could be `FF` or an invalid value that triggers the FS
fallback. Either way the user sees "wrong type / everything FS". This must be resolved empirically
against a real tenant before authoring the fix-spec — see §9 and Open Question 1.

---

## Section 1 — PO dependency fetch path

File: [`src/services/projectOnline/dependencies.ts`](../../src/services/projectOnline/dependencies.ts), helper [`odataClient.ts`](../../src/services/projectOnline/odataClient.ts).

### Endpoint(s)

Two URI variants are tried in order (string-id then `guid'…'`), `dependencies.ts:33-36`:

```ts
const uris = [
  `_api/ProjectServer/Projects('${projectId}')/TaskLinks?$expand=Start,End`,
  `_api/ProjectServer/Projects(guid'${projectId}')/TaskLinks?$expand=Start,End`,
]
```

So the entity is **`TaskLinks`** under the `_api/ProjectServer` (CSOM REST) endpoint, with
`Start` and `End` navigation properties expanded (these are the predecessor/successor task refs).

### `$select`

**No `$select` is used.** The query selects all default columns plus the expanded `Start`/`End`.
Paging is handled generically by `odataGetAll` (`odataClient.ts:76-99`), which follows
`@odata.nextLink` / `__next`.

### Raw OData row shape — how fields are read

The normalizer reads fields defensively across many possible casings/names
(`dependencies.ts:51-71`):

```ts
function normalizeDependency(projectId: string, row: Record<string, unknown>, index: number): PoTaskDependency {
  const predecessor = objectValue(row.Start) ?? objectValue(row.start)
  const successor = objectValue(row.End) ?? objectValue(row.end)
  const dependencyType = dependencyTypeValue(
    row.DependencyType ?? row.dependencyType ??
    row.LinkType ?? row.linkType ??
    row.TaskLinkType ?? row.taskLinkType,
  )
  return {
    DependencyId: stringValue(row.Id ?? row.LinkId ?? row.linkId) || `${projectId}:dependency:${index}`,
    ProjectId: projectId,
    PredecessorTaskId: extractTaskId(predecessor, row.StartId ?? row.startId ?? row.StartTaskId ?? row.startTaskId),
    SuccessorTaskId: extractTaskId(successor, row.EndId ?? row.endId ?? row.EndTaskId ?? row.endTaskId),
    DependencyType: dependencyType,
    Lag: numberValue(row.Lag ?? row.lag),
  }
}
```

| Internal field | Source field(s) tried | Notes / observed unit |
|---|---|---|
| `DependencyId` | `Id`, `LinkId`, `linkId` | falls back to synthetic `${projectId}:dependency:${index}` |
| `PredecessorTaskId` | `Start.{Id,id,TaskId,taskId,TaskGuid,taskGuid}` then `StartId/StartTaskId` | GUID expected (braces stripped) |
| `SuccessorTaskId` | `End.{…}` then `EndId/EndTaskId` | GUID expected |
| `DependencyType` | `DependencyType`/`LinkType`/`TaskLinkType` (+camel) | **integer code expected** (see mapping below); strings also accepted |
| `Lag` | `Lag`, `lag` | **raw number, no unit conversion at fetch** — passed through as-is |

> **Note — we do not actually know the real PO field names at runtime.** The code guesses several
> names because there is **zero logging of a raw row** (see §7). The actual `_api/ProjectServer/.../TaskLinks`
> shape (e.g. whether the type field is `DependencyType` vs `LinkType`, whether `Lag` exists at all,
> and what unit it uses) is **unverified empirically**. This is itself a finding.

### Type-code translation (fetch)

`dependencies.ts:7-12` + `99-110`:

```ts
const DEPENDENCY_TYPES: Record<number, PoDependencyType> = { 0: 'FF', 1: 'FS', 2: 'SF', 3: 'SS' }

function dependencyTypeValue(value: unknown): PoDependencyType | undefined {
  if (typeof value === 'string') {
    const text = value.trim().toUpperCase().replace(/[\s_-]/g, '')
    if (text === 'FS' || text === 'FINISHTOSTART') return 'FS'
    if (text === 'SS' || text === 'STARTTOSTART') return 'SS'
    if (text === 'FF' || text === 'FINISHTOFINISH') return 'FF'
    if (text === 'SF' || text === 'STARTTOFINISH') return 'SF'
  }
  const numeric = numberValue(value)
  return numeric == null ? undefined : DEPENDENCY_TYPES[numeric]
}
```

The numeric map `0:FF, 1:FS, 2:SF, 3:SS` matches the **Project Server CSOM `DependencyType` enum**
(`FinishToFinish=0, FinishToStart=1, StartToFinish=2, StartToStart=3`). This is the conventional PO
ordering and is the most defensible part of the chain — but it is **not cited in a comment** and is
unverified against runtime data.

> **Working-tree improvement vs HEAD:** HEAD only read `row.DependencyType ?? row.dependencyType`
> as a number (`dependencies.ts` @HEAD line ~55). The working tree additionally accepts `LinkType`,
> `TaskLinkType`, and string forms — a strictly wider net for the type field.

### Lag conversion at fetch

**None.** `Lag: numberValue(row.Lag ?? row.lag)` (`:69`) — the raw number is stored unchanged.
Unit interpretation is deferred to the writer (§4).

### Critical: does fetch filter out non-FS or non-zero-lag rows?

**No type/lag filter.** The only filter is on missing task ids (`dependencies.ts:26`):

```ts
.filter(dep => dep.PredecessorTaskId && dep.SuccessorTaskId)
```

⚠️ This drops any row whose predecessor or successor id could not be extracted — **silently, no
warning**. A row with an unrecognised `Start`/`End` shape vanishes here with no record. (Silent-drop
path #1; see Hypothesis D.)

A whole project's links also vanish silently if **both** endpoint variants throw
(`dependencies.ts:38-48`): the error is `console.warn`'d and `[]` is returned. No per-dependency
error is produced because the rows were never seen. (Silent-drop path #2.)

---

## Section 2 — Internal type and state

File: [`src/models/projectOnline.types.ts:74-84`](../../src/models/projectOnline.types.ts#L74-L84):

```ts
export type PoDependencyType = 'FF' | 'FS' | 'SF' | 'SS'

export interface PoTaskDependency {
  DependencyId: string
  ProjectId: string
  PredecessorTaskId: string
  SuccessorTaskId: string
  DependencyType?: PoDependencyType
  Lag?: number
  [key: string]: unknown
}
```

The internal type **does carry both `DependencyType` and `Lag`** (both optional). They are **not**
discarded at the fetch boundary — `normalizeDependency` populates both (§1).

### Flow through context

- `PoFetchedData.dependencies: PoTaskDependency[]` — `projectOnline.types.ts:128-139`.
- Populated:
  - **PO path:** lazily, inside the import in `Step4Import` (`index.tsx:449-456`), gated on
    `migrationScope.dependencies`. The result is held in a local `importDependencies`, not always
    pushed back to context.
  - **File-upload path:** in `fileImportService.ts` (`:955-967`), set via `setFetchedData`.
- Read: `Step4Import/index.tsx:237-240` (`selectedDependencies`), `:582` (per-project filter), and
  the diagnostic in `Step5Report` / `scheduleDiagnostic.ts`.

`MigrationContext.tsx` stores `fetchedData` as plain state (`:174`, `setFetchedData` `:291-293`) and
exposes `importProgress` (`:189`) — it does **not** transform dependencies; type+lag survive the
context unchanged.

**Conclusion:** link type and lag are preserved fetch → context → writer. Nothing is lost *in
between*. (See Hypothesis B/C for what happens *at the edges*.)

---

## Section 3 — File-upload dependency path

There is **no `excelTemplate.ts`**. The file-upload loader is
[`src/services/fileImportService.ts`](../../src/services/fileImportService.ts).

### Template columns (`fileImportService.ts:58-59`)

```ts
Dependencies: [
  ['DependencyId', 'ProjectId', 'PredecessorTaskId', 'SuccessorTaskId', 'DependencyType'],
```

The spec columns are followed. **There is no `Lag` / `LinkLag` column** — so the file-upload path
**cannot carry lag at all** (`Lag` is simply never set on the produced `PoTaskDependency`).

### Parser (`fileImportService.ts:845-897`)

`DependencyType` **is** read and normalised:

```ts
const rawDepType = str(r['DependencyType']).toUpperCase()
const validDepTypes = ['FS', 'SS', 'FF', 'SF']
let depType = normalizeDependencyType(str(r['DependencyType']))
if (rawDepType && !validDepTypes.includes(rawDepType)) {
  pushWarning(warnings, capCounts, {
    sheet: 'Dependencies', row: i + 2, column: 'DependencyType',
    code: 'DEPENDENCY_TYPE_DEFAULTED',
    message: `Unknown DependencyType "${str(r['DependencyType'])}". Defaulted to "FS".`,
  })
  depType = 'FS'
}
```

`normalizeDependencyType` (`:972-976`) returns the value for `FS/SS/FF/SF`, else `FS`.

- **Empty cell → `FS`** silently (no warning — `rawDepType` is falsy so the `if` is skipped). This
  is *close to* the spec's "FS with `DEPENDENCY_TYPE_DEFAULTED`" but the warning fires **only for
  unknown non-empty values**, not for blank cells. Minor spec deviation.
- **Unknown value → `FS` + `DEPENDENCY_TYPE_DEFAULTED` warning** (matches spec).
- Rows referencing an unknown project/predecessor/successor are dropped with an
  `INVALID_REFERENCE_SKIPPED` warning (`:852-875`) — *not* silent.

---

## Section 4 — Dataverse dependency write path (working tree)

File: [`src/services/plannerPremium/dependencyWriter.ts`](../../src/services/plannerPremium/dependencyWriter.ts).

### Entity & action

- **Entity:** `msdyn_projecttaskdependency` — `@odata.type:
  'Microsoft.Dynamics.CRM.msdyn_projecttaskdependency'` (`dependencyWriter.ts:128`). **Not**
  `msdyn_predecessorlink` / `msdyn_tasklink`.
- **Action:** queued into an OperationSet via `msdyn_PssCreateV1` then executed — through
  `executeOperationSetWithRetry` (`dependencyWriter.ts:150`), which internally calls
  `createOperationSet` → `queueScheduleCreate` (`msdyn_PssCreateV1`) → `executeOperationSet`
  (`scheduleApi.ts:128-133`).

### Payload built per dependency (`dependencyWriter.ts:118-138`)

```ts
const ops = creatable.map(dependency => {
  const dependencyId = crypto.randomUUID()
  const lagSeconds = dependencyLagSeconds(dependency, lagContext?.includeSourceLag)
  return {
    id: dependency.DependencyId,
    dvId: dependencyId,
    dependencyType: dependency.DependencyType ?? 'FS',
    sourceLagTenthsOfMinute: dependency.Lag,
    lagSeconds,
    entity: {
      '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_projecttaskdependency',
      msdyn_projecttaskdependencyid: dependencyId,
      msdyn_projecttaskdependencylinktype: dependencyLinkTypeValue(dependency.DependencyType),
      ...(lagSeconds != null ? { msdyn_projecttaskdependencylinklag: lagSeconds } : {}),
      msdyn_description: '',
      'msdyn_Project@odata.bind': `/msdyn_projects(${projectId})`,
      'msdyn_PredecessorTask@odata.bind': `/msdyn_projecttasks(${taskIdMap[dependency.PredecessorTaskId]})`,
      'msdyn_SuccessorTask@odata.bind': `/msdyn_projecttasks(${taskIdMap[dependency.SuccessorTaskId]})`,
    } as Record<string, unknown>,
  }
})
```

Fields present vs the brief's reference payload:

| Reference field | Present? | Actual field name |
|---|---|---|
| `@odata.type` | ✅ | `Microsoft.Dynamics.CRM.msdyn_projecttaskdependency` |
| project bind | ✅ | `msdyn_Project@odata.bind` |
| predecessor bind | ✅ | `msdyn_PredecessorTask@odata.bind` |
| successor bind | ✅ | `msdyn_SuccessorTask@odata.bind` |
| `msdyn_linktype` | ✅ | `msdyn_projecttaskdependencylinktype` (always set) |
| `msdyn_linklag` | ⚠️ conditional | `msdyn_projecttaskdependencylinklag` (only when `lagSeconds != null`) |

(Plus an explicit primary key `msdyn_projecttaskdependencyid` and empty `msdyn_description`.)

### Critical question 1 — link type

The writer **does** set `msdyn_projecttaskdependencylinktype`, **derived from the source type**, via
(`dependencyWriter.ts:27-36`):

```ts
const LINK_TYPE_VALUES: Record<PoDependencyType, number> = { FF: 0, FS: 1, SF: 2, SS: 3 }
export function dependencyLinkTypeValue(type: PoDependencyType | undefined): number {
  return LINK_TYPE_VALUES[type ?? 'FS']
}
```

So it is **not hard-coded to FS** and **not omitted**. A missing source type defaults to `FS` (1).

🚩 **But the integer values are hard-coded with no source comment, and HEAD used different numbers:**

```
HEAD:        const LINK_TYPE_VALUES = { FS:1, SS:2, FF:3, SF:4 }   // 1-based, distinct ordering
Working tree:const LINK_TYPE_VALUES = { FF:0, FS:1, SF:2, SS:3 }   // 0-based, == PO enum
```

The working-tree values happen to equal the PO-side `DEPENDENCY_TYPES` map — i.e. the code now
**assumes Dataverse's option set is identical to Project Server's enum**. That assumption is
unverified. If it is wrong, the symptom "type comes through wrong / as FS" follows directly. (See §9
+ Open Question 1.)

### Critical question 2 — lag

The writer **does** set `msdyn_projecttaskdependencylinklag`, but only when lag is included
(`dependencyWriter.ts:38-46`):

```ts
export function dependencyLagTenthsOfMinute(dependency, includeSourceLag): number | null {
  if (!includeSourceLag || dependency.Lag == null || dependency.Lag === 0) return null
  return dependency.Lag
}
export function dependencyLagSeconds(dependency, includeSourceLag): number | null {
  const lagTenthsOfMinute = dependencyLagTenthsOfMinute(dependency, includeSourceLag)
  return lagTenthsOfMinute == null ? null : Math.round(lagTenthsOfMinute * 6)
}
```

- **Unit assumption:** source `Lag` is treated as **tenths of a minute**; output is **seconds**
  (`×6`, since 1 tenth-of-a-minute = 6 s). Test confirms intent: `4800 → 28800` s = 8 h
  (`dependencyWriter.test.ts:41-42`). Negative lag (lead) is preserved (`-4800 → -28800`).
- **Gated by opt-in:** `includeSourceLag` comes from the Step 4 checkbox `includeDependencyLag`,
  which **defaults to `false`** (`Step4Import/index.tsx:158`). So with default settings the lag
  field is **never emitted** — every dependency is written with no lag.

🚩 **HEAD assumed a different unit:** HEAD wrote `msdyn_projecttaskdependencylinklag: lagMinutes`
where `lagMinutes = dependency.Lag * 60` (and a date-derived "compensated lag" in *minutes*). So
HEAD treated the field as **minutes** and treated source `Lag` as **minutes** too. Working tree
treats the field as **seconds** and source as **tenths-of-minute**. Both cannot be right — see Open
Question 2.

### Critical question 3 — pre-write filtering

The writer's `creatable` filter (`dependencyWriter.ts:75-114`) drops a dependency in three cases,
**each producing a visible `DependencyWriteResult` with an error** (not silent):

1. Summary-task reference when `skipSummaryTaskDependencies` is on → error class `Skipped`,
   message "Dependency references a summary task and was not created" (`:78-93`).
2. Predecessor or successor GUID not found in `taskIdMap` → error class `PredecessorMissing` (`:98-111`).
3. (Outer) project not imported → error "Project was not imported" (`:61-71`).

There is **no filter that drops non-FS or non-zero-lag dependencies** in the working tree. Non-FS
deps are *written with their real type*; FS is only applied as a **fallback after a failed write**
(see §5).

> **Contrast with HEAD — this is where the brief's symptom lived.** HEAD's `creatable` filter
> **explicitly rejected every non-FS dependency** before writing:
> ```ts
> if (dependency.DependencyType && dependency.DependencyType !== 'FS') {
>   ... nowError(..., "Planner Premium only allows Finish-to-Start (FS) ... Project Plan P3 ...",
>                'NonFSDependency', ...)
>   return false
> }
> ```
> That is the source of the "explicit NonFSDependency errors" the brief mentions. The working tree
> **removed that hard filter** and instead attempts the real type, falling back to FS on failure.

---

## Section 5 — OperationSet ordering, batching, retry, verification

### Batching

- Per-project, chunked at **180** per OperationSet: `for (const chunk of chunks(projectDependencies, 180))`
  (`dependencyWriter.ts:74`). Matches the documented 180 cap shared by tasks/assignments/deps
  (`docs/migrator-project-context.md:181`).

### Ordering

In `Step4Import/index.tsx` the per-project sequence is: resources/projects (earlier) → team members
→ **tasks** (`:568-579`) → build `projectTaskIdMap` from task results → **dependencies** (`:581-606`)
→ assignments. So **dependencies are written after all tasks of the same project**, and the
predecessor/successor map is built from that project's just-written task results. Dependencies are in
**separate Execute calls** from tasks (each `writeDependencies` chunk opens its own OperationSet).

### Partial-batch failure handling

`executeOperationSetWithRetry` (`scheduleApi.ts:110-183`) implements Phase-2-style partial retry:

- On failure it reads `failedBatchRequestIndex` (`extractFailedBatchIndex`), **excludes that one op**,
  and retries the rest (`:161-167`).
- Repeated identical failures (3×, by GUID/number-collapsed signature) are treated as systemic and
  the remaining ops are failed in bulk to avoid O(n²) (`:122`, `:145-159`).
- `AlreadyExists` is treated as success/skip and keeps pinpoint-retrying.

So **one bad dependency does not sink the batch** — the rest still land. ✅ Active.

On top of that, `writeDependencies` adds two **fallback retries** specific to dependencies:

1. **Without-lag fallback** (`:156-194`): any op that failed *and* carried a lag field is retried
   with `msdyn_projecttaskdependencylinklag` stripped. Audited as `withoutLag`.
2. **As-FS fallback** (`:196-236`): any op that failed *and* whose source type ≠ FS is retried with
   `msdyn_projecttaskdependencylinktype = LINK_TYPE_VALUES.FS`. Audited as `asFs`.

⚠️ **This as-FS fallback is a plausible mechanism for "everything becomes FS".** If the link-type
integers are wrong (§4) the initial non-FS writes fail, then this fallback re-creates them as FS —
producing exactly "source SS/FF/SF silently became FS in target", but now *with a warning* in the
Step 4 live log (not in the Step 5 report — see §8).

### Verification (read-back)

The **import flow itself does not read back** what landed — `executeOperationSetWithRetry` returns
`succeeded`/`failed` purely from whether the Execute action threw; there is no GET to confirm rows
exist (`scheduleApi.ts:128-182`).

However, a **separate post-import diagnostic** does read back and compare
([`scheduleDiagnostic.ts`](../../src/services/diagnostics/scheduleDiagnostic.ts)):

- `fetchDependenciesForProject` lists `msdyn_projecttaskdependencies` filtered by project
  (`:523-525`), returning full rows.
- `buildDependencyDiagnostics` (`:238-347`) matches each source dep to a target row by
  predecessor/successor GUID pair and reports `typeMatches` / `lagMatches`, plus `missingTargetDependency`
  for source deps with no target row, and orphan target rows with no source.
- It uses the **same** assumed option set `{ FF:0, FS:1, SF:2, SS:3 }` (`:235`) and the **same**
  lag-seconds conversion `Lag * 6` (`:251`) as the working-tree writer.

> **This diagnostic is the empirical key to Open Question 1.** It reads the *actual stored*
> `msdyn_projecttaskdependencylinktype` integer and labels it (`:333`, `DEPENDENCY_TYPE_LABELS`).
> Running it against a tenant where you created a known `SS` dependency will reveal the true option
> set value directly. But note: because the diagnostic shares the writer's assumptions, a `typeMatches:
> true` only proves writer and diagnostic agree — it does **not** independently prove the integers are
> the true Dataverse values.

It is a manual export, **not** wired into the import's pass/fail accounting.

---

## Section 6 — Reference resolution (predecessor/successor GUIDs)

- The writer resolves source task ids → Dataverse GUIDs via `taskIdMap[dependency.PredecessorTaskId]`
  / `[…SuccessorTaskId]` (`dependencyWriter.ts:95-96`, used in the binds `:134-135`).
- The map is built **per project** in the orchestrator from that project's task write results
  (`Step4Import/index.tsx:576-579`):

  ```ts
  const projectTaskIdMap = Object.fromEntries(
    taskResults.filter(r => r.dvTaskId).map(r => [r.poTaskId, r.dvTaskId as string])
  )
  ```

  and passed straight into `writeDependencies(projectDeps, singleProjectMap, projectTaskIdMap, …)`
  (`:586`). **Scope is correctly per-project** — there is no global cross-project task map, so the
  "project A resolves to project B's task with the same id" risk does **not** apply. ✅

- **Lookup miss → visible error**, not silent: `PredecessorMissing` (`dependencyWriter.ts:98-111`).

- **Order-of-operations is safe**: tasks for the project are fully written and their GUIDs cached
  *before* `writeDependencies` runs (§5 ordering). A dependency cannot be queued before its tasks
  within the same project. (A dependency whose task *failed* to write earlier resolves to a missing
  map entry → `PredecessorMissing`, which is the expected, logged outcome.)

---

## Section 7 — Source-data shape / runtime visibility

Grep results for logging in the fetch + write path:

- `dependencies.ts` — **one** `console.warn`, only on a whole-project endpoint failure
  (`:47`). **No log of any raw row, type, or lag.**
- `dependencyWriter.ts` — `console.warn` on fallback paths only (`:161`, `:201`); these log *counts*
  and failure reasons, not the source payload.
- `scheduleApi.ts` — `console.warn` on OperationSet attempt failures (`:143`, `:153`).
- Step 4 live log (`Step4Import/index.tsx:584`, `:599`) prints per-dependency OK/SKIP with type/lag/
  fallback info **derived from `DependencyWriteResult`** — useful, but it logs what the code *decided*,
  not the **raw OData row** PO returned.

**Finding:** there is **zero logging of the raw PO `TaskLinks` row**. We have no runtime evidence of
the real field names, the real type-code values, or the real lag unit that PO returns. Every
statement in §1 about field names is an inference from the defensive read-list, not from observed
data. The fix-spec should add a one-shot raw-row dump (behind a debug flag) to settle §1 and Open
Questions 1–2.

---

## Section 8 — Error classification & reporting

File: [`errorClassifier.ts`](../../src/services/plannerPremium/errorClassifier.ts).

- The `DataverseErrorClass` union includes **`NonFSDependency`** and **`PredecessorMissing`**
  (`:1-9`). However, `classifyDataverseError` (`:21-35`) has **no branch that ever returns
  `NonFSDependency`** — that class is only produced manually by the writer's `nowError(...)` calls
  (HEAD's hard filter set it; the working tree's writer no longer emits it). So `NonFSDependency` is
  now effectively dead unless re-introduced. `PredecessorMissing` is likewise set manually by the
  writer, not by `classifyDataverseError`.
- Step 5 maps the class to a label (`Step5Report/index.tsx:133-134`): `NonFSDependency → 'Non-FS
  dependency type (license limitation)'`, `PredecessorMissing → 'Predecessor or successor task not
  imported'`.

### Silent server-side success-but-no-row

If Dataverse returns success on Execute but a row does not actually persist, **nothing in the import
flow catches it** (no read-back — §5). Only the separate `scheduleDiagnostic` export would surface it
(as `missingTargetDependency`).

### Counting / progress

- Dependencies increment the shared completion counter via the `onProgress` callback
  (`Step4Import/index.tsx:586-588`, `setCompleted(c => c + 1)`), and are added to the totals when
  `migrationScope.dependencies` is on (`:473`).
- A per-category result row is added in Step 5 **only if** `allDepResults.length > 0`
  (`:703-705`): `addImportResult(makeResult('Dependencies', allDepResults.length, …errors))`. Note
  this counts **all** results (successes + failures); only `.error` entries become the error list.
- ⚠️ The rich working-tree audit fields (`writtenDependencyType`, `fallbackApplied`, `warning`) are
  surfaced **only in the Step 4 live log** (`:588-599`). The Step 5 report's `makeResult` consumes
  `r.error` only — **fallback warnings (e.g. "created as FS") are not persisted into the Step 5
  report**. So a migration where every non-FS silently fell back to FS would show **0 dependency
  errors** in Step 5.

---

## Section 9 — Known PSS / P4W constraints found in the codebase

- **Entity name:** `msdyn_projecttaskdependency` (writer `:128`; diagnostic reads
  `msdyn_projecttaskdependencies` `:524`). Confirmed — **not** `predecessorlink`/`tasklink`.
- **`msdyn_projecttaskdependencylinktype` integers** — hard-coded in **three** places, two of which
  agree and one (HEAD) disagrees:
  | Location | Mapping |
  |---|---|
  | `dependencyWriter.ts:27-32` (working tree) | `FF:0, FS:1, SF:2, SS:3` |
  | `scheduleDiagnostic.ts:235-236` | `FF:0, FS:1, SF:2, SS:3` (+ inverse labels) |
  | `dependencyWriter.ts` @ **HEAD** | `FS:1, SS:2, FF:3, SF:4` |
  None carry a source comment or doc link. 🚩 **Maintenance + correctness risk** — exactly the
  instability the schedule-mode spec warns about for PSS option sets.
- **`msdyn_projecttaskdependencylinklag` unit** — working tree assumes **seconds** (`×6` from
  tenths-of-minute); HEAD assumed **minutes** (`×60`). Unverified against the live attribute.
- **License / Project Plan comments:** `docs/migrator-project-context.md:183` — "Non-FS dependency
  types (SS, FF, SF): only supported on Project Plan 3+ licenses; classified as `NonFSDependency` …
  logged as warnings, not failures." This doc text describes the **HEAD** behaviour and is now
  partially stale relative to the working tree. The HEAD writer also embedded the P3 message
  in-code; the working tree removed it in favour of the as-FS fallback.

---

## Section 10 — Open questions for the author

1. **Link-type integers — which mapping is correct?** Working tree/diagnostic use `FF:0, FS:1, SF:2,
   SS:3`; HEAD used `FS:1, SS:2, FF:3, SF:4`. Neither is sourced. The true
   `msdyn_projecttaskdependencylinktype` option-set values must be confirmed from Dataverse attribute
   metadata (or by creating one of each type in P4W UI and reading the stored integer via the
   `scheduleDiagnostic` read-back). **If the working-tree values are wrong, that alone explains
   "wrong type / fell back to FS".**
2. **Lag unit — seconds or minutes?** Confirm the unit of `msdyn_projecttaskdependencylinklag` and
   the unit of PO's `TaskLink.Lag`. Working tree assumes `field = seconds`, `source = tenths-of-minute`
   (`×6`); HEAD assumed `field = minutes`, `source = minutes` (`×60`). They are mutually exclusive.
3. **Does PO's `TaskLinks` actually return `Lag` and `DependencyType`, and under which names?** No
   raw row is ever logged (§7). The fetch reads a guessed list of field names. Confirm against a real
   `_api/ProjectServer/Projects('…')/TaskLinks` response.
4. **Is lag intended to be OFF by default?** `includeDependencyLag` defaults to `false`
   (`Step4Import/index.tsx:158`), so out-of-the-box migrations drop all lag. Confirm this is the
   intended default vs a regression — it is a plausible source of the "lag dropped" symptom even
   after the writer learned to write lag.
5. **Should the as-FS fallback be silent in the Step 5 report?** Fallbacks (`fallbackApplied: 'asFs'`)
   are logged live in Step 4 but **not** carried into the Step 5 report (§8), so a fully-coerced run
   shows zero dependency errors. Decide whether the report should count/expose fallbacks.
6. **No in-flow read-back.** "Missing dependencies" (server accepted Execute but row absent) cannot be
   detected by the import itself — only by the separate `scheduleDiagnostic` export. Confirm whether
   that diagnostic should be promoted into the import's own verification/accounting.
7. **Silent fetch-side drops.** Rows with unextractable task ids are dropped with no warning
   (`dependencies.ts:26`), and a project whose `TaskLinks` endpoint fails twice loses all its deps
   with only a `console.warn` (`:47`). Should these become reportable warnings?

---

## Hypotheses — verdicts

> Verdicts are against the **current working-tree** code (that is "the code" now), with the HEAD
> baseline noted because the brief's symptom originates there.

### Hypothesis A — silent coercion to FS because the payload *omits* `linktype`
**RULED OUT (as literally stated).** The payload **always sets**
`msdyn_projecttaskdependencylinktype` (`dependencyWriter.ts:130`), and HEAD did too. Nothing relies
on a Dataverse default for type.
**But the real-world effect it predicts is live via a different mechanism:** if the hard-coded
integers are wrong (§4/§9), non-FS writes fail and the **as-FS fallback** (`:196-236`) recreates them
as FS. So "everything becomes FS" is plausible — through wrong integers + fallback, *not* omission.
Severity: high, pending Open Question 1.

### Hypothesis B — type lost at the fetch/parse boundary
**RULED OUT.** Type **is** read and mapped on both paths:
PO fetch `dependencies.ts:54-61` + `99-110`; file-upload `fileImportService.ts:877-894`. It is
carried on `PoTaskDependency.DependencyType` (`projectOnline.types.ts:81`) and written
(`dependencyWriter.ts:130`).
**Caveat (indeterminate):** whether the *numeric translation* `DEPENDENCY_TYPES` is correct for what
PO actually returns is unverified — no raw-row logging (§7). The wiring exists; its correctness is
open.

### Hypothesis C — lag never read, never written
**PARTIALLY CONFIRMED, mechanism differs by path:**
- **PO path:** lag **is** read (`dependencies.ts:69`) and the writer **can** write it — but it is
  dropped by default because `includeDependencyLag` defaults to `false`
  (`Step4Import/index.tsx:158`). So "lag = 0 in target" is the **default** outcome, via opt-out, not
  via a missing field.
- **File-upload path:** **CONFIRMED** — there is no `Lag` column in the template
  (`fileImportService.ts:58-59`), so lag genuinely cannot be carried at all.
- Additional unknown: even when enabled, the lag *unit* may be wrong (Open Question 2).

### Hypothesis D — silent drops on reference miss
**PARTIALLY CONFIRMED — but the silent drops are at *fetch*, not the writer:**
- Writer-side misses are **logged**, not silent: `PredecessorMissing` (`:98-111`), summary-skip
  (`:78-93`), project-not-imported (`:61-71`).
- Genuine **silent** drops exist upstream: fetch `.filter` removes rows with unextractable task ids
  with no warning (`dependencies.ts:26`); a failing `TaskLinks` endpoint drops a whole project's deps
  with only a `console.warn` (`:47`); and there is **no post-Execute read-back** in-flow (§5), so
  server-accepted-but-not-persisted rows vanish without a trace in the report.

---

## Appendix — files read

| File | Role |
|---|---|
| `src/services/projectOnline/dependencies.ts` | PO `TaskLinks` fetch + normalize (working tree + HEAD compared) |
| `src/services/projectOnline/odataClient.ts` | `odataGetAll` paging |
| `src/services/plannerPremium/dependencyWriter.ts` | Dataverse write (working tree + HEAD compared) |
| `src/services/plannerPremium/dependencyWriter.test.ts` | New unit tests for type/lag helpers |
| `src/services/plannerPremium/scheduleApi.ts` | OperationSet create/queue/execute + partial retry |
| `src/services/plannerPremium/errorClassifier.ts` | Dataverse error classes |
| `src/services/plannerPremium/importHelpers.ts` | `chunks`, `nowError` |
| `src/services/diagnostics/scheduleDiagnostic.ts` | Post-import read-back + compare |
| `src/services/fileImportService.ts` | File-upload Dependencies parse |
| `src/models/projectOnline.types.ts` | `PoTaskDependency`, `PoDependencyType` |
| `src/steps/Step4Import/index.tsx` | Orchestrator: fetch → tasks → deps ordering, lag/summary toggles |
| `src/steps/Step5Report/index.tsx` | Error labels, dependency result counting |
| `src/app/MigrationContext.tsx` | State: `fetchedData.dependencies`, `importProgress` |
| `docs/migrator-project-context.md` | Documented constraints (180 cap, P3 license note) |
