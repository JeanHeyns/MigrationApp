# Feature Spec: Project Working Time Configuration

> **Document type:** Implementation specification for Claude Code
> **Target codebase:** Project Online Migrator (React + TypeScript + Power Apps Code App)
> **Status:** Ready for implementation
> **Related specs:** `file-upload-spec.md`, `data-only-migration-spec.md`, `import-control-spec.md`, `project-selection-spec.md`
> **Suggested location in repo:** `docs/working-time-spec.md`

---

## 1. Context & doel

Bij het aanmaken van een `msdyn_project` in Dataverse zijn vijf project-level scheduling settings relevant die de migrator op dit moment niet invult:

- **`msdyn_workhourtemplate`** — lookup naar een `msdyn_workhourtemplate` entity die de werkkalender (welke dagen, welke uren, exceptions) voor het project definieert. Bij project-create maakt Dataverse een snapshot-kopie van de template als `msdyn_calendarid` van dat project.
- **`msdyn_schedulemode`** — option set die bepaalt welke variabele constant blijft bij wijzigingen (Fixed Duration, Fixed Effort, Fixed Units, en de Effort-Driven varianten).
- **`msdyn_hoursperday`** / **`msdyn_hoursperweek`** / **`msdyn_dayspermonth`** — numerieke conversie-factoren voor hoe "1 dag" / "1 week" / "1 maand" wordt geïnterpreteerd in duurberekeningen en displays.

Zonder deze settings krijgen alle gemigreerde projecten de Dataverse defaults (typisch Standard work hour template, Fixed Duration, 8/40/20). Voor klanten die werken in een 38u/7.6h regime, of een specifieke project-kalender hebben met holidays/exceptions, geeft dat verkeerde scheduling math en mismatchend duur-weergave op tasks.

**Filosofie:**
- Globale instelling per migratie als baseline (één werkregime voor alle projecten in 80% van de cases)
- Per-project override mogelijk via setting-modal in Step 2 of via extra kolommen in de FileUpload template
- Geen auto-lezen uit PO's enterprise calendar in v1 (te veel edge cases, marginale waarde)
- Geen auto-sync tussen work hour template en h/d/h/w/d/m in v1 (gebruiker is leidend)
- Soft validation: mismatch tussen template-werkuren en h/d/h/w/d/m levert een warning, geen blok

---

## 2. Scope

### In scope
- Vijf nieuwe velden in `MigrationState.projectDefaults`
- Step 1 UI paneel "Project defaults" met work hour template picker, schedule mode picker, en h/d/h/w/d/m inputs
- Step 2 UI: settings-icoon per project in het project overzicht → modal voor per-project override
- Optionele kolommen in FileUpload template Projects sheet: `WorkHourTemplateName`, `ScheduleMode`, `HoursPerDay`, `HoursPerWeek`, `DaysPerMonth`
- Nieuwe service `services/plannerPremium/workHourTemplates.ts` voor het ophalen van templates
- Schedule mode option set ophalen via bestaande `GetGlobalOptionSetByName` operation
- `projectWriter.ts` payload uitbreiding met de vijf velden
- Backwards compatibility: bestaande writer-flow blijft werken zonder de velden (Dataverse defaults gelden dan)
- Mode-aware UI: paneel verbergen in `schemaOnly` (geen project data wordt geschreven)

### Out of scope (voor deze iteratie)
- Auto-lezen van h/d/h/w/d/m uit de gekozen work hour template's calendar rules (v2)
- Auto-lezen uit PO's enterprise of project-specific calendar (v2 of later)
- Aanmaken van nieuwe work hour templates vanuit de migrator (gebruiker moet bestaande gebruiken)
- Aanmaken van bookable resources t.b.v. nieuwe templates
- Per-task override van schedule mode of werkuren (msdyn_projecttask heeft eigen scheduling settings, niet relevant hier)
- Sync tussen project en template na create (Dataverse propageert sowieso geen template-wijzigingen)
- ChoiceValues sheet uit `file-upload-spec.md` §8.4 — orthogonaal

---

## 3. Architecturale beslissingen

