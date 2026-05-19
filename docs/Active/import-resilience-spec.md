# Feature Spec: Import Resilience — Duplicate Handling, Batch Retry, Dependency Throttling

> **Document type:** Implementation specification for Claude Code
> **Target codebase:** Project Online Migrator (React + TypeScript + Power Apps Code App)
> **Status:** Ready for implementation
> **Related specs:** `data-only-migration-spec.md`, `import-control-spec.md`, `2026-05-fixes-full-mode-customfields-lookup-reset.md`
> **Suggested location in repo:** `docs/import-resilience-spec.md`

---

## 1. Context & doel

Een productie-run tegen een grote PWA (~200 projecten, ~16k tasks) heeft 555 errors in het Step 5 rapport opgeleverd. Analyse toont dat de meerderheid van die errors **collateral damage** is van drie specifieke zwakke plekken in de write-laag, niet 555 onafhankelijke fouten:

| Categorie | Count | Echte fouten (geschat) | Collateral |
|---|---|---|---|
| `TASK_DUPLICATE_EXISTS` (`0x80040265`, "bestaat al") | 51 | 0 — moet skip-as-success zijn | 51 |
| `TASK_OUTLINE_DEMOTE_TOO_FAR` (`E_DEMOTETOOFAR`) | 83 | 1 (alle 83 wijzen op zelfde task GUID in zelfde batch) | 82 |
| `BACKEND_TIMEOUT` (forward-request) | 194 | 2 timed-out HTTP requests | 192 |
| `DEPENDENCY_MISSING_TASK` | 217 | Symptom van bovenstaande 3 | ~200 |
| `DEPENDENCY_TYPE_UNSUPPORTED` (SS/FF/SF) | 10 | 10 (license constraint, niet code) | 0 |

**Conclusie:** met de drie fixes in deze spec wordt de error count verwacht te dalen van 555 naar onder de 25, zonder een enkele bugfix in de eigenlijke business logic.

**Filosofie:**
- Server-side write errors moeten **per record geclassificeerd** worden, niet per batch
- "Already exists" is een **expected outcome**, geen failure
- `E_BATCHFAILED` met `failedBatchRequestIndex: N` wijst één element aan — alleen die ene moet falen
- HTTP gateway timeouts zijn **transient** en behoren retried te worden met backoff
- Dependencies hebben dezelfde 180-per-batch limiet als tasks; dat moet expliciet zijn in code

---

## 2. Scope

### In scope
- **Phase 1** — `TASK_DUPLICATE_EXISTS` (`0x80040265`) toevoegen aan skip-as-success set in alle writers; content-level detectie van "already exists" / "bestaat al"
- **Phase 2** — `E_BATCHFAILED` partial-retry logic in `scheduleApi.ts`: zodra een batch faalt op één element, retry de batch zonder dat element; outline-level pre-validation tegen in-batch parents
- **Phase 3** — Dependency writer: expliciete 180-per-batch cap, inter-batch delay (zoals bij tasks), retry-on-timeout met exponential backoff
- **Phase 4** — Step 5 rapport: rollup van non-FS dependency warnings; onderscheid "blocked-by-failed-task" vs "orphan" dependency errors
- Logging-laag: `LogEntry` categorisatie zodat retry-events zichtbaar zijn voor support

### Out of scope (voor deze iteratie)
- Schedule API alternatives voor non-FS dependencies (zou Project Plan 3+ licentie vereisen)
- Project-level resume (na crash verder gaan waar gebleven) — bestaande stop-control blijft het mechanisme
- Async / polling-based OperationSet execution — huidige synchroon-blocking pattern blijft
- Aanpassen van project- of resource-writer skip-logica voorbij toevoegen van de nieuwe error code

---

## 3. Architecturale beslissingen

