# File Upload Spec — Addendum A: Warnings UI, Error Panel & CSV Export

> **Append to:** `docs/Active/file-upload-spec.md`
> **Amends:** §7 (UI changes — replaced in full), §9 AC 28–32 (expanded to AC 28–47)
> **Supersedes:** base-spec §7 — that section sketches the panels; this addendum
> replaces it as the implementation contract. §7 in the base spec is now
> historical context only.
> **Also adds:** working-time mismatch soft warning (§8 of this addendum).
> **Status:** Ready for implementation
> **Related specs:** `file-upload-spec.md` base, `data-only-migration-spec.md`

---

## 1. Context & relationship to base spec

De base spec (§6) specificeert de `LoaderResult`-shape met `fetchedData`, `warnings`,
en `errors`. Die is volledig geïmplementeerd in `src/services/fileImportService.ts`
en `src/services/fileUpload/types.ts`. Wat niet geïmplementeerd is: alles uit §7. De
drie manquerende stukken — warnings doorgeven aan state, een gestructureerd error-panel
bij hard fails, en CSV-export — zijn samen één feature omdat ze dezelfde component
(`LoaderFeedbackPanel`) en dezelfde state-velden delen. Dit addendum specificeert alle
drie als één gecoördineerd werk, plus een kleine uitbreiding voor de working-time
mismatch warning die in de audit (juni 2026) naar boven is gekomen.

Base-spec AC 28–32 vormen het startpunt; dit addendum breidt ze uit naar AC 28–47.

---

## 2. Architectural decisions

| Beslissing | Keuze | Reden |
|---|---|---|
| Shared component vs drie losse panels | Één `LoaderFeedbackPanel` — `mode: 'warnings' \| 'errors'` | Warnings en errors zijn nooit tegelijk zichtbaar; gedeelde layout-logica (group-by-sheet, cap-banner) zou anders gedupliceerd worden |
| Waar warnings in state leven | `MigrationContext.fileUploadWarnings: LoaderWarning[]` + `fileUploadFileName: string \| undefined` | Step 5 moet warnings lezen; lokale Step1-state volstaat niet |
| Waar errors in state leven | Lokale Step1Connect state — `uploadErrors: LoaderError[] \| null` | Hard-fail errors zijn alleen relevant in Step 1; ze hoeven niet in Step 5 |
| Fouten en warnings kunnen tegelijk voorkomen | Nee — `parseWorkbook` throwt bij errors en retourneert alleen warnings bij success | Error-panel en warning-panel zijn wederzijds exclusief in Step 1 |
| State clearing: bij file-wissel | `handleFileChange()` — `clearFileUploadFeedback()` + lokale `setUploadErrors(null)` | Nieuw bestand = schone lei; oude warnings uit Step 5 moeten weg |
| State clearing: bij dataSource-switch | `setDataSource()` in MigrationContext roept ook `clearFileUploadFeedback()` aan | ProjectOnline-data heeft geen fileUploadWarnings; section mag niet zichtbaar zijn |
| State clearing: bij wizard reset | `resetState()` al aanwezig — voeg `clearFileUploadFeedback()` toe | Consistent met alle andere velden |
| CSV format | Volg bestaand `downloadCsv` patroon uit Step5Report — UTF-8 BOM (`﻿`), RFC 4180 quoting | BOM al in gebruik (line 91 in Step5Report/index.tsx); geen nieuw pattern introduceren |
| Kolom-volgorde CSV | `Sheet, Row, Column, Code, Message, Details` | Meest useful voor triage: sheet + row geeft directe locatie |
| Cap in UI vs CSV | UI: 100/code+sheet (bestaand — `WARNING_CAP` in `fileImportService.ts`); CSV: alle warnings, geen cap | CSV is de escape hatch voor grote files |
| Filename CSV | `<basename>-warnings-<YYYYMMDD-HHmm>.csv` | Gebaseerd op original filename; datestamp voorkomt overschrijven bij re-upload |
| Working-time mismatch | Soft `info`-warning, niet blokkerend, geen API call | Template-kalenderdata is niet beschikbaar zonder extra query (expliciet out-of-scope in working-time-spec §2) |