| Beslissing | Keuze | Reden |
|---|---|---|
| Override granulariteit | Globaal (default) + per-project (override) | 80/20 use case: één regime per migratie, soms uitzonderingen |
| Globale defaults | 8 / 40 / 20, Standard template, Fixed Duration | Matchet Dataverse OOB defaults; minste verrassingen |
| Schedule mode optionset | Runtime fetch via `GetGlobalOptionSetByName` | Integer-waarden zijn niet stabiel gedocumenteerd; hard-coden is fragiel |
| Work hour template selectie | Lookup picker uit doel-Dataverse | We maken zelf geen templates; gebruiker kiest uit wat er is |
| PO-fetch van werkuren | Niet doen | Calendar API in PO is complex; te veel edge cases; globale setting is in praktijk leidend |
| h/d sync met template | Handmatig in v1 | Auto-fill vereist Calendar Rules API; v1 keeps it simple |
| Mismatch validatie | Soft warning | Sommige klanten willen bewust afwijken (bv. 38u registratie met 8u-blokken plannen) |
| Per-project UI | Modal achter setting-icoon naast project naam | Niet inline (te druk); modal toont alle 5 velden tegelijk |
| FileUpload columns | 5 optionele kolommen in Projects sheet | Consistent met dataOnly/`DataverseLogicalName` pattern: optioneel, backwards compat |
| Template name lookup | Match op `msdyn_name` case-insensitive | Gebruiker typt in FileUpload de template-naam, niet de GUID |
| Onbekende template name (FileUpload) | Warning + fallback op globale default | Soft validation, consistent met file-upload-spec |
| Mode visibility | Verbergen in `schemaOnly` | Geen project data wordt geschreven; setting heeft geen effect |
| Writer payload | Velden weglaten als niet gezet | Dataverse past dan z'n defaults toe; backwards compat met huidige flow |

---

## 4. Data model

### 4.1 Nieuwe types

```typescript
// src/types/projectDefaults.ts (nieuw)

export interface WorkHourTemplate {
  id: string                  // msdyn_workhourtemplateid (GUID)
  name: string                // msdyn_name
  isDefault?: boolean         // true if name matches "Standard" (case-insensitive)
}

export interface ScheduleModeOption {
  value: number               // option set integer (e.g. 192350001)
  label: string               // UserLocalizedLabel (e.g. "Fixed Duration")
}

export interface ProjectDefaults {
  workHourTemplateId: string | null    // null = use Dataverse default
  workHourTemplateName: string | null  // for display + FileUpload matching
  scheduleMode: number | null          // null = use Dataverse default
  hoursPerDay: number                  // default 8
  hoursPerWeek: number                 // default 40
  daysPerMonth: number                 // default 20
}

export interface ProjectOverride {
  projectId: string
  workHourTemplateId?: string | null
  workHourTemplateName?: string | null
  scheduleMode?: number | null
  hoursPerDay?: number
  hoursPerWeek?: number
  daysPerMonth?: number
}

export const DEFAULT_PROJECT_DEFAULTS: ProjectDefaults = {
  workHourTemplateId: null,
  workHourTemplateName: null,
  scheduleMode: null,
  hoursPerDay: 8,
  hoursPerWeek: 40,
  daysPerMonth: 20,
}
```

### 4.2 MigrationState extension

```typescript
// In src/app/MigrationContext.tsx

interface MigrationState {
  // ... existing fields

  // Loaded from Dataverse at Step 1 (after solution is selected)
  workHourTemplates: WorkHourTemplate[]
  scheduleModeOptions: ScheduleModeOption[]

  // User-configured
  projectDefaults: ProjectDefaults
  projectOverrides: Map<string, ProjectOverride>  // keyed by ProjectId
}
```

### 4.3 Reducer actions

```typescript
| { type: 'SET_WORK_HOUR_TEMPLATES'; templates: WorkHourTemplate[] }
| { type: 'SET_SCHEDULE_MODE_OPTIONS'; options: ScheduleModeOption[] }
| { type: 'SET_PROJECT_DEFAULTS'; defaults: ProjectDefaults }
| { type: 'SET_PROJECT_OVERRIDE'; override: ProjectOverride }
| { type: 'CLEAR_PROJECT_OVERRIDE'; projectId: string }
| { type: 'CLEAR_ALL_PROJECT_OVERRIDES' }
```

Bij `RESET_WIZARD` / source switch: ook `projectDefaults` → DEFAULT, `projectOverrides` → empty, `workHourTemplates` / `scheduleModeOptions` → empty (force re-fetch).

