# Feature Spec: Project Selection & Bulk Controls

> **Document type:** Implementation specification for Claude Code
> **Target codebase:** Project Online Migrator (React + TypeScript + Power Apps Code App)
> **Status:** Complete
> **Related specs:** `import-control-spec.md`, `data-only-migration-spec-addendum-B.md`
> **Suggested location in repo:** `docs/project-selection-spec.md`

## Implementation status — COMPLETE

### Not implemented (descoped)
- **CSV upload** — already exists in Step 2
- **Custom field filters** — out of scope
- **Shift+click range select** — out of scope

### Architecture decision: selection UI in Step 4 (not Step 1)
Spec suggested Step 1 or "Step 1.5". Implemented in Step 4 instead — Step 4 is the natural "configure what to migrate" step. Step 1 remains fetch-only.

### Files changed / created
| File | Change |
|---|---|
| `src/app/MigrationContext.tsx` | Added `selectedProjectIds: Set<string>`, `projectFilter: ProjectFilter`, `isFilterActive()` export, 6 selection actions; `setFetchedData` auto-fills all IDs; `resetState` clears both |
| `src/components/ProjectSelection/BulkActions.tsx` | New — All / None / Invert / First N / Range / Select filtered (N); First N + Range + Select filtered respect active filter |
| `src/components/ProjectSelection/FilterBar.tsx` | New — search (debounced 200ms) / start date range / finish date range / owner multi-select / task count min-max; collapsible advanced section; "Filter active" badge + Clear button |
| `src/utils/projectFilter.ts` | New — `applyFilter()` pure function used by FilterBar |
| `src/steps/Step4Import/index.tsx` | Wired to context `selectedProjectIds`; added FilterBar + BulkActions above project table; table renders filtered list; status line shows "X of Y selected · showing Z filtered" |
| `src/components/StepIndicator.tsx` | "X / Y projects" badge visible from Step 2 onward |
| `src/steps/Step5Report/index.tsx` | Added "Projects migrated X / Y" metric card |

---

## 1. Context & doel

Bij een PWA met 200 projecten is het huidige selectiemechanisme — één voor één door de lijst klikken om de subset te bepalen die gemigreerd moet worden — onhoudbaar. Dit ontstaat bij:

- Pilot-runs ("eerste 20 als test, dan de rest")
- Re-runs na partial failure (alleen de gefaalde subset)
- Multi-tenant scenarios waar de klant een specifieke lijst aanlevert
- Iteratieve testcycli waar je dezelfde selectie meerdere keren wil draaien

**Uitbreiding:** voeg een selectie-laag toe vóór de migratie zodat de gebruiker met enkele clicks subsets van 200+ projecten kan kiezen, filteren, en hergebruiken.

Deze feature is **complementair** aan `migrationScope` uit `import-control-spec.md`: scope bepaalt *welke categorieën* (tasks/deps/assignments/resources) gemigreerd worden, project-selectie bepaalt *welke projecten*. Beide zijn los te combineren.

---

## 2. Scope

### In scope
- Bulk-select controls: All / None / First N / Range / Invert
- Shift+click voor range-select tussen twee rijen
- Filter-bar: search op naam, datum range, custom field filters, task count
- "Select all filtered" / "Deselect all filtered" combinatie van filter + bulk
- Selectie-driven downstream: alleen geselecteerde projecten + hun children worden naar Step 4 doorgegeven
- Status indicator: "X of Y projects selected" persistent in de wizard header tijdens Step 2–5
- CSV upload: lijst van project-namen of IDs om te matchen tegen `fetchedData.projects`

### Out of scope (voor deze iteratie)
- Saved selection presets met persistence — overweegbaar als follow-up als usage-patronen het rechtvaardigen
- Auto-batching ("verdeel 200 in 3 batches van ~67") — overlap met `import-control-spec.md` concurrency-laag, los later
- Random sampling ("pak 20 willekeurige projecten") — niche, low priority
- Selectie van individuele tasks/assignments binnen een project — te fijnmazig, schaalt niet
- Resume na partial migration via selectie van "alleen gefaalde projecten" — vereist persistent import-state, eigen spec waardig

---

## 3. Architecturale beslissingen

