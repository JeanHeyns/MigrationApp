# Feature Spec: Schema-Only Migration Mode

> **Document type:** Implementation specification for Claude Code
> **Target codebase:** Project Online Migrator (React + TypeScript + Power Apps Code App)
> **Status:** Ready for implementation
> **Related specs:** `data-only-migration-spec.md`, `data-only-migration-spec-addendum-A.md`

---

## 1. Context & doel

De app ondersteunt nu twee migratie-modi:

| Modus | Schema | Data |
|---|---|---|
| `full` | ✅ create | ✅ migrate |
| `dataOnly` | ⏭ reuse | ✅ migrate |

De logische derde modus ontbreekt: **alleen schema voorbereiden, geen data**. Dit is nodig voor:

- Schema klaarzetten in een lege solution voordat data binnenkomt
- Productie-environment voorbereiden op basis van wat in test/dev draait
- Klant levert PWA structuur aan, jij bouwt schema, daarna doet iemand anders later de data-import (eventueel via `dataOnly`)
- Schema "transporteren" tussen environments zonder solution export gedoe

**Uitbreiding:** introduceer een `schemaOnly` modus. Resultaat is een complete matrix:

| Modus | Schema | Data |
|---|---|---|
| `full` | ✅ create | ✅ migrate |
| `dataOnly` | ⏭ reuse | ✅ migrate |
| `schemaOnly` (nieuw) | ✅ create | ⏭ skip |

---

## 2. Scope

### In scope
- Nieuwe migratie-modus `'schemaOnly'` selecteerbaar in Step 1
- Step 1 fetch geoptimaliseerd: alleen custom fields + lookup tables, geen project/task/resource/assignment data
- Step 2 mapping behouden, maar dropdown toont alleen "create new" + "skip" (geen "use existing")
- Step 3 maakt custom kolommen + global option sets aan (zelfde als `full`)
- **Custom lookup entities** aanmaken voor PO lookup tables die nog niet bestaan in target solution
- **Lookup entries** als records inserten in de target lookup entity (primary name = PO lookup value)
- Bestaande lookup entities/entries: merge-gedrag (skip duplicates, voeg ontbrekende toe)
- Step 4 wordt overgeslagen (geen data-import)
- Step 5 toont schema-creation rapport (kolommen aangemaakt, option sets aangemaakt, lookup entities aangemaakt, lookup entries toegevoegd, errors)

### Out of scope (voor deze iteratie)
- Hybrid mode (mix schema + data per veld) — niet zinvol
- Lookup table mapping naar bestaande Dataverse entities (bijv. `account` of `contact`) — alleen create-pad
- Schema diff tegen bestaande solution — later
- Dry-run preview van wat aangemaakt zou worden — later
- Rollback bij gedeeltelijke failure — bestaande "best effort" gedrag blijft

---

## 3. Architecturale beslissingen

| Beslissing | Keuze | Reden |
|---|---|---|
| Modus selectie | Expliciete keuze in Step 1 (3-way toggle of dropdown) | Consistent met bestaande `full`/`dataOnly` keuze |
| Step 1 fetch optimalisatie | In `schemaOnly`: skip projects/tasks/resources/assignments fetches | Snellere flow voor grote PWAs; alleen schema-relevante data nodig |
| Step 2 mapping | Behouden, dropdown beperkt tot "create new" + "skip" | Gebruiker behoudt controle over logical names; flow consistent |
| Step 4 in `schemaOnly` | Volledig overslaan (skip naar Step 5) | Niet zinvol om read-only data-import scherm te tonen; sneller voor gebruiker |
| Lookup entity creation | Custom Dataverse entity per PO lookup table | Geen mapping naar bestaande entities in MVP; eenvoud |
| Lookup entries | Als records inserten met primary name = PO label | Direct bruikbaar voor latere `dataOnly` resolver |
| Bestaande lookup entities | Merge: skip entity create, voeg ontbrekende entries toe | Idempotente re-runs; consistent met "already exists = success" patroon |
| Bestaande lookup entries | Skip op duplicate primary name | Idempotente re-runs |
| Project/task/resource fetch in `schemaOnly` | Skip volledig | Tijdwinst |

---

## 4. State uitbreidingen

In `MigrationContext`:

```typescript
type MigrationMode = 'full' | 'dataOnly' | 'schemaOnly'  // add 'schemaOnly'

interface MigrationState {
  // ... bestaande velden ongewijzigd

  migrationMode: MigrationMode  // default 'full'

  // Result tracking voor schemaOnly (en gedeeltelijk full)
  schemaCreationResults: SchemaCreationResults | null
}

interface SchemaCreationResults {
  startedAt: Date
  completedAt: Date | null
  columns: {
    created: Array<{ entity: string; logicalName: string; type: string }>
    skipped: Array<{ entity: string; logicalName: string; reason: string }>
    failed: Array<{ entity: string; logicalName: string; error: string }>
  }
  optionSets: {
    created: Array<{ name: string; optionCount: number }>
    skipped: Array<{ name: string; reason: string }>
    failed: Array<{ name: string; error: string }>
  }
  lookupEntities: {
    created: Array<{ logicalName: string; displayName: string }>
    skipped: Array<{ logicalName: string; reason: string }>
    failed: Array<{ logicalName: string; error: string }>
  }
  lookupEntries: {
    inserted: Array<{ entity: string; name: string }>
    skipped: Array<{ entity: string; name: string; reason: string }>
    failed: Array<{ entity: string; name: string; error: string }>
  }
}
```

### Derived flags (consistent met Direction A pattern)

```typescript
// Existing (from dataOnly):
const skipColumnCreation = migrationMode === 'dataOnly'

// New:
const skipDataImport = migrationMode === 'schemaOnly'
const skipPoDataFetch = migrationMode === 'schemaOnly'  // skip projects/tasks/resources fetches
```

`migrationMode` blijft de single source of truth. Geen losse user-facing toggles.

---

## 5. Nieuwe bestanden

### 5.1 `services/plannerPremium/lookupEntityManager.ts`

**Doel:** Custom lookup entities aanmaken in Dataverse en entries inserten.

**Publieke API:**
```typescript
export interface LookupEntityResult {
  logicalName: string
  displayName: string
  entitySetName: string
  primaryNameField: string
  status: 'created' | 'already_exists' | 'failed'
  error?: string
}

export interface LookupEntryResult {
  entity: string
  name: string
  status: 'inserted' | 'already_exists' | 'failed'
  error?: string
}

export async function ensureLookupEntity(
  poLookupTable: PoLookupTable,
  publisherPrefix: string,
  solutionUniqueName: string
): Promise<LookupEntityResult>

export async function insertLookupEntries(
  entityResult: LookupEntityResult,
  poLookupEntries: PoLookupEntry[]
): Promise<LookupEntryResult[]>
```

**Implementatiestappen voor `ensureLookupEntity`:**

1. Bouw `logicalName = ${publisherPrefix}_${toLogicalName(poLookupTable.name)}`
2. Probeer entity metadata op te halen: `EntityDefinitions(LogicalName='X')`
   - Bij 200: entity bestaat → return `{ status: 'already_exists', ... }`
   - Bij 404: ga door met create
3. Custom entity aanmaken via Dataverse Metadata API:
   ```
   POST /api/data/v9.2/EntityDefinitions
   {
     "@odata.type": "Microsoft.Dynamics.CRM.EntityMetadata",
     "SchemaName": "<prefix>_<Name>",      // PascalCase
     "LogicalName": "<prefix>_<name>",     // lowercase
     "DisplayName": { "LocalizedLabels": [{ "Label": "<PO name>", "LanguageCode": 1033 }] },
     "DisplayCollectionName": { ... },
     "Description": { ... },
     "OwnershipType": "UserOwned",
     "HasActivities": false,
     "HasNotes": false,
     "PrimaryNameAttribute": {
       "@odata.type": "Microsoft.Dynamics.CRM.StringAttributeMetadata",
       "SchemaName": "<prefix>_Name",
       "LogicalName": "<prefix>_name",
       "RequiredLevel": { "Value": "ApplicationRequired" },
       "MaxLength": 200,
       "DisplayName": { "LocalizedLabels": [{ "Label": "Name", "LanguageCode": 1033 }] }
     }
   }
   ```
4. Add to solution via `AddSolutionComponent`:
   ```
   POST /api/data/v9.2/AddSolutionComponent
   {
     "ComponentId": "<entity metadataId>",
     "ComponentType": 1,                   // Entity
     "SolutionUniqueName": "<solutionUniqueName>",
     "AddRequiredComponents": false,
     "DoNotIncludeSubcomponents": false
   }
   ```