### 4.4 Effective settings helper

```typescript
// src/utils/effectiveProjectSettings.ts

export function effectiveSettings(
  projectId: string,
  defaults: ProjectDefaults,
  overrides: Map<string, ProjectOverride>,
): ProjectDefaults {
  const override = overrides.get(projectId)
  if (!override) return defaults
  return {
    workHourTemplateId: override.workHourTemplateId ?? defaults.workHourTemplateId,
    workHourTemplateName: override.workHourTemplateName ?? defaults.workHourTemplateName,
    scheduleMode: override.scheduleMode ?? defaults.scheduleMode,
    hoursPerDay: override.hoursPerDay ?? defaults.hoursPerDay,
    hoursPerWeek: override.hoursPerWeek ?? defaults.hoursPerWeek,
    daysPerMonth: override.daysPerMonth ?? defaults.daysPerMonth,
  }
}
```

---

## 5. New service: workHourTemplates.ts

### 5.1 File: `src/services/plannerPremium/workHourTemplates.ts`

```typescript
import { listAllRecords } from './dataverseClient'
import type { WorkHourTemplate } from '../../types/projectDefaults'

export async function listWorkHourTemplates(): Promise<WorkHourTemplate[]> {
  const records = await listAllRecords('msdyn_workhourtemplates', {
    select: ['msdyn_workhourtemplateid', 'msdyn_name'],
    filter: 'statecode eq 0',  // active only
    orderby: 'msdyn_name asc',
  })
  return records.map(r => ({
    id: String(r.msdyn_workhourtemplateid),
    name: String(r.msdyn_name ?? '(unnamed)'),
    isDefault: String(r.msdyn_name ?? '').trim().toLowerCase() === 'standard',
  }))
}

export function findTemplateByName(
  templates: WorkHourTemplate[],
  name: string,
): WorkHourTemplate | undefined {
  const target = name.trim().toLowerCase()
  return templates.find(t => t.name.trim().toLowerCase() === target)
}

export function pickInitialTemplate(templates: WorkHourTemplate[]): WorkHourTemplate | null {
  if (templates.length === 0) return null
  return templates.find(t => t.isDefault) ?? templates[0]
}
```

### 5.2 Schedule mode option set fetch

Hergebruik bestaand mechanisme. In `services/plannerPremium/choiceSetManager.ts` (of een nieuwe `scheduleMode.ts`) een wrapper:

```typescript
export async function fetchScheduleModeOptions(): Promise<ScheduleModeOption[]> {
  // The option set is bound to msdyn_project.msdyn_schedulemode
  // First try local option set on the attribute
  const result = await getOptionSetOptions('msdyn_project', 'msdyn_schedulemode')
  return result.map(opt => ({
    value: opt.value,
    label: opt.label,
  }))
}
```

Implementatie-detail: gebruik de attribute metadata endpoint:
```
GET /api/data/v9.2/EntityDefinitions(LogicalName='msdyn_project')/Attributes(LogicalName='msdyn_schedulemode')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet
```

Cache het resultaat in module-scope cache analoog aan `resolverFactory.ts` patroon.

**Fallback** als fetch faalt: hard-coded set met de meest voorkomende vier waarden + log warning. Hier zijn we gevoelig voor schema-wijzigingen, maar het is beter dan geheel falen.

```typescript
const FALLBACK_SCHEDULE_MODES: ScheduleModeOption[] = [
  { value: 192350000, label: 'Fixed Effort' },
  { value: 192350001, label: 'Fixed Duration' },
  { value: 192350002, label: 'Fixed Units' },
  { value: 192350003, label: 'Fixed Duration / Effort Driven' },
  { value: 192350004, label: 'Fixed Units / Effort Driven' },
]
```

**Verifieer integer-waarden in dev tenant voor commit** (open vraag 11.1).

### 5.3 Wanneer fetchen

Beide fetches starten in `Step1Connect` zodra de target solution is geselecteerd. Lock de "Project defaults" UI met een spinner totdat beide klaar zijn. Bij fail: toon error in het paneel, fallback naar empty list (gebruiker kan dan geen template kiezen — error message verklaart wat te doen). Voor schedule mode: fallback list gebruiken.

---

## 6. UI changes

### 6.1 Step 1 — "Project defaults" panel