| Beslissing | Keuze | Reden |
|---|---|---|
| Selectie-plek in wizard | Nieuwe Step 1.5 (tussen fetch en mapping), of inline in Step 1 onder fetch summary | Selectie moet ná fetch (data nodig) maar vóór mapping (mapping is per-project niet zinvol) |
| Default selectie na fetch | Alle projecten geselecteerd | Backwards compatible met huidige flow; user moet expliciet de-selecteren |
| Selectie-state shape | `Set<string>` van project IDs | O(1) lookup; eenvoudige serialisatie naar array |
| Filter UI plek | Toolbar boven de lijst | Klassiek patroon; filter + bulk-actions logisch gegroepeerd |
| Filter scope | Op `fetchedData.projects` records | Geen re-fetch nodig; alles client-side |
| CSV upload format | Eén kolom met project naam OF ID, header optioneel | Eenvoudige adoptie; auto-detect ID vs naam |
| Downstream propagatie | Filter `fetchedData` vóór doorgave aan Step 4 writers | Writers blijven ongewijzigd; selectie is een upstream concern |
| Children filtering | Automatisch: tasks/assignments waarvan `projectId` niet in selectie wordt geskipt | Voorkomt orphans; transparent voor gebruiker |
| Status indicator | Permanente badge in wizard header "X of Y selected" | Constant zichtbaar; voorkomt verrassingen in Step 4 |

---

## 4. State uitbreidingen

In `MigrationContext`:

```typescript
interface MigrationState {
  // ... bestaande velden

  selectedProjectIds: Set<string>          // default: empty na fetch, vervolgens auto-gevuld met alle IDs
  projectFilter: ProjectFilter             // huidige filter-state
}

interface ProjectFilter {
  searchTerm: string                       // substring match op project naam (case-insensitive)
  startDateFrom: string | null             // ISO date
  startDateTo: string | null
  finishDateFrom: string | null
  finishDateTo: string | null
  ownerNames: string[]                     // multi-select; leeg = geen filter
  taskCountMin: number | null
  taskCountMax: number | null
  customFieldFilters: CustomFieldFilter[]  // user-toegevoegde filters op custom fields
}

interface CustomFieldFilter {
  fieldName: string                        // PO field name
  operator: 'equals' | 'contains' | 'isEmpty' | 'isNotEmpty'
  value: string | null
}
```

Reducer actions:
- `SET_SELECTED_PROJECT_IDS` (replace volledige selectie)
- `TOGGLE_PROJECT_SELECTION` (één project)
- `SELECT_PROJECTS_BY_IDS` (union met huidige selectie)
- `DESELECT_PROJECTS_BY_IDS` (difference met huidige selectie)
- `SET_PROJECT_FILTER` (replace filter-state)
- `CLEAR_PROJECT_FILTER` (reset naar empty filter)

Default na fetch:
```typescript
case 'SET_FETCHED_DATA': {
  const allIds = new Set(action.payload.projects.map(p => p.id))
  return {
    ...state,
    fetchedData: action.payload,
    selectedProjectIds: allIds,
    projectFilter: emptyFilter()
  }
}
```

---

## 5. Nieuwe bestanden

### 5.1 `src/components/ProjectSelection/index.tsx`

Hoofdcomponent, gebruikt in Step 1 (na fetch summary) of als aparte Step 1.5. Bevat:

- Toolbar (filter + bulk actions)
- Project-lijst (tabel of virtualized list)
- Status footer ("X of Y selected, Z filtered")

### 5.2 `src/components/ProjectSelection/FilterBar.tsx`

Filter-controls in een uitklapbare bar:

```
┌────────────────────────────────────────────────────────────────┐
│ 🔍 [Search projects...]    📅 Start: [from] – [to]    [More ▼] │
└────────────────────────────────────────────────────────────────┘
```

"More ▼" klapt geavanceerde filters open: owner, task count range, custom field filters.

### 5.3 `src/components/ProjectSelection/BulkActions.tsx`

Knoppen-rij:

```
[All] [None] [Invert]  |  First [20] [Select]  |  Range [1]-[20] [Select]  |  [Upload CSV...]
```

### 5.4 `src/components/ProjectSelection/ProjectListRow.tsx`

Per rij:
- Checkbox
- Project naam
- Start date / Finish date
- Task count
- Owner
- Click-to-toggle, shift+click voor range

### 5.5 `src/utils/projectFilter.ts`

Pure functies, makkelijk te testen:

```typescript
export function applyFilter(
  projects: PoProject[],
  filter: ProjectFilter,
  tasksByProjectId: Map<string, PoTask[]>
): PoProject[]

export function emptyFilter(): ProjectFilter

export function isFilterActive(filter: ProjectFilter): boolean
```

