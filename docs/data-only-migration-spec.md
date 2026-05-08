# Feature Spec: Data-Only Migration Mode

> **Document type:** Implementation specification for Claude Code
> **Target codebase:** Project Online Migrator (React + TypeScript + Power Apps Code App)
> **Status:** Ready for implementation

---

## 1. Context & doel

De huidige app voert altijd de volledige flow uit: **Connect → Mapping → Create Columns → Import Data → Report**. Dit is niet bruikbaar voor scenario's waarbij het Dataverse-schema (custom kolommen, global option sets, lookup tables) **al bestaat** in de doel-solution — bijvoorbeeld:

- Tweede PWA-site migreren naar dezelfde target solution
- Productie-run na een test-run
- Klant heeft schema handmatig voorbereid in Dataverse

In die gevallen wil de gebruiker **alleen data migreren** (projects, tasks, resources, assignments) tegen het bestaande schema, zonder kolommen of option sets aan te maken.

**Uitbreiding:** introduceer een `dataOnly` migratie-modus naast de bestaande `full` modus.

---

## 2. Scope

### In scope
- Nieuwe migratie-modus `'dataOnly'` selecteerbaar in Step 1
- Schema inspectie van de gekozen Dataverse solution
- Mapping UI (Step 2) toont **bestaande** custom kolommen i.p.v. "create new"
- Step 3 wordt overgeslagen of toont alleen samenvatting (geen creates)
- Runtime resolvers voor choice (label → value) en lookup (label → GUID)
- Robuuste error handling bij niet-resolvable waarden
- Goede logging in Step 5 rapport

### Out of scope (voor deze iteratie)
- Hybrid mode (mix create + reuse per veld) — later
- Pre-flight resolution report — bewust overgeslagen, errors komen in Step 4 logs
- Mapping persistence (export/import JSON) — later
- Schema diff bij choice-set wijzigingen — later

---

## 3. Architecturale beslissingen

| Beslissing | Keuze | Reden |
|---|---|---|
| Migratie-modus selectie | Expliciete toggle in Step 1 | Gebruiker kent zijn intent het beste |
| Schema detectie | Auto-detect via Dataverse Metadata API | Nodig voor correcte mapping-suggesties |
| Mapping override | Auto-match + handmatige override mogelijk | Naam-matching is niet altijd 100% |
| Onresolvable choice/lookup waarden | **Skip veld** (record wordt aangemaakt, veld blijft leeg) | Pragmatisch: data-completeness > volledigheid |
| Lookup resolver strategie | **Pre-load all** target records | Eenvoud; doelgroep is < 5000 records per lookup table |
| Pre-flight validatie | **Geen** aparte stap | Errors komen in Step 4 logs; voorkomt extra UI-complexiteit |

---

## 4. State uitbreidingen

In `MigrationContext`:

```typescript
interface MigrationState {
  // ... bestaande velden ongewijzigd

  migrationMode: 'full' | 'dataOnly'      // default 'full'
  schemaSnapshot: SchemaSnapshot | null   // gevuld na solution-keuze in dataOnly mode
  resolverPlan: ResolverPlan | null       // afgeleid van mapping in dataOnly mode
}

interface SchemaSnapshot {
  scannedAt: Date
  solutionId: string
  entities: Record<string, EntitySchema>  // key = logical name
  globalOptionSets: GlobalOptionSetMeta[]
}

interface EntitySchema {
  logicalName: string
  entitySetName: string         // plural, voor odata URLs
  primaryNameField: string
  attributes: ColumnMeta[]
}

interface ColumnMeta {
  logicalName: string
  displayName: string
  type: 'String' | 'Memo' | 'Integer' | 'Decimal' | 'Money'
      | 'DateTime' | 'Boolean' | 'Picklist' | 'MultiSelectPicklist' | 'Lookup'
  isCustom: boolean
  // Type-specific:
  optionSetName?: string        // voor Picklist/MultiSelectPicklist (global option set)
  targets?: string[]            // voor Lookup (target entities)
  navigationProperty?: string   // voor Lookup (odata.bind property name)
}

interface GlobalOptionSetMeta {
  name: string
  displayName: string
  options: Array<{ value: number; label: string }>
}

interface ResolverPlan {
  fields: ResolverEntry[]
}

interface ResolverEntry {
  poFieldName: string
  dvLogicalName: string
  dvType: ColumnMeta['type']
  // Filled where relevant:
  optionSetName?: string
  targetEntity?: string
  targetEntitySet?: string
  primaryNameField?: string
  navigationProperty?: string
}
```

