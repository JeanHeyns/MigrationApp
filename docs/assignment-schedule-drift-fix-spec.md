# Fix Spec: Assignment Schedule Drift

> **Document type:** Implementation specification for Claude Code
> **Target codebase:** Project Online Migrator (React + TypeScript + Power Apps Code App)
> **Status:** Ready for implementation
> **Related:** `assignment-drift-audit.md` (diagnostic), `import-resilience-spec.md` (orthogonal)
> **Suggested location in repo:** `docs/fixes/assignment-schedule-drift-fix-spec.md`

---

## 1. Context & probleem

Tasks zonder assignments migreren correct. Tasks **met** assignments drijven 5+ dagen af. Diagnostiek (`docs/diagnostics/assignment-drift-audit.md`) toonde vier samenwerkende root causes:

| # | Root cause | Locatie |
|---|---|---|
| RC1 | `msdyn_duration` op task wordt in **minuten** geschreven, terwijl het veld per MS docs in **dagen** wordt geïnterpreteerd | `taskWriter.ts:540` (`buildTaskEntity`) |
| RC2 | `correctTaskSchedule` stuurt dagen, maar werkdag-count negeert holidays en hours-per-day calendar | `taskWriter.ts:211`, `240-255` (`workingDaysInclusive`) |
| RC3 | Assignment writer stuurt **geen** scheduling velden — geen `msdyn_plannedwork` contour | `assignmentWriter.ts:169-191` |
| RC4 | File-upload loader rekent `DurationDays × 8 × 60` met hardcoded 8u/dag terwijl tenant 7,6u/dag gebruikt | `fileImportService.ts:757` |

### Microsoft docs (PSA 3.x / Project Operations / Planner Premium share PSS engine)

- `msdyn_duration` — *"Shows the duration in days for the task"*, `dataFormat: double`
- `msdyn_scheduleddurationminutes` — *"Shows the scheduled duration of the project task, specified in minutes"*, `dataFormat: int32` (read-only, PSS-computed)
- `msdyn_effort` — submitted hours (double)
- `msdyn_plannedwork` — *"Serialized planned work schedule for assigned resource"*, JSON contour per slice: `[{"Start":"/Date(<unix-ms>)/", "End":"/Date(<unix-ms>)/", "Hours":<number>}, ...]`
- **Assignment unit is deprecated in PSA 3.x**: task effort hours are divided equally per day among assigned resources. Het contract is dus niet "stuur units mee", maar "stuur per-dag hours mee via plannedwork".

### Doel

Migrator import moet eindigen met **dezelfde** task dates als de bron (PO of Excel), zonder drift, ongeacht of een task assignments heeft.

### Niet-doelen (deze spec)

- Refactor van OperationSet ordering (huidige clear→tasks→deps→assignments→correct blijft)
- Custom-field migratie op tasks (out of scope per bestaande beslissing)
- Resource calendars (we gebruiken alleen project calendar)
- Multi-resource effort splitsing per resource — we leveren ruwe schedule contours per assignment; PSS lost effort-deling op

---

## 2. Scope

### In scope

- **RC1 fix**: `msdyn_duration` correct in dagen schrijven bij task creation
- **RC2 fix**: `correctTaskSchedule` werkdag-count vervangen door calendar-aware count (holidays + working days uit project calendar)
- **RC3 fix**: `msdyn_plannedwork` contour genereren en meesturen bij elke assignment
- **RC4 fix**: Hardcoded 8u/dag in `fileImportService.ts` vervangen door de configured `hoursPerDay` van het project (via working-time spec)
- Diagnostiek toevoegen: log assignment payload + correctie payload met alle relevante velden voor post-hoc verificatie
- Tests: deterministische voorbeelden waar input-schedule output-schedule moet zijn

### Out of scope

- `msdyn_units` / `msdyn_resourceunits` schrijven — deprecated per PSA 3.x
- Resource-level calendars (we nemen alleen project calendar in rekening)
- Auto-detectie van mismatch tussen PO calendar en target calendar (zou een aparte audit zijn)
- `msdyn_scheduleddurationminutes` zelf schrijven — read-only, PSS-computed

---

## 3. Architecturale beslissingen

