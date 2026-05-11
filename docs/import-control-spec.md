# Feature Spec: Step 4 Import Control & Performance

> **Document type:** Implementation specification for Claude Code
> **Target codebase:** Project Online Migrator (React + TypeScript + Power Apps Code App)
> **Status:** Ready for implementation
> **Related specs:** `data-only-migration-spec.md`, `schema-only-migration-spec.md`, `data-only-migration-spec-addendum-A.md`, `data-only-migration-spec-addendum-B.md`
> **Suggested location in repo:** `docs/import-control-spec.md`

---

## 1. Context & doel

Een eerste end-to-end run op realistische schaal (200 projecten, ~16k taken, ~18k assignments, ~14k dependencies = ~48k OperationSet operations totaal) loopt sequentieel met vaste 20s sleeps tussen batches en duurt ~22 uur. Dat is voor eenmalige migraties hanteerbaar, maar te lang voor:

- Multi-tenant scenarios (meerdere klanten op rij)
- Test → prod migration cycles
- Re-runs bij gedeeltelijke failures
- Situaties waar gebruiker wil afbreken en herstarten

Bovendien mist de gebruiker:
- Zicht op resterende tijd tijdens lange runs
- Mogelijkheid om bepaalde data-categorieën (assignments, dependencies) over te slaan
- Een veilige manier om een lopende migratie te stoppen
- Bescherming tegen accidenteel browser-sluiten

**Uitbreiding:** vijf samenhangende features in Step 4, alle gericht op throughput, controle en gebruikersbeleving tijdens import:

1. Migration scope toggles
2. Parallel project processing
3. Smart inter-batch delay
4. ETA & progress indicator
5. Stop migration & browser-close safety

Deze features zijn **onafhankelijk implementeerbaar**, maar samen leveren ze een factor 3–5 throughput-verbetering en aanzienlijk betere UX.

---

## 2. Scope

### In scope
- Per-run keuze welke data-categorieën gemigreerd worden (tasks, dependencies, assignments, resources)
- Parallelle verwerking van projecten met configureerbare concurrency (default 3, override via `localStorage`)
- Slimme delay-strategie: korter (10s) tussen batches binnen één project, 0s tussen onafhankelijke projecten, met optionele active polling
- ETA-berekening op basis van rolling average van laatste N batches
- Progress indicator met huidige fase, project-counter en geschatte resterende tijd
- "Stop migration" knop met graceful stop na huidige projecten
- `beforeunload` browser warning tijdens lopende migratie

### Out of scope (voor deze iteratie)
- Resume capability na onderbreking — vereist persistent state per project, eigen spec waardig
- Cancel in-flight HTTP calls via `AbortController` — niveau 3 stop, overkill voor MVP
- Per-task scope-controle (te fijnmazig)
- Auto-retry van gefaalde batches binnen één run
- Concurrency-tuning UI control in Step 1 (alleen `localStorage` override voor nu)

---

## 3. Architecturale beslissingen

| Beslissing | Keuze | Reden |
|---|---|---|
| Scope-controle plek | Step 1, naast mode-keuze | Consistent met `migrationMode` als upfront beslissing; voorkomt mapping-werk voor velden die toch geskipt worden |
| Concurrency default | 3 | Conservatief; Dataverse throttling treedt typisch op vanaf 5–8 parallelle writes |
| Concurrency override | `localStorage.setItem('CONCURRENCY_LIMIT', '4')` | Geen UI-complexiteit; tuning mogelijk tijdens live run |
| Intra-project delay | 10s default (was 20s) | Empirische verkorting; eventual consistency duurt typisch <5s |
| Inter-project delay | 0s | Verschillende project-scopes hebben geen onderlinge state-afhankelijkheid |
| OperationSet completion check | Active polling als optimalisatie, fixed delay als fallback | Polling endpoint moet geverifieerd worden tijdens implementatie |
| ETA strategie | Rolling average over laatste 5 batches | Zelf-corrigerend bij throttling of fase-overgangen; geen complexe modellering nodig |
| Stop semantiek | Niveau 2: "stop na huidige projecten" | Voorkomt half-gemigreerde projecten; balans tussen netheid en complexiteit |
| Browser close protection | Standaard `beforeunload` listener | 2 regels code, voorkomt accidentele dataverlies |