5. Fetch back `EntitySetName` (plural, voor latere insert URL)
6. Return `{ status: 'created', logicalName, displayName, entitySetName, primaryNameField }`

**Implementatiestappen voor `insertLookupEntries`:**

1. Pre-load bestaande entries (alleen primary name + id):
   ```
   GET /api/data/v9.2/<entitySetName>?$select=<primaryNameField>,<entitySetName>id
   ```
   Bouw `Set<normalizedName>` voor duplicate detection.
2. Voor elke PO lookup entry:
   - Normaliseer naam (`s.toLowerCase().trim()`)
   - Indien al aanwezig: skip met status `already_exists`
   - Anders: `POST /<entitySetName>` met `{ "<primaryNameField>": "<original PO label>" }`
3. Verzamel resultaten

**Belangrijke gotchas:**
- Entity creation is **traag** (5-15 sec per entity), Dataverse heeft een poll-cycle. Toon progress per entity.
- `SchemaName` PascalCase vs `LogicalName` lowercase — beide nodig in payload, anders rejection.
- Solution component toevoegen is verplicht, anders entity bestaat wel maar zit niet in de solution voor export.
- "Already exists" detection: HTTP 412/409 of error code `0x8004F00B` afhankelijk van pad. Behandel beide als success.
- Primary name `MaxLength: 200` is zat voor PO labels, maar truncate defensief.

---

### 5.2 `services/plannerPremium/schemaOrchestrator.ts`

**Doel:** orchestratie van Step 3 in `schemaOnly` mode (en kan hergebruikt worden door `full`).

**Publieke API:**
```typescript
export interface SchemaOrchestrationInput {
  mappingConfig: MappingConfiguration
  optionSetMappings: OptionSetMapping[]
  poLookupTables: PoLookupTable[]
  poLookupEntries: PoLookupEntry[]
  selectedSolution: DvSolution
  publisherPrefix: string
  onProgress: (msg: string) => void
}

export async function orchestrateSchemaCreation(
  input: SchemaOrchestrationInput
): Promise<SchemaCreationResults>
```

**Volgorde:**
1. **Global option sets** eerst (kolommen kunnen ernaar verwijzen): voor elke unieke option set in `optionSetMappings`, roep `ensureGlobalOptionSet` aan
2. **Lookup entities**: voor elk PO lookup table dat in mapping als lookup-target wordt gebruikt, roep `ensureLookupEntity` aan
3. **Lookup entries**: voor elke nieuwe of bestaande lookup entity, roep `insertLookupEntries` aan
4. **Custom kolommen op project/task/team entities**: voor elke `create_new` mapping, roep bestaande `columnManager` aan
   - Voor lookup-kolommen: gebruik de zojuist aangemaakte (of bestaande) lookup entity als target
5. Verzamel alles in `SchemaCreationResults`, return

**Belangrijk:**
- Continue-on-error: één gefaalde kolom blokkeert de rest niet
- Per-stap progress callback voor Step 3 UI ("Creating option set 'Priority'...", "Creating lookup entity 'Department'...", etc.)
- Logger integratie: warn-level voor skips, error-level voor failures

---

## 6. Wijzigingen in bestaande bestanden

### 6.1 `MigrationContext.tsx`
- `MigrationMode` type uitbreiden met `'schemaOnly'`
- `schemaCreationResults` toevoegen + reducer action `SET_SCHEMA_CREATION_RESULTS`
- Bij mode-switch reset: `schemaCreationResults: null` als `migrationMode !== 'schemaOnly' && migrationMode !== 'full'`

### 6.2 `Step1Connect/index.tsx`
- Mode keuze uitbreiden naar 3-way: radio group met `Full migration` / `Data only` / `Schema only`
- **Belangrijke optimalisatie:** in `schemaOnly` mode, fetch alleen:
  - `fetchCustomFields()`
  - `fetchLookupTables()` (incl. entries)
  - PO project/resource/task/assignment fetches **overslaan**
- Status panel aanpassen: "Fetched: 12 custom fields, 4 lookup tables (78 entries)"
- Validatie: in `schemaOnly` is `fetchedData.projects` leeg, dus check op `customFields.length > 0` om Next te enablen, niet `projects.length > 0`

