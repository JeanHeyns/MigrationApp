# MigrationApp

Project Online to Planner Premium migration app built as a Power Apps code app with React, TypeScript, and Vite.

## Runbook

1. **Step 1 - Connect & Read**
   - Enter the Project Online PWA URL.
   - Select the target unmanaged Dataverse solution.
   - Read projects, tasks, resources, assignments, team members, custom fields, and lookup tables.

2. **Step 2 - Field Mapping**
   - Review detected custom field types.
   - Use `Re-detect column types` if the source metadata was refreshed.
   - Resource custom fields are skipped by default because resource column creation is not supported yet.
   - Save or load mapping JSON when needed.

3. **Step 3 - Create Columns**
   - Creates global OptionSets for Project Online lookup tables.
   - Creates mapped project/task columns in Dataverse.
   - Creates the migration tracking column `{publisherPrefix}_projectonlineid` on `msdyn_project`.
   - Rerun is safe: existing columns and OptionSets are skipped.

4. **Step 4 - Import Data**
   - Select the projects to import.
   - Confirm schedule rebuild before starting.
   - Resources are matched to Dataverse users/bookable resources.
   - Existing projects are reused through the Project Online tracking ID when available.
   - Existing project schedules are cleared and rebuilt through Project schedule APIs.
   - Project Online top summary task (`TaskId = 0`, outline `0`, or outline level `0`) is excluded.
   - Milestones are imported by setting task duration to `0`.

5. **Step 5 - Validation Report**
   - Review totals by entity.
   - Review failed/skipped records.
   - Export summary and error CSV files.

## Known Behavior

- Generic, unassigned, or unknown Project Online resources are skipped when no matching Dataverse user/bookable resource exists.
- Assignments are skipped when the task or project team member cannot be resolved.
- Step 4 is intentionally destructive for selected project schedules: tasks, dependencies, and assignments are cleared before rebuild.
- The target Dataverse organization URL is currently configured in `src/config/environment.ts`.

## Development

Install dependencies:

```bash
npm install
```

Build:

```bash
npm run build
```

Run locally:

```bash
npm run dev
```

Push the code app with Power Platform CLI:

```powershell
& 'C:\Users\jan-l\AppData\Local\Microsoft\PowerAppsCLI\pac.cmd' code push --environment 'https://dev-jehe.crm4.dynamics.com/'
```
