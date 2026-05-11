# Project Online Migrator — Claude context

## What this app does
5-step Power Apps Code App (React + TypeScript) that migrates data from Microsoft Project Online (SharePoint) to Planner Premium (Dataverse / Project for the Web).

Steps: 1 Connect & Fetch → 2 Field Mapping → 3 Create Columns → 4 Import Data → 5 Validation Report

## Deploy
```
npm run build
"C:\Users\jan-l\AppData\Local\Microsoft\PowerAppsCLI\pac.cmd" code push
```
The `pac` on PATH is a broken npm shim (Node 24 incompatible). Always use the full path above.
Target: https://dev-jehe.crm4.dynamics.com — published as jean.heyns@exerti.com

## Key files
| Path | Purpose |
|------|---------|
| `src/client.ts` | Power Apps SDK singleton — all custom API operations registered here |
| `src/app/MigrationContext.tsx` | All shared wizard state |
| `src/config/environment.ts` | Dataverse org URL |
| `src/services/dataverseService.ts` | Dataverse REST wrapper (list/create/update/metadata) |
| `src/services/sharepointService.ts` | SharePoint OData wrapper |
| `src/services/plannerPremium/` | All Dataverse write logic (projects, tasks, resources, assignments) |
| `src/services/projectOnline/` | All Project Online fetch logic |
| `src/steps/Step*/index.tsx` | One component per wizard step |

## Architecture rules
- `client.ts` is a singleton — custom connector operations must be registered there, once
- SharePoint URL must be single-encoded; SDK re-encodes it (double-encoding lands correctly at SP)
- Dataverse metadata API uses custom operations: `CreateGlobalOptionSet`, `CreateEntityAttribute`, `GetGlobalOptionSetByName`
- Task/assignment writes use Project schedule OperationSet API (max 180 per batch): `msdyn_CreateOperationSetV1` → `msdyn_PssCreateV1` × N → `msdyn_ExecuteOperationSetV1`
- Projects created via `msdyn_CreateProjectV1` unbound action
- Team members created via `msdyn_CreateTeamMemberV1` unbound action
- Entity map: Project → `msdyn_project`, Task → `msdyn_projecttask`

## Known constraints
- Task custom fields cannot be set via OperationSet API — currently not migrated (`void mappingConfig` in taskWriter.ts is intentional)
- `pac code push` always requires a prior `npm run build`
- Dataverse "already exists" errors (codes `0x80044331`, `0x80060891`) are treated as success/skip, not failures

## Git remote
https://github.com/JeanHeyns/MigrationApp — branch: main
