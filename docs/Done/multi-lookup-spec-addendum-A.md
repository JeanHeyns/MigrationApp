# Addendum A: MultiChoice vs N:N target choice per LookupMulti field

> **Document type:** Addendum to `multi-lookup-spec.md`
> **Reason for addendum:** Tijdens UI-review bleek dat een PO `LookupMulti` veld niet automatisch naar N:N moet gaan — voor kleine lookup-tabellen blijft MultiChoice (global option set) een legitieme target. De keuze hoort bij de gebruiker, per veld.
> **Status:** Ready for implementation
> **Applies to:** Sections §2, §3, §7, §9, §11, §14 of the base spec

---

## A.1 Wijziging in architecturale beslissingen (§3)

Twee nieuwe beslissingen toegevoegd aan de tabel:

| # | Beslissing | Keuze | Reden |
|---|---|---|---|
| 16 | Target shape per LookupMulti veld | Configurable: `MultiChoice` of `N:N` | Kleine lookup-tabellen (< ~50 entries) zijn prima als option set; alleen grote tabellen vereisen N:N |
| 17 | Default target shape | `MultiChoice` voor elk LookupMulti veld | Lichtste schema-footprint; gebruiker schakelt bewust naar N:N waar nodig |

**Toelichting bij #17:** geen automatische drempel op entry count. De gebruiker is degene die weet of een 60-entries tabel met de hand beheerd zal worden (option set OK) of onderhouden door functioneel admin (N:N nodig). Een drempel zou een illusie van precisie geven.

**dataOnly mode:** target shape staat in het bestaande schema vast — de "Migrate as" dropdown is read-only. Schema inspector detecteert per veld of het target een N:N relationship is of een MultiChoice kolom, en stelt dat in zonder gebruikersactie. Mismatch (PO veld is LookupMulti maar target heeft geen N:N noch MultiChoice kolom met de verwachte naam) → hard fail met klare melding.

---

## A.2 Wijziging in scope (§2)

**Verwijderen uit "In scope":**
- ~~LookupMulti routes to N:N always~~

**Toevoegen aan "In scope":**
- `LookupMulti` velden ondersteunen twee target shapes — `MultiChoice` (global option set) of `N:N` (custom entity)
- Per-veld configuratie via "Migrate as" dropdown in Step 2
- Default = `MultiChoice` (lichtste footprint)
- DataOnly mode: target shape gedetecteerd uit bestaand schema, dropdown read-only

---

## A.3 Wijziging in type definitions (§4)

`MultiLookupMapping` krijgt een extra veld om de target shape vast te leggen:

```typescript
// mapping.types.ts
export type MultiLookupTargetShape = 'MultiChoice' | 'N:N'

export interface MultiLookupMapping {
  poFieldName: string
  targetShape: MultiLookupTargetShape   // NEW: 'MultiChoice' (default) or 'N:N'

  // Fields below only relevant when targetShape === 'N:N'
  targetEntityLogicalName?: string
  targetEntitySetName?: string
  matchFieldLogicalName?: string
  relationshipSchemaName?: string
  navigationPropertyName?: string
  relationshipType?: 'pure-nn'

  // Field below only relevant when targetShape === 'MultiChoice'
  targetColumnLogicalName?: string      // NEW: DV column for MultiChoice path
}
```

**MappingConfiguration** krijgt twee lijsten (niet meer één):

```typescript
interface MappingConfiguration {
  // ...existing
  multiLookups: MultiLookupMapping[]            // all LookupMulti mappings; split by targetShape at write time
}
```

Eén lijst blijft makkelijker dan twee parallelle lijsten — de writer-laag splitst zelf op `targetShape`.

---

## A.4 Wijziging in schema creation (§7)

Per LookupMulti veld in `full` / `schemaOnly` mode, op basis van `mapping.targetShape`:

**Als `targetShape === 'MultiChoice'`:**
- Pad identiek aan bestaande `MultiChoice` flow (geen wijziging)
- Global option set wordt gecreëerd met de PO lookup entries als options
- Multi-select column wordt op `msdyn_project` aangemaakt
- Geen custom entity, geen N:N relationship

**Als `targetShape === 'N:N'`:**
- Pad zoals beschreven in basis-spec §7.3
- Custom lookup entity + entries + N:N relationship

Beide paden delen dezelfde lookup table data uit PO; de scheiding zit alleen in de Dataverse-side modellering.

---

## A.5 Wijziging in resolver layer (§9)

Twee aparte resolver-builders, gekozen op basis van `targetShape`:

```typescript
// resolverFactory.ts — full mode dispatch
switch (poField.CustomFieldType) {
  case 'LookupMulti': {
    const mapping = mappings.multiLookups.find(m => m.poFieldName === poField.Name)
    if (mapping?.targetShape === 'N:N') {
      return buildMultiLookupResolverFullMode_NN(poField, lookupTable, mapping)
    }
    return buildMultiLookupResolverFullMode_MultiChoice(poField, lookupTable, mapping)
  }
  // ...other cases
}
```

`buildMultiLookupResolverFullMode_MultiChoice` hergebruikt de bestaande `MultiChoice` resolver-flow (geen nieuwe code). `buildMultiLookupResolverFullMode_NN` is wat de basis-spec §9.2 beschrijft.

DataOnly mode: identiek patroon, dispatch op `targetShape` zoals gedetecteerd door schema inspector.

---

## A.6 Wijziging in writer integration (§10)

`applyResolvers` werkt al voor beide paden:
- MultiChoice resolver retourneert `bindKey` / `value` (column write) — bestaand gedrag
- N:N resolver retourneert `associateGuids` — zoals beschreven in basis-spec §10.1

Geen wijziging aan `recordResolverApplier.ts` of `projectWriter.ts` boven op de basis-spec.

---

## A.7 Wijziging in Mapping UI (§11) — vervangt §11 volledig

### A.7.1 Custom field mapping tabel — kolom-volgorde

| Kolom | Voor LookupMulti rows | Voor andere rows |
|---|---|---|
| Skip | checkbox | checkbox |
| Field name | naam + ODataFieldName | naam + ODataFieldName |
| PO type | `LookupMulti` | bv. `Lookup`, `Text`, `Number` |
| Migrate as | dropdown: `MultiChoice` / `N:N relationship` | `—` (niet van toepassing) |
| Dataverse column | dropdown (alleen als `MultiChoice`) of tekstuele verwijzing `↓ see N:N panel below` (als `N:N`) | dropdown |

Sleutel-inzicht: **"Migrate as" komt vóór "Dataverse column"** in de kolomvolgorde, omdat de eerste de tweede context geeft. Een gebruiker kan geen kolom kiezen voordat hij weet of het pad column-based (MultiChoice) of relationship-based (N:N) is.

### A.7.2 LookupMulti row — twee states

**State 1: `Migrate as = MultiChoice` (default)**
- Row ziet er identiek uit aan een bestaande MultiChoice mapping
- Dataverse column dropdown actief
- Geen row in onderste paneel

**State 2: `Migrate as = N:N`**
- Row wordt visueel gedimd (background `var(--color-background-secondary)`, indicator-dot grijs)
- Subtitel onder field name wijzigt naar "Configured below as N:N"
- Dataverse column kolom toont tekstuele verwijzing `↓ see N:N panel below` (geen disabled dropdown — minder visuele ruis)
- Row verschijnt in onderste paneel "Multi-value lookup fields"

### A.7.3 Onderste paneel "Multi-value lookup fields"

- Toont alleen velden waarvan `targetShape === 'N:N'`
- Header: `Multi-value lookup fields (N fields)` waar N het aantal N:N velden is
- Leeg state: dashed border placeholder met `<i class="ti ti-circle-dashed">` icon en tekst "No fields set to N:N. Change Migrate as to N:N relationship in the table above to configure here."
- Per veld een card met drie config-velden naast elkaar (zie basis-spec §11):
  - **Target entity (N:N)** — dropdown van beschikbare entities
  - **Match PO labels against** — dropdown van text/string/formula kolommen
  - **Status** — read-only indicator (entries gevonden / records gevuld)

### A.7.4 DataOnly mode UI

- "Migrate as" dropdown is read-only (disabled), waarde komt uit schema inspector
- Geen mogelijkheid om te wisselen tussen MultiChoice en N:N (target schema is leidend)
- Onderste paneel toont alleen velden waarvan de inspector N:N heeft gedetecteerd
- Bij mismatch (PO veld is LookupMulti, geen target gevonden in schema): rode error in row, hard fail bij Step 4 start

### A.7.5 Toggle gedrag

- Wisselen van `MultiChoice` → `N:N`: behoud van eventuele eerder ingevulde N:N config (target entity, match field) als die er was. Anders: defaults.
- Wisselen van `N:N` → `MultiChoice`: N:N config wordt visueel verborgen maar in state bewaard (gebruiker kan ongedaan maken zonder opnieuw configureren).
- "Skip" check overschrijft alles — het veld wordt niet gemigreerd ongeacht targetShape.

---

## A.8 Wijziging in acceptance criteria (§14)

