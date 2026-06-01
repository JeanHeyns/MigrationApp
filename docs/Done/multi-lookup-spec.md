# Feature Spec: Multi-Value Lookup via N:N Relationships

> **Document type:** Implementation specification for Claude Code
> **Target codebase:** Project Online Migrator (React + TypeScript + Power Apps Code App)
> **Status:** Ready for implementation (two low-risk open items, see §16)
> **Related specs:** `data-only-migration-spec.md`, `schema-only-migration-spec.md`, `file-upload-spec.md`
> **Supersedes:** Implicit pre-existing handling of `LookupMulti` field type (which was silent pass-through and produced incorrect writes)
> **Suggested location in repo:** `docs/multi-lookup-spec.md`

---

## 1. Context & doel

Project Online ondersteunt **multi-value lookup custom fields** — een veld op een project dat meerdere entries selecteert uit een gedeelde lookup-tabel (departments, categorieën, tags, etc.). De huidige app detecteert deze velden al (`FieldType: 'LookupMulti'` in `customFields.ts:63` via de `IsMultiValue` flag), maar de schrijf-laag heeft er geen handling voor — de raw PO-string wordt direct in een Dataverse-kolom gepompt en faalt stil of gooit een DV-fout.

In Dataverse zijn er twee modellen om multi-value te representeren:

| Optie | Voor- en nadeel |
|---|---|
| **MultiChoice** (global option set) | Werkt voor kleine sets (< 50). Voor 900+ entries onhoudbaar — option set values zijn metadata, alleen wijzigbaar via solution import/export door system customizers. |
| **N:N** (Many-to-Many naar custom entity) | Entries worden records in een custom entity. Beheerbaar via standaard records-UI, dataflows, Excel import. Security roles + audit van toepassing. Schaalbaar tot tienduizenden entries. |

Deze spec voegt het **N:N-pad** toe. `MultiChoice` blijft bestaan voor kleine sets; `LookupMulti` (PO) routeert naar N:N. De keuze tussen N:N en MultiChoice is impliciet via PO's metadata: een multi-value veld dat naar een **lookup table** wijst → N:N. Een multi-value veld zonder lookup table (= choice) → MultiChoice.

**Concrete trigger:** een klant met 900 entries in een single lookup-tabel, waar PO-zijde de label `"001 - Engineering"` aanlevert en Dataverse-zijde twee kolommen heeft (`cr123_number`, `cr123_name`) plus een formula-kolom (`cr123_fullname`) die concateneert. De match moet tegen de formula-kolom kunnen lopen, niet alleen tegen de primary name.

**Filosofie:**
- **Pure N:N** (intersect zonder eigen kolommen) — geen metadata op de link. Manual intersect entity is out-of-scope voor v1; ontwerp staat open voor latere uitbreiding.
- **Configurable match-field** per mapping — niet hardcoded op primary name.
- **Strict in dataOnly mode** — schema en records moeten staan; schema inspector faalt met klare melding als ze ontbreken.
- **Defensive in parsing** — split op `;` of `,`, accepteer `null`/`""`/missing key als empty.

---

## 2. Scope

### In scope
- `FieldType: 'LookupMulti'` end-to-end ondersteund in `full`, `dataOnly`, en `schemaOnly` modes
- Entity scope: **Project** custom fields (geen Task/Resource — zie §13.1)
- PO loader: bestaande detectie behouden + opvragen waarde-formaat van OData response
- File upload template: nieuw cell-format voor multi-value (pipe-separated, met fallback parsing)
- Schema creation: N:N relationship + custom lookup entity + entries
- Schema inspector: N:N detectie op `msdyn_project`, validatie van match-field
- Resolver layer: `MultiLookupResolver` met `associateGuids` output
- Writer layer: associate na project create, optioneel pre-clear bij re-run
- Mapping UI: target entity + match-field selectie + N:N relationship selectie (dataOnly)
- Step 5 rapport: per-entry skipped tracking via `partialResolution`
- Backwards compat: single `Lookup`, `MultiChoice`, en alle andere paden ongewijzigd

### Out of scope (voor deze iteratie)
- **Task / Resource multi-lookup velden** — task custom fields worden überhaupt niet gemigreerd (OperationSet-limit). Resource custom fields hebben nog geen template-/loader-pad. Beide kunnen later.
- **Manual intersect entity** (link draagt metadata: rol, weging, datum) — pure N:N volstaat voor bekende use-cases. Ontwerp houdt rekening met latere uitbreiding maar implementeert het niet.
- **Hiërarchische lookup tables** — PO `LookupEntryFullValue` levert het volledige pad (`Department.Engineering.Backend`), maar Dataverse-zijde wordt plat opgeslagen. Self-referencing parent-kolom op de lookup entity is een toekomstige feature.
- **Lazy / streaming entry fetch** — bestaande constraint *"Lookup tables > 5000 records: pre-load with cap + warning"* blijft staan. 900 entries past ruim onder de cap; geen lazy fetch in deze iteratie.
- **Bulk-edit van match-field per mapping** — Step 2 toont match-field dropdown per multi-lookup veld. Geen "set for all" knop in v1.

---

## 3. Architecturale beslissingen