---

## 4. Feature 1: Migration scope toggles

### 4.1 State uitbreidingen

In `MigrationContext`:

```typescript
interface MigrationState {
  // ... bestaande velden

  migrationScope: MigrationScope  // default: alles aan
}

interface MigrationScope {
  projects: true                 // altijd aan, type-level locked
  tasks: boolean                 // default true
  dependencies: boolean          // default true (impliceert tasks: true)
  assignments: boolean           // default true (impliceert tasks: true en resources: true)
  resources: boolean             // default true (impliceert door assignments)
}
```

**Cascade-regels** (afgedwongen in reducer):
- `tasks: false` → `dependencies: false` en `assignments: false` (automatisch)
- `assignments: true` → `resources: true` (automatisch)
- `dependencies: true` → `tasks: true` (automatisch)
- `projects` is altijd `true` (compile-time invariant)

Reducer action: `SET_MIGRATION_SCOPE` met cascade-logica:

```typescript
case 'SET_MIGRATION_SCOPE': {
  const requested = action.payload
  // Apply cascade rules
  const tasks = requested.tasks ?? state.migrationScope.tasks
  const dependencies = tasks ? (requested.dependencies ?? state.migrationScope.dependencies) : false
  const assignments = tasks ? (requested.assignments ?? state.migrationScope.assignments) : false
  const resources = assignments ? true : (requested.resources ?? state.migrationScope.resources)
  return {
    ...state,
    migrationScope: { projects: true, tasks, dependencies, assignments, resources }
  }
}
```

### 4.2 UI: Step 1 scope panel

Toe te voegen als nieuwe sectie in `Step1Connect/index.tsx`, **onder** de migration mode keuze, **boven** de fetch button. Volgens Direction B (`data-only-migration-spec-addendum-B.md`) is de logische volgorde:

1. Migration mode
2. **Migration scope** ← nieuw
3. Source
4. Target
5. Fetch button

Layout (verticale lijst checkboxen):

```
Migration scope (what to migrate)

☑ Projects               (always)
☑ Tasks                   ─┐
  ☑ Dependencies          ─┤ (indented, disabled if tasks off)
  ☑ Assignments           ─┘
☑ Resources               (auto-enabled when Assignments is on)
```

Tooltips op de scope-opties:
- **Tasks:** "Migrate work breakdown structure and schedule. Disable to migrate only project metadata."
- **Dependencies:** "Migrate predecessor/successor relationships between tasks. Without this, all tasks start on project start date."
- **Assignments:** "Migrate resource-to-task allocations with effort/units. Without this, tasks have no resource loading."
- **Resources:** "Migrate team members. Required if Assignments is enabled."

### 4.3 Fetch optimalisatie

De fetch in Step 1 is mode-aware (per addendum B). Voeg scope-awareness toe:

```typescript
async function runFetch(state: MigrationState): Promise<FetchResult> {
  const { migrationMode, migrationScope } = state

  if (migrationMode === 'schemaOnly') {
    // schemaOnly negeert scope; fetch alleen schema-data
    return await fetchSchemaOnlyData(state.pwaUrl)
  }

  // full / dataOnly: scope-aware fetch
  const fetched: PoFetchedData = emptyDataShape()
  fetched.customFields = await fetchCustomFields(state.pwaUrl)
  fetched.lookupTables = await fetchLookupTables(state.pwaUrl)
  fetched.projects = await fetchProjects(state.pwaUrl)

  if (migrationScope.tasks)        fetched.tasks = await fetchTasks(state.pwaUrl)
  if (migrationScope.resources)    fetched.resources = await fetchResources(state.pwaUrl)
  if (migrationScope.assignments)  fetched.assignments = await fetchAssignments(state.pwaUrl)
  // dependencies komen mee in tasks fetch (zelfde endpoint), maar worden in writer geskipt indien uit

  return { fetchedData: fetched, ...maybeSchemaSnapshot(state) }
}
```

### 4.4 Writer logic in Step 4

In `Step4Import/index.tsx`, conditioneel skippen op basis van scope:

```typescript
async function runImport(state: MigrationState) {
  const { migrationScope } = state

  // Phase 1: resources (always if enabled)
  if (migrationScope.resources) {
    await writeResources(state.fetchedData.resources, ...)
  }

  // Phase 2: projects (always)
  await writeProjects(state.fetchedData.projects, ...)

  // Phase 3: tasks (incl. dependencies as part of schedule)
  if (migrationScope.tasks) {
    await writeTasks(state.fetchedData.tasks, {
      includeDependencies: migrationScope.dependencies,
      ...
    })
  }

  // Phase 4: assignments
  if (migrationScope.assignments) {
    await writeAssignments(state.fetchedData.assignments, ...)
  }
}
```

**Belangrijk:** dependencies zitten momenteel waarschijnlijk verweven in `taskWriter.ts` (schedule rebuild rebuildt zowel taken als hun links). Refactor zodat `taskWriter` een `includeDependencies` parameter accepteert en de dependency-links-creatie skipt indien `false`.

### 4.5 Step 5 reporting

In `Step5Report/index.tsx`, toon **welke scope** is gemigreerd:

```
Migration summary
─────────────────
Scope:    Projects ✓ · Tasks ✓ · Dependencies ✗ (skipped) · Assignments ✓ · Resources ✓
```

CSV exports respecteren scope (geen lege "Assignments" sectie als die uit stond).

---

## 5. Feature 2: Parallel project processing

### 5.1 State & config

Geen state-veld nodig — concurrency is een config waarde, geen user-facing keuze in UI.

In een nieuw bestand `src/services/plannerPremium/concurrency.ts`:

```typescript
const DEFAULT_CONCURRENCY = 3
const MAX_CONCURRENCY = 8  // hard cap, hoger triggert throttling

export function getConcurrencyLimit(): number {
  if (typeof window === 'undefined') return DEFAULT_CONCURRENCY
  const override = window.localStorage.getItem('CONCURRENCY_LIMIT')
  if (!override) return DEFAULT_CONCURRENCY
  const parsed = parseInt(override, 10)
  if (isNaN(parsed) || parsed < 1) return DEFAULT_CONCURRENCY
  return Math.min(parsed, MAX_CONCURRENCY)
}
```

### 5.2 Concurrency primitive

Implementeer een eenvoudige promise pool. Geen extra dependency nodig:

```typescript
export async function runWithConcurrency<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number,
  onProgress?: (completed: number, total: number) => void
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  let completed = 0

  const runOne = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) return
      try {
        results[i] = await worker(items[i], i)
      } catch (err) {
        // Don't crash the pool; let the worker decide what to put in results
        results[i] = err as R  // caller should check Result-like shape
      }
      completed++
      onProgress?.(completed, items.length)
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runOne()
  )
  await Promise.all(workers)
  return results
}
```

### 5.3 Project-level parallelisatie in Step 4

Refactor de project-loop in `Step4Import/index.tsx`:

**Voor (sequentieel):**
```typescript
for (const project of projects) {
  await writeProjectAndChildren(project, ...)
}
```

**Na (parallel):**
```typescript
const concurrency = getConcurrencyLimit()
addLog('INFO', `Running migration with concurrency=${concurrency}`)

await runWithConcurrency(
  projects,
  async (project, idx) => {
    if (stopRequested) return { project, status: 'stopped' }
    return await writeProjectAndChildren(project, ...)
  },
  concurrency,
  (completed, total) => updateProgress({ projectsCompleted: completed, projectsTotal: total })
)
```

### 5.4 Wat parallel mag en niet mag

**Wel parallel (per project):**
- `msdyn_CreateProjectV1` voor verschillende projecten
- Task batches voor verschillende projecten
- Dependency batches voor verschillende projecten
- Assignment batches voor verschillende projecten

**NIET parallel:**
- Binnen één project blijft de volgorde tasks → dependencies → assignments **strikt sequentieel**, want ze hebben elkaar nodig
- Resources worden vóór de project-loop sequentieel aangemaakt (geen winst uit parallelisatie, kleine dataset)

### 5.5 Logging onder concurrency

