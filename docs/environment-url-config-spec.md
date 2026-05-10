# Feature Spec: Runtime Environment URL Configuration

> **Document type:** Implementation specification for Claude Code
> **Target codebase:** Project Online Migrator (React + TypeScript + Power Apps Code App)
> **Status:** Ready for implementation
> **Related specs:** `data-only-migration-spec.md`, `schema-only-migration-spec.md`

---

## 1. Context & doel

De Dataverse organization URL is op dit moment **hardcoded** in `src/config/environment.ts`:

```typescript
export const DATAVERSE_ORG_URL = 'https://dev-jehe.crm4.dynamics.com'
```

Deze waarde wordt door `dataverseService.ts` gebruikt om base-URLs te bouwen voor alle directe REST-calls naar:
- Metadata API (`/api/data/v9.2/EntityDefinitions(...)`)
- Custom unbound actions (`msdyn_CreateProjectV1`, `msdyn_CreateTeamMemberV1`, OperationSet API)
- Custom operations geregistreerd via `client.ts` (`CreateGlobalOptionSet`, `CreateEntityAttribute`, etc.)

**Probleem:** bij deployment naar een andere environment (test → prod, of klant-environment) blijven deze REST-calls naar `dev-jehe.crm4.dynamics.com` gaan. De Power Apps SDK-laag verbindt automatisch met de juiste environment voor de generated services, maar de directe REST-calls niet. Dit is een latente bug en blokkeert echte multi-environment ALM.

**Uitbreiding:** vervang de hardcoded URL door een runtime-resolved waarde uit een Power Platform environment variable in de solution waarin de Code App gepubliceerd wordt. Bij ontbrekende of lege waarde valt de app terug op een handmatige URL-input UI met `localStorage` persistentie.

---

## 2. Scope

### In scope
- Power Platform environment variable definitie in de solution (display naam, logical name, type `String`, **default value = leeg**)
- Runtime fetch van de variable waarde bij app startup via Dataverse REST API
- Vervangen van hardcoded `DATAVERSE_ORG_URL` door een resolved waarde
- Fallback UI: eenvoudig input-scherm bij missende waarde, met `localStorage` persistentie per browser
- Validatie van de URL (syntax, basic ping naar `/api/data/v9.2/WhoAmI` om verkeerde waardes vroeg te vangen)
- Loading state tijdens resolve (voorkomt dat Step 1 rendert met een undefined URL)

### Out of scope (voor deze iteratie)
- Andere hardcoded environment-specifieke waarden (PWA URL is gebruikersinput, niet config)
- Connection references voor SharePoint multi-environment (apart spec waardig)
- Runtime environment switcher (de waarde is gekoppeld aan waar de app gepubliceerd is)
- Caching van de URL in Dataverse user settings (localStorage volstaat voor MVP)
- Mode waarin admin de waarde wijzigt zonder solution re-import (uit veiligheid: variable is single source of truth)

---

## 3. Architecturale beslissingen

| Beslissing | Keuze | Reden |
|---|---|---|
| Configuratie-mechanisme | Power Platform environment variable in solution | Native ALM-patroon; één waarde per environment, automatisch correct na solution import |
| Default value in solution | **Leeg** (geen pre-filled URL) | Voorkomt accidentele cross-environment writes; failure mode is duidelijk |
| Failure mode | Soft fail met manuele URL-input UI | Bevestigd door gebruiker; voorkomt blocked state als admin variable niet zet bij import |
| Persistence van manuele input | `localStorage` per browser | Simpel; volstaat voor MVP; user hoeft niet bij elke session opnieuw in te vullen |
| URL-validatie | Syntax check + `WhoAmI` ping | Vangt typo's en verkeerde environments vroeg; één extra GET, verwaarloosbaar |
| Resolve timing | Bij app startup, vóór Step 1 mount | Voorkomt undefined URL in service-laag; loading state tijdens resolve |
| Source of truth precedence | localStorage > variable > input UI | localStorage wint zodat user override mogelijk is na variable wijziging |
| Variable type | `String` (geen `Secret`) | URL is geen secret; Secret-type vereist Key Vault setup, overkill |

---

## 4. State uitbreidingen

In `MigrationContext`:

```typescript
interface MigrationState {
  // ... bestaande velden ongewijzigd

  dataverseOrgUrl: string | null         // resolved URL, null tijdens loading
  dataverseUrlSource: DataverseUrlSource // origin tracking voor debugging
  dataverseUrlError: string | null       // error message bij validation failure
}

type DataverseUrlSource =
  | 'loading'                  // initial state, resolve nog bezig
  | 'localStorage'             // user heeft handmatig ingevuld in een vorige session
  | 'environmentVariable'      // succesvol uit solution variable gehaald
  | 'manualInput'              // user heeft net ingevuld in fallback UI
  | 'error'                    // resolve gefaald, fallback UI tonen
```

**Reducer actions:**
```typescript
| { type: 'SET_DATAVERSE_URL'; url: string; source: DataverseUrlSource }
| { type: 'SET_DATAVERSE_URL_ERROR'; error: string }
| { type: 'CLEAR_DATAVERSE_URL' }       // voor "reset" / "wijzig" knop
```

---

## 5. Nieuwe bestanden

### 5.1 `src/config/environmentVariableConfig.ts`

**Doel:** centrale plaats voor de identifiers van de environment variable. Niet de waarde — alleen de namen waarmee we 'm opvragen.

```typescript
/**
 * Logical name of the Power Platform environment variable that holds
 * the Dataverse organization URL for this Code App's target environment.
 *
 * This variable lives in the same solution as the Code App. Its current
 * value is set per-environment at solution import time. Default value
 * in the solution definition is intentionally empty — see spec §3.
 */
export const DATAVERSE_URL_VARIABLE_NAME = 'jh_dataverseorgurl'
//                                          ^^^ replace with chosen prefix

export const DATAVERSE_URL_VARIABLE_DISPLAY_NAME = 'Dataverse Organization URL'

/**
 * localStorage key for user-provided URL when the environment variable
 * is missing or invalid. Per-browser persistence. See spec §3.
 */
export const DATAVERSE_URL_LOCALSTORAGE_KEY = 'projectMigrator.dataverseOrgUrl'
```

**Belangrijk:** de exacte logical name (`jh_dataverseorgurl` hierboven is placeholder) moet matchen met de naam in de solution. De prefix volgt de publisher van de solution waar de Code App in zit.

---

### 5.2 `src/services/environmentResolver.ts`

**Doel:** orchestratie van de URL-resolve flow bij app startup.

**Publieke API:**
```typescript
export interface EnvironmentResolveResult {
  url: string
  source: DataverseUrlSource
}

/**
 * Resolve the Dataverse org URL using the precedence:
 *   1. localStorage override (set by user via manual input UI)
 *   2. Power Platform environment variable in solution
 *   3. throw — caller renders manual input UI
 *
 * Includes WhoAmI ping for validation. Throws on validation failure.
 */
export async function resolveDataverseOrgUrl(): Promise<EnvironmentResolveResult>

/**
 * Persist user-provided URL after manual input. Validates first.
 * Returns the validated URL or throws.
 */
export async function setManualDataverseOrgUrl(rawInput: string): Promise<string>

/**
 * Clear the localStorage override. Used by "Reset URL" UI.
 * Next resolve attempt will go back to environment variable.
 */
export function clearManualDataverseOrgUrl(): void
```

**Implementatie volgorde in `resolveDataverseOrgUrl`:**

1. **Check localStorage:**
   ```typescript
   const stored = localStorage.getItem(DATAVERSE_URL_LOCALSTORAGE_KEY)
   if (stored) {
     await validateUrl(stored)  // ping WhoAmI
     return { url: stored, source: 'localStorage' }
   }
   ```

2. **Fetch environment variable:**
   ```typescript
   // Need a base URL to make this call. Two options:
   //   a. Same-origin relative path: works only in published Code App context
   //   b. Use getContext().app.environmentId to derive base via API discovery
   //
   // Recommendation: same-origin relative path. Code App runs inside the
   // Power Apps host which proxies /api/data/v9.2 to the correct environment.
   const variable = await fetchEnvironmentVariable(DATAVERSE_URL_VARIABLE_NAME)

   if (variable && variable.value && variable.value.trim()) {
     await validateUrl(variable.value)
     return { url: variable.value.trim(), source: 'environmentVariable' }
   }
   ```