| # | Beslissing | Keuze | Reden |
|---|---|---|---|
| 1 | Multi-value model | N:N naar custom entity, niet MultiChoice | Schaalbaar voor 900+ entries, beheerbaar door functioneel admin |
| 2 | Intersect shape | Pure N:N (geen eigen kolommen) | Use-case vereist geen metadata op de link; manual intersect later mogelijk zonder de pure-N:N-pad te breken |
| 3 | Match-field strategy | Configurable per mapping; default = primary name field | PO-labels matchen niet altijd op DV primary name (zie concat-formula scenario) |
| 4 | dataOnly strictness | Hard fail bij ontbrekend N:N, ontbrekende records, of leeg match-field | Stil overslaan = klant ontdekt dataverlies pas weken later |
| 5 | full / schemaOnly creation | Maak N:N relationship + lookup entity + entries in één run | Consistent met bestaande Lookup-handling; geen pre-step nodig |
| 6 | Associate timing | Na `msdyn_CreateProjectV1`, vóór volgende project | Project-ID nodig; mislukte associates blokkeren de volgende project niet |
| 7 | Re-run strategy | Pre-clear via `DisassociateEntitiesWithOrganization`, dan associate | Consistent met `taskWriter`'s clear & recreate; werkt veilig ongeacht of DV silent dedupliceert |
| 8 | Batching | Sequentieel met `withRetry` | Geen `$batch` beschikbaar in connector; bestaande throttle-handling volstaat |
| 9 | Resolver output | `associateGuids: string[]` op `ResolverResult` | Past in bestaande applyResolvers-flow; writer leest het apart |
| 10 | Skipped tracking | `partialResolution.failedLabels` (bestaand patroon) | Reeds gebruikt door MultiChoice; geen interface-uitbreiding nodig |
| 11 | Cell-format (FileUpload) | Pipe-separated (`A\|B\|C`); fallback `;` of `,` | Pipe vermijdt botsing met labels die komma's of spaties bevatten |
| 12 | Empty multi-value | `null`, `""`, missing key → resolver returns `status: 'empty'` | Defensive parsing; geen warning |
| 13 | Connector wrapper | Nieuwe `CreateManyToManyRelationship` + `GetEntityManyToManyRelationships` operaties in `client.ts` | Hergebruik van `CreateOneToManyRelationship` met N:N body werkt, maar is misleidend in code |
| 14 | Lookup entity creation in dataOnly | Niet — alleen valideren dat hij bestaat | Mode-definitie: dataOnly raakt geen schema aan |
| 15 | Forward compat hook | `relationshipType?: 'pure-nn' \| 'manual-intersect'` op mapping config | Default `pure-nn`; later uitbreidbaar zonder structuur-breuk |

---

## 4. Type definitions & data model changes

### 4.1 PO custom field type — already in place

```typescript
// projectOnline.types.ts (no changes — already exists)
export type PoCustomFieldType =
  | 'Text' | 'Memo' | 'Number' | 'Cost' | 'Date' | 'Boolean'
  | 'Choice' | 'MultiChoice' | 'Lookup'
  | 'LookupMulti'   // already present, was wired to broken pass-through
```

### 4.2 ResolverResult — add `associateGuids`

```typescript
// resolverFactory.ts
export interface ResolverResult {
  status: 'resolved' | 'unresolved' | 'empty'
  value?: unknown
  bindKey?: string
  bindValue?: string
  associateGuids?: string[]      // NEW: GUIDs to N:N-associate after PATCH
  partialResolution?: {
    resolvedLabels: string[]
    failedLabels: string[]
  }
  // ...existing fields
}
```

### 4.3 MappingConfiguration — multi-lookup field mapping

```typescript
// mapping.types.ts
export interface MultiLookupMapping {
  poFieldName: string                      // PO custom field name
  targetEntityLogicalName: string          // e.g. 'cr123_department'
  targetEntitySetName: string              // e.g. 'cr123_departments' (plural)
  matchFieldLogicalName: string            // which DV column to match PO labels against
                                           // default = primary name field
  relationshipSchemaName: string           // e.g. 'cr123_msdyn_project_cr123_department'
  navigationPropertyName: string           // nav prop on msdyn_project side
  relationshipType: 'pure-nn'              // forward-compat hook; only value for v1
}
```

### 4.4 SchemaSnapshot — add N:N relationships per entity

```typescript
// dataOnly.types.ts
export interface NNRelationshipMeta {
  schemaName: string
  intersectEntityName: string
  entity1LogicalName: string
  entity2LogicalName: string
  entity1NavigationPropertyName: string
  entity2NavigationPropertyName: string
  targetEntityLogicalName: string         // the "other side" relative to inspected entity
  targetEntitySetName: string
}

export interface EntitySchema {
  // ...existing
  nnRelationships?: NNRelationshipMeta[]   // NEW
}
```

### 4.5 SkippedFieldInstance — no changes needed

Bestaand `partialResolution` patroon (zie `recordResolverApplier.ts:7-16`) is direct herbruikbaar — MultiChoice gebruikt het al.

---

## 5. PO loader changes

### 5.1 Detection — already done

`customFields.ts:63` zet `'LookupMulti'` als de IsMultiValue-flag set is. Geen wijziging.

### 5.2 Value parsing

PO levert multi-value lookup waardes aan in de project OData response onder de field-naam (`ODataFieldName`). Het exacte format is open (zie §16.1), maar de parsing is defensief:

```typescript
// services/projectOnline/projects.ts of in een nieuwe helper
function parseMultiLookupValue(raw: unknown): string[] {
  if (raw == null || raw === '') return []
  if (Array.isArray(raw)) return raw.map(String).map(s => s.trim()).filter(Boolean)
  // String: split on ; or , (defensive — exact PO separator confirmed at runtime)
  const s = String(raw).trim()
  if (!s) return []
  return s.split(/[;,]/).map(t => t.trim()).filter(Boolean)
}
```

De loader normaliseert naar `string[]` in `PoProject` (custom field bag). Resolver leest een `string[]` zonder zelf te splitten — afwijking van het MultiChoice-patroon (dat intern splitst), maar consistenter omdat de loader het format al kent.

**Backwards compat:** bestaande `MultiChoice`-velden in PO worden niet aangeraakt — die hebben geen `LookupTableId` en gaan via een ander pad in `customFields.ts`.

### 5.3 Entry GUIDs vs labels

PO kan voor multi-value lookup velden zowel GUIDs als labels aanleveren (afhankelijk van de query). De resolver moet beide aankunnen — bestaande Lookup-resolver heeft al dit patroon (`resolverFactory.ts:232-238`): bouw een `sourceLabelMap` met GUID als sleutel en `[FullValue, Value]` als kandidaat-labels, dan match input tegen GUID-set én label-set.