| Beslissing | Keuze | Reden |
|---|---|---|
| Duplicate detectie | Hybride: error code lijst + content fallback | Codes wijken af tussen API surfaces; localisatie geeft Dutch/English messages |
| Skip-as-success grens | Alleen voor "already exists" semantiek — geen andere `0x*` codes silent slikken | Voorkomt verbergen van echte fouten |
| Partial batch retry | Single-element exclude, één retry-pass | Tweede `E_BATCHFAILED` op andere index = recursieve exclude tot batch leeg of slaagt; bounded |
| Outline-level validatie | Recompute uit in-batch parent set, niet uit source data | Filter/scope toggles kunnen tussenliggende parents weggelaten hebben |
| Timeout retry strategy | 3 pogingen, exponential backoff (2s, 5s, 12s) | Past bij Power Platform gateway 120s timeout; 3× is industry-standard |
| Retry idempotency | Vertrouwen op skip-as-success voor accidentele dubbele writes | Phase 1 maakt retry veilig |
| Dependency batch size | 180 ops, gelijk aan tasks | OperationSet API documenteert deze limiet uniform |
| Inter-batch delay | Hergebruik bestaande `import-control` delay logica | Single source of truth voor throttling |
| Error report grouping | Rollup per (code, project) in Step 5 | 200 identieke errors als 1 entry met expand verbetert leesbaarheid |
| Backwards compat | Geen wijziging aan happy-path code paths; alleen aanvullingen aan error-handlers + retry-wrappers | Bestaande succesvolle runs blijven identiek |

---

## 4. Phase 1 — Duplicate handling uitbreiding

### 4.1 Probleem

Huidige skip-as-success set (per `migrator-project-context.md`): `0x80044331`, `0x80060891`. De ontbrekende code is `0x80040265` met message format:

```
ScheduleAPI-EV-0007:<projectId>: De rij met id <guid> in de tabel msdyn_projecttask bestaat al.
```

Engelstalige tenants krijgen vermoedelijk `... already exists in the msdyn_projecttask table` — exacte string moet geverifieerd worden tijdens implementatie.

### 4.2 Implementatie

**Locatie:** Vermoedelijk een centrale helper of error-classifier. Als die niet bestaat, maak `src/services/plannerPremium/errorClassifier.ts`:

```typescript
export type DataverseErrorClass =
  | 'AlreadyExists'         // Skip as success
  | 'OutlineDemoteTooFar'   // Batch retry candidate
  | 'BatchFailed'           // Batch retry candidate
  | 'Timeout'               // Retry candidate
  | 'Throttled'             // Retry candidate with longer backoff
  | 'NonFSDependency'       // Known limitation, report as info
  | 'PredecessorMissing'    // Downstream from task failure
  | 'Other'                 // Surface as error

const ALREADY_EXISTS_CODES = new Set([
  '0x80044331',
  '0x80060891',
  '0x80040265',  // NEW — ScheduleAPI duplicate row
])

const ALREADY_EXISTS_PHRASES = [
  'already exists',     // en-US
  'bestaat al',         // nl-NL
  // Add more as encountered
]

export function classifyDataverseError(raw: unknown): DataverseErrorClass {
  const { code, message } = extractCodeAndMessage(raw)

  if (code && ALREADY_EXISTS_CODES.has(code)) return 'AlreadyExists'
  if (message && ALREADY_EXISTS_PHRASES.some(p => message.toLowerCase().includes(p))) {
    return 'AlreadyExists'
  }

  if (message?.includes('E_DEMOTETOOFAR')) return 'OutlineDemoteTooFar'
  if (message?.includes('E_BATCHFAILED')) return 'BatchFailed'

  if (code === '0x80040224' && message?.includes('Timeout')) return 'Timeout'
  if (message?.match(/timed out/i)) return 'Timeout'

  if (message?.match(/throttl/i) || code === '0x80072322') return 'Throttled'

  // ... rest
  return 'Other'
}

function extractCodeAndMessage(raw: unknown): { code?: string; message?: string } {
  // Handle the nested-JSON-in-string format used by Dataverse:
  //   { error: { code, message: '{"code": ..., "message": "..."}' } }
  // Walk through up to 3 levels of stringified-JSON nesting.
  // ASSUMPTION: existing code already has helper for this — reuse if so.
  // ...
}
```