| Beslissing | Keuze | Reden |
|---|---|---|
| `msdyn_duration` unit | **Days** (zoals docs voorschrijven) | Officiële MS docs; consistent met UI |
| Werkdag-count input | Project working time settings (hoursPerDay, hoursPerWeek) + holidays uit project calendar | Tenant gebruikt 7,6/38; mag nooit hardcoded 8/40/Mon-Fri |
| Holiday-bron | `msdyn_calendarrules` van project's `msdyn_calendarid` | Single source of truth; al gezet bij project creatie |
| `msdyn_plannedwork` semantiek | Eén contour per assignment, met per-werkdag de uren conform calendar | Volgt PSS 3.x contract |
| `msdyn_plannedwork` hours-per-day bron | `project.msdyn_hoursperday` (uit working-time spec, default 7,6) | Project calendar is leidend |
| PO `AssignmentUnits` interpretatie | Gebruikt als allocation factor: `slice.Hours = hoursPerDay × (units/100)` | Backwards compat met PO Units percentage |
| Multi-resource op één task | Elke assignment krijgt eigen contour; PSS verdeelt effort | PSA 3.x default |
| Contour granulariteit | Per kalenderdag (geen sub-day slicing) | Voldoende voor migratie; sub-day = scope creep |
| Wat te doen bij PO Units = null | Default naar 100% (`hoursPerDay`) | Matched PO default gedrag |
| Wat te doen bij PO Units > 100 | Cap op 100% met warning | Voorkomt onrealistische capacity allocation; user kan post-migratie aanpassen |
| Fase 1 vs 2 split | Fase 1 = RC1+RC2+RC4 (taak-side). Fase 2 = RC3 (plannedwork). | Validatie tussen fases; fase 1 alleen lost al een groot deel op |
| Backwards compat | Geen schema wijziging; pure write-path correctie | Geen impact op dataOnly mode (resolvers blijven gelijk) |

---

## 4. Wijzigingen per fase

### Fase 1 — Task duration & correctie (RC1, RC2, RC4)

#### 4.1 `taskWriter.ts` — `buildTaskEntity` (RC1)

**Huidig** ([taskWriter.ts:525-545]):
```ts
msdyn_duration: getTaskDuration(task),  // minutes
```

**Nieuw**:
```ts
msdyn_duration: getTaskDurationDays(task, projectSettings),  // days (double)
```

Nieuwe helper:
```ts
/**
 * Returns the task duration in *days* as PSS expects on msdyn_duration.
 * Per MS docs: "Shows the duration in days for the task" (double).
 *
 * msdyn_scheduleddurationminutes is *read-only* and computed by PSS — we never
 * write it. Setting msdyn_duration here in the correct unit prevents PSS from
 * back-computing a wrong day-count from the (formerly mis-encoded) value.
 */
function getTaskDurationDays(task: PoTask, settings: ProjectSettings): number {
  if (task.IsMilestone) return 0
  const minutes = toMinutes(task.TaskWork ?? task.TaskDurationInMinutes ?? 0)
  const hoursPerDay = settings.hoursPerDay ?? 7.6
  return round2(minutes / 60 / hoursPerDay)
}
```

Behoud `getTaskDuration` voor compat in andere paden, maar markeer deprecated met JSDoc.

**Verifiëren post-fix**: een task die in PO 5 dagen / 38 uur is, moet in Dataverse `msdyn_duration = 5.0` hebben (niet 2280, niet 12000).

#### 4.2 `taskWriter.ts` — `correctTaskSchedule` (RC2)

**Huidig** ([taskWriter.ts:196, 211, 240-255]):
```ts
const days = workingDaysInclusive(task.TaskStartDate, task.TaskFinishDate)
// ...
await queueScheduleUpdate(opSetId, {
  // ...
  msdyn_duration: days,  // already correct unit (days), but day-count is wrong
})

function workingDaysInclusive(start, finish): number {
  // Mon-Fri only, no holidays, no calendar awareness
}
```