---

## 5. Nieuwe bestanden

### 5.1 `services/plannerPremium/schemaInspector.ts`

**Doel:** Dataverse schema scannen voor de gekozen solution.

**Publieke API:**
```typescript
export async function inspectSolution(
  solutionId: string,
  targetEntities?: string[]  // default: ['msdyn_project', 'msdyn_projecttask', 'msdyn_projectteam']
): Promise<SchemaSnapshot>
```

**Implementatiestappen:**
1. Voor elke target entity:
   - Fetch alle attributes met `IsCustomAttribute eq true`
   - Voor elke Lookup attribute: fetch `ManyToOneRelationships` om `ReferencingEntityNavigationPropertyName` op te halen
   - Voor elke Picklist attribute: detecteer of het een global option set is (`OptionSet.IsGlobal eq true`) en noteer de naam
   - Fetch `PrimaryNameAttribute` van de entity
   - Fetch `EntitySetName` (plural) — nodig voor `@odata.bind` URLs
2. Fetch alle global option sets die in de mapping voorkomen (lazy: alleen als nodig)
3. Cache resultaat in `MigrationState.schemaSnapshot`

**Dataverse Metadata API endpoints:**
```
GET /api/data/v9.2/EntityDefinitions(LogicalName='msdyn_project')
    ?$select=PrimaryNameAttribute,EntitySetName,LogicalName

GET /api/data/v9.2/EntityDefinitions(LogicalName='msdyn_project')/Attributes
    ?$filter=IsCustomAttribute eq true
    &$select=LogicalName,DisplayName,AttributeType
    &$expand=...

GET /api/data/v9.2/EntityDefinitions(LogicalName='msdyn_project')/Attributes(LogicalName='X')
    /Microsoft.Dynamics.CRM.LookupAttributeMetadata
    ?$expand=Targets

GET /api/data/v9.2/EntityDefinitions(LogicalName='msdyn_project')/ManyToOneRelationships
    ?$filter=ReferencingAttribute eq 'X'
    &$select=ReferencingEntityNavigationPropertyName,ReferencedEntity

GET /api/data/v9.2/GlobalOptionSetDefinitions(Name='cr123_priority')
```

**Belangrijke gotchas:**
- **Performance:** gebruik `$batch` of `Promise.all` per entity om RTT te beperken
- **Solution-scoping:** filter attributes op solution membership via `solutioncomponent` query (zie sectie 9.1)
- **Caching:** schemaSnapshot is geldig binnen één migratiesessie; voeg refresh-knop toe in UI

---

### 5.2 `services/plannerPremium/resolverFactory.ts`

**Doel:** runtime resolvers bouwen voor choice en lookup velden, gebruikt tijdens write fase.

**Publieke API:**
```typescript
export interface FieldResolver {
  fieldType: ColumnMeta['type']
  resolve(poValue: unknown): ResolverResult
}

export interface ResolverResult {
  status: 'resolved' | 'unresolved' | 'empty'
  value?: unknown               // voor direct/choice/multichoice
  bindKey?: string              // bv. "cr123_Category@odata.bind"
  bindValue?: string            // bv. "/cr123_categories(guid-here)"
  originalLabel?: string        // voor logging
}

export async function buildResolverMap(
  resolverPlan: ResolverPlan,
  schemaSnapshot: SchemaSnapshot
): Promise<Map<string, FieldResolver>>
```

**Resolver types:**