3. **No valid source found:**
   ```typescript
   throw new MissingDataverseUrlError(
     'Dataverse URL not configured. Provide it manually or set the ' +
     `'${DATAVERSE_URL_VARIABLE_DISPLAY_NAME}' environment variable in the solution.`
   )
   ```

**`fetchEnvironmentVariable` implementatie:**

Environment variables in Dataverse zijn opgeslagen in twee tabellen:
- `environmentvariabledefinitions` — definitie (naam, default value, type)
- `environmentvariablevalues` — current value per environment (1:N met definition)

Query:
```
GET /api/data/v9.2/environmentvariabledefinitions
    ?$filter=schemaname eq '<DATAVERSE_URL_VARIABLE_NAME>'
    &$select=schemaname,displayname,defaultvalue,environmentvariabledefinitionid
    &$expand=environmentvariabledefinition_environmentvariablevalue($select=value)
```

Resolve order binnen één variable:
1. `environmentvariablevalues[0].value` (current value, set bij solution import)
2. `defaultvalue` (default in solution definition, by design leeg in onze setup)
3. `null` (niet gevonden)

**`validateUrl` implementatie:**

```typescript
async function validateUrl(rawUrl: string): Promise<void> {
  // Syntax check
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new InvalidDataverseUrlError(`Not a valid URL: ${rawUrl}`)
  }

  if (parsed.protocol !== 'https:') {
    throw new InvalidDataverseUrlError('URL must use HTTPS')
  }

  // Strip trailing slash for consistency with downstream consumers
  const normalized = rawUrl.replace(/\/$/, '')

  // Connectivity + permissions check
  const response = await fetch(`${normalized}/api/data/v9.2/WhoAmI`, {
    headers: { Accept: 'application/json' },
    credentials: 'include',  // SDK auth cookies
  })

  if (!response.ok) {
    throw new InvalidDataverseUrlError(
      `Dataverse responded ${response.status} on WhoAmI. ` +
      `URL may be wrong, or you lack access to this environment.`
    )
  }
}
```

**Custom error classes** voor de error boundary om op te discrimineren:
```typescript
export class MissingDataverseUrlError extends Error {}
export class InvalidDataverseUrlError extends Error {}
```

---

### 5.3 `src/components/DataverseUrlGate.tsx`

**Doel:** wrapper component die voor de wizard rendert, en de resolve flow afhandelt. Toont loading, manual input, of children (de wizard zelf) op basis van resolve state.

```typescript
interface DataverseUrlGateProps {
  children: React.ReactNode
}

export function DataverseUrlGate({ children }: DataverseUrlGateProps) {
  const { state, dispatch } = useMigrationContext()

  // On mount: resolve
  useEffect(() => {
    resolveDataverseOrgUrl()
      .then(({ url, source }) => {
        dispatch({ type: 'SET_DATAVERSE_URL', url, source })
      })
      .catch((err: Error) => {
        dispatch({ type: 'SET_DATAVERSE_URL_ERROR', error: err.message })
      })
  }, [])

  // Loading state
  if (state.dataverseUrlSource === 'loading') {
    return <LoadingScreen message="Resolving environment configuration..." />
  }

  // Error / missing → manual input UI
  if (!state.dataverseOrgUrl) {
    return <ManualUrlInput onSubmit={handleManualSubmit} error={state.dataverseUrlError} />
  }

  // Resolved → show app
  return <>{children}</>
}
```

**`ManualUrlInput` UI:**
- Header: "Configure Dataverse Environment"
- Body text legt uit waarom dit nodig is en verwijst naar de solution variable
- Input field met placeholder `https://your-org.crm4.dynamics.com`
- "Validate & Continue" button → roept `setManualDataverseOrgUrl(input)` aan
- Toon `state.dataverseUrlError` indien aanwezig
- Subtle "Need help? Contact your admin to configure the solution variable" link

**Geen** "Skip validation" optie — invalide URLs leiden tot mysterieuze fouten verderop.

---

## 6. Wijzigingen in bestaande bestanden

### 6.1 `src/config/environment.ts`