### 4.3 Call sites

In `taskWriter.ts`, `projectWriter.ts`, `assignmentWriter.ts`, `resourceWriter.ts` — vervang elke check op de hardcoded codes door:

```typescript
import { classifyDataverseError } from './errorClassifier'

// In catch block:
const cls = classifyDataverseError(err)
if (cls === 'AlreadyExists') {
  state.skippedAsExisting++
  log.info(`Record ${entityId} already exists — treated as success`)
  return { status: 'skipped' }
}
// ... rest of error handling
```

Behoud bestaande `state.skippedAsExisting` counter; expose in import results zodat het zichtbaar blijft hoeveel records er overgeslagen werden (niet als errors gerapporteerd).

### 4.4 Reporting

Step 5 rapport: "Already-existing records skipped: N" — als info-counter, geen warning. Onderscheidt zich van failures.

### 4.5 Acceptance

- ✅ Run tegen een omgeving waar tasks al bestaan voor één project: 0 errors gerapporteerd, N records gemeld als "already existed"
- ✅ Dutch en English error messages beide herkend
- ✅ Andere `0x*` codes worden NIET silent geslikt
- ✅ Bestaande happy-path (geen duplicates) is gedragsidentiek

---

## 5. Phase 2 — Batch retry op partial failure

### 5.1 Probleem

`msdyn_ExecuteOperationSetV1` faalt atomair: één bad element (typisch `E_DEMOTETOOFAR` of een vergelijkbare schedule-validation error) crasht de hele batch. De response bevat `failedBatchRequestIndex: N` die exact het probleemelement aanwijst. Huidige code logt elk element in de batch als gefaald.

### 5.2 Implementatie in `scheduleApi.ts`

Refactor de huidige execute wrapper naar een retry-aware variant:

```typescript
interface BatchExecuteResult {
  successCount: number
  failures: Array<{ element: PssOperation; reason: string }>
}

async function executeOperationSetWithRetry(
  operationSetId: string,
  operations: PssOperation[],
  options: { maxRetries?: number } = {},
): Promise<BatchExecuteResult> {
  const maxRetries = options.maxRetries ?? operations.length  // worst case: every op fails individually
  const failures: BatchExecuteResult['failures'] = []
  let working = [...operations]
  let attempts = 0

  while (working.length > 0 && attempts < maxRetries) {
    attempts++
    try {
      // ASSUMPTION: existing code creates OperationSet + adds ops + executes
      // For retry, we need to create a NEW OperationSet each pass (cannot re-execute a failed one)
      const newOpSetId = await createOperationSet()
      for (const op of working) {
        await pssCreate(newOpSetId, op)
      }
      await executeOperationSet(newOpSetId)
      return { successCount: working.length, failures }
    } catch (err) {
      const idx = extractFailedBatchRequestIndex(err)
      const cls = classifyDataverseError(err)

      if (idx !== null && idx >= 0 && idx < working.length) {
        // Pinpointed failure — exclude it and retry the rest
        const failed = working[idx]
        const reason = extractErrorMessage(err)
        failures.push({ element: failed, reason })
        log.warn(`Batch retry: excluding element ${failed.id} (${cls}: ${reason})`)
        working = working.filter((_, i) => i !== idx)
        continue
      }

      // Untargeted failure — cannot isolate; whole remaining batch fails
      for (const op of working) {
        failures.push({ element: op, reason: 'Batch failed without element index' })
      }
      return { successCount: 0, failures }
    }
  }

  return { successCount: operations.length - failures.length, failures }
}

function extractFailedBatchRequestIndex(err: unknown): number | null {
  // Parse the nested JSON:
  //   { error: { code: '0x80040224', message: '{"failedBatchRequestIndex": 0, ...}' } }
  // Returns null if not present.
}
```