**Nieuw**: vervang `workingDaysInclusive` door `calendarWorkingDaysInclusive`:
```ts
/**
 * Counts working days between start and finish (both inclusive),
 * honoring the project calendar's working days and holidays.
 *
 * @param start ISO date string (YYYY-MM-DD)
 * @param finish ISO date string
 * @param calendar working-day + holiday spec from the project's msdyn_calendar
 */
function calendarWorkingDaysInclusive(
  start: string,
  finish: string,
  calendar: ProjectCalendar
): number {
  // 1. Parse dates, walk day by day
  // 2. Skip non-working weekdays per calendar.workingDayMask (e.g. Mon-Fri)
  // 3. Skip dates in calendar.holidays (Set<string> of 'YYYY-MM-DD')
  // 4. Return count
}

interface ProjectCalendar {
  /** Bitmask of working weekdays (e.g. 0b0111110 = Mon-Fri). Bit 0 = Sunday. */
  workingDayMask: number
  /** Set of YYYY-MM-DD strings of non-working days */
  holidays: Set<string>
  /** Effective hours per working day (e.g. 7.6) */
  hoursPerDay: number
}
```

Calendar ophalen: één keer per project bij start van `writeTasks` / `correctTaskSchedule`, via een nieuwe service `services/plannerPremium/calendarReader.ts`:

```ts
/**
 * Reads the project's calendar (working days + holidays) from msdyn_calendar
 * and its msdyn_calendarrules. Cached per project for the duration of the
 * migration run.
 */
export async function readProjectCalendar(projectId: string): Promise<ProjectCalendar>
```

Implementatie:
1. Fetch `msdyn_projects(<projectId>)?$select=msdyn_calendarid` → calendar GUID
2. Fetch `msdyn_calendars(<calendarId>)` → base working-day mask (read from calendar rules)
3. Fetch `msdyn_calendarrules?$filter=_msdyn_calendar_value eq <calendarId> and msdyn_isnonworking eq true` → holiday list
4. Cache in module-level `Map<projectId, ProjectCalendar>` for the run

**Fallback** indien calendar niet bereikbaar: log warning, gebruik `{ workingDayMask: 0b0111110, holidays: new Set(), hoursPerDay: settings.hoursPerDay ?? 7.6 }`. Beter dan crashen, maar log expliciet zodat we het zien.

**Verifiëren**: een task van 1 jul → 15 jul (10 werkdagen + 1 feestdag op 14 jul) → `days = 9`, niet 10.

#### 4.3 `fileImportService.ts:757` — TaskDurationInMinutes (RC4)

**Huidig**:
```ts
TaskDurationInMinutes: num(r['DurationDays']) * 8 * 60,  // hardcoded 8h
```

**Nieuw**: parameteriseer via working-time settings die je in Step 1 al verzamelt:
```ts
TaskDurationInMinutes: num(r['DurationDays']) * (settings.hoursPerDay ?? 7.6) * 60,
```

Vereist dat `parseExcelTemplate` toegang krijgt tot `MigrationState.workingTime`. Twee opties:

1. **Pass-through**: `parseExcelTemplate(file, { hoursPerDay })` — kleinste change. Aanbevolen.
2. **Two-phase**: parse zonder duration berekening; bereken duration in een latere stap die wel context heeft. Veel groter.

Kies optie 1. Update call site in Step1Connect om `state.workingTime.hoursPerDay` mee te geven.

#### 4.4 Diagnostiek — logging

Voeg structured logs toe op write-time, bewaard in `MigrationState.logs`:

```ts
// In taskWriter.buildTaskEntity, na de payload constructie:
log('debug', `task ${task.TaskId} payload`, {
  msdyn_duration_days: entity.msdyn_duration,
  msdyn_effort_minutes: entity.msdyn_effort,
  msdyn_scheduledstart: entity.msdyn_scheduledstart,
  msdyn_scheduledend: entity.msdyn_scheduledend,
  source_durationMinutes: task.TaskDurationInMinutes,
  source_work: task.TaskWork,
})

// In correctTaskSchedule, na elk payload:
log('debug', `task ${task.TaskId} correction`, {
  intended_start: task.TaskStartDate,
  intended_finish: task.TaskFinishDate,
  calendar_days: days,
  holidays_in_range: <count>,
})
```

Gate achter `localStorage.DEBUG_SCHEDULE = '1'` zodat het niet altijd vol logt.

#### 4.5 Acceptatiecriteria Fase 1