Bestaande `logs: LogEntry[]` in `MigrationState` ontvangt vanuit meerdere workers parallel. JavaScript is single-threaded dus geen data-race, maar logs van verschillende projecten raken **interleaved**.

Mitigatie: prefix elke log entry met project naam:

```typescript
addLog('INFO', `[${project.name}] Created OperationSet for tasks (180 ops)`)
```

In Step 5 kan een filter-UI per project zinvol zijn als logs erg verweven raken. Niet verplicht voor MVP.

---

## 6. Feature 3: Smart inter-batch delay

### 6.1 State & config

Geen state-veld nodig — config-only.

In `src/services/plannerPremium/batchDelay.ts` (nieuw bestand):

```typescript
export interface BatchDelayConfig {
  intraProjectMs: number      // tussen batches binnen één project
  interProjectMs: number      // tussen onafhankelijke projecten
  usePolling: boolean         // active polling i.p.v. blind wachten
  pollIntervalMs: number
  pollTimeoutMs: number
}

const DEFAULT_CONFIG: BatchDelayConfig = {
  intraProjectMs: 10_000,
  interProjectMs: 0,
  usePolling: true,
  pollIntervalMs: 1_000,
  pollTimeoutMs: 60_000,
}

export function getBatchDelayConfig(): BatchDelayConfig {
  if (typeof window === 'undefined') return DEFAULT_CONFIG
  const overrides: Partial<BatchDelayConfig> = {}
  const intra = window.localStorage.getItem('BATCH_DELAY_INTRA_MS')
  if (intra) overrides.intraProjectMs = parseInt(intra, 10)
  const inter = window.localStorage.getItem('BATCH_DELAY_INTER_MS')
  if (inter) overrides.interProjectMs = parseInt(inter, 10)
  const polling = window.localStorage.getItem('BATCH_DELAY_USE_POLLING')
  if (polling === '0') overrides.usePolling = false
  return { ...DEFAULT_CONFIG, ...overrides }
}
```

### 6.2 Polling vs fixed delay

Twee strategieën, in volgorde van voorkeur:

#### Strategie A: Active polling van OperationSet status

**Open vraag (verifieer tijdens implementatie):** bestaat er een Dataverse endpoint om de status van een `OperationSet` op te vragen na `ExecuteOperationSetV1`? Mogelijke kandidaten:
- `msdyn_GetOperationSetStatusV1` (verifieer in custom connector definities)
- Direct querying `msdyn_operationset` entity records via REST
- Polling van één willekeurig record uit de batch via `GET /msdyn_projecttasks(<id>)` tot het bestaat

```typescript
async function waitForBatchCompletion(
  operationSetId: string,
  config: BatchDelayConfig
): Promise<void> {
  if (!config.usePolling) {
    await sleep(config.intraProjectMs)
    return
  }

  const start = Date.now()
  while (Date.now() - start < config.pollTimeoutMs) {
    const status = await getOperationSetStatus(operationSetId)
    if (status === 'Completed' || status === 'Succeeded') return
    if (status === 'Failed') throw new Error(`OperationSet ${operationSetId} failed`)
    await sleep(config.pollIntervalMs)
  }
  // Timeout: fallback to fixed delay
  addLog('WARN', `Polling timeout for ${operationSetId}, falling back to fixed delay`)
  await sleep(config.intraProjectMs)
}
```

#### Strategie B: Read-after-write fallback

Als geen status endpoint bestaat:

```typescript
async function waitForBatchCompletion(
  recentlyCreatedTaskId: string,
  config: BatchDelayConfig
): Promise<void> {
  if (!config.usePolling) {
    await sleep(config.intraProjectMs)
    return
  }

  const start = Date.now()
  while (Date.now() - start < config.pollTimeoutMs) {
    try {
      await dataverseClient.getRecord('msdyn_projecttasks', recentlyCreatedTaskId)
      return  // record exists, batch is processed
    } catch (err: any) {
      if (err.status !== 404) throw err
      await sleep(config.pollIntervalMs)
    }
  }
  await sleep(config.intraProjectMs)
}
```

### 6.3 Integratie in writers