---

## 3. State changes

### 3.1 MigrationContext additions

Voeg toe aan de `MigrationState` interface (`src/app/MigrationContext.tsx`):

```typescript
interface MigrationState {
  // ... existing fields ...

  // File-upload feedback (empty / undefined when dataSource is ProjectOnline)
  fileUploadWarnings: LoaderWarning[]
  fileUploadFileName: string | undefined   // original File.name, used in panel header + CSV filename
}
```

Voeg toe aan de `MigrationActions` interface:

```typescript
interface MigrationActions {
  // ... existing actions ...

  // Called on successful parse: stores warnings + filename, clears any prior errors
  setFileUploadResult: (warnings: LoaderWarning[], fileName: string) => void

  // Called on file-change, dataSource-switch, or wizard reset
  clearFileUploadFeedback: () => void
}
```

### 3.2 MigrationProvider state + callbacks

```typescript
// in MigrationProvider useState declarations
const [fileUploadWarnings, setFileUploadWarnings] = useState<LoaderWarning[]>([])
const [fileUploadFileName, setFileUploadFileName] = useState<string | undefined>(undefined)

// callbacks
const setFileUploadResult = useCallback(
  (warnings: LoaderWarning[], fileName: string) => {
    setFileUploadWarnings(warnings)
    setFileUploadFileName(fileName)
  },
  [],
)

const clearFileUploadFeedback = useCallback(() => {
  setFileUploadWarnings([])
  setFileUploadFileName(undefined)
}, [])
```

### 3.3 Bestaande `resetState()` uitbreiding

Voeg toe aan het einde van de bestaande `resetState()` callback:

```typescript
setFileUploadWarnings([])
setFileUploadFileName(undefined)
```

### 3.4 `setDataSource` uitbreiding

De bestaande `setDataSource` action (huidige eenvoudige setter) wordt uitgebreid:

```typescript
const setDataSource = useCallback((source: DataSource) => {
  setDataSourceState(source)
  setFileUploadWarnings([])
  setFileUploadFileName(undefined)
}, [])
```

### 3.5 Import

Voeg toe aan MigrationContext.tsx import:

```typescript
import type { LoaderWarning } from '../services/fileUpload/types'
```

---

## 4. Component: LoaderFeedbackPanel

**Locatie:** `src/components/FileUpload/LoaderFeedbackPanel.tsx` (nieuw bestand)

### 4.1 Props interface

```typescript
interface LoaderFeedbackPanelProps {
  mode: 'warnings' | 'errors'

  // warnings mode
  warnings?: LoaderWarning[]
  fileName?: string

  // errors mode
  errors?: LoaderError[]
  onDownloadTemplate?: () => void   // alleen in errors-mode; shows download-template button

  // optional override for the panel title
  title?: string
}
```

De component rendert `null` wanneer:
- `mode === 'warnings'` en `warnings` is leeg of undefined
- `mode === 'errors'` en `errors` is leeg of undefined

### 4.2 Warnings mode — visual layout

```
┌──────────────────────────────────────────────────────────┐
│ ⚠ migration-template.xlsx — 23 warnings                  │
│                                                          │
│ [Assignments ▼]  14 warnings                             │
│   Row 47:  ResourceId "R999" not found. Skipped.         │
│   Row 89:  TaskId "T504" not in project "P012". Skipped. │
│   ...and 12 more  [Show all in CSV export]               │
│                                                          │
│ [CustomFields ▼]  2 warnings                             │
│   Row 8:   Field "Mystery Type" — unknown FieldType      │
│            "Numbr". Row skipped.                         │
│   Row 12:  Lookup field "Status" has no LookupTableName. │
│                                                          │
│ [Tasks]  5 warnings                                      │
│   (sheet):  Column "Department" — task custom field,     │
│             will be ignored.                             │
│   ...4 more                                              │
│                                                          │
│ [TeamMembers]  1 info                                    │
│   (sheet):  TeamMembers sheet empty — derived 38         │
│             memberships from Assignments.                │
└──────────────────────────────────────────────────────────┘
```