### 5.3 Outline-level pre-validation

Voorkomt veel `E_DEMOTETOOFAR` errors zonder retry-roundtrip. Voor elke batch tasks die naar PSS gaat:

```typescript
function validateAndNormalizeOutlineLevels(
  tasks: PoTask[],
  alreadyCommittedTaskIds: Set<string>,
): { ready: PoTask[]; deferred: PoTask[]; warnings: string[] } {
  const ready: PoTask[] = []
  const deferred: PoTask[] = []
  const warnings: string[] = []
  const inBatchById = new Map<string, PoTask>(tasks.map(t => [t.TaskId, t]))

  // Sort by OutlineLevel asc, then OutlineNumber lexicographic
  const sorted = [...tasks].sort((a, b) => {
    const lvl = (a.OutlineLevel ?? 1) - (b.OutlineLevel ?? 1)
    if (lvl !== 0) return lvl
    return (a.OutlineNumber ?? '').localeCompare(b.OutlineNumber ?? '')
  })

  const committedInThisBatch = new Set<string>()

  for (const t of sorted) {
    const declaredLevel = t.OutlineLevel ?? 1

    if (declaredLevel === 1) {
      ready.push(t)
      committedInThisBatch.add(t.TaskId)
      continue
    }

    const parentId = t.TaskParentId
    if (!parentId) {
      // Level > 1 but no parent ref — clamp to level 1, warn
      warnings.push(`Task ${t.TaskId}: OutlineLevel ${declaredLevel} but no parent. Clamped to level 1.`)
      ready.push({ ...t, OutlineLevel: 1 })
      committedInThisBatch.add(t.TaskId)
      continue
    }

    const parentAvailable =
      alreadyCommittedTaskIds.has(parentId) || committedInThisBatch.has(parentId)

    if (!parentAvailable) {
      // Parent not yet present — defer to next batch
      deferred.push(t)
      continue
    }

    const parent =
      inBatchById.get(parentId) ??
      // ASSUMPTION: previous-batch parent levels need to be retrievable; cache them or pass through
      { OutlineLevel: declaredLevel - 1 } as PoTask

    const allowedLevel = (parent.OutlineLevel ?? 1) + 1
    if (declaredLevel !== allowedLevel) {
      warnings.push(`Task ${t.TaskId}: OutlineLevel ${declaredLevel} adjusted to ${allowedLevel} to match parent.`)
    }
    ready.push({ ...t, OutlineLevel: allowedLevel })
    committedInThisBatch.add(t.TaskId)
  }

  return { ready, deferred, warnings }
}
```

**Multi-batch handoff:** deferred tasks worden naar de volgende batch verschoven; als ze daar nog niet kunnen, opnieuw deferred. Cap op 3 herplaatsings-rondes; daarna falen ze met klare melding ("Parent task could not be created — task could not be placed").

### 5.4 Cache van committed parent levels

Buiten de batch-loop houdt de orchestrator (waar de PSS batch-loop draait) een `Map<string, number>` bij van succesvol gecommiteerde `taskId → outlineLevel`. Bij start van elke nieuwe batch wordt deze map als `alreadyCommittedTaskIds` parameter doorgegeven.

### 5.5 Integratie in task write flow

```typescript
async function writeTasksForProject(project, tasks, log) {
  const committedLevels = new Map<string, number>()
  let queue = [...tasks]
  let placementRound = 0

  while (queue.length > 0 && placementRound < 3) {
    placementRound++
    const batches = chunk(queue, MAX_BATCH_SIZE)  // 180
    const nextRoundDeferred: PoTask[] = []

    for (const batch of batches) {
      const committed = new Set(committedLevels.keys())
      const { ready, deferred, warnings } = validateAndNormalizeOutlineLevels(batch, committed)
      warnings.forEach(w => log.warn(w))

      if (ready.length > 0) {
        const result = await executeOperationSetWithRetry(/* ... */)
        for (const t of ready) {
          if (!result.failures.find(f => f.element.id === t.TaskId)) {
            committedLevels.set(t.TaskId, t.OutlineLevel ?? 1)
          }
        }
        result.failures.forEach(f => log.error(`Task ${f.element.id}: ${f.reason}`))
      }

      nextRoundDeferred.push(...deferred)
      await delayBetweenBatches()  // from import-control
    }

    queue = nextRoundDeferred
  }

  if (queue.length > 0) {
    queue.forEach(t => log.error(`Task ${t.TaskId}: parent could not be placed after 3 rounds`))
  }
}
```