### 5.6 `src/utils/csvProjectMatcher.ts`

```typescript
export interface CsvMatchResult {
  matchedIds: string[]
  unmatchedEntries: string[]      // CSV rows die nergens matchten
  ambiguousEntries: Array<{ entry: string; matchedIds: string[] }>  // meer dan 1 match
}

export async function matchCsvToProjects(
  csvContent: string,
  projects: PoProject[]
): Promise<CsvMatchResult>
```

Implementatie:
1. Parse CSV (eerste kolom, header optioneel — auto-detect of eerste rij een header is op basis van GUID-pattern check)
2. Voor elke entry:
   - Probeer eerst ID-match (exacte GUID)
   - Daarna naam-match (case-insensitive, trimmed)
   - Bij meerdere naam-matches: noteer als ambiguous
3. Return resultaat met categorisatie

---

## 6. Wijzigingen in bestaande bestanden

### 6.1 `Step1Connect/index.tsx`

Na de fetch summary panel, voeg toe (alleen indien `fetchedData.projects.length > 0`):

```
┌─ Projects to migrate ──────────────────────────────────────┐
│                                                            │
│  [ProjectSelection component]                              │
│                                                            │
│  Selected: 200 of 200                                      │
└────────────────────────────────────────────────────────────┘
```

Next-button validatie: ook `selectedProjectIds.size > 0` als vereiste, anders "Select at least one project to continue".

### 6.2 `Step2Mapping`, `Step3CreateColumns`, `Step4Import`, `Step5Report`

Wizard header bevat altijd zichtbaar: `"📋 142 of 200 projects selected"` als badge.

In Step 4 vóór writers worden aangeroepen, filter `fetchedData`:

```typescript
function getEffectiveFetchedData(state: MigrationState): PoFetchedData {
  const selected = state.selectedProjectIds
  const projects = state.fetchedData.projects.filter(p => selected.has(p.id))
  const tasks = state.fetchedData.tasks.filter(t => selected.has(t.projectId))
  const assignments = state.fetchedData.assignments.filter(a => selected.has(a.projectId))
  // resources: keep all (resources zijn project-onafhankelijk in PO)
  return { ...state.fetchedData, projects, tasks, assignments }
}
```

Writers krijgen het ge-filterde object, ongewijzigd in signature.

### 6.3 `Step5Report/index.tsx`

Summary header laat zien:

```
Migrated: 142 of 200 selected (58 skipped via selection)
```

CSV exports filteren ook op de gekozen subset. Voor "not migrated" projecten (de niet-geselecteerde): geen entries in het rapport — die waren expliciet geskipt, geen failure.

### 6.4 `MigrationContext.tsx`

State + reducer uitbreidingen zoals in §4. Exporteer een derived selector:

```typescript
export function useSelectedProjects(): PoProject[] {
  const { state } = useMigration()
  if (!state.fetchedData) return []
  return state.fetchedData.projects.filter(p => state.selectedProjectIds.has(p.id))
}

export function useFilteredProjects(): PoProject[] {
  const { state } = useMigration()
  if (!state.fetchedData) return []
  const tasksByProject = buildTasksByProjectIdMap(state.fetchedData.tasks)
  return applyFilter(state.fetchedData.projects, state.projectFilter, tasksByProject)
}
```

---

## 7. Bulk action gedrag (detail-spec)

### 7.1 Select All
Alle project IDs uit `fetchedData.projects` worden toegevoegd aan `selectedProjectIds`. Negeert actieve filter (selecteert ook gefilterde-weg projecten? — zie §7.2).

### 7.2 Select All Filtered
Alleen projecten die matchen met huidige `projectFilter` worden geselecteerd. Bestaande selectie buiten de filter blijft. Dit is een **union**, niet een replace.

Voorbeeld: filter "naam bevat 'Q4'" matcht 30 projecten. Klik "Select All Filtered" → die 30 worden toegevoegd aan de selectie. Reeds geselecteerde projecten met "Q4" in de naam veranderen niets; reeds geselecteerde projecten zonder "Q4" blijven geselecteerd.

Voor het maximaliseren van controle: bied beide knoppen aan wanneer filter actief is:
- **Select all filtered (add)** — union (default gedrag hierboven)
- **Replace selection with filtered** — vervang volledige selectie met de filter-resultaten

### 7.3 None
`selectedProjectIds = new Set()`. Next-button wordt disabled.