Vervangen door een module die de runtime-resolved waarde exposeert:

```typescript
// VOOR:
export const DATAVERSE_ORG_URL = 'https://dev-jehe.crm4.dynamics.com'

// NA:
let _resolvedUrl: string | null = null

export function setDataverseOrgUrl(url: string): void {
  _resolvedUrl = url.replace(/\/$/, '')  // strip trailing slash
}

export function getDataverseOrgUrl(): string {
  if (!_resolvedUrl) {
    throw new Error(
      'Dataverse org URL accessed before resolve completed. ' +
      'Ensure DataverseUrlGate has rendered.'
    )
  }
  return _resolvedUrl
}
```

**Reden voor module-level singleton + getter:** alle bestaande call sites gebruiken nu een import-time constant. Met een getter kunnen we minimaal invasief refactoren — `import { DATAVERSE_ORG_URL } from '...'` wordt `import { getDataverseOrgUrl } from '...'` en alle gebruik wordt `getDataverseOrgUrl()`. De getter throwt als hij te vroeg wordt aangeroepen, wat een snelle ontwikkelaarsfout-detectie is.

### 6.2 `src/services/dataverseService.ts`

Vervang alle imports van `DATAVERSE_ORG_URL` door `getDataverseOrgUrl()`. URL-bouw verandert van:

```typescript
const url = `${DATAVERSE_ORG_URL}/api/data/v9.2/...`
```

naar:

```typescript
const url = `${getDataverseOrgUrl()}/api/data/v9.2/...`
```

Geen functionele wijziging — getter geeft dezelfde waarde terug die de constante had, alleen runtime-resolved.

### 6.3 `src/app/MigrationContext.tsx`

State velden uit §4 toevoegen. Reducer actions implementeren. `dataverseOrgUrl` moet ook door `setDataverseOrgUrl()` worden gepushed naar de module singleton wanneer hij gezet wordt:

```typescript
case 'SET_DATAVERSE_URL':
  setDataverseOrgUrl(action.url)  // sync naar config module
  return { ...state, dataverseOrgUrl: action.url, dataverseUrlSource: action.source }
```

### 6.4 `src/App.tsx` (of equivalent root component)

Wrap de wizard in `DataverseUrlGate`:

```typescript
<MigrationProvider>
  <DataverseUrlGate>
    <MigrationWizard />
  </DataverseUrlGate>
</MigrationProvider>
```

**Belangrijk:** `DataverseUrlGate` moet **binnen** de Provider zitten (heeft context nodig) maar **buiten** de Wizard (gate moet voor de wizard renderen).

### 6.5 `src/client.ts`

Geen wijziging nodig — custom operations bouwen geen URLs zelf, ze gaan via de SDK die same-origin werkt. Het URL-probleem zit in de directe `fetch()` calls in `dataverseService.ts`, niet in de SDK-laag.

**Verifieer wel:** als ergens in `client.ts` een base URL wordt opgegeven aan `connectorRegistry.register()` o.i.d., moet die ook door de getter heen.

---

## 7. Edge cases & gotchas

### 7.1 Same-origin probleem bij ophalen environment variable
We willen de variable ophalen via `/api/data/v9.2/environmentvariabledefinitions` — maar tegen welke host? Als we de URL uit de variable nog moeten resolven, zit er een kip-en-ei probleem.

**Mitigatie:** De Code App draait gehost binnen Power Apps, en `fetch('/api/data/v9.2/...', { credentials: 'include' })` (same-origin relatief pad) wordt door de Power Apps host geproxied naar de juiste environment. Dat is precies waarom dit überhaupt werkt zonder pre-existing URL.

**Verifieer tijdens implementatie:** test of een relatieve `fetch` op `/api/data/v9.2/...` werkt vanuit de gepubliceerde Code App. Zo niet: gebruik `getContext().app.environmentId` + een fixed Power Platform discovery endpoint om de URL af te leiden vóór de variable-call.

### 7.2 localStorage corruptie of cross-environment pollutie
User opent de app in environment A, vult URL handmatig in (komt in localStorage). Daarna opent dezelfde browser de app in environment B (zelfde origin) — krijgt verkeerde URL.

