# Option Set Resolution Fix

> **Fix status:** Implemented
> **Date completed:** May 2026
> **Area:** `dataOnly` Picklist / MultiSelectPicklist resolution

---

## 1. What was wrong

`dataOnly` choice resolution treated missing option-set metadata and real value mismatches as the same thing.

For global choice fields, the resolver fetched `GlobalOptionSetDefinitions(Name='...')` using the name stored in the schema snapshot. If that name was missing or the fetch failed, the resolver built an empty value map. Step 5 then reported each record as:

`No matching Picklist value for "Amber"`

That hid the actual root cause: the option set itself could not be loaded.

Local option sets had a second gap. The schema scan only preserved a global option-set name. If Dataverse returned a field-bound local option set (`OptionSet.IsGlobal === false`), there was no way for the resolver to use the options from the attribute metadata.

---

## 2. What changed

The schema snapshot now carries explicit option-set metadata for choice columns:

- `optionSetName`
- `optionSetIsGlobal`
- `optionSetOptions` for local option sets when Dataverse returns bound options in the attribute metadata

The resolver now distinguishes three cases:

- **Shared global option set:** fetch by the actual `OptionSet.Name` / `GlobalOptionSet.Name` from metadata.
- **Local option set with options:** resolve directly from `optionSetOptions`; no global fetch is attempted.
- **Missing or failed option-set metadata:** return an option-set-level failure reason so Step 5 shows the root cause instead of individual value mismatches.

The label map includes both `UserLocalizedLabel.Label` and every `LocalizedLabels[].Label`, so English and localized Dataverse labels can both resolve.

---

## 3. Supported option-set types

| Type | Status | Notes |
|---|---|---|
| Shared global Picklist | Supported | Uses `GlobalOptionSetDefinitions(Name='...')` with the metadata-derived option-set name. |
| Shared global MultiSelectPicklist | Supported | Same global fetch path; values are split on comma/semicolon and written as comma-separated integers. |
| Local Picklist | Supported when metadata includes `OptionSet.Options` | Resolver uses attribute-bound options from schema scan. |
| Local MultiSelectPicklist | Supported when metadata includes `OptionSet.Options` | Same local metadata path as Picklist. |
| Local option set without returned options | Explicit failure | Step 5 reports that local option-set metadata could not be loaded and recommends re-scanning/checking connector metadata support. |

---

## 4. Debugging

Enable verbose browser logging before a test run:

```js
localStorage.setItem('DEBUG_DATAONLY_WRITER', '1')
```

Relevant logs now show:

- schema-scan option-set metadata per Picklist/MultiSelectPicklist field
- global option-set fetches and cache hits
- fetched option and label counts
- local option-set usage and option counts

For the concrete failure cases, the important thing to verify is that:

- `exp_budget_status` and `exp_resource_status` point to the same shared global name when they use shared choices, for example `exp_status_choices`
- `exp_codes` points to the real global name or carries local options
- `exp_codes_multiselect` points to the real global name or carries local multi-select options