- **Header**: `⚠ <fileName> — <N> warning(s)` voor intent `warning`; `ℹ` voor uitsluitend info-codes
- **Groups**: één group per unieke `sheet`-waarde in `warnings[]`, gesorteerd op count desc
- **Collapsible**: elke group heeft een toggle-knop (▶ gesloten, ▼ open); default: eerste twee groups open als ≤ 3 groups; anders allemaal gesloten
- **Row display**: `Row <n>:` prefix als `row` aanwezig; `(sheet):` als `row` undefined (sheet-level warning zoals `TEAMMEMBERS_DERIVED_FROM_ASSIGNMENTS`)
- **Column display**: als `column` aanwezig, toon als suffix `[in column "<column>"]` op dezelfde regel
- **Cap banner**: als de raw count voor een group groter is dan de weergegeven entries (de `WARNING_CAP = 100` in fileImportService.ts heeft al getruncated), toon: `...and N more — full list in CSV export`

  > **Bepalen of er meer zijn:** UI weet niet hoeveel er getruncated zijn zonder de cap-info van de loader. Aanpak: de loader voegt bij truncatie een sentinel warning toe met `code === warningCode` en `message.startsWith('(')` (zie pushWarning() in fileImportService.ts). Detecteer de sentinel warning en toon de `...and N more` banner in plaats van die regel als normale warning.

- **Fluent**: gebruik `tokens.colorPaletteYellowBackground2` voor warnings; `tokens.colorNeutralBackground2` voor info-only

### 4.3 Errors mode — visual layout

```
┌──────────────────────────────────────────────────────────┐
│ ✗ Could not load migration-template.xlsx                 │
│                                                          │
│ · Required sheet "Projects" not found. Sheet "Project"   │
│   exists — did you rename it?                            │
│ · Required column "TaskId" missing in sheet "Tasks".     │
│                                                          │
│ Download a fresh template and copy your data into it:    │
│ [Download empty template]                                │
└──────────────────────────────────────────────────────────┘
```

- **Header**: `✗ Could not load <fileName>` als `fileName` aanwezig; `✗ Could not load file` als absent
- **Errors list**: `·` per `LoaderError`; `sheet`-prefix als aanwezig: `[<sheet>] <message>`
- **Download button**: getoond als `onDownloadTemplate` prop is meegegeven
- **Intent**: `error` MessageBar of vergelijkbare rode styling

### 4.4 CSS / layout notes

Volg het patroon van `AssociationDiagnosticsPanel` in `src/steps/Step5Report/index.tsx`:
- Outer `div` met `styles.panel` class (background, border, borderRadius, padding)
- Title row: `styles.sectionTitle` + optioneel een `styles.toolbar` wrapper met export-knop rechts
- Gebruik `makeStyles` tokens voor kleuren — geen hardcoded hex
- Group-headers gebruiken `cursor: 'pointer'` + `user-select: 'none'` voor de toggle

---

## 5. Step 1 integration

### 5.1 Lokale state-wijzigingen in Step1Connect

**Vervang** de bestaande `uploadError: string | null` (line 311) door:

```typescript
const [uploadErrors, setUploadErrors] = useState<LoaderError[] | null>(null)
```

Bewaar de bestaande `uploadError: string | null` voor niet-parse gerelateerde meldingen
(bv. "Choose a file before loading") — hernoem naar `uploadValidationError`.

Destructure de twee nieuwe context-actions:

```typescript
const { ..., setFileUploadResult, clearFileUploadFeedback } = useMigration()
```

### 5.2 `runFetch()` — FileUpload branch (vervangt lines 429–454)

```typescript
if (dataSource === 'FileUpload') {
  if (!uploadedFile) {
    setUploadValidationError('Choose a file before loading.')
    return
  }
  setUploadValidationError(null)
  setUploadErrors(null)
  clearFileUploadFeedback()         // clear prior warnings from context
  setGlobalError(null)
  setScanError(null)
  setModeNotice(null)
  setSchemaSnapshot(null)
  setResolverPlan(null)
  setUploadParsing(true)
  try {
    const parsed = await parseWorkbook(uploadedFile)
    setUploadResult(parsed.fetchedData)
    setFetchedData(parsed.fetchedData)
    setFileUploadResult(parsed.warnings, uploadedFile.name)  // ← NEW
    if (migrationMode === 'dataOnly') {
      await runScan()
    }
  } catch (err) {
    if (err instanceof LoaderFileError) {
      setUploadErrors(err.errors)           // ← structured errors
    } else {
      setUploadErrors([{
        code: 'CORRUPTED_FILE',
        message: String(err),
      }])
    }
    clearFileUploadFeedback()
  } finally {
    setUploadParsing(false)
  }
  return
}
```

