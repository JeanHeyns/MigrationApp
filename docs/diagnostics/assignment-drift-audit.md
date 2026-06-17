# Assignment Schedule Drift — Diagnostic Audit

**Type:** Read-only investigation. No code changed.
**Goal:** Map the complete data flow from Project Online assignment fetch → Dataverse `msdyn_resourceassignment` write, so a fix-spec can be authored next.
**Date:** 2026-06-17
**Symptom:** Tasks + dependencies migrate correctly. Tasks WITHOUT assignments stay correct after migration. Only tasks WITH assignments drift (sometimes 5+ days). Scheduling type is Fixed Effort (effort leading, duration derived).

> **Headline finding (read first):** The assignment writer sends **no scheduling fields at all** — no units, no work/effort, no dates. It writes only the three relationship binds (`msdyn_projectid`, `msdyn_taskid`, `msdyn_projectteamid`) plus a name. The PO `AssignmentUnits` value is fetched, carried through context, and silently dropped. With no units supplied, PSS assigns its default (typically 100 %) and — under Fixed Effort — recomputes the task's **duration** from `Work / Units` the instant a resource lands on the task. A separate post-pass (`correctTaskSchedule`) tries to re-pin the dates, but it derives duration from a **Mon–Fri working-day count** that ignores the 7.6 h/day calendar and holidays. Those two facts are the leading drift candidates. Details and the exact open questions are in §4, §5, and §9.

---

## Section 1 — PO assignment fetch path

File: [src/services/projectOnline/assignments.ts](../../src/services/projectOnline/assignments.ts)

### Endpoints

Two fetch variants exist. The import path (Step 4) uses the per-project filtered one.

