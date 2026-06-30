# Handover: Assignment schedule drift — Project Online Migrator

**Datum:** 18 juni 2026
**Status:** Open, escalatie naar collega gewenst
**Repo:** github.com/JeanHeyns/MigrationApp
**Test omgeving:** plannerpremiumacc.crm4.dynamics.com (klant acc tenant)

---

## 1. Het probleem in één zin

Na migratie van een project van Project Online naar Planner Premium (Dataverse / Project for the Web) kloppen de schedules niet meer: tasks met assignments krijgen verkeerde start- en finishdatums. Soms enkele dagen, soms (zoals nu) jaren afwijking op het project-niveau.

---

## 2. Wat al gefixt is en werkt

Vier root causes geïdentificeerd uit eerdere audit (`docs/diagnostics/assignment-drift-audit.md`) en geïmplementeerd:

| # | Fix | Status |
|---|---|---|
| RC1 | `msdyn_duration` op task in dagen geschreven (was minuten) per MS docs | Geïmplementeerd |
| RC2 | `correctTaskSchedule` gebruikt project calendar voor werkdag-count (was Mon-Fri only) | Geïmplementeerd |
| RC3 | Eerder geprobeerd: `msdyn_plannedwork` in PssCreate payload meegeven — **gaf ScheduleAPI-AV-0001 error, niet toegestaan**. Weer verwijderd. | Reverted |
| RC4 | File-upload: `DurationDays × hoursPerDay × 60` (was hardcoded 8h) | Geïmplementeerd |

Resultaat: assignments lopen zonder errors, drift is kleiner dan voorheen, maar **nog niet weg**.

---

## 3. Wat we hebben gemeten (concrete data)

Een diagnostic-export bouwt een JSON met side-by-side source vs target waarden voor elk gemigreerd project, plus alle assignments, resources en hun contours. Code in `services/diagnostics/scheduleDiagnostic.ts`, knop in Step 5.

Twee testprojecten gemigreerd (dataOnly mode):

### Project 1 — bron Fixed Duration

```
Source:   2020-11-16 → 2024-02-12   (3 jaar 3 maanden)
Target:   2020-11-16 → 2029-01-23   (8 jaar 2 maanden)
Drift:    +1807 dagen op project finish
```

Per task: drift verschilt, sommige correct, sommige sterk verschoven. Schedule mode op target staat correct op "Vaste duur" (Fixed Duration).

PSS heeft 50 assignments aangemaakt met eigen `msdyn_plannedwork` contours. Voorbeeld: één resource (Veraart Bianca) heeft een contour van **54 slices van elk 0,28 uur per dag = 17 minuten**, gespreid over 2,5 maand. Totaal: 15 uur effort.

Andere assignments idem dito — kleine fracties, gespreid uit. PSS lijkt onder Fixed Duration effort te "smeren" over wat het beschouwt als de beschikbare duration. Maar dat verlengt de duration verder doordat task-finishes naar achteren schuiven.

Totaal effort over alle 50 assignments: **1905,68 uur**, exact wat het project `msdyn_effort` zegt (1935,68 minus 30 voltooid). Effort klopt dus, alleen de spreiding niet.

### Project 2 — bron Fixed Effort

```
Source:   2027-01-12 → 2031-03-11
Target:   2027-01-12 → 2031-03-11
Drift:    0 dagen — exact correct
```

Zelfde diagnostic-export. PSS heeft hier contours per assignment van **2-3 slices met realistische uren** (3,95u + 3,55u = 7,5u). Geconcentreerde werkblokken, niet versmeerd.

Totaal effort over 49 assignments: **811,45 uur**, exact `msdyn_effort` van het project.

### Conclusie uit de data

Met Fixed Effort werkt de migratie volledig correct. Met Fixed Duration faalt het catastrofaal. PSS-gedrag onder de twee modes verschilt fundamenteel: Fixed Effort respecteert dates, Fixed Duration herrekent ze.

---

## 4. Wat we al hebben uitgesloten

**Hypothese A: resource calendar override** — gefalsifieerd. Diagnostic toont `hasCalendar: false` voor alle 12 resources in beide projecten. Alle resources gebruiken de project calendar. Geen calendar-mismatch.