#### Direct resolver (string, number, date, boolean, memo, money)
Identity met basale type-coercion:
```typescript
function buildDirectResolver(entry: ResolverEntry): FieldResolver {
  return {
    fieldType: entry.dvType,
    resolve: (poValue) => {
      if (poValue == null || poValue === '') return { status: 'empty' }
      // Optional: type coercion (bv. string → number voor Integer)
      return { status: 'resolved', value: poValue }
    }
  }
}
```

#### Choice resolver (Picklist)
1. Fetch global option set via `GlobalOptionSetDefinitions(Name='X')`
2. Bouw `Map<normalizedLabel, optionValue>`
3. Resolve: normaliseer PO-waarde, lookup in map

```typescript
const normalize = (s: string) => s.toLowerCase().trim()

async function buildChoiceResolver(entry: ResolverEntry): Promise<FieldResolver> {
  const optionSet = await fetchGlobalOptionSet(entry.optionSetName!)
  const map = new Map<string, number>()
  for (const opt of optionSet.options) {
    map.set(normalize(opt.label), opt.value)
  }
  return {
    fieldType: 'Picklist',
    resolve: (poValue) => {
      if (poValue == null || poValue === '') return { status: 'empty' }
      const value = map.get(normalize(String(poValue)))
      return value !== undefined
        ? { status: 'resolved', value, originalLabel: String(poValue) }
        : { status: 'unresolved', originalLabel: String(poValue) }
    }
  }
}
```

#### MultiChoice resolver (MultiSelectPicklist)
PO-data komt vaak als `;` of `,` gescheiden string. Split, resolve elk label, en geef comma-separated values terug.

```typescript
resolve: (poValue) => {
  if (poValue == null || poValue === '') return { status: 'empty' }
  const labels = String(poValue).split(/[;,]/).map(s => s.trim()).filter(Boolean)
  const values: number[] = []
  for (const label of labels) {
    const v = singleChoiceMap.get(normalize(label))
    if (v !== undefined) values.push(v)
  }
  if (values.length === 0) {
    return { status: 'unresolved', originalLabel: String(poValue) }
  }
  return { status: 'resolved', value: values.join(',') }
}
```

#### Lookup resolver
1. Pre-load **alle** records uit target entity met `$select=<id>,<primaryName>`
2. Bouw `Map<normalizedName, GUID>`
3. Detecteer en log duplicaten (eerste match wint)
4. Resolve: lookup name → GUID, bouw `@odata.bind` payload

```typescript
async function buildLookupResolver(entry: ResolverEntry): Promise<FieldResolver> {
  const idField = `${entry.targetEntity}id`
  const records = await listAllRecords(entry.targetEntitySet!, [
    idField,
    entry.primaryNameField!
  ])

  const map = new Map<string, string>()
  const duplicates = new Set<string>()

  for (const rec of records) {
    const name = normalize(String(rec[entry.primaryNameField!] ?? ''))
    if (!name) continue
    if (map.has(name)) {
      duplicates.add(name)
      continue  // first match wins
    }
    map.set(name, rec[idField])
  }

  if (duplicates.size > 0) {
    console.warn(
      `Lookup '${entry.targetEntity}' has duplicate names; first match used:`,
      [...duplicates]
    )
  }

  return {
    fieldType: 'Lookup',
    resolve: (poValue) => {
      if (poValue == null || poValue === '') return { status: 'empty' }
      const guid = map.get(normalize(String(poValue)))
      if (!guid) {
        return { status: 'unresolved', originalLabel: String(poValue) }
      }
      return {
        status: 'resolved',
        bindKey: `${entry.navigationProperty}@odata.bind`,
        bindValue: `/${entry.targetEntitySet}(${guid})`,
        originalLabel: String(poValue)
      }
    }
  }
}
```

---

### 5.3 `services/plannerPremium/recordResolverApplier.ts`

**Doel:** centrale helper die voor één PO-record de mapping + resolvers toepast en een Dataverse-payload bouwt.