**Mitigatie:** sleutel localStorage-entry op environment ID:
```typescript
const key = `${DATAVERSE_URL_LOCALSTORAGE_KEY}.${ctx.app.environmentId}`
```
Vereist `getContext()` call vóór localStorage check. Doet niet veel kwaad in de happy path, lost dit edge case op. **Aanbeveling:** wel doen.

### 7.3 WhoAmI ping faalt door network/auth latency
Bij eerste app-load zijn auth cookies mogelijk nog niet klaar; WhoAmI returnt 401.

**Mitigatie:** retry met exponential backoff (3x, total max 5 sec). Als het nog faalt: toon manual input UI met de network error, niet een hard crash.

### 7.4 Variable bestaat maar value is whitespace
Admin heeft "  " ingevuld bij solution import. Onze check moet `trim()` toepassen vóór het check op truthiness.

**Mitigatie:** in §5.2 al meegenomen — `variable.value.trim()` check.

### 7.5 User wil URL wijzigen na valid input
Use case: admin past variable aan, user moet refresh forceren. localStorage wint, dus de oude waarde blijft.

**Mitigatie:** voeg een **"Reset Dataverse URL"** menu-item toe (in app header of Step 1 footer). Roept `clearManualDataverseOrgUrl()` aan en herlaadt. Niet prominent — dit is een uitzonderingsactie.

### 7.6 Trailing slash mismatch
Variable value is `https://x.crm4.dynamics.com/`, code bouwt `${url}/api/...` → dubbele slash. Dataverse pikt dit meestal op, maar niet altijd.

**Mitigatie:** `setDataverseOrgUrl` strip altijd trailing slashes (zie §6.1).

### 7.7 Solution variable wordt gewijzigd terwijl app draait
Admin wijzigt de variable, user zit nog in een sessie met de oude waarde gecached.

**Mitigatie:** geen automatische refresh. Variable wordt alleen bij app startup gelezen. User moet de browser refreshen — gebruikelijk gedrag voor configuratie.

### 7.8 Power Platform admin heeft de variable verwijderd
GET op `environmentvariabledefinitions` returnt empty result.

**Mitigatie:** behandel als "geen waarde gevonden" → manual input UI. Error message moet duidelijk zijn dat de variable niet bestaat in deze environment, niet dat het een runtime fout is.

### 7.9 `getContext()` faalt of returnt onverwachte data
Kan gebeuren bij oudere SDK versies of misconfigured host.

**Mitigatie:** `getContext()` is alleen nodig voor de localStorage scope key (§7.2). Bij failure: gebruik niet-gescoped key met een waarschuwing in console. Niet blokkerend.

### 7.10 Bestaande deployment werkt nog niet met de variable
Eerste deploy na deze refactor: variable bestaat nog niet in de huidige dev-environment.

**Mitigatie:** documenteer in CLAUDE.md dat na deze feature, een eenmalige solution-update nodig is om de variable aan te maken in de dev-environment vóór de eerste app-start. Of: schrijf een `pac` snippet die dit automatiseert.

---

## 8. Acceptance criteria

De feature is klaar wanneer:

1. ✅ `src/config/environment.ts` bevat geen hardcoded URL meer
2. ✅ Bij app startup wordt de URL gehaald uit de Power Platform environment variable in de solution
3. ✅ Bij ontbrekende of lege variable: manual input UI verschijnt; waarde wordt gepersisteerd in localStorage (per environment ID gescoped)
4. ✅ Validatie: URL syntax check + WhoAmI ping; foute URL wordt geweigerd met duidelijke error
5. ✅ `dataverseService.ts` (en alle andere consumers) gebruikt `getDataverseOrgUrl()` getter; geen import-time constanten meer
6. ✅ Loading state tijdens resolve voorkomt rendering van Step 1 met undefined URL
7. ✅ "Reset Dataverse URL" actie beschikbaar voor edge case waarbij admin de variable wijzigt
8. ✅ Solution bevat de environment variable definition met **lege** default value
9. ✅ Bij solution import in een nieuwe environment: admin wordt om de URL gevraagd, app werkt direct na geldige input
10. ✅ Test scenario: deploy naar dev-environment → variable invullen → app werkt. Importeer dezelfde solution naar tweede environment zonder variable in te vullen → manual input UI verschijnt → user vult URL in → app werkt en onthoudt URL bij refresh.