In `taskWriter.ts` en vergelijkbare files, vervang elke `await sleep(20_000)` door:

```typescript
const config = getBatchDelayConfig()
// ... ExecuteOperationSetV1 ...
const operationSetId = result.OperationSetId  // of equivalent
await waitForBatchCompletion(operationSetId, config)
```

Tussen verschillende projecten (in de concurrency pool): **geen delay**. Elk project heeft een eigen scope; batches zijn onafhankelijk.

### 6.4 Failure handling

Als polling 60s timeout haalt: log een `WARN`, val terug op fixed delay, ga door. Niet faalfaste, want false negatives op polling zouden anders de hele migratie killen.

---

## 7. Feature 4: ETA & progress indicator

### 7.1 State

In `MigrationContext`, voeg toe:

```typescript
interface MigrationState {
  // ... bestaande velden

  importProgress: ImportProgress | null
}

interface ImportProgress {
  startedAt: Date
  phase: 'resources' | 'projects' | 'tasks' | 'dependencies' | 'assignments' | 'finalizing'
  currentPhaseLabel: string  // bv. "Importing tasks"
  projectsCompleted: number
  projectsTotal: number
  opsCompleted: number       // cumulatief over alle phases
  opsTotal: number           // schatting vooraf (tasks + deps + assignments + resources + projects)
  recentBatchDurations: number[]  // rolling window van laatste 5 batch-tijden (ms)
  etaMs: number | null       // null = nog niet genoeg data
}
```

Reducer actions:
- `IMPORT_PROGRESS_START` (init)
- `IMPORT_PROGRESS_UPDATE_PHASE` (fase-overgang)
- `IMPORT_PROGRESS_TICK` (batch klaar — update opsCompleted en recentBatchDurations)

### 7.2 ETA berekening

Rolling average over laatste 5 batches:

```typescript
export function calculateEta(progress: ImportProgress): number | null {
  const { recentBatchDurations, opsCompleted, opsTotal } = progress
  if (recentBatchDurations.length < 3) return null  // niet genoeg data

  const avgBatchMs = recentBatchDurations.reduce((a, b) => a + b, 0) / recentBatchDurations.length
  const opsPerBatch = 180  // OperationSet limiet
  const remainingOps = opsTotal - opsCompleted
  const remainingBatches = Math.ceil(remainingOps / opsPerBatch)
  return Math.round(remainingBatches * avgBatchMs)
}
```

### 7.3 Op-totaal vooraf inschatten

Voor `opsTotal`, schat vooraf op basis van scope:

```typescript
function estimateTotalOps(state: MigrationState): number {
  const { fetchedData, migrationScope } = state
  let total = 0
  if (migrationScope.resources)    total += fetchedData.resources.length
  total += fetchedData.projects.length  // projects always
  if (migrationScope.tasks)        total += fetchedData.tasks.length
  if (migrationScope.dependencies) total += countDependencies(fetchedData.tasks)
  if (migrationScope.assignments)  total += fetchedData.assignments.length
  return total
}
```

### 7.4 UI: Step 4 progress paneel

In `Step4Import/index.tsx`, toon onder de bestaande log-output:

```
┌─────────────────────────────────────────────────────────────┐
│ Importing: tasks                                            │
│                                                             │
│ ████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 23%      │
│                                                             │
│ Projects: 47 / 200                                          │
│ Operations: 11,200 / 48,700                                 │
│ Elapsed: 1h 12m · Remaining: ~3h 45m                        │
│                                                             │
│ Avg batch time: 12.3s (5 batches)                           │
└─────────────────────────────────────────────────────────────┘
```

Update-frequentie: elke batch (~10–15s). Voor smooth UX kan `Elapsed` per seconde live updaten via een `setInterval`.

Wanneer ETA nog niet beschikbaar is (< 3 batches): toon "Calculating..." in plaats van het tijd-getal.

### 7.5 Phase-overgangen

Bij overgang `tasks → dependencies → assignments`: reset `recentBatchDurations` (verschillende phases hebben verschillende batch-kosten). Behoud `startedAt` en cumulatieve `opsCompleted`.