Import toevoegen:

```typescript
import { parseWorkbook, generateTemplate } from '../../services/fileImportService'
import { LoaderFileError } from '../../services/fileUpload/types'
import type { LoaderError } from '../../services/fileUpload/types'
```

### 5.3 `handleFileChange()` uitbreiding (lines 480–492)

Voeg toe:

```typescript
setUploadErrors(null)
clearFileUploadFeedback()
```

### 5.4 UI — waar panels verschijnen (vervangt lines 871–875)

**Vervang** het bestaande `{uploadError && ...}` blok door:

```tsx
{/* Success: warning panel */}
<LoaderFeedbackPanel
  mode="warnings"
  warnings={fileUploadWarnings}
  fileName={fileUploadFileName}
/>

{/* Hard fail: error panel */}
<LoaderFeedbackPanel
  mode="errors"
  errors={uploadErrors ?? undefined}
  fileName={uploadedFile?.name}
  onDownloadTemplate={handleDownloadTemplate}
/>
```

Beide staan na de file-input control, voor het "Target" sectionBox.

### 5.5 Success summary line

Na een succesvolle parse toont de bestaande `previewItems` / `activeResult` al de record-counts als tags. Voeg daarboven een één-regel success-indicator toe (conditioneel op `uploadResult !== null && uploadErrors === null`):

```tsx
{uploadResult && !uploadErrors && (
  <div style={{ fontSize: '13px', color: tokens.colorNeutralForeground3, marginBottom: '4px' }}>
    ✓ {uploadedFile?.name ?? 'Uploaded file'}{' '}
    loaded — {fileUploadWarnings.length > 0
      ? `${fileUploadWarnings.length} warning(s) below`
      : 'no warnings'}
  </div>
)}
```

De gedetailleerde counts (200 projects, 16 000 tasks, …) komen uit de bestaande
`previewItems` mapping (lines 694–705), die al rendeert als `activeResult` beschikbaar
is. Geen duplicatie nodig.

---

## 6. Step 5 integration

### 6.1 Conditional render

Voeg toe aan de destructuring van `useMigration()` in `Step5Report` (line 450):

```typescript
const { ..., dataSource, fileUploadWarnings, fileUploadFileName } = useMigration()
```

### 6.2 Plaatsing

Voeg de sectie toe **vóór** het bestaande `{migrationMode === 'dataOnly' && <AssociationDiagnosticsPanel ...>}` blok (huidige line 761). Logische volgorde van einde naar boven:

```
Entity Results
Errors
Schema Results
File Upload Warnings  ← nieuw, alleen zichtbaar bij FileUpload
N:N Association Diagnostics
Skipped Fields
```

### 6.3 Render logic

```tsx
{/* File Upload Warnings — FileUpload source only */}
{dataSource === 'FileUpload' && fileUploadWarnings.length > 0 && (
  <div className={styles.panel}>
    <div className={styles.toolbar} style={{ justifyContent: 'space-between', marginBottom: '10px' }}>
      <div className={styles.sectionTitle}>
        File Upload Warnings ({fileUploadWarnings.length})
      </div>
      <Button size="small" onClick={exportUploadWarnings}>
        Export CSV ({fileUploadWarnings.length})
      </Button>
    </div>
    <LoaderFeedbackPanel
      mode="warnings"
      warnings={fileUploadWarnings}
      fileName={fileUploadFileName}
      title=""  // title al getoond door de toolbar
    />
  </div>
)}
```

### 6.4 Export function in Step5Report