### 5.6 Acceptance

- ✅ Een batch met één corrupt `outlineLevel` element commit 179 tasks en faalt enkel die ene
- ✅ Re-run met dezelfde inputs is idempotent (skip-as-success from Phase 1 fangs het op)
- ✅ Tasks waarvan de parent in dezelfde batch zit, krijgen `outlineLevel` automatisch genormaliseerd naar `parent.level + 1`
- ✅ Tasks waarvan de parent in een eerdere batch zit, gebruiken de `committedLevels` cache
- ✅ Tasks die na 3 placement-rondes nog steeds geen parent hebben, falen met klare melding
- ✅ `E_BATCHFAILED` zonder `failedBatchRequestIndex` faalt nog steeds de hele batch — geen silent degradation
- ✅ Logs bevatten retry-events voor support: "Batch retry: excluding element X"

---

## 6. Phase 3 — Dependency batching + timeout retry

### 6.1 Probleem

194 `forward-request` timeouts in een 2-minuten venster, geclusterd op 2 `clientRequestId` waarden. Dit betekent: 2 HTTP requests timed out, en het client-side error pad rapporteerde de timeout per dependency record dat in die request zat (97 + 94 = 191). De resterende 3 zijn echte losse timeouts.

Root cause: **dependencies worden vermoedelijk in één grote OperationSet gestopt** (of er is geen retry-on-timeout op de gateway).

### 6.2 Dependency batch size cap

In `assignmentWriter.ts` of waar dependencies geschreven worden — pas dezelfde 180-per-batch cap toe als tasks:

```typescript
const DEPENDENCY_BATCH_SIZE = 180  // Same as PSS task limit

async function writeDependencies(projectId: string, deps: PoDependency[], log) {
  const supported = deps.filter(d => d.Type === 'FS')
  const unsupported = deps.filter(d => d.Type !== 'FS')

  unsupported.forEach(d => log.info(
    `Dependency ${d.DependencyId} (${d.Type}) skipped — Planner Premium requires FS type`
  ))

  const batches = chunk(supported, DEPENDENCY_BATCH_SIZE)
  for (const batch of batches) {
    await executeOperationSetWithRetry(/* ... */)
    await delayBetweenBatches()
  }
}
```

### 6.3 Timeout retry wrapper

Wrap de HTTP-niveau call (`performUnboundAction`, of waar de gateway-call gebeurt) in een retry-met-backoff helper. Idealiter centraal in `dataverseClient.ts`:

```typescript
interface RetryOptions {
  maxAttempts?: number       // default 3
  baseDelayMs?: number       // default 2000
  retryOn?: DataverseErrorClass[]  // default ['Timeout', 'Throttled']
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3
  const baseDelay = options.baseDelayMs ?? 2000
  const retryOn = options.retryOn ?? ['Timeout', 'Throttled']
  let lastErr: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const cls = classifyDataverseError(err)
      if (!retryOn.includes(cls) || attempt === maxAttempts) {
        throw err
      }
      const delay = baseDelay * Math.pow(2.5, attempt - 1)  // 2s, 5s, 12.5s
      const jitter = Math.random() * 500
      log.info(`Transient error (${cls}), retry ${attempt}/${maxAttempts - 1} in ${Math.round(delay + jitter)}ms`)
      await sleep(delay + jitter)
    }
  }
  throw lastErr
}
```