```typescript
function onPhaseChange(newPhase: ImportProgress['phase']) {
  dispatch({
    type: 'IMPORT_PROGRESS_UPDATE_PHASE',
    payload: { phase: newPhase, currentPhaseLabel: `Importing ${newPhase}` }
  })
  // reset rolling window
  dispatch({ type: 'IMPORT_PROGRESS_RESET_WINDOW' })
}
```

---

## 8. Feature 5: Stop migration & browser-close safety

### 8.1 State

```typescript
interface MigrationState {
  // ... bestaande velden

  stopRequested: boolean  // default false
}
```

Reducer actions: `REQUEST_STOP`, `CLEAR_STOP_REQUEST` (op nieuwe import-start).

### 8.2 Stop-knop in Step 4

In het progress paneel (§7.4), naast of onder de progress info, een rode knop:

```
[ Stop migration ]
```

Click handler:

```typescript
async function handleStopClick() {
  const confirmed = window.confirm(
    `Stop migration after current projects complete?\n\n` +
    `Up to ${concurrency} projects in progress will finish first. ` +
    `Subsequent projects will be skipped. Partial results will be available in the report.`
  )
  if (!confirmed) return

  dispatch({ type: 'REQUEST_STOP' })
  addLog('WARN', 'Stop requested by user — finishing current projects')
}
```

### 8.3 Stop-check in concurrency pool

In de `runWithConcurrency` worker (§5.2), check tussen items:

```typescript
const runOne = async (): Promise<void> => {
  while (true) {
    if (stopRequestedRef.current) return  // graceful exit
    const i = nextIndex++
    if (i >= items.length) return
    // ... process item
  }
}
```

Belangrijk: gebruik een `useRef` (of equivalent) zodat workers de **actuele** waarde van `stopRequested` zien, niet de stale waarde van toen ze gestart zijn.

### 8.4 UI state tijdens stop

Wanneer `stopRequested === true`:
- Stop-knop wordt `disabled` met label "Stopping... (X projects to finish)"
- X = aantal projecten momenteel in flight (== `concurrency` of minder aan het einde)
- Progress paneel toont oranje statusbalk i.p.v. blauwe
- Logs krijgen entry per voltooid project: `"[ProjectName] Completed (stopping after)"`

Na alle in-flight projecten klaar:
- Status: "Stopped — partial migration"
- Wizard gaat door naar Step 5 met een gemarkeerd report

### 8.5 Step 5 partial report

In `Step5Report/index.tsx`, conditioneel render een banner indien stopped:

```
⚠ This migration was stopped by user before completing.
   Migrated: 73 of 200 projects
   Remaining 127 projects were not processed.
```

`importResults` per project krijgt een nieuwe status:

```typescript
type ProjectImportStatus = 'success' | 'failed' | 'skipped' | 'not_started'
//                                                              ^ nieuw
```

Projecten die nooit gestart zijn vanwege stop krijgen `not_started`. Projecten die mid-stop nog afgerond werden krijgen `success` of `failed`.

### 8.6 Browser close protection

In een nieuw `src/hooks/useBrowserCloseGuard.ts`:

```typescript
import { useEffect } from 'react'

export function useBrowserCloseGuard(active: boolean) {
  useEffect(() => {
    if (!active) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''  // required for Chrome
      return ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [active])
}
```

Gebruik in `Step4Import`:

```typescript
const isImporting = state.importProgress !== null && state.importProgress.phase !== 'finalizing'
useBrowserCloseGuard(isImporting)
```

Browsers tonen een generieke dialog ("Wijzigingen die je hebt aangebracht worden mogelijk niet opgeslagen"). Het is niet mogelijk een custom message te tonen om security-redenen — accepteer dit.

### 8.7 Documentatie in code

In `Step4Import/index.tsx`, voeg een comment toe:

```typescript
// Note: closing the browser tab during import will:
// 1. Show a browser confirmation dialog (beforeunload listener)
// 2. If confirmed, stop the JavaScript loop immediately
// 3. In-flight HTTP requests already sent to Dataverse will complete server-side
// 4. Records partially created may need manual cleanup
//
// For a clean stop, use the "Stop migration" button instead.
```

---

## 9. Edge cases & gotchas