```typescript
export interface AppliedRecord {
  payload: Record<string, unknown>
  skippedFields: Array<{ poField: string; reason: string; originalValue: unknown }>
}

export function applyResolvers(
  poRecord: Record<string, unknown>,
  mapping: MappingConfiguration,
  resolvers: Map<string, FieldResolver>,
  logger: LogEntry[]
): AppliedRecord {
  const payload: Record<string, unknown> = {}
  const skippedFields: AppliedRecord['skippedFields'] = []

  for (const [poField, dvField] of Object.entries(mapping.fieldMap)) {
    const resolver = resolvers.get(poField)
    const poValue = poRecord[poField]

    if (!resolver) {
      // No resolver = direct mapping for non-special types
      if (poValue != null && poValue !== '') {
        payload[dvField] = poValue
      }
      continue
    }

    const result = resolver.resolve(poValue)
    switch (result.status) {
      case 'empty':
        // Field intentionally left empty
        break
      case 'resolved':
        if (result.bindKey && result.bindValue) {
          // Lookup
          payload[result.bindKey] = result.bindValue
        } else {
          // Choice / direct
          payload[dvField] = result.value
        }
        break
      case 'unresolved':
        skippedFields.push({
          poField,
          reason: `No matching ${resolver.fieldType} value found for "${result.originalLabel}"`,
          originalValue: poValue
        })
        // Field stays empty (per scope decision)
        break
    }
  }

  return { payload, skippedFields }
}
```

---

## 6. Wijzigingen in bestaande bestanden

### 6.1 `MigrationContext.tsx`
- State uitbreiden zoals in sectie 4
- Default `migrationMode: 'full'`
- Reducer actions toevoegen: `SET_MIGRATION_MODE`, `SET_SCHEMA_SNAPSHOT`, `SET_RESOLVER_PLAN`

### 6.2 `Step1.tsx` (Connect & Fetch)
- Na solution-keuze: extra UI-element met radio of toggle:
  - **"Full migration"** — kolommen aanmaken + data migreren (huidig gedrag)
  - **"Data only"** — bestaand schema gebruiken, alleen data migreren
- Bij keuze "Data only": trigger `inspectSolution(selectedSolution.id)` en sla op in state
- Toon loading spinner tijdens scan
- Toon samenvatting: *"Found N custom columns across 3 entities, M global option sets"*

### 6.3 `Step2.tsx` (Field Mapping)
- Lees `migrationMode` uit context
- **Indien `dataOnly`:**
  - Right-side dropdown toont **bestaande custom kolommen** uit `schemaSnapshot` (gefilterd per target entity)
  - Auto-match suggestion: voor elke PO custom field, zoek in `schemaSnapshot` naar:
    1. Exact match op `toLogicalName(poField.name)`
    2. Match op displayName (case-insensitive)
    3. Geen match → markeer als "❌ No match — field will be skipped"
  - Status indicator per rij: 🟢 auto-match / 🟡 manual override / 🔴 unmapped
  - Type-compatibility check: als PO-veld `Number` is en gekozen DV-kolom `String`, toon waarschuwing (niet blokkerend)
  - Bij choice fields: dropdown toont alleen Picklist/MultiSelectPicklist DV kolommen
  - Bij lookup fields: dropdown toont alleen Lookup DV kolommen
- **Aan het einde van Step 2 (alleen dataOnly):** bouw `ResolverPlan` op basis van mapping en sla op in state

### 6.4 `Step3.tsx` (Create Columns)
- **Indien `dataOnly`:**
  - Skip stap volledig OF toon read-only samenvatting met "✓ Schema validated, no creates needed"
  - Aanbeveling: toon de stap wel (zelfde UI flow), maar met disabled "Create" knop en groene checks
  - "Next" knop is direct beschikbaar
- `skipColumnCreation` blijft bestaan voor backwards compat