```typescript
// In MultiLookupResolver constructor
const sourceMap = new Map<string, { fullValue: string; value: string }>()
for (const entry of lookupTable.LookupEntries) {
  sourceMap.set(entry.LookupEntryUID, {
    fullValue: entry.LookupEntryFullValue,
    value: entry.LookupEntryValue ?? entry.LookupEntryFullValue,
  })
}
// Per input token: try GUID lookup first, then label match against fullValue/value
```

---

## 6. Excel template changes (FileUpload path)

### 6.1 Cell format

Multi-lookup velden in `Projects` sheet: pipe-separated labels in één cel:

```
ProjectId | ProjectName  | Department
P001      | Apollo       | 001 - Engineering | 014 - DevOps
P002      | Mercury      | 002 - Marketing
P003      | Gemini       |
```

(De `|` in tabel hierboven is markdown — in Excel zit alles in één cel met pipe-separator.)

### 6.2 Loader parsing

```typescript
function parseMultiLookupCell(raw: unknown): string[] {
  if (raw == null || raw === '') return []
  const s = String(raw).trim()
  if (!s) return []
  // Primary: pipe. Fallback: ; or , for users who didn't read the template instructions.
  const sep = s.includes('|') ? '|' : /[;,]/.test(s) ? /[;,]/ : null
  if (!sep) return [s]   // single value, no separator
  return s.split(sep).map(t => t.trim()).filter(Boolean)
}
```

### 6.3 Template `_Instructions` update

Voeg toe aan §4.3 van `file-upload-spec.md`:

```
Multi-value lookup fields
─────────────────────────

Some custom fields allow multiple values per project (e.g. multiple departments,
multiple categories). In your cell, separate the values with a pipe character:

  001 - Engineering | 014 - DevOps | 027 - Architecture

Use the exact label from the lookup table for each value.
```

### 6.4 CustomFields sheet — no change

`FieldType: Lookup` met `IsMultiValue: true` is geen template-concept. Template gebruiker zet `FieldType: LookupMulti`. Dropdown van `FieldType` (zie `file-upload-spec.md` §5) wordt uitgebreid:

```
Text, Memo, Number, Cost, Date, Boolean, Choice, MultiChoice, Lookup, LookupMulti
```

Validation: `FieldType: LookupMulti` zonder `LookupTableName` → row skip + warning (zelfde regel als `Lookup`).

---

## 7. Schema creation (full / schemaOnly)

### 7.1 Connector additions

Voeg twee operaties toe aan `client.ts`:

```typescript
// client.ts — naast bestaande CreateOneToManyRelationship (line 201-213)
CreateManyToManyRelationship: {
  path: "/{connectionId}/api/data/v9.2/RelationshipDefinitions",
  method: 'POST',
  parameters: [
    { name: 'connectionId',                 in: 'path',   required: true,  type: 'string' },
    { name: 'organization',                 in: 'header', required: true,  type: 'string' },
    { name: 'MSCRM.SolutionUniqueName',     in: 'header', required: false, type: 'string' },
    { name: 'item',                         in: 'body',   required: true,  type: 'object' },
  ],
  responseInfo: { default: { type: 'object' } },
},

// Analoog aan GetEntityManyToOneRelationships (line 214-227)
GetEntityManyToManyRelationships: {
  path: "/{connectionId}/api/data/v9.2/EntityDefinitions(LogicalName='{entityLogicalName}')/ManyToManyRelationships",
  method: 'GET',
  parameters: [
    { name: 'connectionId',       in: 'path',   required: true,  type: 'string' },
    { name: 'organization',       in: 'header', required: true,  type: 'string' },
    { name: 'accept',             in: 'header', required: true,  type: 'string' },
    { name: 'entityLogicalName',  in: 'path',   required: true,  type: 'string' },
    { name: '$select',            in: 'query',  required: false, type: 'string' },
  ],
  responseInfo: { default: { type: 'object' } },
},
```

### 7.2 `dataverseService.ts` wrappers

```typescript
export async function createManyToManyRelationship(
  schemaName: string,
  entity1LogicalName: string,
  entity2LogicalName: string,
  entity1Label: string,
  entity2Label: string,
  solutionUniqueName: string,
): Promise<void> {
  const body = {
    '@odata.type': 'Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata',
    SchemaName: schemaName,
    Entity1LogicalName: entity1LogicalName,
    Entity2LogicalName: entity2LogicalName,
    Entity1AssociatedMenuConfiguration: {
      Behavior: 'UseCollectionName',
      Group: 'Details',
      Order: 10000,
      Label: makeLocalizedLabel(entity1Label),
    },
    Entity2AssociatedMenuConfiguration: {
      Behavior: 'UseCollectionName',
      Group: 'Details',
      Order: 10000,
      Label: makeLocalizedLabel(entity2Label),
    },
  }
  await withRetry(() =>
    client.CreateManyToManyRelationship({
      connectionId: getConnectionId(),
      organization: getOrgUrl(),
      'MSCRM.SolutionUniqueName': solutionUniqueName,
      item: body,
    })
  )
}

export async function getEntityManyToManyRelationships(
  entityLogicalName: string,
): Promise<NNRelationshipMeta[]> {
  const result = await withRetry(() =>
    client.GetEntityManyToManyRelationships({
      connectionId: getConnectionId(),
      organization: getOrgUrl(),
      accept: 'application/json',
      entityLogicalName,
      $select: 'SchemaName,IntersectEntityName,Entity1LogicalName,Entity2LogicalName,Entity1NavigationPropertyName,Entity2NavigationPropertyName',
    })
  )
  return (result.value ?? []).map((r: any) => normalizeNNRelationship(r, entityLogicalName))
}
```

