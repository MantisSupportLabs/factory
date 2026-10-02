# DirtWorks

A civil construction ERP workspace for owners, project managers, and field foremen managing earthwork, utilities, and roads across multiple jobs. Jobs, crews, people, equipment, measured production, purchasing, forecasts, and billing share one persistent database. The original live fleet/map tools remain under **Live field workspace**.

The app now includes the next development phases described in the [civil ERP blueprint](docs/CIVIL_ERP_BLUEPRINT.md). Its operational and commercial ledgers work locally; payroll tax, general ledger, bank connections, and live provider integrations still require implementation and validation.

## Working modules

| Module | Behavior |
|---|---|
| Portfolio and projects | Jobs, client, PM ownership across multiple jobs, superintendent, contract/budget, dates, coordinates, measured progress and risks |
| Weekly PM updates | Weekly estimated completion, finish/final-cost forecast, health, blockers and next-week plan; PM estimates stay separate from measured work |
| People, crews and dispatch | Employee register, crew membership history, frozen dispatched rosters, one crew assignment per day, cross-crew worker conflict checks, required qualifications valid on the assignment date |
| Time and qualifications | Person/job/code split shifts, interval and legacy-timecard checks, breaks, dated certification expiry, approved wage/burden snapshots, void history and payroll preparation CSV; field roles cannot read individual pay rates |
| Field production | Work-item targets and cost codes, daily drafts/submission/approval, rejection reasons, immutable approved facts, reversal and linked same-day corrections |
| Equipment operations | Timed reservations, transfer requests and acceptance/custodian history, conflict checks, inspections, repair/preventive work orders, meter/calendar service rules and explicit return to service |
| Job costs | Direct costs plus approved source costs; time voids/report reversals remove eligible costs; sourced labor, material usage and completed job repairs post once |
| Purchasing and inventory | Vendors/items, quantity/price order lines, partial receipt lots, FIFO material usage and remaining stock; legacy whole-order commitments retained separately |
| Supplier invoices | Received-quantity and price matching, duplicate reference prevention, partial payment balances and append-only AP records |
| Change controls | RFIs/issues/requests; signed change approvals preserve before/after contract, budget and work-quantity snapshots. Closing a request alone changes no money |
| Plans and forecasts | Work calendars/holidays, dependencies with cycle detection, baseline versions, bottom-up remaining cost by code/category and approved EAC snapshots; original PO totals are informational and never added twice |
| Progress billing | Schedule of values/pay items, cumulative quantity or verified-amount applications, certification, retainage, partial customer receipts, release and separate retainage cash receipts |
| Closeout | Required checklist, measured completion, pending-report/billing/delivery/stock/control checks and recorded final acceptance; collections can settle afterward |
| Project documents | PDF/images/text/CSV up to 5 MB, retained revisions, project/category register, immutable metadata, file hashes and authenticated downloads |
| Device drafts | New daily drafts queue on network failure and retry with server idempotency. Export/discard local drafts; approvals and financial actions require a connection |
| Team access and activity | First-owner setup, individual accounts, seven permission roles, tenant-bound sessions, CSRF/origin checks, durable login throttling, session revocation and append-only mutation audit |
| Reports and recovery | Operational CSVs, owner-only company JSON export and host SQLite/attachment backups with verified restore into a new directory |

Recorded manual production and eligible approved reports establish measured quantities. Telemetry estimates and PM percentages do not create installed work. Mixed units are never added together; project completion weights work-item progress by budget. Manual cost entries require reconciliation with source ledgers.

Material receipt creates stock; material usage creates job cost. Supplier invoice/payment records do not repeat that expense. Maintenance repair cost and operating equipment cost are separate. Forecasts state their as-of date and preserve actual/remaining costs when approved.

## Run the app

Use **Node.js 24+** (the app and recovery tools use `node:sqlite`).

```bash
npm install
npm run build
npm start
```