---

## 9. Aanvullende technische notes

### 9.1 Solution variable creatie in Power Platform

De variable moet handmatig (of via `pac`) worden aangemaakt in de solution **vóór** de eerste deploy. Stappen:

1. Open de solution in make.powerapps.com
2. New → More → Environment variable
3. Display Name: `Dataverse Organization URL`
4. Logical Name: `<prefix>_dataverseorgurl`
5. Data Type: `Text`
6. Default Value: **leave empty**
7. Save & Publish
8. Add the Code App to the same solution if not already there
9. Document de logical name in `environmentVariableConfig.ts`

### 9.2 SDK context call timing
`getContext()` is async. Voor §7.2 (gescoped localStorage key) moet hij voor de localStorage check gebeuren. Total resolve flow:

```
app start
  → DataverseUrlGate mount
  → getContext() (await)
  → check localStorage[scoped key]
    → hit: validate → return
    → miss: fetch environment variable → validate → return
  → on error: render manual input UI
```

Dit is een paar honderd ms extra startup-tijd. Acceptabel.

### 9.3 Ontwikkelflow
Bij lokale development via `pac code run`:
- App draait tegen de dev-environment waar developer is ingelogd
- Variable bestaat in die environment (eenmalige setup)
- Geen `.env` file of speciale dev-flow nodig
- Eerste keer dat een nieuwe developer de repo cloned: of variable bestaat al in shared dev-env (meestal), of hij krijgt manual input UI en vult eenmalig in

### 9.4 Logger integratie
URL resolution event loggen (info-level) bij elke startup met de source: `INFO: Resolved Dataverse URL from environmentVariable: https://...`. Helpt bij troubleshooting "waarom praat de app met de verkeerde environment".

### 9.5 Bestaande hardcoded references
Grep voor `crm4.dynamics.com` en `dev-jehe` om zeker te zijn dat geen andere plek de URL hardcoded heeft. Verwacht: alleen `environment.ts` en mogelijk `CLAUDE.md` (documentatie, mag blijven met annotation "default dev environment").

---

## 10. Implementatie volgorde (aanbevolen)

1. State uitbreiden in `MigrationContext` (`dataverseOrgUrl`, `dataverseUrlSource`, reducer actions)
2. `environmentVariableConfig.ts` met variable name + localStorage key
3. `environmentResolver.ts` met `resolveDataverseOrgUrl`, `validateUrl`, custom errors
4. `environment.ts` refactor naar getter/setter pattern
5. `DataverseUrlGate.tsx` + `ManualUrlInput` component
6. Root component: wrap wizard in DataverseUrlGate
7. Refactor alle `DATAVERSE_ORG_URL` consumers naar `getDataverseOrgUrl()`
8. Solution variable creatie in dev-environment + waarde invullen
9. End-to-end test: dev → werkt; clear localStorage → werkt via variable; clear variable → manual input UI; foute URL → validation error
10. "Reset URL" UI element toevoegen
11. localStorage scoping op environmentId (§7.2)
12. Documenteren in CLAUDE.md (deployment runbook, "after first install: configure variable")

Geschatte effort: 1 dag development. Klein in scope, maar veel call sites om aan te passen + zorgvuldige testing van resolve flow.

---

## 11. Open vragen (voor implementatie-tijd)

- Welke publisher prefix gebruiken voor de variable logical name? Hangt af van de solution waar de Code App in zit. **Te bepalen bij stap 8 implementatievolgorde.**
- Werkt same-origin relatieve `fetch` voor `/api/data/v9.2/...` vanuit gepubliceerde Code App? **Verifieer vroeg in implementatie (§7.1).** Als nee: discovery-endpoint flow nodig.
- Moet de "Reset URL" action gated zijn achter een admin-check? **Aanbeveling: nee** — dit is een config-correctie, niet een privilege-actie. Worst case is dat user moet opnieuw invullen.
- Is `getContext().app.environmentId` betrouwbaar genoeg om localStorage op te scopen? Wat als hij undefined is? **Mitigatie in §7.9 al voorzien (fallback naar non-scoped key + console warning).**