Idempotency: bestaande `errorClassifier.ts` vangt `0x80060891` (relatienaam in gebruik) als `AlreadyExists`. Verificeer tijdens implementatie of N:N-creatie dezelfde code retourneert; zo niet, voeg toe.

### 7.3 Schema build flow (full / schemaOnly)

In de bestaande schema-creatie-pipeline (`Step3` orchestratie):

1. Voor elke `LookupMulti` custom field:
   - **a.** Create custom entity (als nog niet bestaat) — zelfde flow als `Lookup`
   - **b.** Create entries — zelfde flow als `Lookup`
   - **c.** **NEW:** Create N:N relationship tussen `msdyn_project` en de custom entity
   - **d.** Bewaar `MultiLookupMapping` in `MappingConfiguration` (zie §4.3)

Stap a en b zijn deelbaar met `Lookup`-flow — extract helper `ensureLookupEntityAndEntries()` indien nog niet bestaand.

Naming conventions:
- Entity: `{publisherPrefix}_{snakeCase(fieldName)}` (e.g. `cr123_department`)
- Relationship: `{publisherPrefix}_msdyn_project_{publisherPrefix}_{snakeCase(fieldName)}` (e.g. `cr123_msdyn_project_cr123_department`)
- Nav prop on `msdyn_project` side: `{publisherPrefix}_{snakeCase(fieldName)}s` (plural, auto-generated by Dataverse if not specified)

### 7.4 schemaOnly mode

Identiek aan full mode voor schema-creatie. Geen data-write, dus geen associates. Schema is klaar voor latere dataOnly run.

---

## 8. Schema inspector (dataOnly mode)

### 8.1 N:N detection

Uitbreiding op `schemaInspector.ts:38` (`inspectEntity`):

```typescript
async function inspectEntity(logicalName: string): Promise<EntitySchema> {
  // ...existing: fetch attributes
  const attributes = await fetchCustomAttributes(logicalName)

  // NEW: fetch N:N relationships
  const nnRelationships = await getEntityManyToManyRelationships(logicalName)

  return {
    logicalName,
    attributes,
    nnRelationships,
  }
}
```

### 8.2 Mapping validation in dataOnly mode

Voor elke `LookupMulti` PO custom field, in `Step2` mapping resolution:

```typescript
function validateMultiLookupMappingDataOnly(
  poField: PoCustomField,
  mapping: MultiLookupMapping,
  snapshot: SchemaSnapshot,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const projectEntity = snapshot.entities['msdyn_project']

  // 1. N:N relationship must exist
  const nn = projectEntity.nnRelationships?.find(r => r.schemaName === mapping.relationshipSchemaName)
  if (!nn) {
    issues.push({
      severity: 'error',
      message: `N:N relationship "${mapping.relationshipSchemaName}" not found on msdyn_project. ` +
               `Run a schemaOnly migration first or create the relationship manually.`,
    })
    return issues  // hard fail, no further checks make sense
  }

  // 2. Target entity must exist
  const targetEntity = snapshot.entities[mapping.targetEntityLogicalName]
  if (!targetEntity) {
    issues.push({
      severity: 'error',
      message: `Target entity "${mapping.targetEntityLogicalName}" not found in solution.`,
    })
    return issues
  }

  // 3. Match field must exist
  const matchField = targetEntity.attributes.find(a => a.logicalName === mapping.matchFieldLogicalName)
  if (!matchField) {
    issues.push({
      severity: 'error',
      message: `Match field "${mapping.matchFieldLogicalName}" not found on ${mapping.targetEntityLogicalName}.`,
    })
    return issues
  }

  // 4. Records must exist AND match field must be populated on most of them
  // Deferred to runtime: when resolver pre-loads entries, count populated match values.
  // If 0 records or <50% populated → error (raise in Step 4 startup, not Step 2).

  return issues
}
```

### 8.3 Runtime match-field population check

In de resolver factory voor dataOnly mode:

```typescript
async function buildMultiLookupResolverDataOnly(mapping: MultiLookupMapping) {
  const records = await listAllRecords(mapping.targetEntitySetName, {
    select: [`${mapping.targetEntityLogicalName}id`, mapping.matchFieldLogicalName],
  })

  if (records.length === 0) {
    throw new SchemaValidationError(
      `Target entity ${mapping.targetEntityLogicalName} has no records. ` +
      `Multi-lookup field "${mapping.poFieldName}" cannot be migrated.`
    )
  }

  const populatedCount = records.filter(r => r[mapping.matchFieldLogicalName]).length
  if (populatedCount === 0) {
    throw new SchemaValidationError(
      `Match field "${mapping.matchFieldLogicalName}" is empty on all ${records.length} ` +
      `records in ${mapping.targetEntityLogicalName}. Cannot match PO labels.`
    )
  }

  // Build labelMap from records
  const labelMap = new Map<string, string>()  // matchValue → recordId
  for (const r of records) {
    const matchValue = String(r[mapping.matchFieldLogicalName] ?? '').trim()
    if (matchValue) labelMap.set(matchValue, r[`${mapping.targetEntityLogicalName}id`])
  }

  return new MultiLookupResolver(mapping, labelMap)
}
```

---

## 9. Resolver layer

### 9.1 New `MultiLookupResolver`