### 9.1 Scope: assignments aan, resources uit
Cascade-logica zou dit moeten voorkomen, maar als state via JSON import binnenkomt met inconsistente scope: detecteer in `Step4Import` entry, toon error, dwing user terug naar Step 1.

### 9.2 Concurrency override boven hard cap
`MAX_CONCURRENCY = 8`. Override naar 20 → wordt geclampt naar 8 met log warning. Voorkomt user-error met catastrophic throttling.

### 9.3 Polling timeout in productie
Default 60s polling timeout. Bij hele zware batches (180 complex tasks met veel custom fields) kan dit niet genoeg zijn. Override via `localStorage.setItem('BATCH_DELAY_POLL_TIMEOUT_MS', '120000')` indien nodig.

### 9.4 ETA in eerste minuten
Met 3-batch minimum is ETA pas na ~30s beschikbaar. Toon "Calculating..." duidelijk; geen 99h 99m placeholder.

### 9.5 ETA bij phase-overgang
Reset rolling window bij phase change. Eerste 3 batches van nieuwe phase = "Calculating..." opnieuw. Acceptabel voor de UX-correctheid.

### 9.6 Stop tijdens phase-overgang
Als stop tijdens task-fase wordt aangevraagd, maar de in-flight projecten zitten al in dependencies-fase: laat ze de huidige phase voor hun project afmaken. Voorkomt projecten met tasks maar zonder dependencies.

### 9.7 Stop + beforeunload combinatie
User klikt Stop, krijgt confirmatie, in-flight projecten lopen door. User wordt ongeduldig, sluit tab. `beforeunload` triggert. User confirms. **Resultaat:** zelfde als nu zonder Stop-knop — pending requests landen, rest niet. Documenteer in UI: "Stopping... do not close the browser until complete."

### 9.8 Parallel logging interleaving
Met 3 projecten parallel kunnen logs van 3 verschillende projecten elkaar overlappen. Project-prefix in elke log entry (§5.5) lost dit op, maar Step 5 kan baat hebben bij filter-knop per project. Out of scope voor MVP, optionele future enhancement.

### 9.9 Resources fase + parallelisatie
Resources draaien **vóór** de project-loop, sequentieel. Geen parallelisatie nodig (kleine dataset typisch). Documenteer dit zodat een toekomstige optimalisatie-poging niet de verkeerde fase aanpakt.

### 9.10 ETA precisie bij snelle vs trage batches
Rolling average over 5 batches is gevoelig voor één outlier. Bij batch van 60s na 4 batches van 10s wordt ETA tijdelijk inaccurate. Acceptabel; volgende batches normaliseren weer. Geen median nodig.

---

## 10. Acceptance criteria

De feature-set is klaar wanneer:

### Feature 1: Scope toggles
1. ✅ Step 1 toont scope-panel onder mode-keuze, boven fetch-button
2. ✅ Cascade-regels werken: tasks=off zet dependencies/assignments op off en disable de checkboxes
3. ✅ assignments=on zet resources op on (verplicht)
4. ✅ Fetch in Step 1 slaat de uitgeschakelde categorieën over (verifieer in network tab)
5. ✅ Step 4 schrijft alleen ingeschakelde categorieën weg
6. ✅ Step 5 rapport toont welke scope gemigreerd is

### Feature 2: Parallel projects
7. ✅ Default 3 projecten draaien parallel in Step 4
8. ✅ `localStorage.setItem('CONCURRENCY_LIMIT', '5')` past concurrency aan na page reload
9. ✅ Hard cap 8: override naar 20 wordt geclampt
10. ✅ Logs binnen één project blijven in volgorde; cross-project logs zijn interleaved met project-prefix
11. ✅ End-to-end test: 12 projecten met concurrency 3 voltooit aantoonbaar sneller dan concurrency 1 (factor 2.5–3x)

### Feature 3: Smart delay
12. ✅ Intra-project delay = 10s (was 20s) bij fixed-delay fallback
13. ✅ Inter-project delay = 0s (verifieer: geen wait tussen project A finish en project B start)
14. ✅ Active polling, indien endpoint beschikbaar, completes batches in <5s gemiddeld i.p.v. 10s
15. ✅ Polling fallback naar fixed delay bij timeout zonder de migratie te killen
16. ✅ `localStorage` overrides voor intra/inter/use_polling werken