**Plaatsing:** Na de target solution selectie, vóór de Fetch knop. Verborgen in `schemaOnly` mode.

**Layout:**

```
┌─ Project defaults ─────────────────────────────────────────┐
│                                                             │
│ Work hour template                                          │
│ [Standard ▼]  (5 templates available)                       │
│                                                             │
│ Schedule mode                                               │
│ [Fixed Duration ▼]                                          │
│                                                             │
│ Working time                                                │
│ Hours per day   [  8.0 ]                                    │
│ Hours per week  [ 40.0 ]                                    │
│ Days per month  [ 20.0 ]                                    │
│                                                             │
│ ⚠ These defaults apply to all projects unless overridden    │
│   per project in Step 2.                                    │
└─────────────────────────────────────────────────────────────┘
```

**Validation rules (in-form):**
- HoursPerDay: 0 < value ≤ 24
- HoursPerWeek: 0 < value ≤ 168
- DaysPerMonth: 0 < value ≤ 31
- HoursPerDay × DaysPerMonth should be in range [0.5 × HoursPerWeek × 4, 1.5 × HoursPerWeek × 4] — warning if outside

**Gating:** Fetch knop is enabled wanneer (work hour templates loaded + schedule mode options loaded + alle drie de numerieke velden gevuld en valid) **OR** dataSource === FileUpload (dan kan template via upload geleverd worden — globale fields kunnen nog steeds gezet zijn).

**Edge case:** target Dataverse heeft 0 work hour templates. Onwaarschijnlijk in praktijk (Standard wordt OOB aangemaakt), maar mogelijk in een net-aangemaakt environment. Toon: "No work hour templates found in target. Please create one in Project Operations / Project for the Web before continuing." Block Fetch.

### 6.2 Step 2 — Per-project override modal

**Trigger:** Klein gear-icoon (⚙ of Settings16Regular) naast project naam in de project lijst, tussen de checkbox en de naam.

**Visual indicator:** Projects met een actieve override krijgen een subtiele highlight (bv. een dot of gekleurde rand op het icoon).

**Modal layout:**

```
┌─ Working time for "Renovation Project Alpha" ──────────────┐
│                                                             │
│ ☑ Override defaults for this project                        │
│                                                             │
│ Work hour template                                          │
│ [Standard ▼]    [Reset to default]                          │
│                                                             │
│ Schedule mode                                               │
│ [Fixed Duration ▼]                                          │
│                                                             │
│ Hours per day   [ 8.0 ]                                     │
│ Hours per week  [40.0 ]                                     │
│ Days per month  [20.0 ]                                     │
│                                                             │
│              [Cancel]  [Save override]                      │
└─────────────────────────────────────────────────────────────┘
```

Toggle bovenaan: als off, alle velden grijs en disabled, save = clear override. Als on, prefill met huidige override of globale defaults.

**Mismatch warning:** Bij Save, als de gekozen `workHourTemplate` een naam heeft die typische werkuren suggereert (bv. "38h template", "37.5h template") en h/d staat op een andere waarde, toon warning: "Hours per day (8) doesn't match the work hour template name. Continue anyway?" Heuristiek-based, niet strict. **v1 implementeren:** alleen voor template-namen die `Nh` of `N.Nh` of `N,Nh` patronen bevatten. Skippen als geen patroon match.

### 6.3 Step 2 — Project list header

Toon eventueel: "3 of 47 projects have overrides" naast de existing "X of Y selected". Klein, secundair element.

### 6.4 SchemaOnly mode

Step 1 paneel **niet renderen** in `schemaOnly` mode. Step 2 gear-icoon niet renderen. State blijft bestaan (defaults blijven op DEFAULT) maar wordt niet gebruikt.

---

## 7. Writer changes

### 7.1 `projectWriter.ts` payload uitbreiding