```typescript
// resolverFactory.ts
class MultiLookupResolver implements FieldResolver {
  constructor(
    private mapping: MultiLookupMapping,
    private labelMap: Map<string, string>,   // matchValue → DV recordId
    private sourceMap?: Map<string, string>, // PO GUID → PO label (full mode only)
  ) {}

  resolve(poValue: unknown): ResolverResult {
    const labels = normalizeMultiLookupInput(poValue, this.sourceMap)
    if (labels.length === 0) return { status: 'empty' }

    const resolved: string[] = []
    const failed: string[] = []
    for (const label of labels) {
      const guid = this.labelMap.get(label)
      if (guid) resolved.push(guid)
      else failed.push(label)
    }

    if (resolved.length === 0) {
      return {
        status: 'unresolved',
        partialResolution: { resolvedLabels: [], failedLabels: failed },
      }
    }

    return {
      status: 'resolved',
      associateGuids: resolved,
      partialResolution: failed.length > 0
        ? { resolvedLabels: labels.filter(l => !failed.includes(l)), failedLabels: failed }
        : undefined,
    }
  }
}

function normalizeMultiLookupInput(raw: unknown, sourceMap?: Map<string, string>): string[] {
  if (raw == null || raw === '') return []
  const tokens = Array.isArray(raw)
    ? raw.map(String)
    : String(raw).split(/[;,|]/).map(t => t.trim()).filter(Boolean)

  // If sourceMap (full mode), map GUIDs to labels; pass labels through.
  if (!sourceMap) return tokens
  return tokens.map(t => sourceMap.get(t) ?? t)
}
```

### 9.2 Build path — full mode

```typescript
function buildMultiLookupResolverFullMode(
  poField: PoCustomField,
  lookupTable: PoLookupTable,
  mapping: MultiLookupMapping,
): Promise<FieldResolver> {
  // Load DV records (just created in Step 3)
  const records = await listAllRecords(mapping.targetEntitySetName, {
    select: [`${mapping.targetEntityLogicalName}id`, mapping.matchFieldLogicalName],
  })
  const labelMap = new Map<string, string>()
  for (const r of records) {
    const matchValue = String(r[mapping.matchFieldLogicalName] ?? '').trim()
    if (matchValue) labelMap.set(matchValue, r[`${mapping.targetEntityLogicalName}id`])
  }

  // Build sourceMap (PO GUID → label) for input normalization
  const sourceMap = new Map<string, string>()
  for (const e of lookupTable.LookupEntries) {
    sourceMap.set(e.LookupEntryUID, e.LookupEntryFullValue)
  }

  return new MultiLookupResolver(mapping, labelMap, sourceMap)
}
```

### 9.3 Build path — dataOnly mode

Zie §8.3.

### 9.4 Wire-in to `buildResolver` / `buildFullModeFieldResolver`

```typescript
// resolverFactory.ts:93-169 (full mode)
switch (poField.CustomFieldType) {
  // ...existing cases
  case 'LookupMulti':
    return buildMultiLookupResolverFullMode(poField, lookupTable, mapping)
}

// resolverFactory.ts:296-301 (dataOnly mode)
switch (dvType) {
  // ...existing cases
  // For LookupMulti, dvType is not a single ColumnMetaType — handled separately
}

// New entry point for LookupMulti in dataOnly:
function buildResolverForMultiLookup(mapping: MultiLookupMapping): FieldResolver {
  return buildMultiLookupResolverDataOnly(mapping)
}
```

### 9.5 Caching

Module-level cache analoog aan `optionSetCache` (`resolverFactory.ts:55`):

```typescript
const multiLookupRecordCache = new Map<string, Map<string, string>>()
// key: targetEntitySetName + ':' + matchFieldLogicalName
// value: labelMap
```

Hergebruik tussen meerdere `LookupMulti` velden die naar dezelfde entity wijzen — onwaarschijnlijk in de praktijk maar gratis optimalisatie.

---

## 10. Writer integration

### 10.1 applyResolvers — read associateGuids

```typescript
// recordResolverApplier.ts
export interface ApplyResolversResult {
  payload: Record<string, unknown>
  skippedFields: SkippedField[]
  pendingAssociations: PendingAssociation[]   // NEW
}

export interface PendingAssociation {
  poFieldName: string
  navigationPropertyName: string
  targetEntitySetName: string
  guids: string[]
  failedLabels: string[]   // for skipped-field reporting
}

export function applyResolvers(
  poRecord: PoProject,
  resolvers: Map<string, FieldResolver>,
  mappings: MappingConfiguration,
): ApplyResolversResult {
  const payload: Record<string, unknown> = {}
  const skipped: SkippedField[] = []
  const pendingAssociations: PendingAssociation[] = []

  for (const [poFieldName, resolver] of resolvers) {
    const result = resolver.resolve(poRecord[poFieldName])

    if (result.status === 'empty') continue

    if (result.associateGuids) {
      // Multi-lookup path
      const mapping = mappings.multiLookups.find(m => m.poFieldName === poFieldName)!
      pendingAssociations.push({
        poFieldName,
        navigationPropertyName: mapping.navigationPropertyName,
        targetEntitySetName: mapping.targetEntitySetName,
        guids: result.associateGuids,
        failedLabels: result.partialResolution?.failedLabels ?? [],
      })
      if (result.partialResolution && result.partialResolution.failedLabels.length > 0) {
        skipped.push({
          fieldName: poFieldName,
          reason: 'partialResolution',
          partialResolution: result.partialResolution,
        })
      }
      continue
    }

    // Existing scalar/bind handling
    if (result.bindKey && result.bindValue) {
      payload[result.bindKey] = result.bindValue
    } else if (result.value !== undefined) {
      payload[/* column logical name */] = result.value
    }

    if (result.status === 'unresolved') {
      skipped.push({ fieldName: poFieldName, reason: 'unresolved' })
    }
  }

  return { payload, skippedFields: skipped, pendingAssociations }
}
```

### 10.2 `projectWriter.ts` — associate after create

