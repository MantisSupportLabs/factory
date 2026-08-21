# DirtWorks API Contract (feature modules)

Single source of truth for the feature route modules and the web panels.
Core endpoints (`/api/assets*`, `/api/faults`, `/api/connectors`,
`/api/credentials*`, `/api/ingestion/runs`) are already implemented in
`server/src/api/routes/assets.ts` and `connectors.ts` — see those files.

Conventions: all routes live under `/api`, tenant comes from
`req.tenant.id` (middleware), JSON in/out, snake_case keys mirroring the DB
columns in `server/src/db/schema.sql`. Mutations return the created/updated
row (or `{ok:true}`), errors as `{error}` with 4xx/5xx.

## jobsites.ts → `jobsitesRouter`
- `GET /jobsites` → all jobsite rows for tenant (every column), ordered by name.
- `POST /jobsites` body `{name, code, lat, lng, address?, superintendent?, start_date?, end_date?, notes?, boundary?}` → 201 row. 400 on missing name/code/lat/lng.
- `GET /jobsites/:id` → jobsite row plus `summary: {machines, trucks, small_tools, cameras, active_faults, tools_out, timecards_today}` (counts).
- `PATCH /jobsites/:id` editable: name, status, superintendent, notes, address, boundary, start_date, end_date → row.
- `GET /jobsites/:id/plans` → production_plans rows each augmented with `actual_qty, actual_hours, pct_complete` (sum over production_entries; pct = actual_qty/planned_qty*100 capped 100, 1 decimal).

## tools.ts → `toolsRouter`
- `GET /tools` → small_tool assets: `{id, name, make, model, serial_number, jobsite_id, jobsite_name, lat, lng, status, out: null | {assignment_id, employee_id, employee_name, jobsite_id, jobsite_name, checked_out_at, due_back, overdue: boolean}}` (open assignment join; overdue = due_back < now).
- `POST /tools/:assetId/checkout` body `{jobsite_id?, employee_id, due_back?, condition_out?, notes?}` → 201 assignment row. 409 `{error}` if already checked out. 404 unknown tool.
- `POST /tools/:assetId/checkin` body `{condition_in?, notes?}` → closed assignment row. 409 if not checked out.
- `GET /tools/assignments?asset_id=` → assignment history rows (+ employee_name, jobsite_name), newest first, limit 100.

## cameras.ts → `camerasRouter`
- `GET /cameras` → camera assets `{id, name, model, serial_number, jobsite_id, jobsite_name, lat, lng, meta}` plus simulated UniFi Protect live status: `{online: boolean, recording: boolean, uptime_pct, last_motion (ISO), rtsp}`. Status derived deterministically from serial + current hour (~95% online).
- `POST /cameras` body `{name, model, mac, ip?, jobsite_id, lat, lng}` → 201 creates asset kind='camera' (make 'Ubiquiti', meta {mac, ip, rtsp}).

## connectivity.ts → `connectivityRouter`
- `GET /connectivity` → array per jobsite: `{jobsite_id, jobsite_name, starlink: [...], gateways: [...]}`.
  - starlink item: `{asset_id, name, model, kit_serial, service, status: 'online'|'degraded'|'offline', downlink_mbps, uplink_mbps, latency_ms, obstruction_pct, uptime_pct}` — deterministic mock varying by minute (mostly online, occasionally degraded).
  - gateway item: `{asset_id, name, model, status: 'online'|'offline', clients (int), wan}` (from network assets meta.category 'Gateway').

## fleet.ts → `fleetRouter`
- `GET /fleet/trucks` → truck assets + state columns (like /assets/state) + `today: {loads, tons}` from haul_cycles for today's date.
- `GET /fleet/hauls?from=&to=&asset_id=&jobsite_id=` → haul rows + asset_name + jobsite_name, newest first, limit 200.
- `POST /fleet/hauls` body `{asset_id, jobsite_id, date, material, loads, tons?, cubic_yards?, notes?}` → 201 row (source 'manual').
- `GET /fleet/summary?days=7` → `{daily: [{date, loads, tons}], materials: [{material, loads, tons}]}` over the window.

## workforce.ts → `workforceRouter`
- `GET /employees` → active employee rows.
- `GET /timecards?date=&jobsite_id=&status=` → rows + employee_name, employee_role, jobsite_name, asset_name; date defaults to today (YYYY-MM-DD); ordered by employee_name.
- `POST /timecards` body `{employee_id, jobsite_id?, date, start_time?, end_time?, hours, cost_code?, asset_id?, notes?}` → 201 (source 'manual', status 'draft'). 409 if UNIQUE(employee,date,source) conflict.
- `PATCH /timecards/:id` editable hours, start_time, end_time, cost_code, jobsite_id, asset_id, status, notes → row. When the row's source='ai_auto' and hours changes, set corrected=1 (that's the "manual correction" audit).
- `POST /timecards/:id/approve` → status='approved', returns row.