### Feature 4: ETA & progress
17. ✅ Progress paneel toont in Step 4 tijdens import
18. ✅ Toont: huidige fase, projecten X/Y, ops X/Y, elapsed time, ETA
19. ✅ ETA toont "Calculating..." gedurende de eerste 3 batches per phase
20. ✅ Bij stabiele tempo (na ~5 batches) is ETA binnen ±20% accuraat over een 10-minuten run

### Feature 5: Stop & browser safety
21. ✅ Rode "Stop migration" knop zichtbaar in Step 4 progress paneel
22. ✅ Click → confirm dialog → graceful stop na huidige projecten
23. ✅ In-flight projecten ronden af; nieuwe projecten worden geskipt
24. ✅ Step 5 toont partial report banner + `not_started` status voor geskipte projecten
25. ✅ Browser close tijdens import triggert `beforeunload` dialog
26. ✅ Na confirm sluit tab; reeds-verzonden requests landen alsnog server-side

### Integratie
27. ✅ Bestaande `full` en `dataOnly` flows zijn ongewijzigd qua functionaliteit (alleen sneller)
28. ✅ `schemaOnly` mode negeert scope-toggles correct (geen data-import sowieso)
29. ✅ `npm run build` passes, `pac code push` deployed cleanly

---

## 11. Implementatie volgorde (aanbevolen)

Onafhankelijk implementeerbaar, maar deze volgorde minimaliseert merge-conflicten en maakt elke feature los testbaar:

1. **Feature 1 (scope)** — pure state + UI, geen runtime risico. Test eerst zonder de andere features.
2. **Feature 4 (ETA & progress)** — instrumentatie. Voegt geen risico toe, maakt features 2 en 3 wel meetbaar.
3. **Feature 3 (smart delay)** — kleine change met directe meetbare winst. Test impact via ETA-uitlezing.
4. **Feature 2 (parallel)** — grootste change. Met ETA in plaats is winst direct zichtbaar; met smart delay al actief is parallelisatie veiliger.
5. **Feature 5 (stop & browser safety)** — afsluiter. Logisch ná parallel omdat stop-semantiek anders complexer wordt mid-implementation.

Geschatte effort: 4–6 dagen development voor een ervaren dev op deze codebase. Features 1, 3 en 5 zijn elk 0.5–1 dag. Features 2 en 4 zijn elk 1–1.5 dag inclusief tests.

---

## 12. Open vragen (voor implementatie-tijd)

1. **Bestaat er een OperationSet status endpoint?** Onderzoek `msdyn_GetOperationSetStatusV1` of equivalent. Indien niet: gebruik read-after-write fallback (§6.2 strategie B).

2. **Dependency-creatie volgorde:** zit dependencies-write momenteel verweven in `taskWriter.ts` of in een aparte writer? Beïnvloedt hoe `migrationScope.dependencies` toggle aansluit (§4.4).

3. **Resources count voor scope-validatie:** moet `assignments=on, resources=on, fetchedData.resources=[]` een waarschuwing geven (geen resources om aan te toewijzen)? Of stilletjes 0 assignments schrijven? **Aanbeveling:** waarschuwing in Step 4 entry, niet blokkerend.

4. **Stop-state persistence:** als user de browser refresht tijdens een actieve stop, gaat `stopRequested` verloren. **Aanbeveling:** geen persistence — refresh = effectief een "harde stop", documenteren in code.

5. **ETA tijdens parallelle execution:** met 3 projecten parallel kunnen 3 batches gelijktijdig draaien. Rolling window bevat dan een mix. **Aanbeveling:** verzamel batch-durations onafhankelijk van project; pool-gemiddelde is een prima proxy voor doorvoer.

6. **Logging cap:** met parallel + ETA + scope kan log-volume hard groeien. Cap bij 10.000 entries met "..." indicator? **Aanbeveling:** ja, met laatste 10k behouden (FIFO). Out of scope voor deze spec, openen als aparte issue indien nodig.