```typescript
// Pseudocode, integreer in bestaande createProjectPayload functie

function buildProjectPayload(
  poProject: PoProject,
  settings: ProjectDefaults,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    msdyn_subject: poProject.ProjectName,
    msdyn_scheduledstart: poProject.ProjectStartDate,
    // ... existing fields
  }

  // Working time fields — only set if user configured them
  if (settings.workHourTemplateId) {
    payload['msdyn_workhourtemplate@odata.bind'] =
      `/msdyn_workhourtemplates(${settings.workHourTemplateId})`
  }
  if (settings.scheduleMode !== null) {
    payload.msdyn_schedulemode = settings.scheduleMode
  }
  // Numerics: always have values (defaults are 8/40/20), but only write if non-default
  // to keep payload minimal and let Dataverse handle defaults explicitly when user
  // didn't customize. Decision: ALWAYS write — explicit is better than implicit.
  payload.msdyn_hoursperday = settings.hoursPerDay
  payload.msdyn_hoursperweek = settings.hoursPerWeek
  payload.msdyn_dayspermonth = settings.daysPerMonth

  return payload
}
```

**Toepassen per project:**

```typescript
// In de project write loop
for (const poProject of projectsToMigrate) {
  const settings = effectiveSettings(poProject.ProjectId, state.projectDefaults, state.projectOverrides)
  const payload = buildProjectPayload(poProject, settings)
  await callCreateProjectV1(payload)
}
```

### 7.2 DataOnly mode

In dataOnly maakt de migrator nog steeds nieuwe `msdyn_project` records aan (alleen de schema wordt hergebruikt). Dus de working-time settings worden ook in dataOnly toegepast. Geen wijziging aan dataOnly resolvers nodig — deze velden zijn niet via mapping geconfigureerd, ze komen direct uit `ProjectDefaults`.

### 7.3 Backwards compatibility

Als `workHourTemplateId === null` en `scheduleMode === null`: velden worden niet in de payload opgenomen, Dataverse past z'n defaults toe. Dit is de fallback wanneer:
- Gebruiker heeft globale defaults niet aangepast en geen WHT geselecteerd (theoretisch onmogelijk door de Fetch-button gating, maar defensieve check)
- Schedule mode optionset fetch faalde én gebruiker selecteerde geen waarde

Numerieke h/d/h/w/d/m staan **altijd** in de payload (defaults 8/40/20 als gebruiker niets aanpaste). Reden: expliciet maakt het project-record predictable; bij latere edits in P4W ziet de PM dezelfde waarden als configured.

---

## 8. FileUpload template integration

Verwijst naar `file-upload-spec.md`. Vijf optionele kolommen toevoegen in `Projects` sheet, na `OwnerName`:

| Kolom | Type | Validatie |
|---|---|---|
| `WorkHourTemplateName` | string | Match (case-insensitive) op `msdyn_name` van een WHT in target. Geen match → warning, fallback op globale default. |
| `ScheduleMode` | string | Match op label van een `ScheduleModeOption` (case-insensitive, exact). Geen match → warning, fallback. |
| `HoursPerDay` | number | 0 < value ≤ 24. Buiten range → warning, fallback. |
| `HoursPerWeek` | number | 0 < value ≤ 168. Buiten range → warning, fallback. |
| `DaysPerMonth` | number | 0 < value ≤ 31. Buiten range → warning, fallback. |

**Loader gedrag:** waarden worden geparsed in `excelTemplate.ts` parseWorkbook en doorgegeven als deel van een nieuw `fileUploadProjectOverrides: ProjectOverride[]` veld in `PoFetchedData`. Step 2 init: als er overrides uit FileUpload komen, push ze naar `state.projectOverrides`.

**Nieuwe warning codes** in `file-upload-spec.md` §6.1:

```typescript
export type WarningCode =
  | ... existing
  | 'UNKNOWN_WORK_HOUR_TEMPLATE'
  | 'UNKNOWN_SCHEDULE_MODE'
  | 'WORKING_TIME_OUT_OF_RANGE'
```

**Template generation update** (`excelTemplate.ts` generateTemplate):
- Voeg de 5 kolommen toe na `OwnerName`
- Geen data validation dropdowns voor template name en schedule mode (afhankelijk van target tenant — niet bekend op template-generation-time)
- _Instructions sheet: kort blokje toevoegen met uitleg over deze kolommen

**Resolution timing:** template name resolution naar GUID gebeurt pas in Step 1 nadat de target solution gekozen is en `workHourTemplates` geladen zijn. Voor FileUpload: na fetch én WHT-load, walk de fileUploadProjectOverrides en resolve namen naar IDs. Onbekende naam → warning, override krijgt `workHourTemplateId = null` (= use global default).

---

## 9. Edge cases & gotchas