### 6.5 `Step4.tsx` + writers (`projectWriter.ts`, `taskWriter.ts`, etc.)
- **Voor de write fase:** als `migrationMode === 'dataOnly'`:
  1. Build resolver map: `const resolvers = await buildResolverMap(resolverPlan, schemaSnapshot)`
  2. Voor elk PO-record: `const { payload, skippedFields } = applyResolvers(record, mapping, resolvers, logger)`
  3. Schrijf `payload` weg via bestaande `msdyn_CreateProjectV1` / OperationSet API
  4. Log `skippedFields` naar `logs` collection met severity `WARN`
- **Belangrijk:** bestaande writer-code voor `full` mode mag NIET wijzigen. Refactor zo dat de resolver-laag een aparte stap is die alleen in `dataOnly` mode draait, of zo dat `full` mode een trivial passthrough resolver gebruikt.

### 6.6 `Step5.tsx` (Validation Report)
- Nieuwe sectie: **"Skipped Fields"**
  - Tabel met: PO field, PO value, Reason, Affected record count
  - Aggregatie: groepeer per (field, reason)
  - Export: CSV download van alle skipped fields voor debugging
- Bestaande error logging uitbreiden met resolver-context

---

## 7. Edge cases & gotchas

### 7.1 Lookup navigation property name
**Klassieke valkuil:** logical name ≠ navigation property. Voorbeeld:
- Logical name: `cr123_category`
- Navigation property: `cr123_Category` (PascalCase) of `cr123_category_msdyn_project` (bij meerdere relationships)

**Altijd ophalen via `ManyToOneRelationships` metadata.** Hardcode of guess nooit.

### 7.2 Polymorphic lookups
Sommige lookups (zoals `customerid`) wijzen naar meerdere entities (Account OR Contact). Voor MVP: pak de eerste target uit `Targets` array. Documenteer dit als bekende beperking.

### 7.3 Lookup target table > 5000 records
Pre-load strategie faalt bij grote tabellen. Voor MVP: log waarschuwing als target > 5000 records, vraag gebruiker om door te gaan of te aborten. Toekomstige uitbreiding: lazy resolver met `$filter`.

### 7.4 Localized option set labels
Als Dataverse environment Nederlands is, kunnen labels vertaald zijn ("Hoog" i.p.v. "High"). PO-data is meestal in Engels.

**Mitigatie:**
- Probeer eerst `UserLocalizedLabel`
- Bij geen match: probeer alle `LocalizedLabels` en match daar

### 7.5 Whitespace en case sensitivity
PO heeft "high", DV heeft " High ". Gebruik `normalize()` helper consequent: `s.toLowerCase().trim()`.

### 7.6 Duplicate names in lookup target
Twee categorieën met name "Construction" → eerste wint, log waarschuwing. Geef in Step 5 rapport een sectie "Lookup Ambiguity Warnings".

### 7.7 Multi-choice separator detection
PO multi-select kan `;` of `,` gebruiken afhankelijk van locale. Split op beide: `/[;,]/`.

### 7.8 Empty vs unresolved
Onderscheid `null/empty` (PO had geen waarde) van `unresolved` (PO had wel waarde maar matcht niet). Beide leiden tot leeg veld in Dataverse, maar in logging is dit verschil belangrijk.

### 7.9 Schema staleness
Gebruiker doet schema-scan, gaat lunchen, iemand anders past solution aan tijdens lunch. Toon `scannedAt` timestamp + refresh-knop in UI. Geen auto-refresh.

### 7.10 OperationSet API + 180 ops limiet
Bestaande beperking blijft. Resolver-laag zit vóór de batch-logica, dus geen impact, maar wel testen dat resolver-overhead geen extra latency toevoegt aan kritieke path.

### 7.11 Custom field naming op locked entities
Bestaande issue: Dynamics 365 met Dutch language pack veroorzaakte solution import failures op `msdyn_projecttask`. Bij dataOnly mode wordt dit minder relevant (geen creates), maar schema-scan moet wel kunnen lezen. Verifieer dat metadata-queries werken op locked entities.

---

## 8. Acceptance criteria

De feature is klaar wanneer:

1. ✅ Gebruiker kan in Step 1 kiezen tussen `full` en `dataOnly` modus
2. ✅ In `dataOnly` mode wordt na solution-keuze een schema-scan uitgevoerd en getoond
3. ✅ Step 2 toont bestaande custom kolommen en doet auto-match suggesties
4. ✅ Step 2 toont type-mismatch waarschuwingen (niet blokkerend)
5. ✅ Step 3 wordt overgeslagen of toont read-only samenvatting
6. ✅ Step 4 schrijft data correct weg met resolved choice values en lookup GUIDs
7. ✅ Onresolvable choice/lookup waarden leiden tot leeg veld + WARN log (record blijft door komen)
8. ✅ Step 5 rapport toont aparte sectie voor skipped fields met aggregatie
9. ✅ Bestaande `full` mode flow is **ongewijzigd** in gedrag
10. ✅ Test scenario: migreer 50 projecten met 3 custom choice + 2 custom lookup velden naar bestaand schema, alle records komen door, onresolvable waarden zijn duidelijk gelogd

---

## 9. Aanvullende technische notes

### 9.1 Solution-scoped attribute filtering
Om alleen attributes uit de **gekozen** solution te tonen (niet álle custom attributes in de environment):

```
GET /api/data/v9.2/solutioncomponents
    ?$filter=_solutionid_value eq <solutionId> and componenttype eq 2
    &$select=objectid
```
`componenttype = 2` is Attribute. Cross-reference `objectid` (= MetadataId) met EntityDefinition Attributes.

Alternatief: vraag dit niet hard af, toon **alle** custom attributes met een filter UI in Step 2 ("Show only solution X attributes"). Dit is simpeler en flexibeler voor multi-solution scenarios.

### 9.2 Bestaande Dataverse client gebruiken
Alle nieuwe metadata-calls moeten via `dataverseClient.ts` lopen voor consistente auth en error handling. Voeg een `fetchMetadata()` helper toe als die nog niet bestaat:

```typescript
export async function fetchMetadata<T>(path: string): Promise<T> {
  // GET met header: 'Prefer': 'odata.include-annotations="*"'
  // Base URL: <env>/api/data/v9.2/
}
```

### 9.3 `listAllRecords` helper
Voor lookup pre-loading is paging nodig (5000 record limit per call). Hergebruik bestaande paging-logica uit `odataClient.ts` of bouw equivalent in `dataverseClient.ts`:

```typescript
export async function listAllRecords(
  entitySetName: string,
  selectFields: string[]
): Promise<Record<string, unknown>[]>
```

### 9.4 Logger integratie
Bestaande `logs: LogEntry[]` in MigrationState gebruiken. Resolver warnings krijgen severity `WARN`, resolution successes hoeven niet gelogd (alleen aggregatie in Step 5).

---

## 10. Implementatie volgorde (aanbevolen)

1. State uitbreidingen + reducer actions in `MigrationContext`
2. `schemaInspector.ts` met basis entity + attribute scan
3. Step 1 UI: mode toggle + scan trigger
4. Step 2 UI: dropdown bevolken vanuit schemaSnapshot, auto-match logica
5. `resolverFactory.ts` met direct + choice resolvers (lookup later)
6. `recordResolverApplier.ts` + writer integratie voor projects
7. Lookup resolver toevoegen + test met één lookup veld
8. Step 3 conditional rendering
9. Step 5 skipped fields rapport
10. Tasks + assignments + resources writers integreren
11. Edge cases (multi-choice, localized labels, duplicates) afronden
12. End-to-end test met realistisch dataset

Geschatte effort: 3-5 dagen development voor een ervaren dev op deze codebase.

---

## 11. Open vragen (voor implementatie-tijd)

- Moet de solution-scoped filter (sectie 9.1) hard zijn, of acceptabel om alle custom attributes te tonen? **Aanbeveling: alle tonen, met optionele filter UI.**
- Moet schema-scan resultaat persisteren tussen sessies (bv. in localStorage)? **Aanbeveling: nee, altijd vers — voorkomt staleness issues.**
- Hoe groot zijn de target lookup tabellen typisch bij klanten? Dit bepaalt of pre-load voldoende is.