```typescript
function exportUploadWarnings() {
  if (!fileUploadWarnings.length) return
  const base = fileUploadFileName
    ? fileUploadFileName.replace(/\.[^.]+$/, '')   // strip extension
    : 'upload'
  const stamp = new Date().toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 13)                                   // YYYYMMDD-HHm → 13 chars
  const filename = `${base}-warnings-${stamp}.csv`
  downloadCsv(filename, buildWarningsCsvRows(fileUploadWarnings))
}
```

> `downloadCsv` bestaat al in Step5Report/index.tsx (line 89). Geen duplicatie.

---

## 7. CSV export format

### 7.1 Helper function

```typescript
function buildWarningsCsvRows(warnings: LoaderWarning[]): string[][] {
  return [
    ['Sheet', 'Row', 'Column', 'Code', 'Message', 'Details'],
    ...warnings.map(w => [
      w.sheet,
      w.row != null ? String(w.row) : '',
      w.column ?? '',
      w.code,
      w.message,
      w.details != null ? JSON.stringify(w.details) : '',
    ]),
  ]
}
```

**Encoding:** volgt bestaand `downloadCsv` patroon — `Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' })`.
De `﻿` BOM staat al in de blob-constructor (Step5Report line 91). Geen aanpassing nodig aan `downloadCsv`.

**Quoting:** RFC 4180 via bestaande `csvEscape` helper (Step5Report lines 83–87) — elke cell wordt gecsvEscaped.

**Cap:** de CSV bevat **alle** warnings, inclusief de sentinel `...and N more` regels die de loader bijvoegt na het bereiken van `WARNING_CAP`. Die sentinels zijn herkenbaar aan hun format en kunnen eventueel gefilterd worden — maar voor MVP: gewoon meenemen. Gebruiker weet dan hoeveel er getruncated zijn per group.

### 7.2 Kolom-spec

| Kolom | Source | Beschrijving |
|---|---|---|
| Sheet | `w.sheet` | Exact de sheetname uit de loader |
| Row | `w.row` | 1-indexed Excel rij; leeg als sheet-level warning |
| Column | `w.column` | Kolomhoofd; leeg als niet van toepassing |
| Code | `w.code` | `WarningCode` enum-waarde |
| Message | `w.message` | Human-readable tekst |
| Details | `JSON.stringify(w.details)` | Optionele extra context; leeg als `undefined` |

### 7.3 Voorbeeld output

```csv
"Sheet","Row","Column","Code","Message","Details"
"Assignments","47","","INVALID_REFERENCE_SKIPPED","ResourceId ""R999"" not found. Row skipped.",""
"Assignments","89","","INVALID_REFERENCE_SKIPPED","TaskId ""T504"" not in project ""P012"". Row skipped.",""
"CustomFields","8","FieldType","INVALID_FIELD_TYPE_SKIPPED","Field ""Mystery Type"" has unknown FieldType ""Numbr"". Valid values: Text, Memo, .... Row skipped.",""
"Tasks","","","TASK_CUSTOM_FIELD_IGNORED","Column ""Department"" in Tasks sheet looks like a custom field. Task custom fields are not migrated and will be ignored.",""
"TeamMembers","","","TEAMMEMBERS_DERIVED_FROM_ASSIGNMENTS","TeamMembers sheet empty — derived 38 membership(s) from Assignments.",""
```

### 7.4 Filename patroon

`<basename>-warnings-<YYYYMMDD-HHm>.csv`

Voorbeeld: `migration-template-warnings-20260618-093.csv`

Noot: de timestamp-string is 13 chars: `YYYYMMDD-HHmm` zonder colons. Dat levert bv. `20260618-0930`. Gebruik `new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13)` zoals hierboven.

---

## 8. Working-time mismatch soft warning

### 8.1 Aanleiding

De working-time-spec noemt een soft warning wanneer de geselecteerde work hour template
niet overeenkomt met de ingevoerde `hoursPerDay` / `hoursPerWeek` / `daysPerMonth`. De
template's kalenderdata is echter niet beschikbaar zonder een extra Dataverse API-query
(expicit buiten scope in working-time-spec §2: "Geen auto-sync"). De vergelijking kan
dus niet "template-uren vs ingevoerde uren" zijn.