```typescript
async function writeProject(po: PoProject, /* ... */): Promise<ImportResult> {
  const { payload, skippedFields, pendingAssociations } = applyResolvers(po, resolvers, mappings)

  // Existing: create project
  const projectId = await createProject(payload)

  // NEW: handle associations
  for (const assoc of pendingAssociations) {
    // Pre-clear existing associations if re-run mode
    if (isReRun) {
      await disassociateAll(projectId, assoc.navigationPropertyName)
    }

    for (const targetGuid of assoc.guids) {
      try {
        await withRetry(() =>
          associateRecord(
            'msdyn_projects',
            projectId,
            assoc.navigationPropertyName,
            buildAssociateRef(assoc.targetEntitySetName, targetGuid),
          )
        )
      } catch (err) {
        const classification = classifyDataverseError(err)
        if (classification === 'AlreadyExists') continue   // silent skip
        // Otherwise: log and continue with next association
        logAssociateFailure(po.ProjectId, assoc.poFieldName, targetGuid, err)
      }
    }
  }

  return { /* existing */, skippedFields, associationsCreated: countAssociations(pendingAssociations) }
}
```

### 10.3 Pre-clear helper

```typescript
async function disassociateAll(projectId: string, navProp: string): Promise<void> {
  // Fetch current associations
  const currentRefs = await listAssociatedRecords('msdyn_projects', projectId, navProp)
  for (const ref of currentRefs) {
    try {
      await withRetry(() =>
        disassociateRecord('msdyn_projects', projectId, navProp, ref.id)
      )
    } catch {
      // Best-effort; log but don't fail the write
    }
  }
}
```

### 10.4 OperationSet compatibility

N:N associates lopen **niet** via OperationSet. Ze gebeuren sequentieel per project, na `msdyn_CreateProjectV1`. Heeft geen impact op de bestaande task/assignment OperationSet flow.

---

## 11. Mapping UI (Step 2)

### 11.1 Detection in MappingPanel

Per PO custom field met `CustomFieldType === 'LookupMulti'`: render een nieuwe `MultiLookupMappingRow` component.

### 11.2 Full / schemaOnly mode UI

```
Department (LookupMulti, 900 entries)
─────────────────────────────────────
Target: ☐ Create new lookup entity "Department"  (recommended)
        ☐ Use existing entity: [dropdown of custom entities]

Match PO labels against: [dropdown of text columns of target entity]
  Default: primary name field
  Example values from target entity: "001 - Engineering", "002 - Marketing", "003 - Sales"
```

Als "Create new" geselecteerd: match-field is automatisch de primary name (we hebben volledige controle, geen formula-veld).

### 11.3 dataOnly mode UI

```
Department (LookupMulti, 900 entries)
─────────────────────────────────────
Target entity:        [dropdown of entities with N:N to msdyn_project]
                      e.g. "cr123_department" ▾
N:N relationship:     [auto-selected if only one between project and target]
                      "cr123_msdyn_project_cr123_department"
Match field:          [dropdown of text/string/formula columns on target entity]
                      "cr123_fullname" ▾
                      Preview: "001 - Engineering", "002 - Marketing", ...
                      ✓ 900 records found, 900 with match value
```

Validation badges:
- ✓ groen: N:N + records + match field allemaal OK
- ⚠ oranje: N:N + records OK, sommige records missen match value
- ✗ rood: N:N ontbreekt, of geen records, of match field leeg op alle records

### 11.4 Match-field dropdown population

```typescript
function getMatchFieldCandidates(entitySchema: EntitySchema): ColumnMeta[] {
  return entitySchema.attributes.filter(a =>
    a.attributeType === 'String' ||
    a.attributeType === 'Memo' ||
    a.attributeType === 'Virtual'   // formula columns
  )
}
```

Default selectie: primary name field (`PrimaryNameAttribute` from entity metadata).

### 11.5 Persistence in MappingConfiguration

```typescript
interface MappingConfiguration {
  // ...existing
  multiLookups: MultiLookupMapping[]   // NEW
}
```

---

## 12. Step 5 reporting

### 12.1 New summary counter

In `ImportResult`:

```typescript
interface ImportResult {
  // ...existing
  associationsCreated?: number     // total N:N associates across all projects
  associationsFailed?: number      // failed (after retries) — not "skipped due to unresolved label"
}
```

In Step 5 UI:

```
Migration Summary
─────────────────
Projects:       200 created
Tasks:        16,000 created
Resources:        47 created
Assignments:  12,800 created
Associations:  1,234 created  (NEW — only shown if any LookupMulti fields migrated)
```

### 12.2 Skipped fields — per-entry rows

Bestaande "Skipped Fields" sectie krijgt rows met `partialResolution`:

```
Project P042 "Apollo Mission":
  · Department (LookupMulti): 3 of 5 values matched
      ✗ Unmatched: "999 - Legacy", "888 - Deprecated"
      ✓ Matched: "001 - Engineering", "014 - DevOps", "027 - Architecture"
```

CSV export columns extended:

| ProjectId | FieldName | FieldType | Reason | FailedLabels | ResolvedLabels |
|---|---|---|---|---|---|
| P042 | Department | LookupMulti | partialResolution | `999 - Legacy\|888 - Deprecated` | `001 - Engineering\|014 - DevOps\|027 - Architecture` |

---

## 13. Edge cases & gotchas

### 13.1 Task / Resource multi-lookup velden
Out-of-scope per §2. Task custom fields worden überhaupt niet gemigreerd (OperationSet-limit). Resource custom fields zijn nog niet in template/loader. Multi-lookup op Task/Resource velden: loader detecteert ze, schema-creatie slaat ze over met warning *"LookupMulti on entity Task/Resource not supported in this version"*, geen N:N gecreëerd.

### 13.2 Empty multi-value
`null`, `""`, missing key, of lege array → `status: 'empty'` in resolver, geen associate, geen warning. Identiek aan single Lookup-gedrag voor lege waarden.

### 13.3 Duplicate values in PO source
`"A;B;A"` of `["A", "B", "A"]`: dedupe silently in `normalizeMultiLookupInput`. Geen warning — typisch geen user error maar PO-artefact.

### 13.4 Label collision in target entity
Twee records in `cr123_department` met dezelfde match-value (bv. twee "Engineering" entries onder verschillende parents). `labelMap` is een `Map<string, string>` — laatste-wint. Warning bij build van resolver: *"Match field has N duplicate values; first record wins per label."* Niet per-record, één keer.