- ✅ Task zonder assignments: `msdyn_duration` = exact dagen (5,0 voor 5-daagse task)
- ✅ `msdyn_scheduledstart` / `msdyn_scheduledend` van geïmporteerde task matched PO source (date-only vergelijking)
- ✅ Task die over één feestdag loopt: PSS computed `msdyn_scheduleddurationminutes` matched verwachting (5 dagen × 7,6u × 60 voor 5 effectieve werkdagen)
- ✅ File-upload mode: task van 5 DurationDays krijgt `TaskDurationInMinutes = 5 × 7,6 × 60 = 2280`, niet 2400
- ✅ Bestaande tests blijven groen
- ✅ Geen regressie in dataOnly/schemaOnly modes

### Fase 2 — Assignment plannedwork contour (RC3)

#### 4.6 `assignmentWriter.ts` — payload uitbreiden

**Huidig** payload ([assignmentWriter.ts:180-189]):
```ts
{
  '@odata.type': 'Microsoft.Dynamics.CRM.msdyn_resourceassignment',
  msdyn_resourceassignmentid: assignmentId,
  msdyn_name: sourceId,
  'msdyn_projectid@odata.bind': `/msdyn_projects(${projectId})`,
  'msdyn_taskid@odata.bind': `/msdyn_projecttasks(${taskId})`,
  'msdyn_projectteamid@odata.bind': `/msdyn_projectteams(${teamMemberId})`,
}
```

**Nieuw**:
```ts
{
  // ... bestaande velden ...
  msdyn_plannedwork: serializePlannedWork(contour),
}
```

Waarbij `contour` voor deze assignment wordt opgebouwd uit:
- Task's start/finish (PO source)
- Project calendar (working days + holidays)
- Resource allocation factor uit `assignment.AssignmentUnits` (0-100 → 0-1)
- Project's hoursPerDay

#### 4.7 Nieuwe service: `assignmentContour.ts`

`src/services/plannerPremium/assignmentContour.ts`:

```ts
export interface ContourSlice {
  Start: string  // "/Date(<unix-ms>)/"
  End: string    // "/Date(<unix-ms>)/"
  Hours: number
}

/**
 * Generates a per-day work contour for one assignment, honoring the project
 * calendar (working days + holidays) and the resource's allocation percentage.
 *
 * Format matches PSA 3.x msdyn_plannedwork:
 * [
 *   { "Start": "/Date(1543856400000)/", "End": "/Date(1543885200000)/", "Hours": 7.6 },
 *   ...
 * ]
 *
 * @param task source task with start/finish + work hours
 * @param assignment source assignment with Units (0-100, defaults to 100)
 * @param calendar project calendar
 */
export function buildAssignmentContour(
  task: PoTask,
  assignment: PoAssignment,
  calendar: ProjectCalendar
): ContourSlice[] {
  const start = parseISODate(task.TaskStartDate)
  const finish = parseISODate(task.TaskFinishDate)
  const units = clamp((assignment.AssignmentUnits ?? 100) / 100, 0, 1)
  const hoursPerDay = calendar.hoursPerDay * units

  const slices: ContourSlice[] = []
  for (const date of iterateWorkingDays(start, finish, calendar)) {
    // Day's working window in the project's timezone:
    // Use 09:00 → 09:00 + hoursPerDay (simple front-load).
    // PSA docs show this pattern; sub-day precision not migration-critical.
    const workStart = new Date(date)
    workStart.setHours(9, 0, 0, 0)
    const workEnd = new Date(workStart.getTime() + hoursPerDay * 3600_000)

    slices.push({
      Start: toMsDate(workStart),
      End: toMsDate(workEnd),
      Hours: round2(hoursPerDay),
    })
  }
  return slices
}

export function serializePlannedWork(contour: ContourSlice[]): string {
  return JSON.stringify(contour)
}

function toMsDate(d: Date): string {
  return `/Date(${d.getTime()})/`
}
```

**Edge cases**:
- Task zonder finish date → gebruik `start + 1 working day`
- Task duration < 1 dag → één slice met fractie van hoursPerDay
- Milestone (`IsMilestone: true`) → leeg contour (`[]`), of helemaal geen `msdyn_plannedwork` veld. Aanbeveling: laat veld weg voor milestones.
- Units > 100 → cap op 100, log warning per assignment
- Units = 0 of negatief → skip met warning (geen sensible contour)

#### 4.8 Interactie met `correctTaskSchedule`