### 6.3 `Step2Mapping/index.tsx`
- Lees `migrationMode` uit context
- **Indien `schemaOnly`:**
  - Right-side dropdown toont alleen:
    - "+ Create new column" (default, met logical name preview op basis van `publisherPrefix`)
    - "Skip" (don't migrate)
  - **Geen** "use existing" optie (in tegenstelling tot `dataOnly`)
  - Geen `schemaSnapshot` nodig — geen scan vooraf
  - Auto-suggesties op basis van PO veldtype → DV type (bijv. PO `TEXT` → DV `String`, PO `NUMBER` → DV `Decimal`)
  - Voor PO lookup-fields: toon "Will create lookup entity '<prefix>_<name>'" inline
- Banner boven Next: "N fields will be created, M will be skipped"
- `MappingConfiguration.migrationMode` correct serialiseren in JSON save/load

### 6.4 `Step3CreateColumns/index.tsx`
- **Indien `schemaOnly` of `full`:** roep `orchestrateSchemaCreation` aan
- UI uitbreiden om alle 4 categorieën te tonen (option sets, lookup entities, lookup entries, columns) met per-categorie progress
- Bij completion: sla `SchemaCreationResults` op in context
- Next-knop label:
  - `full` → "Next: Import Data" (zoals nu)
  - `schemaOnly` → "Next: View Report" (skip Step 4)
  - `dataOnly` → unchanged

### 6.5 Wizard navigation (`MigrationWizard` of equivalent)
- Step indicator blijft 5 stappen tonen voor consistentie
- In `schemaOnly`: bij klik op Next vanuit Step 3, ga direct naar Step 5 (skip Step 4)
- Step 4 component mag niet renderen in `schemaOnly` (early return of conditional in router)
- Back-navigation vanaf Step 5 in `schemaOnly` → terug naar Step 3, niet Step 4

### 6.6 `Step4Import/index.tsx`
- Geen wijziging nodig — wordt simpelweg overgeslagen
- Defensief: als component toch mounten, toon `<Redirect to="step5" />` of equivalent met log warning

### 6.7 `Step5Report/index.tsx`
- Conditioneel renderen op basis van `migrationMode`:
  - `full`: bestaande data-import report + nieuwe schema-creation report
  - `dataOnly`: bestaande data-import report (incl. skipped fields)
  - `schemaOnly`: **alleen** schema-creation report, geen data-import sectie
- Nieuwe sectie "Schema Creation Summary":
  - 4 sub-tabellen: Columns, Option Sets, Lookup Entities, Lookup Entries
  - Per tabel: created / skipped / failed counts + expandable details
  - CSV export per categorie
- Empty state als alles 0 is: "No schema changes needed"

### 6.8 `services/projectOnline/index.ts` (of equivalent fetch orchestrator)
- Nieuwe helper `fetchSchemaOnlyData(pwaUrl)`:
  ```typescript
  export async function fetchSchemaOnlyData(pwaUrl: string): Promise<{
    customFields: PoCustomField[]
    lookupTables: PoLookupTable[]
    lookupEntries: PoLookupEntry[]
  }>
  ```
- Step 1 callt deze i.p.v. de full fetch in `schemaOnly` mode

---

## 7. Edge cases & gotchas

### 7.1 Lookup entity al bestaat in **andere** solution
Entity bestaat in environment maar niet in de geselecteerde solution. `EntityDefinitions(LogicalName='X')` returnt 200, maar `solutioncomponent` query toont 'm niet in deze solution.

**Mitigatie:** behandel als "already exists" en voeg toe aan solution via `AddSolutionComponent`. Documenteer dat de entity dan gedeeld wordt tussen solutions (Dataverse-gedrag, niet onze keuze).

### 7.2 Lookup entity prefix collision
PO heeft "Department" lookup, en er bestaat al `cr123_department` als compleet andere custom entity (bijv. uit een vorig project).

**Mitigatie:** logical name match = match. We hergebruiken de bestaande entity en inserten entries. Documenteer als bekend gedrag. Gebruiker moet weten welke prefixes "veilig" zijn.

### 7.3 Lookup entries met identieke names
PO lookup heeft twee entries met name "Construction" (legacy data).

**Mitigatie:** eerste insert lukt, tweede faalt op duplicate detection in eigen pre-load (we sturen geen tweede POST). Log als skip met reason "duplicate name in source".

### 7.4 Lookup entry name > 200 chars
PO heeft geen harde limiet, Dataverse `String` primary name wel.

**Mitigatie:** truncate met suffix `...` en log waarschuwing. Of: maak primary name `Memo`/`StringFormat=TextArea` met `MaxLength=4000`. **Aanbeveling:** `String` MaxLength 200 voor compatibiliteit met latere lookup-views. Truncate met warning.

### 7.5 Step 1 "schemaOnly" maar custom fields zijn leeg
PWA heeft 0 custom fields gedefinieerd. Wat doen we?

**Mitigatie:** lookup tables kunnen nog wel relevant zijn. Sta toe verder te gaan zolang `customFields.length > 0 || lookupTables.length > 0`. Anders: tonen "Nothing to migrate in schema-only mode" en disable Next.

### 7.6 Mode switch wist state
User kiest `full`, doet fetch, switcht naar `schemaOnly`. Wat gebeurt met `fetchedData.projects`?

**Mitigatie:** behoud data, maar UI in Step 1 herrendert met de relevante summary. Bij switch van `schemaOnly` → `full`/`dataOnly`: trigger re-fetch knop ("Fetch project data") want we hebben de extra data nodig. Niet automatisch re-fetchen — dat is destructive.

### 7.7 Step 3 errors halverwege
Helft van de option sets is aangemaakt, dan failure op een lookup entity. Wat nu?

**Mitigatie:** continue-on-error. Eindrapport toont alles. Re-run is idempotent dankzij "already exists = success" pattern. Geen rollback (consistent met bestaand gedrag).

### 7.8 Custom kolom verwijst naar lookup entity die in dezelfde run wordt aangemaakt
Volgorde-afhankelijkheid: lookup entity moet bestaan voordat de kolom op `msdyn_project` ernaar kan verwijzen.

**Mitigatie:** `schemaOrchestrator` volgorde is strikt: option sets → lookup entities → lookup entries → kolommen. Geen parallel.

### 7.9 Solution publisher prefix mismatch
Gebruiker selecteert solution met prefix `cr123_`, maar lookup entity bestaat al als `new_department` (default publisher).

**Mitigatie:** logical name match wint. We zoeken op `<prefix>_<name>` eerst. Geen match → check zonder prefix? **Nee** — strikt op `<prefix>_<name>`. Anders krijgen we onbedoelde merges. Documenteer.

### 7.10 PowerApps Dataverse entity creation rate limits
Bij grote PWA met 20+ lookup tables kan creation lang duren (5-15 sec per entity). Dataverse heeft soft limits.

**Mitigatie:** sequentieel uitvoeren (geen parallel), per-entity progress in UI. Cap bijvoorbeeld op 50 entities per run, anders waarschuwing.

### 7.11 Fetch optimalisatie breekt iets
Bestaande Step 1 logica verwacht mogelijk dat alle fetch-velden gevuld zijn voor downstream code.

**Mitigatie:** in `schemaOnly` mode, vul `fetchedData.projects = []`, `tasks = []`, etc. Niet `null`. Downstream code die over arrays itereert blijft werken.

---

## 8. Acceptance criteria

De feature is klaar wanneer:

1. ✅ Gebruiker kan in Step 1 kiezen tussen `full`, `dataOnly`, en `schemaOnly`
2. ✅ In `schemaOnly` mode wordt alleen `fetchCustomFields` + `fetchLookupTables` (met entries) gedaan
3. ✅ Step 2 toont in `schemaOnly` een "create new" + "skip" dropdown (geen "use existing")
4. ✅ Step 3 maakt option sets, lookup entities, lookup entries en custom kolommen aan in correcte volgorde
5. ✅ Bestaande lookup entities worden hergebruikt; ontbrekende entries worden toegevoegd; duplicate entries geskipt
6. ✅ Step 4 wordt overgeslagen (Next vanuit Step 3 → Step 5)
7. ✅ Step 5 toont schema-creation rapport met 4 categorieën (columns, option sets, lookup entities, lookup entries) elk met created/skipped/failed counts en CSV export
8. ✅ Bestaande `full` en `dataOnly` flows zijn **ongewijzigd** in gedrag
9. ✅ Re-run van `schemaOnly` op dezelfde solution resulteert in alle items als `skipped` (already exists), geen failures
10. ✅ Test scenario: PWA met 8 custom fields (waarvan 2 lookup) en 3 lookup tables (totaal 25 entries) wegschrijven naar lege solution. Daarna: dezelfde run nogmaals = 0 creates, 25 skips. Daarna: één lookup entry verwijderd uit Dataverse, run nogmaals = 1 create, 24 skips.

---

## 9. Aanvullende technische notes

### 9.1 Custom entity creation API endpoint
Dataverse exposeert custom entity creation via `EntityDefinitions` POST. Dit is **niet** beschikbaar via custom connector standaard ops — mogelijk extra registration in `client.ts` nodig:

```typescript
// In client.ts:
client.registerOperation('CreateEntityDefinition', {
  method: 'POST',
  path: '/api/data/v9.2/EntityDefinitions',
  // ...
})
```

Verifieer of de bestaande `dataverseService.createRecord` voldoende is, of dat we een aparte `createEntityDefinition` helper nodig hebben.

### 9.2 Solution component types
Voor `AddSolutionComponent`:
- ComponentType `1` = Entity
- ComponentType `2` = Attribute
- ComponentType `9` = OptionSet (global)
- ComponentType `10` = EntityRelationship

Custom lookup entity creation moet zowel de entity als impliciet zijn primary attribute toevoegen. Verifieer of `AddRequiredComponents: true` dit afhandelt, anders apart toevoegen.

### 9.3 Logger integratie
Hergebruik bestaande `logs: LogEntry[]` in `MigrationState`. Severity:
- `INFO` voor created
- `WARN` voor skipped (already exists, duplicate)
- `ERROR` voor failed

`SchemaCreationResults` is de gestructureerde versie voor het rapport; logs zijn voor lopende feedback tijdens Step 3.

### 9.4 Fetch helper organisatie
`fetchSchemaOnlyData` kan als wrapper rond bestaande `fetchCustomFields` + `fetchLookupTables` + nieuwe `fetchLookupEntries`. Geen duplicate logica.

PO lookup entries fetchen via:
```
GET /_api/ProjectServer/LookupTables('<id>')/Entries
```
of via OData expand:
```
GET /_api/ProjectServer/LookupTables?$expand=Entries
```

Verifieer welke endpoint stabiel is (zie bestaande `lookupTables.ts`).

---

## 10. Implementatie volgorde (aanbevolen)

1. State uitbreiden + `MigrationMode` type bijwerken
2. Step 1 UI: 3-way mode toggle + conditionele fetch
3. `fetchSchemaOnlyData` helper + lookup entries fetch verifiëren
4. Step 2 UI: dropdown beperken in `schemaOnly` mode (geen "use existing")
5. `lookupEntityManager.ts` met `ensureLookupEntity` (entity creation pad)
6. `lookupEntityManager.ts` `insertLookupEntries` met merge-gedrag
7. `schemaOrchestrator.ts` met correcte volgorde (option sets → entities → entries → kolommen)
8. Step 3 UI: progress per categorie, results opslaan in state
9. Wizard routing: skip Step 4 in `schemaOnly`
10. Step 5 UI: schema-creation rapport + CSV export
11. Edge cases (duplicates, prefix collisions, truncation) afronden
12. End-to-end test: lege solution → schemaOnly run → verifieer in Dataverse → dataOnly run met dezelfde mapping → data komt door

Geschatte effort: 2-3 dagen development voor een ervaren dev op deze codebase. Korter dan `dataOnly` omdat veel infrastructuur (Step 3 column creation, option set manager, mapping UI) hergebruikt wordt.

---

## 11. Open vragen (voor implementatie-tijd)

- Lookup entity primary name: `String` MaxLength 200 of `Memo` 4000? **Aanbeveling:** `String` 200 voor compatibiliteit met lookup views; truncate PO labels met warning.
- `AddSolutionComponent` `AddRequiredComponents`: `true` of `false`? **Aanbeveling:** `true` voor entities (haalt impliciete primary attribute mee), `false` voor losse kolommen.
- Lookup entity ownership: `UserOwned` of `OrganizationOwned`? **Aanbeveling:** `UserOwned` (Dataverse default voor data entities), tenzij solution conventie anders is.
- Step 5 schema-rapport ook tonen na `full` mode, of alleen na `schemaOnly`? **Aanbeveling:** ook na `full` — gebruiker wil zien wat er aan schema is aangemaakt naast wat aan data is geïmporteerd. Geen extra werk; rapport-component is sowieso conditioneel per categorie.