### 7.4 Invert
Voor elke project ID: als in `selectedProjectIds`, verwijderen; anders toevoegen. Werkt op de **volledige lijst**, niet op gefilterde subset.

### 7.5 First N
Input: getal N (default 20). Selecteert de eerste N projecten in de huidige **sorteer-volgorde van de lijst**. Vervangt huidige selectie.

Open vraag: respecteert "First 20" de actieve filter? **Aanbeveling:** ja — wanneer filter actief is, "First 20" betekent "eerste 20 van gefilterde subset". Toon duidelijke label: "First 20 (of 47 filtered)".

### 7.6 Range
Twee inputs: van rij X tot rij Y (1-indexed). Vervangt huidige selectie. Respecteert sorteer + filter.

### 7.7 Shift+click
Klassiek file-explorer gedrag. Anchor = laatst-aangeklikt project (toggle of click). Bij shift+click op een ander project: selecteer (toggle naar `true`) alle projecten tussen anchor en doel in huidige sorteer-volgorde.

Implementatie: bewaar `lastClickedId` in component state (niet in MigrationContext — UI-only concern).

### 7.8 Upload CSV
Modale dialog:
1. Drag-drop of file input voor `.csv` of `.txt`
2. Preview: "Found 47 entries. 42 matched by name, 3 matched by ID, 2 unmatched."
3. Bij ambiguous matches: tabel met de ambiguous entries en welke projecten ze matchen, met expliciete keuze per rij
4. Bij unmatched: lijst met de niet-gevonden entries, optie "Continue anyway" of "Cancel"
5. **Apply**: vervangt of voegt toe aan huidige selectie (radio keuze in modal)

---

## 8. Filter gedrag (detail-spec)

### 8.1 Search term
Substring match op `project.name`, case-insensitive, trimmed. Debounce 200ms op input om re-rendering bij grote lijsten te beperken.

### 8.2 Date ranges
Twee paren (start, finish): `startDateFrom/To` en `finishDateFrom/To`. Logica:
- Lege from = geen ondergrens
- Lege to = geen bovengrens
- Beide leeg = filter niet actief

Match: project komt door als `project.startDate >= startDateFrom && project.startDate <= startDateTo` (en analoog voor finish).

### 8.3 Owners
Multi-select dropdown met alle unieke `project.ownerName` waarden uit `fetchedData.projects`. Lege selectie = geen filter.

### 8.4 Task count
Min en max integer. Match: `tasksByProjectId.get(project.id).length` valt binnen range. Geen tasks gefetcht (bv. `migrationScope.tasks=false`) → filter niet beschikbaar, toon disabled met tooltip.

### 8.5 Custom field filters
"Add custom field filter" knop in advanced section. Per filter:
- Dropdown: kies een PO custom field uit `fetchedData.customFields`
- Operator: `equals`, `contains`, `isEmpty`, `isNotEmpty`
- Waarde input (verborgen bij `isEmpty`/`isNotEmpty`)

Match: lees `project.customFields[fieldName]` (of equivalent in jouw data shape), pas operator toe.

### 8.6 Combinatie
Alle actieve filters in AND combinatie. Toon "Showing X of Y projects" boven de lijst.

### 8.7 Clear filter
Reset-knop in toolbar wanneer `isFilterActive(filter)`. Reset alleen filter, niet selectie.

---

## 9. UI layout

### 9.1 Selection component complete view

