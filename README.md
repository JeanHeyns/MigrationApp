# MigrationApp

Power Apps Code App for migrating Microsoft Project Online data to Planner Premium / Project for the Web in Dataverse.

The app is built with React, TypeScript, Vite, Fluent UI, and the Power Apps CLI. It runs as a single-page wizard inside Power Apps and writes to Dataverse through the Project schedule APIs.

## Current Application Flow

1. **Step 1 - Configure & Fetch**
   - Choose migration mode: `Full migration`, `Data only`, or `Schema only`.
   - Choose the data source:
     - `Project Online`: fetch from a PWA URL through SharePoint / Project Online APIs.
     - `Upload File`: download and fill the Excel/CSV migration template, then upload it.
   - Select the target unmanaged Dataverse solution. The solution publisher prefix is used for generated columns.
   - Configure migration scope for data runs: projects are always included; tasks, dependencies, assignments, and resources are optional.
   - In `dataOnly` mode, the app scans the target Dataverse schema before continuing.

2. **Step 2 - Field Mapping**
   - Review detected Project Online custom fields.
   - Map Project Online fields to Dataverse columns.
   - Use existing columns in `dataOnly` mode, or prepare generated columns in `full` / `schemaOnly` mode.
   - Configure lookup and option-set mapping where required.
   - Select which projects should be migrated with filters and bulk controls.

3. **Step 3 - Create Columns / Validate Schema**
   - `Full migration`: creates missing Dataverse columns, global option sets, custom lookup entities, and tracking metadata.
   - `Schema only`: creates schema and lookup data without importing projects/tasks.
   - `Data only`: validates and reuses the existing schema; no columns are created.
   - Reruns are intended to be safe: existing columns and option sets are skipped.

4. **Step 4 - Import Data**
   - Imports selected projects into Planner Premium.
   - Optional scope controls determine whether tasks, dependencies, assignments, and resources are included.
   - Existing migrated projects are reused through the Project Online tracking ID.
   - Existing project schedules are cleared and rebuilt through Project schedule OperationSet APIs.
   - Imports run with progress, ETA, stop control, and browser-close guard.

5. **Step 5 - Validation Report**
   - Shows imported, skipped, and failed records.
   - Reports skipped data-only field values and file-upload validation warnings when available.
   - Exports summary/error CSV files for review.

## Migration Modes

| Mode | Schema behavior | Data behavior | Use when |
| --- | --- | --- | --- |
| `full` | Create missing Dataverse schema | Import selected data | Building a new migration target |
| `dataOnly` | Reuse existing schema | Import selected data | Running data into a prepared target |
| `schemaOnly` | Create schema only | Skip data import | Preparing a target environment first |

## Data Sources

### Project Online

Enter the Project Online PWA URL, for example:

```text
https://contoso.sharepoint.com/sites/pwa
```

The app reads projects, tasks, dependencies, resources, assignments, team members, custom fields, and lookup tables depending on the selected migration mode and scope.

### File Upload

Use the in-app template download button, fill the workbook, and upload it back into Step 1.

The template path supports project metadata, tasks, resources, assignments, dependencies, team members, custom fields, and lookup values. Downstream mapping and import steps use the same internal data shape as the Project Online fetch path.

## Important Behavior

- Project Online summary/root tasks are excluded from migration.
- Task custom fields are not written because the Project schedule OperationSet API does not support the same custom-field write path as projects.
- Existing project schedules are cleared before rebuild during Step 4.
- Assignments are skipped when the task, project team member, or resource cannot be resolved.
- Generic or unknown resources are skipped when no matching Dataverse user/bookable resource exists.
- OperationSet writes are batched because Dataverse has schedule API limits.
- The target Dataverse organization URL is configured in `src/config/environment.ts`.

## Development

Install dependencies:

```powershell
npm install
```

Run locally:

```powershell
npm.cmd run dev
```

Build:

```powershell
npm.cmd run build
```

On Windows, use `npm.cmd` instead of `npm` if PowerShell blocks `npm.ps1`.

## Deploy To Power Platform

Build first, then push the code app:

```powershell
npm.cmd run build
& 'C:\Users\jan-l\AppData\Local\Microsoft\PowerAppsCLI\pac.cmd' code push --environment 'https://dev-jehe.crm4.dynamics.com/'
```

Known working target:

```text
Environment: https://dev-jehe.crm4.dynamics.com/
User: jean.heyns@exerti.com
```

## Git

Remote:

```text
https://github.com/JeanHeyns/MigrationApp.git
```

Main branch:

```text
main
```

Typical push flow:

```powershell
git status --short --branch
npm.cmd run build
git fetch origin main
git add -A
git commit -m "Update migration app documentation"
git push origin main
```