### 13.5 Match-field met null/empty op sommige records
Records waarvan match-field leeg is, worden uit `labelMap` weggelaten. Resolver kan dus tegen die records niet matchen. Geen warning per-record; al gedekt door de §8.3 startup-check ("X of N records hebben match value").

### 13.6 PO entry verwijderd tussen fetch en write
Resolver `sourceMap` heeft GUID maar `labelMap` niet → token blijft in `failedLabels`. Logging als skipped via `partialResolution`. Identiek aan single Lookup edge case.

### 13.7 Hiërarchische lookup tables
PO `LookupEntryFullValue = "Department.Engineering.Backend"`, target entity flat. Match werkt als de gebruiker de DV `cr123_fullname` met `"Department.Engineering.Backend"` heeft gevuld. Anders: `failedLabels`. Documenteer in template instructions.

### 13.8 Re-run met gewijzigde mapping
Pre-clear gebruikt `navigationPropertyName` uit de huidige mapping. Als gebruiker tussen runs de mapping wijzigt (ander target entity), worden de oude associaties niet opgeruimd — die blijven op de oude entity hangen. Out-of-scope om dit op te lossen; documenteer als limitation: *"If you change a multi-lookup mapping between runs, old associations remain. Delete the old N:N relationship or its records manually if needed."*

### 13.9 N:N met `msdyn_project` als beide sides
Onmogelijk in PO multi-lookup context (PO multi-lookup wijst altijd naar een custom lookup table, nooit naar projects). Schema inspector negeert deze edge case.

### 13.10 Custom entity already has data not from this migration
DataOnly mode: target entity heeft 900 records, sommige hebben match-value, sommige niet. Niet onze records. Migratie matcht tegen alles wat een match-value heeft. Acceptabel — het is de target tenant z'n verantwoordelijkheid om alleen relevante records in de tabel te hebben. Geen extra filter.

### 13.11 Re-run idempotency
Pre-clear + associate werkt altijd, ongeacht of DV silent dedupliceert of niet. Cost: extra disassociate-calls bij re-run. Acceptabel.

### 13.12 1000+ associates per project
Theoretisch mogelijk maar absurd (PO laat zelden meer dan 10-20 multi-value selecties toe per veld). Geen cap, geen optimization. Als het in praktijk pijn doet: aparte ticket.

### 13.13 Multi-lookup field zonder mapping in Step 2
Gebruiker kan in Step 2 een LookupMulti field bewust unchecken. Loader heeft hem nog steeds gefetcht, resolver wordt niet gebouwd, geen schema/data actie. Identiek aan single Lookup behavior.

---

## 14. Acceptance criteria

De feature is klaar wanneer:

### Detection & parsing
1. ✅ PO custom field met `IsMultiValue: true` wordt gedetecteerd als `'LookupMulti'` (al werkend, regressie-test)
2. ✅ Multi-value waarde in PO OData response wordt geparseerd naar `string[]` ongeacht separator (`;`, `,`, of array)
3. ✅ Empty multi-value (`null`, `""`, missing) → resolver returns `status: 'empty'`
4. ✅ Excel template cell met pipe-separated waarden → `string[]` na parsing
5. ✅ Excel template cell met semicolon/komma als fallback separator → `string[]`

### Schema creation (full / schemaOnly)
6. ✅ `LookupMulti` veld creëert custom entity + entries + N:N relationship in één run
7. ✅ Re-run: bestaande N:N retourneert `AlreadyExists` (silent skip)
8. ✅ `client.ts` heeft `CreateManyToManyRelationship` en `GetEntityManyToManyRelationships` operaties
9. ✅ N:N landt in de geselecteerde solution (verified via solution explorer)

### Schema inspector (dataOnly)
10. ✅ `inspectEntity('msdyn_project')` retourneert `nnRelationships[]` met expected metadata
11. ✅ Step 2 toont alleen N:N relaties op `msdyn_project` waarvan target entity custom is (geen `msdyn_*`)
12. ✅ Step 2 dataOnly: rode error als N:N ontbreekt op target entity
13. ✅ Step 4 startup: harde fout als match-field leeg op alle records van target entity

### Mapping UI
14. ✅ Step 2 toont match-field dropdown per LookupMulti veld
15. ✅ Default match-field = primary name field van target entity
16. ✅ Dropdown bevat string/memo/formula kolommen
17. ✅ Validation badges (groen/oranje/rood) correct getoond
18. ✅ Mapping persistent in `MigrationState.mappingConfig.multiLookups`

### Resolver
19. ✅ `MultiLookupResolver` matched labels tegen `labelMap`, retourneert `associateGuids`
20. ✅ Gedeeltelijke match → `partialResolution.failedLabels` gevuld
21. ✅ Zero match → `status: 'unresolved'`
22. ✅ Cache: tweede LookupMulti veld met zelfde target entity + match-field hergebruikt records

### Writer
23. ✅ N:N associates worden gemaakt na `msdyn_CreateProjectV1`
24. ✅ Re-run modus pre-cleared bestaande associates
25. ✅ `AlreadyExists` fout op associate → silent skip
26. ✅ Andere fouten op associate → gelogd in diagnostics, loop gaat door

### Reporting
27. ✅ Step 5 toont `Associations: N created` counter
28. ✅ Skipped fields met `partialResolution` tonen resolved + failed labels
29. ✅ CSV export bevat FailedLabels / ResolvedLabels kolommen

### Backwards compatibility
30. ✅ Single `Lookup` veld werkt onveranderd (regressie-test met een bestaande fixture)
31. ✅ `MultiChoice` veld werkt onveranderd
32. ✅ Project zonder LookupMulti velden: geen extra calls, geen UI-verandering in Step 2 voor andere field types
33. ✅ `npm run build` slaagt; `pac code push` deployed cleanly
34. ✅ Bestaande end-to-end test suite passes