**Haalbare variant:** waarschuw wanneer de gebruiker **zowel** een work hour template
selecteert **als** de numerieke standaardwaarden wijzigt. In dat geval zijn de twee
instellingen onafhankelijk en kan er een mismatch zijn die de gebruiker zelf moet
controleren.

### 8.2 Trigger

Toon de warning in het "Project defaults" panel van Step 1 wanneer:

```typescript
projectDefaults.workHourTemplateId !== null
&& (
  projectDefaults.hoursPerDay  !== DEFAULT_PROJECT_DEFAULTS.hoursPerDay  ||
  projectDefaults.hoursPerWeek !== DEFAULT_PROJECT_DEFAULTS.hoursPerWeek ||
  projectDefaults.daysPerMonth !== DEFAULT_PROJECT_DEFAULTS.daysPerMonth
)
```

### 8.3 Wording

```
ℹ Work hour template and custom numeric values are both set.
  The template controls the project calendar (days/hours per week, holidays).
  HoursPerDay / HoursPerWeek / DaysPerMonth are effort-display factors used
  separately. Verify they are consistent with the chosen template.
```

Intent: `info` (blauw) — niet `warning` (geel). Geen blokkerend effect op de Fetch-knop.

### 8.4 Plaatsing

Onmiddellijk onder de drie numerieke inputs in het "Project defaults" sectionBox, vóór
de "Fetch" knop. Gebruik een klein `MessageBar intent="info"` in Fluent UI stijl.

---

## 9. Edge cases

### 9.1 Re-upload vervangt vorige warnings

Elke keer dat `handleFileChange()` fires of `runFetch()` (FileUpload-branch) start,
worden `clearFileUploadFeedback()` en `setUploadErrors(null)` aangeroepen vóór de nieuwe
parse. Einde resultaat: altijd één set warnings per bestand, nooit accumulatie.

### 9.2 Switch van FileUpload naar ProjectOnline

`setDataSource('ProjectOnline')` roept `clearFileUploadFeedback()` aan. `fileUploadWarnings`
wordt leeg; de Step 5 sectie verdwijnt. Geen verdere actie nodig.

### 9.3 Hard fail na eerder succesvolle upload

Scenario: gebruiker laadt bestand A (200 warnings, opgeslagen in context), verandert
naar bestand B (structuurfout). Correct gedrag:
1. `handleFileChange()` → `clearFileUploadFeedback()` + `setUploadErrors(null)` → paneel in Step 5 verdwijnt
2. `runFetch()` → `clearFileUploadFeedback()` voor parse
3. Loader throwt `LoaderFileError` → `setUploadErrors(err.errors)`, `clearFileUploadFeedback()` blijft leeg
4. Step 1 toont errors-panel; Step 5 toont geen file upload sectie

### 9.4 10 000+ warnings in één upload

UI cap: `WARNING_CAP = 100` per code+sheet — al ingebakken in `fileImportService.ts`.
De `LoaderResult.warnings` bevat al getrunceerde data; de UI ziet nooit meer dan
`100 * aantal code+sheet-combinaties` regels. `LoaderFeedbackPanel` rendert alles wat
binnenkomt — geen extra cap op component-niveau.

CSV export: alle `fileUploadWarnings` uit state, inclusief sentinel-regels. Geen cap.

### 9.5 Sheet-level warning zonder `row` of `column`

Voorbeeld: `TEAMMEMBERS_DERIVED_FROM_ASSIGNMENTS` heeft geen `row` of `column`.
`LoaderFeedbackPanel` toont `(sheet):` als placeholder in plaats van `Row <n>:`.
In CSV: Row-kolom leeg, Column-kolom leeg.

### 9.6 Export-knop bij nul warnings

De "Export CSV (0)" knop in Step 5 verschijnt nooit, want de conditional render
`fileUploadWarnings.length > 0` bewaakt de hele sectie. Geen disabled-state nodig.

In Step 1 is er geen export-knop (alleen weergave in panel); Step 5 is de enige
plek voor de export.

### 9.7 Gebruiker downloadt CSV, upload dan opnieuw

