<claude-mem-context>
# Memory Context

# [project-online-migrator] recent context, 2026-05-04 6:41pm GMT+2

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (15,736t read) | 417,211t work | 96% savings

### May 4, 2026
24 1:59p 🟣 Implement Step 3 Create Columns scaffold
25 " 🟣 Implement Step 4 Import Data scaffold
26 " 🟣 Implement Step 5 Validation Report scaffold
27 " 🔄 Replace App.tsx with migration wizard shell
28 2:04p 🔵 Deprecated inlineDynamicImports option in build configuration
29 2:06p ✅ Migration wizard app deployed to Power Apps dev environment
30 2:09p 🟣 Implement Step 2 Field & Owner Mapping UI
31 2:10p 🔴 Add null-safety to mapping configuration save
32 " 🔴 Add null-safety to mapping configuration in next step handler
33 2:34p 🔵 Field Mapping Component Depends on fetchedData.customFields Population
34 2:35p 🔵 Step1Connect Fetches customFields via fetchCustomFields Service
35 " 🔵 fetchCustomFields Queries _api/ProjectData/CustomFields OData Endpoint
36 2:36p 🔵 odataGetAll Implements Pagination with Dual OData Response Format Support
37 2:40p 🔵 fetchLookupTables Uses OData $expand to Nest Lookup Entries
38 2:41p 🔴 Fixed fetchCustomFields to Use ProjectServer API Instead of ProjectData API
39 " 🔴 Fixed fetchLookupTables to Use ProjectServer API with Robust Property Mapping
40 " ✅ Project Build Succeeds After API Endpoint Corrections
41 " ✅ Custom Field Mapping Fixes Deployed to Power Apps
42 2:45p 🟣 Power Platform Solution Selection with Publisher Prefix and Skip Column Creation
43 2:48p 🟣 fetchSolutions Implementation for Dataverse Solution Discovery
44 " ✅ MigrationContext Extended with Solution Selection and Column Creation Skip States
45 " 🟣 Step1Connect UI Implementation with Dataverse Solution Selection
46 2:49p ✅ Step2Mapping Updated to Use Selected Solution Publisher Prefix
47 " ✅ Step2Mapping useEffect Updated to Re-run on Solution Prefix Change
48 " ✅ buildInitialMappings Updated to Accept and Apply Publisher Prefix
49 " ✅ Step2Mapping Save Function Updated to Persist Publisher Prefix and Skip Column Setting
50 " ✅ Step2Mapping Load Function Updated to Restore Skip Column Creation Flag
51 " ✅ Step2Mapping handleNext Function Updated to Include Publisher Prefix and Skip Column Setting
52 " 🟣 Step2Mapping UI Added Solution Selection and Skip Column Creation Controls
53 2:50p 🟣 Step3CreateColumns Updated with Skip Column Creation Support
54 " ✅ Solution Built and Deployed Successfully to Power Apps
55 3:04p 🟣 Register custom HttpRequestForSite API operation on SharePoint Online connector
56 " 🔄 Refactor SharePoint service to use singleton client from client.ts
58 3:05p ✅ Refactored singleton client deployed to Power Apps
59 3:11p 🔴 Fixed SharePoint URL encoding causing 404 errors
60 " ✅ Deployed SharePoint URL encoding fix to Power Apps
61 3:13p ✅ Corrected SharePoint URL encoding strategy based on SDK behavior discovery
62 3:15p 🔵 Located CreateRecord operation for Dataverse column creation
63 3:18p 🔵 Documented CreateRecord API specification for Dataverse entity creation
64 3:19p 🔵 Located existing createRecord implementation in dataverseService
65 " 🔵 Found createRecord implementation pattern in dataverseService
66 3:33p 🔵 pac@1.0.0 Node.js v24.14.0 incompatibility is systemic across all shells
S24 Push code to https://dev-jehe.crm4.dynamics.com/ - implemented Step 4 (Import Data) functionality for Project Online to Dynamics migration tool (May 4, 4:03 PM)
S25 Fix resource identifier handling and Dataverse payload issues in Project Online migrator import logic (May 4, 4:09 PM)
S26 Fix bookable resource linking and task outline number handling in Dataverse API payloads (May 4, 4:11 PM)
S27 Design approach for handling task imports to existing projects in Step 4 - rebuild schedule vs. incremental matching (May 4, 4:13 PM)
S28 Implement and deploy schedule rebuild strategy for project task imports (May 4, 4:14 PM)
72 4:17p ✅ Implemented schedule rebuild strategy for task imports
S29 Add OperationSet execution guards and fix task payload field issue (May 4, 4:17 PM)
73 4:19p ✅ Optimized task creation and removed unsupported field
S30 Remove unsupported LinkStatus field from task creation payload and deploy (May 4, 4:19 PM)
74 4:20p ✅ Removed unsupported LinkStatus field from task creation payload
S31 Does the project importer create a bucket, or does it expect one to already exist? (May 4, 4:20 PM)
S32 Implement Step 5 Validation Report component for Project Online migrator with CSV export capabilities and deploy to Power Apps environment (May 4, 4:27 PM)
75 4:31p 🟣 Default value generation for mapped custom fields
76 " ✅ Milestone duration handling refactored
77 4:33p ✅ Improved default value fallbacks for option set fields
78 " ✅ Removed custom field payload from task import
80 4:36p 🟣 Exclude Project Online summary task from migration
S33 Code review and improvement suggestions for Project Online to Dataverse migration tool (May 4, 6:29 PM)
**Investigated**: Examined full codebase structure including: custom field type detection (customFields.ts), data import orchestration (Step4Import), schedule API writers (taskWriter, assignmentWriter, projectWriter, resourceWriter), Dataverse service layer (dataverseService.ts, odataClient.ts), and UI steps. Performed targeted searches for error handling, TODOs, type safety issues, and architectural patterns.

**Learned**: Fixed custom field type enumeration mapping: Project Server uses non-sequential enum codes (4=Date, 6=Duration, 9=Cost, 15=Number, 17=Flag, 21=Text). Schedule API batch operations queue changes via OperationSet but mark items success before ExecuteOperationSet commits them. Project matching uses only name, creating risk of collisions. Dataverse record listing does not implement pagination beyond $top parameter. Bucket lookup hardcodes "Bucket 1" name which breaks in localized environments.

**Completed**: Fixed custom field type detection in customFields.ts with correct enum mapping and added PS_TYPE_NAME_MAP for name-based fallback. Added helper functions (readLookupTableId, readFieldTypeCode, readFieldTypeName) for robust parsing of mixed-format field metadata. Added "Re-detect column types" button to Step2Mapping UI. Fixed TypeScript null safety in Step2Mapping. Build passes successfully. App deployed to dev-jehe Dataverse environment.

**Next Steps**: Comprehensive code review identified 8 actionable improvements ranked by severity: (1) Fix success-reporting timing in task/assignment writers to report success only after OperationSet execution, (2) Add migration ID columns (exerti_projectonlineid) to enable safe project/task/resource matching, (3) Make clearSchedule operation safer with preflight validation, (4) Implement Dataverse pagination with skiptoken/nextLink, (5) Make bucket discovery resilient (use first bucket or create via API), (6) Hide Resource custom fields from Step 2 until bookableresource support added, (7) Move hardcoded environment URL to config/context, (8) Refactor schedule API payloads into typed builders with documentation.


Access 417k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>