Open [http://localhost:4000](http://localhost:4000). Development:

```bash
npm run dev
```

Vite opens at [http://localhost:5173](http://localhost:5173) and proxies the API to port 4000. Business records survive refresh and restart while `DB_PATH` and its adjacent `documents/` directory are retained. Schema upgrades preserve existing records; sample ERP records extend the named contractor once.

```bash
npm run typecheck
npm test --workspace=server
```

Tests use isolated databases and cover approval/reversal totals, split-time privacy and conflicts, equipment availability, inventory/AP matching, forecasting/billing/retainage, tenant/role denials, document revisions and host recovery.

## Secure company access

Development starts in an explicitly labeled demo mode until the first owner account is created under **Team access & activity**. Enabling access preserves the company records and requires all users to sign in. Accounts belong to a fixed company; a caller header cannot change an authenticated user's company. Employee roster roles and login roles are separate.

With `NODE_ENV=production`, sign-in is required even before setup, and first-owner creation requires the configured `DIRTWORKS_SETUP_TOKEN`. Deploy behind HTTPS, configure the exact `DIRTWORKS_PUBLIC_ORIGIN`, preserve the credential encryption key, and configure protected persistent storage. Owner/admin accounts manage users; PMs review field work; accountants certify billing/forecasts and record cash; dispatchers/mechanics manage their operations. Shared operational summaries remain readable within the company; private individual wage details and payroll exports are restricted.

The audit records successful API mutations, account identity, route, record ID when available and timestamp; it omits passwords, cookies, tokens and request bodies. It is an activity log rather than a full before/after accounting journal. Host administrators can access the database and backup archives.

## Demo and remaining work

The Summit DirtWorks & Paving demo has three North Texas jobs, two PMs, crews, assets, tools, production plans, opening cost balances and sample commercial records. Customers, quantities and costs are illustrative. Six OEM transports use simulated feeds; camera/network status and heuristic estimates also remain simulated. America/Chicago defines ERP business dates.

Remaining major work includes estimating/takeoff, subcontract administration, inventory returns/reallocation, procurement credit/reversal workflows, rentals and equipment ownership costing, leave and multi-job timed crew dispatch, drawing markup/quality testing, schedule/resource calculation, payroll rules/taxes, GL/accounting exports and reconciliation, credit notes/SOV amendments, weekly-update before/after revisions, and real OEM/accounting integrations. Final acceptance intentionally freezes new work; a formal reopening workflow is still needed.

Offline support covers new daily drafts on the device, with an application shell cache in built deployments. It does not provide offline editing of every module, cached authenticated job datasets, background approval, or attachment upload. Device storage is lost when browser data is cleared. Baselines/calendars/dependencies are stored and reviewed; they do not yet produce a full critical-path or resource-loaded schedule.

SQLite supports this local implementation. Shared production deployment still needs capacity/concurrency testing, operational monitoring, managed secrets, backup scheduling and restore rehearsal with the deployed encryption key. Tenant JSON exports omit attachment bytes and credentials and cannot restore the database.

## Configuration

| Variable | Purpose |
|---|---|
| `PORT` | API/built app port; default `4000` |
| `DB_PATH` | SQLite file; default `server/data/dirtworks.db`; uploads use adjacent `documents/` |
| `NODE_ENV` | `production` requires secure access and secure session cookies |
| `DIRTWORKS_SETUP_TOKEN` | Production first-owner setup token |
| `DIRTWORKS_PUBLIC_ORIGIN` | Exact browser origin used for write-request origin checks |
| `CREDENTIALS_KEY` | 32-byte hex OEM credential encryption key; fixed development default must be replaced for real credentials |
| `INGEST_INTERVAL_SEC` | OEM polling; default `45` |
| `DEMO_TIME_SCALE` | Simulated fleet clock; default `12`, use `1` for real time |
| `WEB_DIST` | Built web directory; default `web/dist` |
| `VITE_API_TARGET` | Optional development API proxy target; default `http://localhost:4000` |

## Documentation

- [Civil ERP blueprint](docs/CIVIL_ERP_BLUEPRINT.md): lifecycle, evidence rules, researched design basis and remaining roadmap.
- [Backup and recovery](docs/BACKUP_RECOVERY.md): consistent database/files archive and verified isolated restore.
- [Architecture](docs/ARCHITECTURE.md): existing telematics model and connector pipeline.
- ERP route modules: `server/src/api/routes/erp.ts`, `workforce-planning.ts`, `equipment-operations.ts`, `procurement.ts`, `project-finance.ts`, `documents.ts`, and `access.ts`.