Gebruik in `dataverseClient.performUnboundAction`:

```typescript
export async function performUnboundAction(name: string, params: unknown) {
  return withRetry(() => /* existing call */)
}
```

**Idempotency check:** dit is veilig omdat:
- `msdyn_CreateProjectV1` / `msdyn_CreateTeamMemberV1` retries worden door Phase 1's skip-as-success opgevangen als er per ongeluk twee writes plaatsvinden
- `msdyn_ExecuteOperationSetV1` is server-side eenmalig (heeft een operationSetId) — re-execute geeft een error dat de opSet al uitgevoerd is, wat eveneens "AlreadyExists"-achtig gedrag is

Verifieer tijdens implementatie of `ExecuteOperationSetV1` zelf safe-retryable is; als niet, sluit het uit van retry en alleen de createOpSet + pssCreate calls retryen, met fresh opSetId bij retry.

### 6.4 Gateway timeout = 120s

Power Platform's forward-request limiet is doorgaans 120s. Een batch die 180 ops bevat en daarmee 100+s pakt staat dichtbij die limiet. Recommendation: **monitor de p95 execution time per batch**; als die boven 90s komt, halveer dynamisch de batch size voor de volgende cycli. Niet voor MVP — voorlopig hardcoded 180.

### 6.5 Acceptance

- ✅ Een dependency-import van 5000 deps draait in batches van 180 met de standaard inter-batch delay
- ✅ Een timeout op een batch wordt tot 2× retried met exponential backoff (2s, 5s)
- ✅ Na 3 mislukte pogingen worden de elementen in die batch gefaald gerapporteerd
- ✅ `clientRequestId` van elke retry is uniek; logs tonen retry-attempts
- ✅ Non-FS dependencies worden upfront uitgefilterd, niet aan PSS aangeboden, en gerapporteerd als info-warnings

---

## 7. Phase 4 — Step 5 rapport rollup

### 7.1 Probleem

Het huidige rapport toont elk dependency-record met "Predecessor or successor task was not imported" als een aparte regel. 217 daarvan = 217 regels van dezelfde melding. Onbruikbaar.

### 7.2 Reporting model

Voeg `errorClass` toe aan `ImportResult` / `LogEntry`:

```typescript
interface ImportError {
  entity: 'Project' | 'Task' | 'Resource' | 'Assignment' | 'Dependency' | 'TeamMember'
  sourceId: string
  timestamp: string
  errorClass: DataverseErrorClass | 'BlockedByMissingTask' | 'Other'
  message: string
  projectId?: string  // for grouping
}
```

In Step 5 rendering: group by `errorClass`, dan by `projectId` waar zinvol:

```
✗ Import failures (24)
─────────────────────
  Tasks: 1 error
    · OutlineDemoteTooFar: 1 task — [Expand]
        F4536...  Outline level invalid relative to in-batch parents

  Dependencies: 13 errors
    · NonFSDependency: 10 — Planner Premium FS-only (license constraint)
      [Expand: list with type breakdown SS=5 FF=3 SF=2]
    · BlockedByMissingTask: 3 — Predecessor or successor was not imported
      [Expand: 3 dependency IDs with referenced task IDs]

ℹ Records skipped (51)
─────────────────────
  · Already existed in target: 51 tasks across 2 projects
    [Expand by project]
```

### 7.3 CSV export structure

`migration-errors.csv` blijft beschikbaar met **alle rows** ongegroepeerd (huidig formaat), maar krijgt een extra `ErrorClass` kolom voor downstream analyse. Bestaande kolommen ongewijzigd voor backwards compat met evt. customer-side scripts.

### 7.4 Acceptance

- ✅ Step 5 toont rollup-groepen i.p.v. 200+ identieke regels
- ✅ Each groep heeft `[Expand]` om de individuele records te zien
- ✅ CSV export bevat `ErrorClass` kolom met de classificatie
- ✅ Skipped-as-existing wordt apart gerapporteerd van failures
- ✅ Non-FS dependencies hebben hun eigen sectie met license-context