### 9.1 Target tenant zonder Standard template
Onwaarschijnlijk maar mogelijk. Geen "Standard" → `pickInitialTemplate` selecteert eerste op alfabet. Tonen in UI; gebruiker kan altijd ander kiezen.

### 9.2 Schedule mode optionset waarden veranderen
Microsoft kan in een release nieuwe schedule modes toevoegen of (theoretisch) values renummeren. Runtime fetch is daarom essentieel. Fallback list (§5.2) blijft een risico — documenteren als "verify in dev tenant when something breaks".

### 9.3 Work hour template GUID stabiel?
GUIDs zijn stabiel per tenant maar verschillen tussen tenants. Voor FileUpload template portabiliteit: we slaan **naam** op in de Excel kolom, niet GUID. Bij upload in een ander tenant: naam wordt geresolved naar de GUID van dat tenant's gelijknamige template. Als het tenant geen "Standard" heeft maar wel "Standaard": warning + fallback. Acceptabel tradeoff.

### 9.4 Override modal sluiten zonder save
Cancel discardt wijzigingen. Confirm dialog alleen als er onsaved changes zijn én de gebruiker drukt op X / klikt buiten modal.

### 9.5 Project zonder tasks (alleen metadata migration)
Working time settings worden alsnog toegepast op de `msdyn_project` record. Toekomstige tasks die in P4W worden aangemaakt gebruiken dan deze settings. Geen probleem.

### 9.6 Mismatch tussen scheduledstart (project) en template werkdagen
Als `msdyn_scheduledstart` op een non-working day in de template valt (bv. zaterdag), schuift Dataverse waarschijnlijk de tasks. Niet ons probleem hier — out of scope.

### 9.7 Numerieke precisie van h/d
Dataverse `msdyn_hoursperday` is een Decimal(2). Inputs als 7.6 of 7.50 zijn fine; 7.123 wordt afgekapt. Frontend: round to 2 decimal places on input blur.

### 9.8 FileUpload override + Step 2 override conflict
Gebruiker uploadt template met override voor Project X, daarna handmatig in Step 2 ook override. **Step 2 wint** (laatst gezet). Bij display in de modal: toon huidige effective waarde, niet de file-waarde apart.

### 9.9 Re-fetch van work hour templates
Bij switch van target solution: clear `workHourTemplates` + `projectOverrides.workHourTemplateId` (omdat GUIDs solution-specifiek kunnen zijn na unmanaged solution moves). Re-fetch verplicht. `workHourTemplateName` in overrides blijft bestaan en wordt opnieuw geresolved tegen nieuwe lijst.

### 9.10 Schedule mode null in payload
Als `scheduleMode === null` (optionset fetch faalde + gebruiker koos niets): veld wordt weggelaten uit payload. Dataverse default = waarschijnlijk Fixed Duration. OK voor backwards compat.

### 9.11 Werkende template, niet meer beschikbaar bij re-run
Gebruiker bewaart override met template "Custom 38h", template wordt later in Dataverse verwijderd, gebruiker draait migratie opnieuw. Resolution faalt: warning + fallback op globale default. Logged in import report.

### 9.12 Effort-Driven schedule modes niet beschikbaar in vanilla P4W
De effort-driven varianten (192350003/4) bestaan alleen in Project Operations volledige licentie. In vanilla P4W tenants levert de optionset fetch ze niet op — geen probleem.

### 9.13 Hours per day > Hours per week ÷ 5
Bv. 10 / 40 / 20: math is inconsistent (10×5 = 50 ≠ 40). Soft check in form: warning, niet blok. Sommige klanten registreren bewust 8h-dagen in een 32h-week (4-day week). Toestaan.

---

## 10. Acceptance criteria

### State & types
1. ✅ `ProjectDefaults`, `ProjectOverride`, `WorkHourTemplate`, `ScheduleModeOption` types gedefinieerd in `src/types/projectDefaults.ts`
2. ✅ `MigrationState` uitgebreid met `workHourTemplates`, `scheduleModeOptions`, `projectDefaults`, `projectOverrides`
3. ✅ Reducer acties geïmplementeerd; state reset bij `RESET_WIZARD` werkt
4. ✅ `effectiveSettings` helper retourneert correct gemergede settings per project