`correctTaskSchedule` blijft draaien, **maar** moet nu mogelijk niet meer nodig zijn omdat de contour PSS exact vertelt wanneer er gewerkt wordt. Twee opties:

1. **Keep**: correctie blijft als safety net. Goedkoop, geen extra risico.
2. **Conditional skip**: skip correctie als alle assignments een contour kregen.

**Aanbeveling**: optie 1 voor deze release. We laten beide actief en kijken in fase 2 testing of de correctie überhaupt nog wijzigingen oplevert. Logging in §4.4 maakt zichtbaar of de correctie nog impact heeft.

#### 4.9 Diagnostiek

Per assignment, gate-d achter `DEBUG_SCHEDULE`:
```ts
log('debug', `assignment ${sourceId} contour`, {
  taskId: task.TaskId,
  units: assignment.AssignmentUnits,
  slices: contour.length,
  totalHours: contour.reduce((sum, s) => sum + s.Hours, 0),
  firstSlice: contour[0],
  lastSlice: contour[contour.length - 1],
})
```

#### 4.10 Acceptatiecriteria Fase 2

- ✅ Task **met** assignment: dates matchen PO source (zelfde criterium als fase 1, maar nu mét assignment in beeld)
- ✅ Multi-resource task: beide assignments krijgen eigen `msdyn_plannedwork`; PSS-berekende task `msdyn_scheduleddurationminutes` matched bron
- ✅ Assignment met PO Units = 50: contour heeft `Hours = 3.8` per slice (50% van 7,6)
- ✅ Assignment zonder Units: contour heeft `Hours = 7.6` per slice (100% default)
- ✅ Task die over feestdag loopt: contour heeft géén slice op feestdag, totaal aantal slices = werkdagen
- ✅ Geen functionele regressie in dataOnly/schemaOnly modes (al doet schemaOnly geen data writes)

---

## 5. Edge cases & gotchas

### 5.1 Project zonder ingestelde calendar
Fallback: `workingDayMask = 0b0111110` (Mon-Fri), `holidays = empty`, `hoursPerDay = settings.hoursPerDay`. Warning loggen.

### 5.2 Calendar bestaat maar geen calendar rules
Tenant default. Zelfde fallback als 5.1 — geen holidays.

### 5.3 PSA 3.x docs vs Project Operations / Planner Premium
Docs gevonden zijn PSA 3.x. PSS engine wordt gedeeld tussen PSA en Project Operations / Planner Premium. **Risico**: niet 100% gegarandeerd identiek. **Mitigatie**: fase 1 testen vóór fase 2 zodat we weten welke fix welke impact heeft.

### 5.4 PSS recompute na contour write
Het is mogelijk dat PSS de contour herrekent op het moment van Execute, en de geleverde contour overschrijft. Als dat zo blijkt: log de post-Execute contour terug uit Dataverse (extra verificatie-stap) en pas aan.

### 5.5 `msdyn_plannedwork` is gigantisch op lange tasks
Een task van 200 werkdagen → 200 contour slices → grote JSON string per assignment. PSA docs zeggen max 1_048_576 chars op het veld; 200 slices × ~120 chars = 24 KB, ruim binnen limiet. Tasks > 1000 dagen: nog steeds OK.

### 5.6 Tijdzones
Contour timestamps zijn Unix ms (UTC). Een werkdag van 09:00 in Europe/Brussels = 08:00 UTC in winter, 07:00 UTC in zomer. Voor migratie is sub-day precisie onbelangrijk; PSS gebruikt de project calendar timezone. **Aanbeveling**: bouw timestamps in UTC met "9 AM local time" als simpele heuristiek; vermijd DST-edge cases door geen sub-hour precisie te gebruiken.

### 5.7 Multi-resource task: contour overlap
Twee resources op één task: elk krijgt eigen contour, beide tellen vol mee in PSS' effort calc. Per PSA 3.x docs: PSS verdeelt task effort gelijk over assignments. **Gevolg**: de Units uit PO worden in feite genegeerd door PSS (en zijn deprecated). Onze contour-hoogtes (`Hours per slice`) zijn dus eerder een advies dan een hard contract. **Beslissing**: lever de contour conform Units uit PO; als PSS het overschrijft is dat acceptabel.

### 5.8 Tasks zonder finish date in PO
Komt zelden voor maar mogelijk. Skip met warning of gebruik `start + duration` als fallback.