---

## 8. Edge cases & gotchas

### 8.1 ExecuteOperationSetV1 re-execute
Verifieer in een spike of `msdyn_ExecuteOperationSetV1` op een al-uitgevoerde opSetId een retry-safe error gooit, of een echte schade veroorzaakt. Als onveilig: bij retry altijd een nieuwe opSetId aanmaken (huidige design in §5.2 doet dit al).

### 8.2 Localized error messages
Tenants kunnen elke Dataverse-supported locale gebruiken. Phase 1 dekt Dutch en English. Voeg German/French/Spanish toe op feedback. Tot dan: code-based detectie (set van `0x*` codes) is de primaire signal; content-based is fallback.

### 8.3 Outline-level cache groei
`committedLevels` Map kan voor grote projecten 10k+ entries bevatten. Memory-impact verwaarloosbaar (~500KB) maar wel buiten de batch-loop scope. Reset per project, niet per batch.

### 8.4 Dependent retry storms
Phase 3's retry wrapper en Phase 2's batch retry kunnen *cascaderen*: een dependency-batch timeout retried 3× (Phase 3), elke retry kan zelf één element falen (Phase 2). Worst-case: 3 × 180 = 540 retries voor 1 batch van 180 deps. Acceptabel bij goede backoff; cap totaal retry budget per project op 100 attempts om runaway scenarios af te vangen.

### 8.5 Stop migration tijdens retry
Bestaande stop-control in `import-control` moet de retry-loops kunnen onderbreken. Voeg `signal: AbortSignal` toe aan `withRetry()` en `executeOperationSetWithRetry()` zodat de stop-check elke iteratie geraakt wordt.

### 8.6 Skip-as-success counter inflatie
Als een gebruiker dezelfde migratie 3× draait, krijgt de tweede en derde run hoge `AlreadyExists` counts. Dit is correct gedrag maar kan verwarrend zijn. Step 5 message: *"N records already existed — these were left unchanged. If this is unexpected, check if a previous run partially completed."*

### 8.7 Parent task in vorige project
Theoretisch onmogelijk (tasks zijn project-scoped), maar als source data corrupt is: `validateAndNormalizeOutlineLevels` ziet de parent niet en clamps de task naar level 1 met warning.

### 8.8 Custom field errors zijn niet inbegrepen
Custom field write errors (zowel project- als resource-level) zitten niet in deze spec. Als die ook in de productie-run failures geven: separate spec. Huidige errors-CSV bevatte geen custom-field-gerelateerde rows.

### 8.9 Dependency cycles
Niet een retry-issue, maar als Planner Premium een cyclic dependency afwijst, krijg je een error die niet in `AlreadyExists` categorie zit. Behoort als `Other` te falen, niet retried. Phase 1's classifier `Other` default is voldoende.

### 8.10 Throttling onderscheid van Timeout
`0x80072322` en gerelateerde throttle codes zijn ander gedrag dan gateway timeouts: server zegt expliciet "te druk, kom later terug" met soms een `Retry-After` header. Behandel als eigen klasse met langere backoff (10s, 30s, 60s). Voor MVP: zelfde retry-wrapper, gewoon andere `baseDelayMs`.

---

## 9. Acceptance criteria (samenvatting end-to-end)

De feature is klaar wanneer:

1. ✅ Heruitvoering van de mei-12 run tegen dezelfde PWA produceert < 25 errors (vs 555 nu)
2. ✅ De resterende errors zijn echte business-failures (non-FS deps die license vereisen, of source data corruption)
3. ✅ Geen enkele error in de output is collateral damage van een ander element in dezelfde batch
4. ✅ "Already existed" records worden in Step 5 apart van failures getoond
5. ✅ Step 5 rapport groepeert per error class; geen 200+ identieke regels
6. ✅ Retries worden zichtbaar gelogd; support kan een failed run forensisch nalopen
7. ✅ Stop-control onderbreekt retries binnen 3 seconden
8. ✅ Bestaande tests (als die er zijn) slagen ongewijzigd
9. ✅ `npm run build` slaagt; `pac code push` deployed cleanly
10. ✅ Re-run van een gefaalde migration is idempotent door Phase 1's skip-as-success