```
┌── Projects to migrate ──────────────────────────────────────────────┐
│                                                                     │
│ ┌─ Filter ────────────────────────────────────────────────────────┐ │
│ │ 🔍 [Search...]   Start: [   ] – [   ]   Owner: [Any ▼] [More ▼] │ │
│ │                                                          [Clear] │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ ┌─ Bulk actions ──────────────────────────────────────────────────┐ │
│ │ [All] [None] [Invert] │ First [20  ] [Select] │ [📄 Upload CSV] │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ Showing 47 of 200 projects · 32 selected                            │
│                                                                     │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ ☑ │ Name                       │ Start      │ Finish    │ Tasks │ │
│ ├───┼────────────────────────────┼────────────┼───────────┼───────┤ │
│ │ ☑ │ Q1 Marketing Campaign      │ 2026-01-15 │ 2026-03-31│ 142   │ │
│ │ ☐ │ Q1 Product Launch          │ 2026-01-01 │ 2026-04-15│ 287   │ │
│ │ ☑ │ Q1 Sales Enablement        │ 2026-02-01 │ 2026-03-15│ 56    │ │
│ │ ...                                                              │ │
│ └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 9.2 Wizard header badge (Step 2–5)

```
┌─ Step 4: Import Data ───── 📋 142 of 200 projects ──────────────────┐
```

Klikken op het badge → modal met de selectie-lijst (read-only, met "Edit selection" link die terug-navigeert naar Step 1).

### 9.3 Virtualized list voor performance

Bij >50 projecten: gebruik `react-window` of equivalent voor virtual scrolling. Houdt rendering snappy bij 500–1000 projecten.

---

## 10. Edge cases & gotchas

### 10.1 Fetch zonder enkele project
PWA met 0 projecten. Toon empty state: "No projects fetched. Check PWA URL or fetch scope." Selection component rendert niet.

### 10.2 Selectie + scope: assignments aan voor geselecteerde projecten zonder assignments-data
Bij `migrationScope.assignments=false` worden assignments niet gefetcht. Filter op task count blijft werken (tasks zijn er wel) maar selectie blijft consistent. Documenteer: scope-toggle gaat over data-categorieën, selectie over project-instanties.

### 10.3 CSV upload met whitespace / encoding issues
PO project namen kunnen tabs, leading/trailing spaces, of non-printable characters bevatten. Normaliseer beide kanten van de match: `s.replace(/\s+/g, ' ').trim().toLowerCase()`.

### 10.4 CSV upload met BOM
Excel exporteert vaak UTF-8 met BOM (`\uFEFF`). Strip dit aan het begin van de eerste cel voordat matching loopt.

### 10.5 Header detection in CSV
Als eerste regel een GUID-pattern matcht: geen header. Anders: als eerste regel niet matcht met een project naam **en** de tweede regel wel: behandel eerste regel als header.

### 10.6 Shift+click over gefilterde lijst
Anchor staat op rij 3 (filtered view), shift+click op rij 8 (filtered view). Range = rijen 3–8 van **filtered view**, niet absolute index. Documenteer in code: "shift+click respects current filter".

### 10.7 Wizard back-navigatie met selectie-wijzigingen
User selecteert 20 projecten in Step 1, doet mapping in Step 2, gaat terug naar Step 1, deselecteert 5. Mapping in Step 2 blijft geldig (mapping is op veld-niveau, niet project-niveau). Geen reset nodig.

Maar: als user opnieuw fetcht (mode/scope verandert), gaat selectie **wel** verloren — dat is een nieuwe `fetchedData` en default = alles geselecteerd.

### 10.8 Hele grote selecties + parallelisatie uit `import-control-spec.md`
142 projecten met concurrency 3 = 142 / 3 ≈ 48 batches sequentieel. Combineert prima. Geen interactie nodig tussen features.

### 10.9 Selectie tijdens partial mode-switch (Direction B)
User switcht van `full` naar `dataOnly` na fetch. `fetchedData` blijft (zie addendum B §B.4), selectie blijft. Goed default.

User switcht van `schemaOnly` → `full`: re-fetch nodig (data ontbreekt). Bij re-fetch: reset selectie naar "alle geselecteerd". Documenteer.

### 10.10 Sorteren in de lijst
Default sortering: project naam alfabetisch. Klik op kolom-header sorteert. Selectie blijft persistent ongeacht sortering (`selectedProjectIds` is een Set, sorteer-onafhankelijk). "First N" en "Range" gebruiken altijd de **huidige getoonde volgorde**.

---

## 11. Acceptance criteria

De feature is klaar wanneer:

### Bulk controls
1. ✅ Na fetch is selectie default = alle projecten geselecteerd
2. ✅ "Select All" / "None" / "Invert" werken correct op volledige lijst
3. ✅ "First N" input met default 20 selecteert eerste N projecten in huidige sortering
4. ✅ "Range X–Y" selecteert subset op rij-indices
5. ✅ Shift+click selecteert range tussen anchor en doel

### Filter
6. ✅ Search-term filter werkt case-insensitive met substring match en debounce
7. ✅ Date range filters (start + finish) werken correct
8. ✅ Owner multi-select filter werkt
9. ✅ Task count range filter werkt (en is disabled als tasks niet gefetcht)
10. ✅ Custom field filters: add/remove + 4 operators werken
11. ✅ Filters combineren als AND
12. ✅ "Clear filter" reset filter zonder selectie te raken

### Filter + Bulk combinatie
13. ✅ "Select all filtered" voegt filter-resultaten toe aan selectie (union)
14. ✅ Alternatief: "Replace selection with filtered" optie zichtbaar wanneer filter actief
15. ✅ "First N" met actieve filter selecteert eerste N van **filtered** subset met duidelijke label

### CSV upload
16. ✅ CSV met project-namen (één per regel) wordt correct gematcht
17. ✅ CSV met GUIDs wordt correct gematcht
18. ✅ Mixed naam + GUID wordt correct gematcht
19. ✅ Preview toont matched / unmatched / ambiguous counts vóór toepassen
20. ✅ Ambiguous entries krijgen explicit-keuze UI
21. ✅ Apply geeft user keuze tussen union of replace

### Downstream propagatie
22. ✅ Step 4 schrijft alleen geselecteerde projecten weg (verifieer met 5 selected uit 20)
23. ✅ Tasks en assignments van niet-geselecteerde projecten worden niet doorgegeven aan writers
24. ✅ Step 5 rapport toont "Migrated X of Y selected" met juiste tellingen
25. ✅ Niet-geselecteerde projecten verschijnen niet als "failed" of "skipped" in rapport — gewoon afwezig

### UI / UX
26. ✅ Wizard header toont permanent "X of Y selected" badge vanaf Step 2
27. ✅ Klik op badge opent read-only modal met selectie
28. ✅ Virtualized list houdt rendering snappy bij 500+ projecten
29. ✅ Next-button in Step 1 disabled wanneer 0 projecten geselecteerd

### Integratie
30. ✅ Bestaande full/dataOnly/schemaOnly flows ongewijzigd (selectie heeft geen effect in schemaOnly)
31. ✅ Combinatie met `migrationScope` toggles werkt correct (orthogonale features)
32. ✅ `npm run build` passes; `pac code push` deployed cleanly

---

## 12. Implementatie volgorde (aanbevolen)

1. **State uitbreiden** (`MigrationContext` + types + reducer actions) — fundament voor de rest
2. **`ProjectListRow` + basis-lijst** met checkbox toggle, zonder filters/bulk — kleinste werkende versie
3. **Bulk controls** (`BulkActions`): All/None/Invert/First N/Range — high impact, low complexity
4. **Shift+click range select** — verfijning bovenop bulk
5. **Filter-bar zonder custom field filters** — search + date + owner + task count
6. **Filter + bulk combinatie** (Select all filtered, replace optie)
7. **Custom field filters** — meer complex, los daarna
8. **Wizard header badge** + readonly modal — globale UX-verbetering
9. **Downstream propagatie** in Step 4 (filter `fetchedData`) + Step 5 reporting
10. **CSV upload** — laagste prioriteit qua adoptie, kan als laatste

Geschatte effort: 3–4 dagen development. Stappen 1–4 dekken 70% van de pijn (bulk + range) in ~1 dag. Filter-laag (5–7) is grootste blok. CSV (10) is los toevoegbaar.

---

## 13. Open vragen (voor implementatie-tijd)

1. **Selectie-plek in wizard:** inline in Step 1 (na fetch summary) of als aparte Step 1.5 met eigen Next-button? **Aanbeveling:** inline in Step 1. Aparte stap is overhead voor een filter-actie; gebruiker is mentaal nog in "configure source" mode.

2. **Task count filter zonder tasks-fetch:** in `schemaOnly` mode of bij `migrationScope.tasks=false` zijn tasks niet beschikbaar. Disable de filter met tooltip "Task count not available — fetch tasks first"? **Aanbeveling:** ja, disable met tooltip.

3. **Owner field in PO data:** is `project.ownerName` direct beschikbaar of moet apart gefetcht worden? Verifieer in `projectOnline/projects.ts`. Als duur: lazy-load owners alleen wanneer filter geopend wordt.

4. **CSV upload feedback bij grote bestanden:** wat is een redelijke cap? 10.000 entries? Documenteer in modal "Max 10.000 entries per upload".

5. **Saved presets later:** als deze feature live gaat en gebruikers vragen om herbruikbare selecties: persistence in `localStorage` met (PWA URL, name, IDs) tuple. Out of scope voor nu.

6. **Selectie persisteren over fetch heen:** als user re-fetch (bv. PWA URL aanpast en opnieuw fetcht), gaat selectie verloren want IDs kunnen veranderd zijn. Acceptabel. Documenteer in code.