`fetchAssignments` — all assignments site-wide ([assignments.ts:4-6](../../src/services/projectOnline/assignments.ts#L4-L6)):

```ts
export async function fetchAssignments(siteUrl: string): Promise<PoAssignment[]> {
  return odataGetAll<PoAssignment>(siteUrl, '_api/ProjectData/Assignments?$format=json')
}
```

`fetchAssignmentsForProjects` — per-project, the one actually used in import ([assignments.ts:8-14](../../src/services/projectOnline/assignments.ts#L8-L14)):

```ts
export async function fetchAssignmentsForProjects(siteUrl: string, projects: PoProject[]): Promise<PoAssignment[]> {
  const rows = await Promise.all(projects.map(project =>
    odataGetAll<PoAssignment>(siteUrl, `_api/ProjectData/Assignments?$format=json&$filter=ProjectId eq guid'${cleanGuid(project.ProjectId)}'`)
      .catch(() => odataGetAll<PoAssignment>(siteUrl, `_api/ProjectData/Assignments?$format=json&$filter=ProjectId eq '${cleanGuid(project.ProjectId)}'`))
  ))
  return rows.flat()
}
```

OData URL template: `_api/ProjectData/Assignments?$format=json&$filter=ProjectId eq guid'<projectId>'` (with a bare-string `$filter` fallback on error).

### `$select` — NONE

**There is no `$select`.** The query returns the full default ProjectData `Assignments` entity shape. Every column the feed exposes is present on the raw row object, but the code only ever reads the handful declared on the `PoAssignment` type (see §2). All other columns — `AssignmentWork`, `AssignmentActualWork`, `AssignmentRemainingWork`, `AssignmentBaselineWork`, `AssignmentPercentWorkComplete`, `AssignmentDelay`, `AssignmentCost`, etc. — arrive in the JSON but are never referenced anywhere in the codebase.

### Raw OData response shape

Because there is no `$select` and no per-row logging, the **observed** field set cannot be enumerated from code alone — only the fields the code *consumes* are knowable. Those are (from the type and writer usage):

| Field | Consumed by code? | Notes |
|---|---|---|
| `AssignmentId` | yes — as `sourceId` fallback | string GUID |
| `ProjectId` | yes — grouping/filtering | string GUID |
| `TaskId` | yes — `taskIdMap` lookup | string GUID |
| `ResourceUID` | yes — team-member resolution | string GUID |
| `ResourceId` | yes — alias fallback | string GUID |
| `AssignmentStartDate` | **declared, never read** | — |
| `AssignmentFinishDate` | **declared, never read** | — |
| `AssignmentUnits` | **declared, never read by the writer** | scale unknown from code — see §9 Q1 |

> Note the type uses `AssignmentStartDate` / `AssignmentFinishDate` (see §2), **not** `AssignmentStart` / `AssignmentFinish`. The ProjectData OData feed's actual column names are not confirmed in code; if the real feed columns are `AssignmentStart`/`AssignmentFinish` these declared properties would always be `undefined`. Cannot be settled from code — see §9 Q5.

### Transformations during fetch

**None.** `fetchAssignmentsForProjects` returns `rows.flat()` with zero mapping, scaling, rounding, or unit conversion. Raw OData rows are cast directly to `PoAssignment` via the `odataGetAll<PoAssignment>` generic — no runtime transform exists.

---

## Section 2 — Internal type and state

### Type definition

File: [src/models/projectOnline.types.ts:58-68](../../src/models/projectOnline.types.ts#L58-L68)

```ts
export interface PoAssignment {
  AssignmentId?: string
  ProjectId: string
  TaskId: string
  ResourceUID: string
  ResourceId?: string
  AssignmentStartDate?: string
  AssignmentFinishDate?: string
  AssignmentUnits?: number
  [key: string]: unknown
}
```

The `[key: string]: unknown` index signature means every un-declared OData column survives on the object at runtime — but only the declared keys are statically reachable, and the writer reads none of the schedule-bearing ones.

### Flow through context

Populated: assignments enter `fetchedData` either from the PO fetch ([Step4Import/index.tsx:444-452](../../src/steps/Step4Import/index.tsx#L444-L452)) or from the file-upload parser ([fileImportService.ts:951-963](../../src/services/fileImportService.ts#L951-L963), field `assignments`). `PoFetchedData.assignments` is typed at [projectOnline.types.ts:130](../../src/models/projectOnline.types.ts#L130).

Context merge: [MigrationContext.tsx:263](../../src/app/MigrationContext.tsx#L263) merges `partial.assignments ?? prev.assignments` — pass-through, no transform.

Read for import: [Step4Import/index.tsx:386](../../src/steps/Step4Import/index.tsx#L386) (`importAssignments = selectedAssignments`), reassigned to the freshly-fetched array at [index.tsx:452](../../src/steps/Step4Import/index.tsx#L452), then filtered per project at [index.tsx:541](../../src/steps/Step4Import/index.tsx#L541) and handed to `writeAssignments` at [index.tsx:587-592](../../src/steps/Step4Import/index.tsx#L587-L592).

### Is Units preserved or normalized?

**Preserved as-is, then discarded.** `AssignmentUnits` is never scaled, normalized, or even read between fetch and the writer. The file-upload path sets it once from the Excel `Units` column ([fileImportService.ts:835](../../src/services/fileImportService.ts#L835), `AssignmentUnits: num(r['Units'])`) with no conversion. Since the writer never references the field, its scale is irrelevant to the current output — it has no effect on what is written.

---

## Section 3 — File upload assignment path

File: [src/services/fileImportService.ts](../../src/services/fileImportService.ts) (the `excelTemplate.ts` named in the brief does not exist — assignment parsing lives here).

### Parsing

Assignments sheet parsed at [fileImportService.ts:797-838](../../src/services/fileImportService.ts#L797-L838):

```ts
return {
  AssignmentId:    `a_${i}`,
  ProjectId:       pid,
  TaskId:          tid,
  ResourceUID:     rid,
  ResourceId:      rid,
  AssignmentUnits: num(r['Units']),
}
```

Columns are validated against `['ProjectId', 'TaskId', 'ResourceId']` (required) at [fileImportService.ts:194](../../src/services/fileImportService.ts#L194). `Units` is optional. Rows with unknown project/task/resource references are skipped with warnings ([index 804-827](../../src/services/fileImportService.ts#L804-L827)).

### Documented unit of the `Units` column

**Spec/template vs. code:** The generated template seeds `Units` with values `100` and `50` ([fileImportService.ts:53-57](../../src/services/fileImportService.ts#L53-L57)):

```ts
Assignments: [
  ['ProjectId', 'TaskId', 'ResourceId', 'Units'],
  ['P001', 'T002', 'R001', 100],
  ['P001', 'T002', 'R002',  50],
],
```

This implies a **0–100 percentage** convention to the template author. The code stores it verbatim via `num()` ([fileImportService.ts:330-334](../../src/services/fileImportService.ts#L330-L334)) — `100` stays `100`, `50` stays `50`. No `/100` scaling.

The `_Instructions` sheet does **not** document what `Units` means ([fileImportService.ts:84-130](../../src/services/fileImportService.ts#L84-L130) — the Units column is never explained). So the only signal of intended scale is the seeded example (0–100).

### Transformation between Excel value and `PoAssignment.Units`

**None** beyond `num()` (parseFloat). `100` → `100`. But again: irrelevant downstream, because the writer ignores `AssignmentUnits` entirely (§4).

### Work / Effort in the template

Confirmed: the Assignments sheet has **no** Work/Effort column — only `ProjectId, TaskId, ResourceId, Units`. Effort lives only on tasks (`DurationDays` → minutes, §5). Per the spec, only `Units` is in the assignment template — confirmed in code.

---

## Section 4 — Dataverse assignment write path

Files: [src/services/plannerPremium/assignmentWriter.ts](../../src/services/plannerPremium/assignmentWriter.ts), [src/services/plannerPremium/scheduleApi.ts](../../src/services/plannerPremium/scheduleApi.ts)

### The payload — what is actually sent

`writeAssignments` builds each op at [assignmentWriter.ts:169-191](../../src/services/plannerPremium/assignmentWriter.ts#L169-L191):

```ts
const ops = creatable.map(assignment => {
  const resourceKeys = getResourceKeys(assignment)
  const resourceUid = resourceKeys[0] ?? ''
  const sourceId = assignment.AssignmentId ?? `${assignment.TaskId}:${resourceUid}`
  const assignmentId = crypto.randomUUID()
  const taskId = taskIdMap[assignment.TaskId]
  const teamMemberId = resolveMappedId(
    teamMemberIdMap,
    resourceKeys.map(key => `${assignment.ProjectId}:${key}`),
  )
  return {
    id: sourceId,
    dvId: assignmentId,
    entity: {
      '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_resourceassignment',
      msdyn_resourceassignmentid: assignmentId,
      msdyn_name: sourceId,
      'msdyn_projectid@odata.bind': `/msdyn_projects(${projectId})`,
      'msdyn_taskid@odata.bind': `/msdyn_projecttasks(${taskId})`,
      'msdyn_projectteamid@odata.bind': `/msdyn_projectteams(${teamMemberId})`,
    } as Record<string, unknown>,
  }
})
```

Representative JSON sent to PSS per assignment:

```json
{
  "@odata.type": "Microsoft.Dynamics.CRM.msdyn_resourceassignment",
  "msdyn_resourceassignmentid": "<new-guid>",
  "msdyn_name": "<assignmentId or taskId:resourceUid>",
  "msdyn_projectid@odata.bind": "/msdyn_projects(<dvProjectId>)",
  "msdyn_taskid@odata.bind": "/msdyn_projecttasks(<dvTaskId>)",
  "msdyn_projectteamid@odata.bind": "/msdyn_projectteams(<teamMemberId>)"
}
```

### Action invoked

Assignments are queued through `queueScheduleCreate` → **`msdyn_PssCreateV1`** inside an OperationSet, executed via `executeOperationSetWithRetry` ([assignmentWriter.ts:194-198](../../src/services/plannerPremium/assignmentWriter.ts#L194-L198) → [scheduleApi.ts:74-147](../../src/services/plannerPremium/scheduleApi.ts#L74-L147) → [scheduleApi.ts:28-36](../../src/services/plannerPremium/scheduleApi.ts#L28-L36)):

```ts
export async function queueScheduleCreate(operationSetId, entity) {
  await performUnboundAction('msdyn_PssCreateV1', {
    Entity: entity,
    OperationSetId: operationSetId,
  })
}
```

Team members (a prerequisite, not the assignment itself) use `msdyn_CreateTeamMemberV1` ([assignmentWriter.ts:57-64](../../src/services/plannerPremium/assignmentWriter.ts#L57-L64)).

### `msdyn_*` fields populated on the assignment record

| Field | Set? | Value / unit |
|---|---|---|
| `msdyn_resourceassignmentid` | yes | client-generated GUID |
| `msdyn_name` | yes | source id string |
| `msdyn_projectid` (bind) | yes | project ref |
| `msdyn_taskid` (bind) | yes | task ref |
| `msdyn_projectteamid` (bind) | yes | team-member ref |
| `msdyn_effort` | **NO** | not set |
| `msdyn_plannedwork` | **NO** | not set |
| `msdyn_effortcompleted` / `msdyn_effortremaining` | **NO** | not set |
| `msdyn_units` / `msdyn_resourceunits` / `msdyn_unitsofmeasure` | **NO** | not set |
| `msdyn_plannedstart` / `msdyn_plannedend` | **NO** | not set |
| `msdyn_scheduledstart` / `msdyn_scheduledend` | **NO** | not set |
| `msdyn_resourcecategory` / `msdyn_committype` | **NO** | not set |

A repo-wide grep for `msdyn_units|msdyn_resourceunits|msdyn_unitsofmeasure|msdyn_plannedwork|msdyn_effortcompleted|msdyn_effortremaining|msdyn_committype|msdyn_resourcecategory|msdyn_efforttype` returned **zero matches anywhere in the codebase.** The assignment record carries only its relationships — no effort, no units, no dates.

**Consequence:** PSS receives a bare resource-on-task link and must invent every scheduling quantity from defaults. Under Fixed Effort, attaching a resource to a task with task-level `msdyn_effort` already set (see §5) makes the engine solve `Duration = Effort / (Units × hoursPerDay)` using its **default Units** (the PO units are not supplied). If the PO assignment was, e.g., 50 % and PSS defaults to 100 %, the engine halves the duration; if PO was >100 % it lengthens it — either way the dates move. This is the core mechanism the symptom describes ("only tasks WITH assignments drift").

### Does assignment creation re-schedule the task?

Yes — indirectly and by design of Fixed Effort. No `msdyn_effort` is PATCHed onto `msdyn_projecttask` at assignment time (the assignment op touches only the assignment entity). But the task already has `msdyn_effort` set at creation (§5), and the act of binding a resource triggers the engine's `Duration = Work / Units` recompute. The `correctTaskSchedule` pass (§5) exists precisely to undo this — its own header comment states it.

---

## Section 5 — Task write path (cross-check)

File: [src/services/plannerPremium/taskWriter.ts](../../src/services/plannerPremium/taskWriter.ts)

### Fields set at task creation

`buildTaskEntity` ([taskWriter.ts:525-545](../../src/services/plannerPremium/taskWriter.ts#L525-L545)):

```ts
return {
  '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_projecttask',
  msdyn_projecttaskid: taskId,
  'msdyn_project@odata.bind': `/msdyn_projects(${projectId})`,
  'msdyn_projectbucket@odata.bind': `/msdyn_projectbuckets(${bucketId})`,
  msdyn_subject: getTaskSubject(task),
  msdyn_scheduledstart: task.TaskStartDate,
  msdyn_scheduledend: task.TaskFinishDate,
  msdyn_start: task.TaskStartDate,
  msdyn_duration: getTaskDuration(task),
  ...(getTaskEffort(task) != null ? { msdyn_effort: getTaskEffort(task) } : {}),
  ...(getTaskProgress(task) != null ? { msdyn_progress: getTaskProgress(task) } : {}),
  ...(task.TaskOutlineLevel != null ? { msdyn_outlinelevel: task.TaskOutlineLevel } : {})
}
```

- **`msdyn_effort` IS set at task-creation time.** Value = `getTaskEffort(task)` ([taskWriter.ts:421-424](../../src/services/plannerPremium/taskWriter.ts#L421-L424)): `toMinutes(task.TaskWork)`, rounded to 2 decimals, `0` for milestones. **Unit: minutes** (`toMinutes` converts ISO `PT_H_M_S` durations and bare numbers to minutes, [taskWriter.ts:432-447](../../src/services/plannerPremium/taskWriter.ts#L432-L447)).
- **`msdyn_scheduledstart` / `msdyn_scheduledend` ARE set** at creation, directly from `task.TaskStartDate` / `task.TaskFinishDate` (date-only strings). Not left for PSS to compute.
- **`msdyn_start`** also set to `TaskStartDate`.
- **`msdyn_duration` IS set.** Value = `getTaskDuration(task)` ([taskWriter.ts:417-419](../../src/services/plannerPremium/taskWriter.ts#L417-L419)): `task.TaskDurationInMinutes` (**unit: minutes**), `0` for milestones. For file-upload, `TaskDurationInMinutes = DurationDays × 8 × 60` ([fileImportService.ts:757](../../src/services/fileImportService.ts#L757)) — note the hard-coded **8 h/day**, not the 7.6 h project calendar.

### Post-assignment task-update step — `correctTaskSchedule`

This runs **after** tasks + dependencies + assignments, only when the project has assignments ([Step4Import/index.tsx:585-602](../../src/steps/Step4Import/index.tsx#L585-L602)). Its purpose, per its own doc-comment ([taskWriter.ts:157-175](../../src/services/plannerPremium/taskWriter.ts#L157-L175)):

> Fixed Effort recomputes a task's duration when resources are assigned (Duration = Work / Units), shrinking it… This pass re-asserts each leaf task's original start AND duration via `msdyn_PssUpdateV1`, pinning them like a manual edit does in the UI.

The op it queues ([taskWriter.ts:205-213](../../src/services/plannerPremium/taskWriter.ts#L205-L213)):

```ts
await queueScheduleUpdate(opSetId, {
  '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_projecttask',
  msdyn_projecttaskid: taskIdMap[task.TaskId],
  msdyn_scheduledstart: task.TaskStartDate,
  msdyn_start: task.TaskStartDate,
  msdyn_duration: days,
})
```

where `days = workingDaysInclusive(task.TaskStartDate, task.TaskFinishDate)` ([taskWriter.ts:196](../../src/services/plannerPremium/taskWriter.ts#L196)).

**Two unit/semantic mismatches surface here:**

1. **`msdyn_duration` unit differs between the two write paths.** `buildTaskEntity` sends duration in **minutes** ([taskWriter.ts:540](../../src/services/plannerPremium/taskWriter.ts#L540), `TaskDurationInMinutes`). `correctTaskSchedule` sends duration as a **working-day count** ([taskWriter.ts:211](../../src/services/plannerPremium/taskWriter.ts#L211), `days`, e.g. `5`). One of these is using the wrong unit unless `msdyn_duration` is interpreted differently by `PssCreateV1` vs `PssUpdateV1` — see §9 Q3.

2. **`workingDaysInclusive` ignores the project calendar.** It counts Mon–Fri only, with no holiday awareness and no hours-per-day input ([taskWriter.ts:240-255](../../src/services/plannerPremium/taskWriter.ts#L240-L255)):

```ts
function workingDaysInclusive(start: string, finish: string): number {
  // ...
  while (cursor.getTime() <= f.getTime() && guard < 36500) {
    const day = cursor.getDay()
    if (day !== 0 && day !== 6) count++   // Mon–Fri only; no holidays, no 7.6h calendar
    cursor.setDate(cursor.getDate() + 1)
    guard++
  }
  return count
}
```

The target tenant calendar is 7.6 h/day **with holidays**. If the correction feeds a Mon–Fri day count to an engine that spreads duration across a holiday-aware 7.6 h calendar, the recomputed finish lands **later** than the imported finish — and the error accumulates with task length, matching the observed "sometimes 5+ days" drift. This is a leading candidate and is also flagged in §9 Q4.

`correctTaskSchedule` is **best-effort**: a failed OperationSet is abandoned and the engine-computed (drifted) values are left in place ([taskWriter.ts:220-234](../../src/services/plannerPremium/taskWriter.ts#L220-L234)). It also skips summary and milestone tasks and any task missing start/finish ([taskWriter.ts:187-197](../../src/services/plannerPremium/taskWriter.ts#L187-L197)).

---

## Section 6 — OperationSet ordering and dependencies

Orchestration: [Step4Import/index.tsx:510-611](../../src/steps/Step4Import/index.tsx#L510-L611), per project, inside a concurrency-limited loop.

Order per project:

1. `writeProjects` ([index.tsx:510](../../src/steps/Step4Import/index.tsx#L510)) — creates `msdyn_project` (sets `msdyn_schedulemode`, work-hour template, hours/day — see §7).
2. `writeTeamMembers` ([index.tsx:543](../../src/steps/Step4Import/index.tsx#L543)).
3. If `migrationScope.tasks`: `writeTasks` ([index.tsx:563](../../src/steps/Step4Import/index.tsx#L563)).
4. If `migrationScope.dependencies`: `writeDependencies` ([index.tsx:577](../../src/steps/Step4Import/index.tsx#L577)).
5. If `migrationScope.assignments` AND assignments exist: `writeAssignments` ([index.tsx:587](../../src/steps/Step4Import/index.tsx#L587)), **immediately followed by** `correctTaskSchedule` ([index.tsx:598](../../src/steps/Step4Import/index.tsx#L598)).

### Same OperationSet or separate?

**Separate OperationSets, separate Executes** — and many of them. There is no single project-wide OperationSet. Each writer chunks its work (180 per chunk, [assignmentWriter.ts:123](../../src/services/plannerPremium/assignmentWriter.ts#L123), [taskWriter.ts:77](../../src/services/plannerPremium/taskWriter.ts#L77), [dependencyWriter.ts:58](../../src/services/plannerPremium/dependencyWriter.ts#L58)) and calls `executeOperationSetWithRetry`, which creates a **fresh** OperationSet per attempt ([scheduleApi.ts:90-99](../../src/services/plannerPremium/scheduleApi.ts#L90-L99)):

```ts
opSetId = await createOperationSet(projectId, description)
for (const op of working) { await queueScheduleCreate(opSetId, op.entity) }
await executeOperationSet(opSetId)
```

Additionally, before any creation, `writeTasks` runs `clearSchedule` ([taskWriter.ts:60](../../src/services/plannerPremium/taskWriter.ts#L60), [477-505](../../src/services/plannerPremium/taskWriter.ts#L477-L505)) which deletes existing assignments, then dependencies, then tasks, each in its own OperationSet(s).

So a single project executes, in order: clear-assignments → clear-deps → clear-tasks → create-tasks (×rounds/chunks) → create-deps → create-assignments → correct-schedule. **Every Execute is a discrete PSS recalculation boundary.** Tasks are fully materialized and the engine has already scheduled them before assignments arrive — so the assignment-time Fixed-Effort recompute happens against committed dates, and only the final `correctTaskSchedule` Execute can repair it.

### Re-fetch / verification after Execute

Yes, partially. After task creation, `remapMaterializedTaskIds` ([taskWriter.ts:312-351](../../src/services/plannerPremium/taskWriter.ts#L312-L351)) polls `msdyn_projecttasks` (up to 5 attempts, 20 s apart — [taskWriter.ts:8-9](../../src/services/plannerPremium/taskWriter.ts#L8-L9), [353-371](../../src/services/plannerPremium/taskWriter.ts#L353-L371)) to reconcile client GUIDs against engine-materialized rows, matching on subject + `msdyn_scheduledstart` + `msdyn_scheduledend` + `msdyn_duration` ([taskWriter.ts:335-343](../../src/services/plannerPremium/taskWriter.ts#L335-L343)). This reads dates back but **only to map IDs** — it does not compare them against the imported schedule or flag drift. There is no verification read after assignment creation or after `correctTaskSchedule`; the correction results report the *intended* start/duration, not the engine's post-Execute values.

---

## Section 7 — PSS scheduling type / commitment configuration

Grep across the codebase for the requested strings:

| String | Found? | Where |
|---|---|---|
| `msdyn_schedulingmode` | **no** | — |
| `msdyn_committype` / `commitment` | **no** | — |
| `msdyn_effortdrivenmode` | **no** | — |
| `fixedeffort` / `fixed_effort` / `FixedEffort` | **no** (as identifiers) | only the human label `'Fixed Effort'` in `FALLBACK_SCHEDULE_MODES` |
| `msdyn_scheduledurationmode` | **no** | — |
| `msdyn_efforttype` | **no** | — |
| `msdyn_resourcecategory` | **no** | — |

What **does** exist is project-level schedule mode, set on the `msdyn_project` record at creation ([projectWriter.ts:114-116](../../src/services/plannerPremium/projectWriter.ts#L114-L116)):

```ts
if (settings.scheduleMode !== null) {
  projectPayload['msdyn_schedulemode'] = settings.scheduleMode
}
```

`settings.scheduleMode` resolves to one of the option-set values in [scheduleMode.ts:7-13](../../src/services/plannerPremium/scheduleMode.ts#L7-L13) (`Fixed Effort = 192350000`, etc.). The work-hour template and hours/day/week, days/month are also set on the project ([projectWriter.ts:106-113](../../src/services/plannerPremium/projectWriter.ts#L106-L113)).

**Conclusion:** Scheduling type is configured **only at the project level** (`msdyn_schedulemode`). There is **no per-task or per-assignment scheduling-type, effort-driven, or commitment-type configuration anywhere.** No `msdyn_committype` is ever set on assignments — PSS uses the tenant/entity default (see §9 Q2).

---

## Section 8 — Known observations and logged values

Logging in the scheduling/assignment path (no payload-level dumps exist for assignments):

| File:line | Level | Logs |
|---|---|---|
| [taskWriter.ts:484](../../src/services/plannerPremium/taskWriter.ts#L484) | info | `clearSchedule … deleting N assignment(s)` |
| [taskWriter.ts:493](../../src/services/plannerPremium/taskWriter.ts#L493) | info | `clearSchedule … deleting N dependenc(ies)` |
| [taskWriter.ts:502](../../src/services/plannerPremium/taskWriter.ts#L502) | info | `clearSchedule … deleting N task(s)` |
| [taskWriter.ts:83](../../src/services/plannerPremium/taskWriter.ts#L83) | warn | outline-level normalization warnings |
| [taskWriter.ts:222](../../src/services/plannerPremium/taskWriter.ts#L222) | warn | `schedule correction batch failed (N task(s)): <error>` |
| [scheduleApi.ts:107](../../src/services/plannerPremium/scheduleApi.ts#L107) | warn | `OperationSet attempt N failed (… class=… failedIndex=…): <raw error 500 chars>` |
| [scheduleApi.ts:117](../../src/services/plannerPremium/scheduleApi.ts#L117) | warn | systemic-failure bail message |
| [dependencyWriter.ts:138](../../src/services/plannerPremium/dependencyWriter.ts#L138) | warn | `N dependency op(s) failed with lag set — retrying once without lag` |
| [dependencyWriter.ts:154](../../src/services/plannerPremium/dependencyWriter.ts#L154) | warn | `N dependency(ies) created without lag — dates of those successors may shift` |
| [scheduleMode.ts:36,39](../../src/services/plannerPremium/scheduleMode.ts#L36-L39) | warn | option-set fetch fallback |

UI-level per-row logs (via `appendLog`, written to the Step 4 log panel, not console):
- Assignment OK/SKIP: [Step4Import/index.tsx:590](../../src/steps/Step4Import/index.tsx#L590).
- Schedule-correction line **does** surface the corrected start + day-count: [Step4Import/index.tsx:600](../../src/steps/Step4Import/index.tsx#L600) — `schedule <taskId> → <start> <days>d`. This is the single most useful existing runtime artifact: it shows what the correction *intended*, which can be diffed against the engine's actual post-import dates.

**No log anywhere captures:** the assignment OperationSet payload, the PSS create/update response body, or the engine's recomputed task dates after Execute. Runtime evidence of the actual drift is **not** currently captured — only the intended correction values are.

---

## Section 9 — Open questions for the author

1. **PO `AssignmentUnits` scale.** The field is fetched and (in file-upload) seeded as 0–100 (`100`, `50`), but the writer reads it **not at all** — no `msdyn_units`/`msdyn_resourceunits` is sent. Is the intended fix to write units (and at what scale: PSS `msdyn_units` is conventionally 0–100, but confirm against the tenant), and what is the actual ProjectData scale (0–1 decimal vs 0–100)? Until units are written, PSS uses its default and Fixed Effort re-derives duration — the prime suspect.

2. **No `msdyn_committype` / scheduling-type on assignments.** Confirm the tenant default for assignment commitment/effort-driven behavior. With nothing set, does PSS treat the assignment as effort-driven against the project's `msdyn_schedulemode`, and is that the behavior we want?

3. **`msdyn_duration` unit mismatch between create and correct.** `buildTaskEntity` sends `msdyn_duration` in **minutes** ([taskWriter.ts:540](../../src/services/plannerPremium/taskWriter.ts#L540)); `correctTaskSchedule` sends it as a **working-day count** ([taskWriter.ts:211](../../src/services/plannerPremium/taskWriter.ts#L211)). Does `PssCreateV1` vs `PssUpdateV1` interpret `msdyn_duration` in different units, or is one of these wrong? If both are minutes-expected, the correction pass is feeding a day-count (e.g. `5`) where minutes are expected and collapsing task durations to near-zero.

4. **`correctTaskSchedule` ignores the project calendar.** Its day count is Mon–Fri only, no holidays, no 7.6 h/day ([taskWriter.ts:240-255](../../src/services/plannerPremium/taskWriter.ts#L240-L255)). The target calendar is 7.6 h/day with holidays. Should duration be derived from the work-hour template (hours/day, holidays) instead of a raw weekday count? This is a leading candidate for the 5+ day drift independent of the units issue.

5. **OData field names.** The type declares `AssignmentStartDate` / `AssignmentFinishDate` / `AssignmentUnits`. Confirm these match the real ProjectData `Assignments` column names (the feed may expose `AssignmentStart` / `AssignmentFinish` / `AssignmentUnits` differently). If the names are wrong, the declared properties are always `undefined` and any future writer reading them would silently get nothing.

6. **Task `msdyn_effort` (minutes) vs assignment units interaction.** `msdyn_effort` is set on the task at creation ([taskWriter.ts:541](../../src/services/plannerPremium/taskWriter.ts#L541)) and never on the assignment. Under Fixed Effort, which value drives the recompute when a resource is bound, and does the imported task duration (8 h/day basis at [fileImportService.ts:757](../../src/services/fileImportService.ts#L757)) stay consistent with the project's 7.6 h/day calendar? The 8-vs-7.6 hours/day discrepancy is itself a fractional-day drift source per task.

7. **No post-Execute verification of dates.** Nothing reads back the engine's actual scheduled dates after assignment creation or after correction to confirm the import landed on the imported schedule. Should a verification + re-correction loop be added so drift is detected rather than silently shipped?