De CSV is een snapshot van het moment van download. Na re-upload worden de warnings
opnieuw ingesteld — de eerder gedownloade CSV wordt niet overschreven (browser-side
download, geen live link). Gebruiker behoudt de oude CSV als historisch artefact.

### 9.8 `fileUploadFileName` undefined

Als `uploadedFile` voor de een of andere reden `null` is op het moment van succesvol
parsen (race condition), valt `LoaderFeedbackPanel` terug op een generieke header zonder
filename. In `exportUploadWarnings()`: gebruik `'upload'` als basename. Praktisch niet
waarschijnlijk maar defensief afgehandeld.

### 9.9 Wizard restart (resetState)

`resetState()` roept `clearFileUploadFeedback()` aan (via §3.3). Alle warnings
verdwijnen. De `uploadErrors` lokale state in Step1Connect wordt bij unmount
automatisch gereset (component opnieuw gemount bij stap-navigatie). ⚠ TODO: verifieer
dat Step1Connect inderdaad opnieuw gemount wordt bij resetState → navigate naar step 1,
of voeg een `useEffect(() => setUploadErrors(null), [])` toe als dat niet zo is.

---

## 10. Acceptance criteria

Numering sluit aan op base-spec §9 (AC 28–47):

### Upload success + warnings (base spec AC 28–29, uitgebreid)

28. ✅ Na succesvolle upload toont Step 1 een één-regel success-indicator met bestandsnaam en warningtelling ("✓ migration-template.xlsx loaded — 23 warning(s) below").
29. ✅ `LoaderFeedbackPanel` in warnings-mode toont alle warnings gegroepeerd per sheet, elk group collapsible, sheet-naam als groepstitel.
30. ✅ Warnings zonder `row` tonen `(sheet):` als row-prefix.
31. ✅ Warnings zonder `column` tonen de `column`-placeholder niet.
32. ✅ De eerste twee groups zijn standaard open als ≤ 3 groepen aanwezig zijn; alle gesloten bij ≥ 4 groepen.

### Hard-fail error panel (base spec AC 30, uitgebreid)

33. ✅ Upload van bestand zonder `_Meta` sheet → `LoaderFeedbackPanel` in errors-mode toont bestandsnaam in header + elke `LoaderError` als aparte bullet.
34. ✅ Errors-panel toont "Download empty template" knop.
35. ✅ `String(err)` wordt niet langer gebruikt voor bestandsparse-fouten — alleen voor overige (niet-parse) fouten.
36. ✅ Errors-panel verdwijnt bij upload van een nieuw bestand.

### CSV export (base spec AC 32)

37. ✅ "Export CSV (N)" knop verschijnt in Step 5 wanneer `dataSource === 'FileUpload'` en `fileUploadWarnings.length > 0`.
38. ✅ Gedownloade CSV bevat kolommen `Sheet, Row, Column, Code, Message, Details` (RFC 4180, UTF-8 BOM).
39. ✅ CSV bevat **alle** warnings zonder cap (ook als de UI maar 100/code+sheet toont).
40. ✅ Filename van de CSV bevat de originele upload-bestandsnaam en een datestamp.

### Step 5 integration (base spec AC 31, uitgebreid)

41. ✅ Step 5 toont "File Upload Warnings" sectie alleen als `dataSource === 'FileUpload'` én `fileUploadWarnings.length > 0`.
42. ✅ Step 5 toont géén "File Upload Warnings" sectie als data source `ProjectOnline` is, zelfs als `fileUploadWarnings` om welke reden dan ook gevuld zou zijn.

### State management

43. ✅ Re-upload van een nieuw bestand vervangt vorige warnings — geen accumulatie.
44. ✅ Wisselen van `FileUpload` naar `ProjectOnline` als data source wist de warnings en de Step 5 sectie verdwijnt.
45. ✅ `resetState()` wist `fileUploadWarnings` en `fileUploadFileName`.

### Working-time mismatch

46. ✅ In Step 1: wanneer een work hour template geselecteerd is én minstens één numeriek veld afwijkt van de defaults, toont een `info`-melding de consistency-tip.
47. ✅ De info-melding is niet blokkerend — de Fetch-knop blijft enabled.

---

## 11. Implementation order

### Phase A — State + actions (geen UI)