**Hypothese B: hoursPerDay mismatch** — uitgesloten. Project target `msdyn_hoursperday: 7.6`, `msdyn_hoursperweek: 38`, `msdyn_dayspermonth: 20`. Matched source. `delta.hoursPerDayMatch: true`.

**Hypothese C: msdyn_plannedwork meegeven bij assignment create** — uitgesloten. API laat het niet toe, gaf `ScheduleAPI-AV-0001`. Per officiële docs:
- `msdyn_plannedwork` is niet writeable bij `msdyn_PssCreateV1` voor assignments
- Er is een aparte action `msdyn_PssUpdateResourceAssignmentContourV1` met andere payload format (`{start, end, minutes}` ISO 8601, niet `/Date(ms)/`)
- Max 100 slices per contour, max 200 ops per OperationSet
- Bron: https://learn.microsoft.com/dynamics365/project-operations/project-management/schedule-api-preview

---

## 5. De open vraag

**De migrator neemt momenteel de scheduleMode 1-op-1 over uit Project Online.** De klant heeft echter aangegeven dat alle PO-projecten *bedoeld* zijn als Fixed Effort. Sommige staan vermoedelijk per ongeluk op Fixed Duration (PO default of legacy keuze).

Jean wil de scheduleMode behouden zoals in source — geen forced override. Dat is een legitieme business-keuze, maar betekent dat Fixed Duration projecten drift houden tenzij we de PSS interpretatie van Fixed Duration begrijpen en kunnen sturen.

**De feitelijke vraag:** waarom verspreidt PSS onder Fixed Duration de effort als microblokjes (0,28u/dag) in plaats van als normale werkblokken? En kunnen we PSS dat anders laten doen zonder de scheduleMode te wijzigen?

Hypothesen die we niet getest hebben:

1. **Task `msdyn_effort` waarde** is misschien verkeerd, waardoor PSS te weinig werk over te veel tijd verdeelt. We zagen al dat `source_durationMinutes: undefined` was in eerdere logs (PO fetch populated dit niet). Vraag: kloppen de individuele task effort waarden in target?

2. **`correctTaskSchedule`** draait al na assignments, schrijft `msdyn_duration` in dagen via `msdyn_PssUpdateV1`. Werkt voor sommige tasks, niet alle. Niet duidelijk waarom de update soms niet beklijft.

3. **Volgorde van OperationSets** — momenteel zijn task-create, dependency-create, assignment-create en correction allemaal aparte OperationSets met aparte Executes. Tussen elke Execute kan PSS herrekenen. Een test waarin alles in één OperationSet zit (binnen de 200-ops limiet) zou kunnen tonen of dit verschil maakt.

---

## 6. Wat er beschikbaar is voor jou

| Resource | Locatie |
|---|---|
| Migrator project context | `migrator-project-context.md` |
| Originele audit | `docs/diagnostics/assignment-drift-audit.md` |
| Fix spec (gedeeltelijk geïmplementeerd) | `docs/fixes/assignment-schedule-drift-fix-spec.md` |
| Diagnostic export feature | `docs/features/schedule-diagnostic-spec.md` |
| Diagnostic JSON van laatste run | `schedule-diagnostic-2026-06-18T09-37-34-369Z.json` |
| Werkende test-omgeving | plannerpremiumacc.crm4.dynamics.com |
| Source code services | `src/services/plannerPremium/` (writers, scheduleApi, calendarReader, assignmentContour) |
| Step 4 orchestrator | `src/steps/Step4Import/index.tsx` |
| Debug logging toggle | `localStorage.DEBUG_SCHEDULE = '1'` |

Diagnostic-knop staat in Step 5, levert per migratie een JSON met alle source vs target velden voor projects, tasks, assignments, resources, en hun contours. Gebruik die om te valideren wat een wijziging echt doet.

---

## 7. Persoonlijke notitie

Ik (Jean) heb met Claude meerdere iteraties gedaan om dit op te lossen. We hebben veel uitgesloten maar geen sluitend antwoord. Komt erop neer dat we PSS-gedrag onder Fixed Duration niet volledig doorgronden.

Mijn instinct zegt: de bron-effort per task moet ergens fout zitten of niet meegegeven worden waardoor PSS denkt dat het tijd heeft om alles uit te smeren. Maar dat is een gevoel, geen bewijs.

Frisse ogen welkom. Begin met het diagnostic JSON bestand — dat is de meest bondige samenvatting van waar we staan.