### 5.9 Resource niet beschikbaar op werkdagen in slice range
Out of scope. Migrator schrijft contour op basis van project calendar. Resource calendar discrepanties los je post-migratie op.

### 5.10 Hot-reload calendar tijdens migratie
Calendar wordt eenmalig per project gelezen aan het begin van `writeTasks`. Als de klant tijdens migratie de calendar wijzigt, krijg je inconsistente results. **Beslissing**: niet ondersteunen; documenteer in de UI.

---

## 6. Implementatie volgorde

### Fase 1 (RC1 + RC2 + RC4)

1. **`calendarReader.ts`** — nieuwe service, working-day mask + holidays per project. Cached.
2. **`getTaskDurationDays`** helper in taskWriter; vervang `msdyn_duration` value in `buildTaskEntity`.
3. **`calendarWorkingDaysInclusive`** vervangt `workingDaysInclusive` in `correctTaskSchedule`.
4. **`fileImportService.ts:757`** — `hoursPerDay` parameter doorgeven via `parseExcelTemplate`.
5. **Diagnostiek logs** — gate-d achter `DEBUG_SCHEDULE`.
6. **End-to-end test fase 1**: importeer test-project, vergelijk dates. Verwachting: tasks zonder assignment kloppen, tasks met assignment hebben mogelijk nog drift maar minder.

**Geschatte effort**: 0,5-1 dag.

### Fase 2 (RC3)

7. **`assignmentContour.ts`** — contour generator + serializer.
8. **`assignmentWriter.ts`** — payload uitbreiden met `msdyn_plannedwork`.
9. **Diagnostiek logs** voor contour.
10. **End-to-end test fase 2**: zelfde test-project, nu met assignments. Verwachting: drift weg.
11. **Beslissing over correctTaskSchedule**: laten staan of conditioneel skippen op basis van fase 2 resultaten.

**Geschatte effort**: 1 dag.

### Tests

12. Unit tests voor `calendarWorkingDaysInclusive` met edge cases (single day, weekend, holiday in range, holiday op start, holiday op finish).
13. Unit tests voor `buildAssignmentContour` met edge cases (1 dag, met feestdag, units = 50, units = 0).
14. Integratietest: PO snapshot → write naar dev tenant → readback dates → assert.

### Rollout

15. Deploy naar `dev-jehe.crm4.dynamics.com`.
16. Export solution → import bij klant acc tenant → migreer testset.
17. Vergelijk source PO dates met target PfW dates row-by-row.
18. Bij succes: documenteer in `migrator-project-context.md`.

---

## 7. Open vragen voor implementatie

1. **Calendar API beschikbaar?** Verifieer dat `msdyn_calendars` en `msdyn_calendarrules` queryable zijn via standaard Web API (geen custom action nodig). Quick test: `GET .../msdyn_calendars` op dev tenant.

2. **Working-day mask in `msdyn_calendar`**: hoe wordt dit gerepresenteerd? Mogelijk als individuele rules per dag. Verifieer schema voor migratie.

3. **PSS rounding**: als we `msdyn_duration = 0.4` schrijven (3 uur op 7,6), wat doet PSS? Rondt het af? Onmisbaar? Quick test in dev.

4. **`msdyn_plannedwork` schema in jouw target tenant**: bevestig dat het veld bestaat en writeable is via metadata API. Niet alle PSS tenants exposen alles.

5. **Holiday detection precisie**: `msdyn_calendarrules` met `msdyn_isnonworking = true`, of via een ander field? Dev tenant raadplegen.

6. **Conditional skip `correctTaskSchedule`**: na fase 2, als correctie geen wijzigingen meer levert, optie 2 (skip) wordt aantrekkelijker. Beslissing uitstellen tot fase 2 testresultaten.

---

## 8. Definition of Done

- Fase 1 + fase 2 geïmplementeerd
- Unit tests + integratietest groen
- Test-migratie in acc tenant: tasks WITH assignments matchen source dates ±1 dag (was 5+)
- Geen regressie in tasks WITHOUT assignments
- Geen regressie in dataOnly / schemaOnly modes
- Diagnostiek logs werken; debug toggle gedocumenteerd in `migrator-project-context.md`
- Spec archivered, learnings toegevoegd aan project context