Voeg `fileUploadWarnings`, `fileUploadFileName`, `setFileUploadResult`,
`clearFileUploadFeedback` toe aan `MigrationContext.tsx`. Breid `resetState()` en
`setDataSource()` uit. Voeg de `LoaderWarning` import toe.

Verificatie: TypeScript compileert; `useMigration()` geeft de nieuwe fields terug.

---

### Phase B — `LoaderFeedbackPanel` component (geïsoleerd)

Maak `src/components/FileUpload/LoaderFeedbackPanel.tsx`. Bouw warnings-mode en
errors-mode. Render `null` bij lege input. Schrijf de group-by-sheet logica.

Verificatie: render de component met gemockte data in een test-harness of tijdelijk in
Step 1; valideer dat groups correct collapsed/expanded zijn en de sentinel-regels
herkenbaar gemarkeerd worden.

---

### Phase C — Step 1 wiring

- Vervang `uploadError: string | null` door `uploadErrors: LoaderError[] | null`
- Update `runFetch()` FileUpload-branch: roep `setFileUploadResult()` aan bij succes,
  `setUploadErrors()` bij fail
- Update `handleFileChange()`: roep `clearFileUploadFeedback()` + `setUploadErrors(null)` aan
- Vervang het bestaande `{uploadError && ...}` blok door de twee `LoaderFeedbackPanel` renders
- Voeg de success-indicator toe (één-regel "✓ Loaded…")
- Import `LoaderFileError`

Verificatie: upload een valide template → warnings panel verschijnt; upload een
hernoemde template → errors panel verschijnt met structured errors + download button.

---

### Phase D — Step 5 integration

- Destructure `dataSource`, `fileUploadWarnings`, `fileUploadFileName` in `Step5Report`
- Voeg de `{dataSource === 'FileUpload' && ...}` sectie toe vóór `AssociationDiagnosticsPanel`
- Voeg `exportUploadWarnings()` en `buildWarningsCsvRows()` toe

Verificatie: doorloop een volledige FileUpload-flow end-to-end tot Step 5; controleer
dat de sectie zichtbaar is; controleer dat de sectie ontbreekt na een ProjectOnline-fetch.

---

### Phase E — CSV export

`buildWarningsCsvRows()` is al gespecificeerd in §7. Voeg toe aan `exportUploadWarnings()`.

Verificatie: download CSV; open in Excel; controleer kolomvolgorde, BOM (geen garbled
eerste cel), quoting van velden met komma's.

---

### Phase F — Working-time mismatch warning

Voeg de `info`-melding toe in het "Project defaults" sectionBox van Step1Connect, na
de drie numeric inputs. Trigger op `projectDefaults.workHourTemplateId !== null && ...`.

Verificatie: selecteer een template + wijzig `hoursPerDay` → melding verschijnt;
verwijder template → melding verdwijnt; defaults behouden → melding verdwijnt.

---

## 12. Open questions — resolved

1. **✅ Sentinel-regel detectie — RESOLVED:** Geen sentinels nodig. `row === undefined &&
   column === undefined` = sheet-level warning. `LoaderWarning` type staat dit al toe.
   Panel en CSV exporter branchet op `undefined`. Render `(sheet)` in row-kolom.
   Truncation sentinels van `pushWarning()` zijn gewone warnings — worden meegetoond als
   `(sheet)` entries; geen speciale detectie in de component.

2. **✅ Component directory — RESOLVED:** `src/components/LoaderFeedbackPanel/` met:
   - `LoaderFeedbackPanel.tsx` — main component
   - `index.ts` — re-export
   - helpers als nodig
   Shared tussen Step 1 en Step 5 → niet in step-directories.

3. **✅ Working-time defaults — RESOLVED:** Hardcode MS Project defaults:
   `hoursPerDay = 8`, `hoursPerWeek = 40`, `daysPerMonth = 20`.
   Definieer als `MS_PROJECT_DEFAULTS` constante in working-time service file
   (niet inline in warning-logica) zodat ze vindbaar zijn als MS ze ooit wijzigt.
   Niet lezen uit Dataverse — heuristiek blijft lokaal.