---

## 10. Implementatie volgorde

Fasering laat elke fase apart valideren tegen de productie-data; klant kan tussentijds re-runnen.

**Phase 1 — Duplicate handling (½ dag)**
1. `errorClassifier.ts` met `classifyDataverseError()` + skip-as-success set
2. Aanroepen vanuit `taskWriter`, `projectWriter`, `assignmentWriter`, `resourceWriter`
3. `state.skippedAsExisting` counter doorgeven naar Step 5
4. Test: rerun van halve migratie — 0 dup errors, expected count in skipped

**Phase 2 — Batch retry + outline normalization (1–1.5 dag)**
5. `executeOperationSetWithRetry()` in `scheduleApi.ts`
6. `extractFailedBatchRequestIndex()` parser voor nested-JSON Dataverse format
7. `validateAndNormalizeOutlineLevels()` met multi-batch placement
8. `committedLevels` cache integratie in task write loop
9. Test: bestand met opzettelijk fout `OutlineLevel` op 1 task — 179/180 commits, 1 faalt

**Phase 3 — Dependency batching + timeout retry (½ dag)**
10. `DEPENDENCY_BATCH_SIZE = 180` cap in dependency writer
11. Non-FS filter upfront, info-logging
12. `withRetry()` helper in `dataverseClient.ts`
13. Integratie in `performUnboundAction` en `executeOperationSet`
14. Test: kunstmatige timeout (chaos test) — retry events in log, eventueel succes na backoff

**Phase 4 — Reporting (½ dag)**
15. `errorClass` toevoegen aan `ImportError`
16. Step 5 rollup component
17. CSV export met extra kolom
18. End-to-end run tegen volledige PWA — error count check

**Totaal: 2.5–3 dagen ervaren dev.**

Optionele stap 19 (na productie-validatie): adaptive batch sizing op basis van p95 execution time.

---

## 11. Open vragen (voor implementatie-tijd)

1. **`ExecuteOperationSetV1` retry safety:** is re-execute van een al-executed opSet veilig (terugkeert error zonder bijwerkingen) of niet? Spike eerst tegen test-environment.

2. **Locatie van skip-set:** bestaat er al een centrale plek waar `0x80044331` en `0x80060891` als "skip" geclassificeerd worden? Grep op die codes. Indien ja: uitbreiden daar i.p.v. nieuwe classifier.

3. **`LogEntry` shape:** bestaat er al een `level: 'info' | 'warn' | 'error'` veld? `MigrationContext` in `migrator-project-context.md` heeft `logs: LogEntry[]` maar shape niet gespecified.

4. **Retry-After header:** worden response headers überhaupt blootgesteld door de Power Apps SDK? Zo niet: throttling backoff blijft heuristisch.

5. **Custom field write errors:** als die ook 0x80040265 retourneren (custom field rij bestaat al), zou Phase 1 ook daar gelden. Verifieer of de classifier ook in `columnManager.ts` / `choiceSetManager.ts` aangeroepen moet worden.

6. **Step 5 CSV stability:** sommige customers parsen `migration-errors.csv` met scripts. Toevoegen van `ErrorClass` kolom aan het einde behoudt bestaande positie van eerdere kolommen, maar verifieer of er een explicit kolomvolgorde-contract is in dataOnly-spec of import-control-spec.

7. **Stop signal granulariteit:** bestaande `import-control` stop check — wordt die geraakt tussen batches of ook binnen `executeOperationSetWithRetry`'s retry-loop? Phase 2 §5.5 voegt `signal` parameter toe; verifieer of dat de bestaande stop-flag gebruikt.