### Service layer
5. ✅ `listWorkHourTemplates()` returnt active templates uit doel-Dataverse, gesorteerd op naam
6. ✅ `fetchScheduleModeOptions()` returnt option set values + labels uit metadata API
7. ✅ Fallback schedule modes worden gebruikt als metadata fetch faalt, met warning in logs
8. ✅ Templates en options worden gefetched zodra target solution geselecteerd is

### Step 1 UI
9. ✅ "Project defaults" paneel zichtbaar in `full` en `dataOnly` mode, verborgen in `schemaOnly`
10. ✅ Work hour template dropdown toont alle actieve templates; "Standard" is initial selection als aanwezig
11. ✅ Schedule mode dropdown toont opgehaalde of fallback option labels
12. ✅ h/d, h/w, d/m inputs pre-filled met 8 / 40 / 20
13. ✅ Numerieke inputs valideren range; out-of-range toont inline error
14. ✅ Fetch knop disabled tot paneel valid + templates/options geladen
15. ✅ Lege templates list → blocking error met instructie

### Step 2 UI
16. ✅ Gear icoon per project in project lijst (Step 2)
17. ✅ Klik opent modal met override settings; pre-filled met effectieve waarden
18. ✅ Toggle "Override defaults" enabled/disabled alle velden
19. ✅ Save met toggle off clearet de override; toggle on slaat override op
20. ✅ Project met actieve override krijgt visuele indicator op het gear-icoon
21. ✅ Heuristic mismatch warning werkt voor template-namen met `Nh` patroon
22. ✅ Header toont "N of M projects have overrides" tussen project selection counts

### Writer
23. ✅ `projectWriter.ts` voegt de 5 velden toe aan `msdyn_CreateProjectV1` payload
24. ✅ `msdyn_workhourtemplate@odata.bind` wordt alleen gezet als `workHourTemplateId !== null`
25. ✅ `msdyn_schedulemode` wordt alleen gezet als `scheduleMode !== null`
26. ✅ h/d/h/w/d/m worden altijd gezet (defaults 8/40/20)
27. ✅ Per-project effective settings worden gebruikt, niet globaal
28. ✅ Backwards compat: project zonder template/mode wordt aangemaakt met Dataverse defaults

### FileUpload integration
29. ✅ Template v2 (`generateTemplate()`) bevat 5 nieuwe kolommen na `OwnerName`
30. ✅ `_Instructions` sheet beschrijft de kolommen
31. ✅ Parser leest de kolommen, valideert, push override naar `state.projectOverrides`
32. ✅ Onbekende WorkHourTemplateName → warning, override gevuld met `workHourTemplateId: null` (= global fallback)
33. ✅ Onbekende ScheduleMode → warning, override gevuld met `scheduleMode: null` (= global fallback)
34. ✅ h/d/h/w/d/m out-of-range → warning, veld onbenoemd in override

### Mode integration
35. ✅ `full` mode: paneel zichtbaar, overrides toegepast in writer
36. ✅ `dataOnly` mode: paneel zichtbaar, overrides toegepast in writer
37. ✅ `schemaOnly` mode: paneel verborgen, geen state effect
38. ✅ Switch tussen modes resetbares correcte state

### End-to-end
39. ✅ Full mode migratie met aangepaste WHT + 7.6/38/20 produceert projecten met die settings in Dataverse
40. ✅ Per-project override voor 1 van 5 projecten: dat project krijgt override settings, anderen krijgen globale
41. ✅ FileUpload met override-kolommen werkt; Step 2 modal toont de file-overrides als initial state
42. ✅ `npm run build` slaagt; `pac code push` deployed cleanly
43. ✅ Bestaande migraties (zonder de UI geconfigureerd) blijven werken — Dataverse defaults gelden dan

---

## 11. Implementatie volgorde (aanbevolen)

Fasering: types/services eerst (geen visuele impact), dan UI, dan writer-integratie, dan FileUpload integratie.

