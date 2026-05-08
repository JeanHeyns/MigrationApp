# Option Set Fetch Fix

## Root Cause

The Dataverse REST paths for picklist metadata were correct. The failure was in the Power Apps connector operation registration: the connector layer did not have concrete operations that matched the single-attribute OData cast paths, so the backend returned:

- `source: "configuration"`
- `reason: "OperationNotFound"`

This was not a Dataverse metadata API URL problem.

The built-in `GetOptionSetMetadata` route is a different connector route under the same `commondataserviceforapps` connector. It goes through the generated APIM URL (`shared-commondataser...`) and needs the organization-aware shape. Calling the non-organization variant produced `Invalid organization URL 'null'`.

## Registered Metadata Operations

All custom operations are registered in `src/client.ts` under `commondataserviceforapps`.

| Operation | Method | Path | Query parameters |
| --- | --- | --- | --- |
| `CreateGlobalOptionSet` | `POST` | `/{connectionId}/api/data/v9.1.0/GlobalOptionSetDefinitions` | none |
| `GetGlobalOptionSetByName` | `GET` | `/{connectionId}/api/data/v9.1.0/GlobalOptionSetDefinitions(Name='{optionSetName}')` | `$select` |
| `ListGlobalOptionSetDefinitions` | `GET` | `/{connectionId}/api/data/v9.1.0/GlobalOptionSetDefinitions` | `$select` |
| `ListEntityDefinitions` | `GET` | `/{connectionId}/api/data/v9.1.0/EntityDefinitions` | `$select`, `$filter` |
| `GetEntityDefinition` | `GET` | `/{connectionId}/api/data/v9.1.0/EntityDefinitions(LogicalName='{entityLogicalName}')` | `$select`, `$expand` |
| `CreateEntityDefinition` | `POST` | `/{connectionId}/api/data/v9.1.0/EntityDefinitions` | none |
| `CreateEntityAttribute` | `POST` | `/{connectionId}/api/data/v9.1.0/EntityDefinitions(LogicalName='{entityLogicalName}')/Attributes` | none |
| `GetEntityAttributes` | `GET` | `/{connectionId}/api/data/v9.1.0/EntityDefinitions(LogicalName='{entityLogicalName}')/Attributes` | `$select`, `$filter`, `$expand` |
| `GetEntityAttributesByCast` | `GET` | `/{connectionId}/api/data/v9.1.0/EntityDefinitions(LogicalName='{entityLogicalName}')/Attributes/{attributeCast}` | `$select`, `$filter`, `$expand` |
| `GetEntityAttributeByMetadataIdCast` | `GET` | `/{connectionId}/api/data/v9.1.0/EntityDefinitions(LogicalName='{entityLogicalName}')/Attributes({attributeMetadataId})/{attributeCast}` | `$select`, `$expand` |
| `GetEntityAttributeByLogicalNameCast` | `GET` | `/{connectionId}/api/data/v9.2/EntityDefinitions(LogicalName='{entityLogicalName}')/Attributes(LogicalName='{attributeLogicalName}')/{attributeCast}` | `$select`, `$expand` |
| `GetPicklistAttribute` | `GET` | `/{connectionId}/api/data/v9.2/EntityDefinitions(LogicalName='{entityLogicalName}')/Attributes(LogicalName='{attributeLogicalName}')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata` | `$expand` |
| `GetMultiSelectPicklistAttribute` | `GET` | `/{connectionId}/api/data/v9.2/EntityDefinitions(LogicalName='{entityLogicalName}')/Attributes(LogicalName='{attributeLogicalName}')/Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata` | `$expand` |
| `GetEntityManyToOneRelationships` | `GET` | `/{connectionId}/api/data/v9.1.0/EntityDefinitions(LogicalName='{entityLogicalName}')/ManyToOneRelationships` | `$select`, `$filter` |

`GetPicklistAttribute` and `GetMultiSelectPicklistAttribute` were added because the connector operation matcher rejected the generic single-attribute cast route even though the resulting Dataverse URL was valid.

## Strategy

The schema inspector now prefers the concrete cast operations:

- `GetPicklistAttribute`
- `GetMultiSelectPicklistAttribute`

Both use `$expand=OptionSet,GlobalOptionSet` and parse `Options[]` directly from the attribute response.

Inline options are stored on `ColumnMeta.inlineOptions` and mirrored to the existing `optionSetOptions` field for compatibility. This means:

- Global choice fields can resolve without an extra `GlobalOptionSetDefinitions` fetch.
- Local choice fields work the same way because their field-bound `OptionSet.Options[]` is already in the attribute response.
- Shared global option sets still cache by `optionSetMetadataId` when available, otherwise by `optionSetName`.

The old `GlobalOptionSetDefinitions(Name='...')` flow remains as a fallback when inline options are unavailable.

## Resolver Behavior

Choice and multi-choice resolvers now use this order:

1. `inlineOptions` from the schema snapshot.
2. Legacy `optionSetOptions`.
3. Global option-set fetch by `optionSetName`.
4. Explicit error warning if no usable metadata exists.

Every option label map includes:

- `Label.UserLocalizedLabel.Label`
- every `Label.LocalizedLabels[].Label`

Each label is normalized before insertion so English and localized labels map to the same Dataverse integer value.