## safety.ts → `safetyRouter`
- `GET /safety/jsas?jobsite_id=` → rows (+ jobsite_name), newest first.
- `POST /safety/jsas` body `{jobsite_id, date, task, hazards: [{hazard, control}], crew: [string], created_by?}` → 201 (hazards/crew stored as JSON strings).
- `PATCH /safety/jsas/:id` `{status}` open|signed|closed → row.
- `GET /safety/incidents` → rows (+ jobsite_name), newest first.
- `POST /safety/incidents` body `{jobsite_id?, date, type, severity, description}` → 201.
- `PATCH /safety/incidents/:id` `{status?, severity?}` → row.
- `GET /safety/summary` → `{open_jsas, incidents_30d, open_incidents, days_since_recordable}` (recordable = type 'recordable'; null if none ever).

## ai.ts → `aiRouter`  (+ `services/ai-engine.ts`)
- `GET /ai/settings` → `[{feature, enabled}]` for: production_auto, timecards_auto, projections_auto, fault_triage_auto, idle_alerts_auto (insert missing rows enabled=1 on read).
- `PUT /ai/settings/:feature` body `{enabled: boolean}` → row. This is the field's "turn AI auto off" switch — the engine must skip disabled features.
- `POST /ai/analyze` → runs `runAiAnalysis(tenantId)` now → its stats.
- `GET /ai/insights?status=` (default 'suggested') → insight rows newest first limit 100.
- `POST /ai/insights/:id/accept` and `/dismiss` → updated row.
- `GET /ai/projections` → per production plan: `{plan_id, jobsite_id, jobsite_name, phase, activity, unit, planned_qty, planned_hours, actual_qty, actual_hours, pct_complete, rate_qty_per_day (avg over entry days), projected_finish (ISO date | null), planned_end, days_variance (negative = ahead), at_risk: boolean}`.

`services/ai-engine.ts` exports:
- `runAiAnalysis(tenantId: number)` → `{insightsCreated, productionEntries, timecardsSuggested}`. Heuristic engine, honors ai_settings per feature:
  - production_auto: for each active plan with telemetry-bearing machines on its jobsite, upsert today's `production_entries` row (source 'ai_auto', UNIQUE(plan_id,date,source) → INSERT OR IGNORE then UPDATE qty/hours if not corrected): hours = sum of jobsite machines' (engine_hours latest − engine_hours at start of day) from telemetry_readings; qty = hours × (planned_qty/planned_hours).
  - timecards_auto: draft ai_auto timecards for operators/drivers whose assigned asset (assets.operator = employee name) ran today (engine hours delta > 0.5): hours = round(delta*2)/2 clamped 4..12. INSERT OR IGNORE (employee,date,source).
  - projections_auto: compute projections; for at_risk plans create insight kind 'projection' severity 'warning' (skip if a 'suggested' insight of same kind+jobsite exists).
  - idle_alerts_auto: machines with utilization_pct < 55 and engine_status running → insight kind 'idle_alert' severity 'info' (dedup as above per asset).
  - fault_triage_auto: active critical/high faults → insight kind 'fault_triage' severity critical/warning with maintenance suggestion text (dedup per asset+code).
- `computeProjections(tenantId)` → the /ai/projections rows.
- `startAiScheduler()` → setInterval(5 min, unref) running runAiAnalysis for all tenants; called from index.ts.

## reports.ts → `reportsRouter`
- `GET /reports?kind=&jobsite_id=` → rows without payload, newest first, limit 100.
- `GET /reports/:id` → full row, payload JSON.parse'd.
- `POST /reports/generate` body `{kind: 'daily'|'production'|'utilization'|'safety'|'timecards', jobsite_id?, date? (default today)}` → 201 full row. Payload shapes (all include `generated_at`, `jobsite_name?`):
  - daily: `{production: [{activity, unit, qty, hours, source}], hauls: {loads, tons, materials:[...]}, labor: {timecards, hours}, equipment: {machines, running, faults}, safety: {jsas, incidents}}`
  - production: plans vs actuals + projections rows.
  - utilization: per machine `{name, make, model, engine_hours, idle_hours, utilization_pct, fuel_percent, active_faults}`.
  - safety: jsas + incidents in window (last 30d).
  - timecards: per employee `{employee_name, role, hours, cost_codes: [..], source_mix}` for date.
  - `generated_by`: 'manual' (this endpoint) — the AI engine may store 'ai' ones later.

## Web panels (web/src/panels/*.tsx)
Default-export React components, no props. Use `api` (../api/client), types
(../api/types), `useApp` store (../state/store), shared CSS classes from
styles.css (btn, list-row, pill, card, table, switch, field inputs). Refetch
when `useApp((s) => s.dataVersion)` changes; call `useApp.getState().bumpVersion()`
after mutations; big touch targets (min 44px), no new npm deps, no inline
style objects except tiny dynamic values.