1. **Types + state** — `ProjectDefaults`, `ProjectOverride`, `WorkHourTemplate`, `ScheduleModeOption`, MigrationContext extension, reducer actions. Geen UI nog.
2. **`workHourTemplates.ts` service** — list/find/pick helpers. Unit-test handmatig via console.
3. **Schedule mode fetch** — metadata API call + fallback list. Test in dev tenant: verifieer dat de fallback values matchen met live optionset (open vraag 12.1).
4. **`effectiveSettings` helper** — pure functie, simpel te testen.
5. **Step 1 UI paneel** — render WHT picker, schedule mode picker, drie inputs. Form validation. Gating van Fetch knop.
6. **Step 2 gear-icoon + modal** — modal component met toggle, dropdowns, inputs. Visual indicator op icoon. Header counter.
7. **`projectWriter.ts` payload uitbreiding** — voeg 5 velden toe; gebruik `effectiveSettings` per project. Test in `full` mode end-to-end.
8. **Verifieer dataOnly compat** — run migratie in dataOnly, check projecten in Dataverse hebben juiste WHT/schedule mode.
9. **FileUpload kolommen in generateTemplate** — 5 kolommen + _Instructions blok.
10. **FileUpload parser** — lees kolommen, validate, push naar `projectOverrides`. Resolve template name → GUID na Step 1 fetch.
11. **Mismatch heuristic warning** — Nh-pattern detectie in Step 2 modal save.
12. **schemaOnly verbergen** — conditionele render in Step 1 + Step 2.
13. **End-to-end test** — alle drie modes, met en zonder overrides, PO + FileUpload sources.
14. **Backwards-compat regressie** — verifieer dat bestaande full-mode migratie zonder UI-configuratie nog steeds werkt.

**Geschatte effort:** 2 dagen voor een ervaren dev op deze codebase. Stappen 1–4 (services + state) ~0.5 dag. Stappen 5–7 (UI + writer) ~1 dag. Stappen 8–11 (mode compat + FileUpload + heuristic) ~0.5 dag.

---

## 12. Open vragen (voor implementatie-tijd)

1. **Verifieer schedule mode optionset values in dev tenant** (`dev-jehe.crm4.dynamics.com`). De fallback list in §5.2 is gebaseerd op publieke Microsoft documentatie maar values zijn niet officieel gestandaardiseerd. Run één keer:
   ```
   GET /api/data/v9.2/EntityDefinitions(LogicalName='msdyn_project')/Attributes(LogicalName='msdyn_schedulemode')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet
   ```
   Note exacte values + labels in een code comment in `scheduleMode.ts`.

2. **Belgische defaults als alternatief?** Huidige spec stelt 8/40/20 voor (Microsoft default). Voor Exerti-klanten met overwegend 38u/7.6h regimes zou 7.6/38/20 als app-level default minder klikken kosten. **Aanbeveling:** behoud 8/40/20 als hard default; voeg later eventueel een env-var of user-pref toe voor "preferred defaults". Niet nu.

3. **Mismatch-heuristic regex:** detecteren we alleen `Nh` en `N.Nh` / `N,Nh`? Of ook woorden als "Hours", "Uren"? **Aanbeveling:** start met `/(\d+([.,]\d+)?)\s*h\b/i` regex, uitbreiden op feedback.

4. **`_Instructions` sheet update:** is het beter om de werkkalender-uitleg in een aparte sectie te zetten of bij de Projects-sheet beschrijving in §4.4 van `file-upload-spec.md`? **Aanbeveling:** bij Projects-sheet, want de kolommen staan daar.

5. **DataOnly resolver impact:** moet er een resolver-entry komen voor `msdyn_workhourtemplate` (omdat het een lookup is)? **Antwoord: nee.** Resolvers in `resolverFactory.ts` mappen PO custom field waarden naar Dataverse lookup GUIDs. Work hour template is geen custom field maar een built-in property die wij rechtstreeks vullen vanuit `ProjectDefaults`. Out of resolver scope.

6. **Effort-driven modes in vanilla P4W:** als de optionset fetch effort-driven varianten teruggeeft in een tenant zonder Project Operations licentie, accepteert Dataverse die waarden dan? **Aanbeveling:** trust de fetch — als Dataverse die labels exposeert, mag het ook de value accepteren. Bij fail in writer: gebruiker krijgt error en kan switchen naar non-effort-driven.

7. **Migratie van bestaande overrides bij wizard restart:** bij `RESET_WIZARD` clearen we overrides. Bedoeling: schone start. Maar wat als gebruiker per ongeluk reset clickt na 30 min werk in Step 2? **Aanbeveling:** bevestig-dialog op reset, niet expliciet onderdeel van deze spec maar wel relevant. Track in een aparte UX-ticket.