**Vervangen:**
- ~~AC #14: Step 2 toont match-field dropdown per LookupMulti veld~~ → "Step 2 toont 'Migrate as' dropdown per LookupMulti veld, met opties MultiChoice en N:N relationship"

**Toevoegen:**
- AC #14a: Default "Migrate as" waarde = MultiChoice voor elk LookupMulti veld
- AC #14b: Wisselen "Migrate as" naar N:N verbergt Dataverse column dropdown, toont verwijzing naar onderste paneel, voegt row toe in onderste paneel
- AC #14c: Wisselen "Migrate as" terug naar MultiChoice herstelt Dataverse column dropdown, verwijdert row uit onderste paneel
- AC #14d: DataOnly mode — "Migrate as" dropdown is read-only, waarde komt uit schema inspector
- AC #14e: DataOnly mode — als schema inspector noch N:N noch MultiChoice target detecteert voor een LookupMulti veld: rode error, hard fail bij Step 4 start
- AC #14f: Match field dropdown verschijnt alleen in onderste paneel voor N:N velden

---

## A.9 Wijziging in implementatie volgorde (§15)

**Phase 5 (Mapping UI) wordt uitgebreid van ~1 dag naar ~1.5 dagen:**

16. `LookupMultiRow` component met "Migrate as" dropdown + conditional rendering van Dataverse column vs verwijzing
17. `MultiLookupNNConfigRow` component (onderste paneel) — alleen voor N:N velden
18. Empty state placeholder voor onderste paneel
19. State management: behouden van N:N config bij toggle naar MultiChoice en terug
20. DataOnly schema inspector: detecteer per LookupMulti veld of target N:N of MultiChoice is
21. DataOnly mode: read-only "Migrate as" dropdown + mismatch detection

**Totaal effort spec + addendum: ~4.5–5.5 dagen** (was 4–5 dagen in basis-spec).

---

## A.10 Edge cases — toevoegingen aan §13

### A.10.1 LookupMulti met > 50 entries op MultiChoice
Geen automatische block. Dataverse global option sets hebben geen harde limiet — performance en beheerbaarheid degraderen, maar het werkt. Geef alleen een soft warning in Step 2: bij selectie van MultiChoice voor een veld met > 50 entries → kleine inline notice *"Large option set may be hard to maintain. Consider N:N for > 50 entries."* Geen blocker, geen popup, gewoon een visuele hint.

### A.10.2 DataOnly mode — target schema heeft beide (N:N én MultiChoice kolom)
Ongebruikelijk maar mogelijk: een eerdere full-mode run heeft beide aangemaakt (gewisseld tussen targetShape tussen schemaOnly run en dataOnly run). Schema inspector geeft N:N voorrang, MultiChoice kolom wordt genegeerd met info-warning *"Both N:N relationship and MultiChoice column found for field X. Using N:N. Remove the MultiChoice column if not needed."*

### A.10.3 Wisselen tussen schemaOnly en dataOnly runs met andere targetShape
Klant draait schemaOnly met `targetShape: N:N` voor "Codes multiselect". Daarna dataOnly run — maar de mapping config is verloren tussen sessies (geen persistence). Schema inspector detecteert N:N en stelt automatisch in. Geen handmatige actie nodig. Documenteer dit als bewust gedrag.

### A.10.4 N:N → MultiChoice toggle nadat schema al gecreëerd is
In één run is dit niet relevant (Step 2 → Step 3 → Step 4 is volgorde). Maar bij re-run met gewijzigde mapping: schema heeft N:N + custom entity + records, klant wisselt naar MultiChoice. Dan creëert Step 3 een nieuwe global option set náást het bestaande N:N. Beide bestaan in target. Schema-bloat maar geen data-correctheidsprobleem. Documenteer als limitation; geen cleanup-logic in v1.

---

## A.11 Samengevat: wat verandert er ten opzichte van de basis-spec

| Sectie | Wijziging |
|---|---|
| §3 (decisions) | +2 beslissingen: configurable target shape, default MultiChoice |
| §4 (types) | `MultiLookupMapping.targetShape` veld + `targetColumnLogicalName` |
| §7 (schema) | Twee paden afhankelijk van targetShape |
| §9 (resolver) | Dispatch op targetShape; MultiChoice pad hergebruikt bestaande resolver |
| §10 (writer) | Geen wijziging boven op basis-spec |
| §11 (UI) | Volledig vervangen door A.7 |
| §13 (edge cases) | +4 edge cases (zie A.10) |
| §14 (AC) | +6 acceptance criteria |
| §15 (effort) | Phase 5 +0.5 dag |

Backwards compat: ongewijzigd. Bestaande `MultiChoice` en single `Lookup` flows raken niet aan dit pad.