### Integration
35. ✅ Full mode + LookupMulti → schema + data + associates eind-tot-eind
36. ✅ SchemaOnly mode + LookupMulti → schema klaar, data overgeslagen
37. ✅ DataOnly mode + LookupMulti → records geassocieerd, schema ongewijzigd
38. ✅ FileUpload + LookupMulti + alle drie modes werkt

---

## 15. Implementatie volgorde

Phased, met verificatie per phase. Geschat 4–5 dagen voor een ervaren dev.

### Phase 1 — Foundation (loader + types) — ~0.5 dag
1. `MultiLookupMapping`, `NNRelationshipMeta`, `PendingAssociation` types
2. `ResolverResult.associateGuids` toevoegen
3. `MappingConfiguration.multiLookups` toevoegen
4. `MigrationState` reducer-actions voor multi-lookup mapping persistence
5. Loader: `parseMultiLookupValue` helper + integratie in PO project parser

**Verificatie:** unit test op parser met verschillende inputs.

### Phase 2 — Connector + schema services — ~1 dag
6. `client.ts`: `CreateManyToManyRelationship` + `GetEntityManyToManyRelationships`
7. `dataverseService.ts`: `createManyToManyRelationship` + `getEntityManyToManyRelationships` + `associateRecord` + `disassociateRecord` wrappers
8. `schemaInspector.ts`: integratie van N:N fetch

**Verificatie:** manual call vanuit een debug-knop of console — creëer een N:N, lees hem terug, associate, disassociate.

### Phase 3 — Resolver — ~1 dag
9. `MultiLookupResolver` class
10. `buildMultiLookupResolverFullMode` + `buildMultiLookupResolverDataOnly`
11. Wire-in `LookupMulti` case in resolver dispatch (full + dataOnly)
12. Module-level cache

**Verificatie:** unit test met mock labelMap + sourceMap, assert correct `associateGuids` en `partialResolution`.

### Phase 4 — Writer — ~0.5 dag
13. `applyResolvers` returnt `pendingAssociations`
14. `projectWriter` loopt door pendingAssociations, associate + retry + error handling
15. Pre-clear logic voor re-run

**Verificatie:** end-to-end run in dev tegen testproject met 2-3 multi-value entries.

### Phase 5 — Mapping UI — ~1 dag
16. `MultiLookupMappingRow` component (full/schemaOnly variant)
17. `MultiLookupMappingRow` dataOnly variant met dropdown + validation badges
18. Match-field dropdown population
19. Live preview van match-field waardes

**Verificatie:** klik door alle drie modes in UI, controleer mapping persistent in state.

### Phase 6 — Reporting + final integration — ~0.5 dag
20. `ImportResult.associationsCreated` counter
21. Step 5 summary update
22. Skipped fields rendering met partialResolution
23. CSV export columns

**Verificatie:** volledige end-to-end test met klant-fixture (900 entries, formula match-field). Vergelijk PO vs DV per project.

### Phase 7 — Regression + polish — ~0.5 dag
24. Bestaande Lookup/MultiChoice end-to-end test
25. SchemaOnly + dataOnly mode tests
26. FileUpload data source met multi-lookup template
27. Documentation update (`_Instructions` sheet in template generator)

---

## 16. Open punten (low-risk runtime verificaties)

Deze items hoeven niet vóór implementatie beantwoord — ze beïnvloeden één regel code elk en kunnen tijdens Phase 1/4 worden bevestigd.

### 16.1 PO multi-value storage format (§2.3, §2.6 van discovery)
**Wat:** exacte separator en empty-representatie van een populated `LookupMulti` veld in `_api/ProjectData/Projects?$format=json`.
**Risico:** laag — `parseMultiLookupValue` accepteert al `;`, `,`, en array. Empty handling dekt `null`/`""`/missing.
**Verificatie:** één live PO-fetch in Phase 1, log de raw waarde. Pas separator-regex of empty-check aan indien nodig.

### 16.2 Associate idempotency (§3.5)
**Wat:** retourneert `AssociateEntitiesWithOrganization` 204 No Content of een foutcode bij dubbele `(record, navProp, target)` combinatie?
**Risico:** laag — pre-clear strategy werkt veilig in beide gevallen. Als silent dedupe: pre-clear is overhead maar correct. Als foutcode: pre-clear is essentieel.
**Verificatie:** één manuele dubbele call in Phase 2. Indien foutcode: voeg toe aan `AlreadyExists`-set in `errorClassifier.ts`.

### 16.3 N:N create idempotency
**Wat:** welke errorcode retourneert Dataverse bij creatie van een N:N met reeds bestaande SchemaName?
**Risico:** laag — `errorClassifier.ts` heeft al `0x80060891` (relatienaam in gebruik) als `AlreadyExists`. Verificeer of dit ook voor N:N retourneert.
**Verificatie:** in Phase 2, run schema-creatie tweemaal achter elkaar in dev. Bevestig silent skip.

---

## 17. Toekomstige uitbreidingen (expliciet niet in v1)

- **Manual intersect entity** met link-metadata (rol, weging, datum). `relationshipType: 'manual-intersect'` is al gereserveerd in `MultiLookupMapping`. Implementatie: extra entity + twee 1:N relaties + payload-shape per intersect record.
- **Task multi-lookup velden** — vereist eerst dat task custom fields überhaupt gemigreerd worden (OperationSet-limit).
- **Resource multi-lookup velden** — vereist eerst dat Resources sheet template custom field kolommen ondersteunt.
- **Hiërarchische lookup tables** — zelf-referentiële parent-kolom op de custom entity, en hierarchical match strategy (full path vs leaf name).
- **Bulk match-field configuratie** — "set for all multi-lookup fields" knop in Step 2.
- **Lazy / streaming entry fetch** — pas relevant bij lookup tables > 5000 entries.
