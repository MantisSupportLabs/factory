-- DirtWorks normalized schema (SQLite dialect; designed to port 1:1 to Postgres).
-- Every business table carries tenant_id — single-tenant demo today,
-- multi-tenant SaaS later without schema changes.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tenants (
  id            INTEGER PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Per-tenant OEM API credentials, encrypted at rest (AES-256-GCM blob).
CREATE TABLE IF NOT EXISTS provider_credentials (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
  provider      TEXT NOT NULL,             -- connector slug: caterpillar, john_deere, ...
  label         TEXT NOT NULL,
  auth_type     TEXT NOT NULL,             -- oauth2 | api_key | basic
  ciphertext    TEXT NOT NULL,             -- base64(iv || tag || data)
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_sync_at  TEXT,
  last_status   TEXT,                      -- ok | error: message
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, provider, label)
);

CREATE TABLE IF NOT EXISTS jobsites (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
  name          TEXT NOT NULL,
  code          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',   -- planned | active | paused | complete
  lat           REAL NOT NULL,
  lng           REAL NOT NULL,
  boundary      TEXT,                              -- GeoJSON polygon
  address       TEXT,
  superintendent TEXT,
  start_date    TEXT,
  end_date      TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, code)
);

-- One row per physical asset of ANY kind. Telematics-fed machines, manually
-- tracked iron, trucks, small tools (BLE tags later), cameras, network gear.
CREATE TABLE IF NOT EXISTS assets (
  id                INTEGER PRIMARY KEY,
  tenant_id         INTEGER NOT NULL REFERENCES tenants(id),
  kind              TEXT NOT NULL,          -- machine|truck|small_tool|attachment|camera|network|trailer
  name              TEXT NOT NULL,
  make              TEXT,
  model             TEXT,
  serial_number     TEXT,
  year              INTEGER,
  category          TEXT,                   -- Excavator, Dozer, Articulated Truck, ...
  jobsite_id        INTEGER REFERENCES jobsites(id),
  source            TEXT NOT NULL DEFAULT 'manual',  -- oem_telematics|can_j1939|ble_tracker|manual
  provider          TEXT,                   -- connector slug when source=oem_telematics
  provider_asset_id TEXT,                   -- OEM EquipmentID/PIN
  credential_id     INTEGER REFERENCES provider_credentials(id),
  tracking_mode     TEXT NOT NULL DEFAULT 'auto',    -- auto (telemetry) | manual (hand position)
  status            TEXT NOT NULL DEFAULT 'active',  -- active|down|maintenance|retired
  operator          TEXT,                   -- current assigned operator (fleet board)
  icon              TEXT,
  meta              TEXT,                   -- JSON extras (tool bin, camera rtsp, kit serial...)
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_assets_provider
  ON assets (tenant_id, provider, provider_asset_id)
  WHERE provider IS NOT NULL AND provider_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_assets_tenant_kind ON assets (tenant_id, kind);
CREATE INDEX IF NOT EXISTS ix_assets_jobsite ON assets (jobsite_id);

-- Latest state per asset — one row, updated in place. The map reads this.
CREATE TABLE IF NOT EXISTS asset_state (
  asset_id        INTEGER PRIMARY KEY REFERENCES assets(id),
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id),
  ts              TEXT,                     -- last telemetry update (any channel)
  lat             REAL,
  lng             REAL,
  altitude_m      REAL,
  heading_deg     REAL,
  speed_kph       REAL,
  location_ts     TEXT,
  engine_status   TEXT,                     -- running|idle|off|unknown
  engine_status_ts TEXT,
  engine_hours    REAL,
  idle_hours      REAL,
  fuel_percent    REAL,
  fuel_used_l     REAL,
  def_percent     REAL,
  odometer_km     REAL,
  utilization_pct REAL,
  payload_tons    REAL,
  battery_pct     REAL,
  active_faults   INTEGER NOT NULL DEFAULT 0,
  source          TEXT
);
CREATE INDEX IF NOT EXISTS ix_state_tenant ON asset_state (tenant_id);

-- Location history. Dedup enforced by the unique index; INSERT OR IGNORE.
CREATE TABLE IF NOT EXISTS location_history (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
  asset_id    INTEGER NOT NULL REFERENCES assets(id),
  ts          TEXT NOT NULL,
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  altitude_m  REAL,
  heading_deg REAL,
  speed_kph   REAL,
  source      TEXT NOT NULL,
  UNIQUE (asset_id, ts, source)
);
CREATE INDEX IF NOT EXISTS ix_loc_asset_ts ON location_history (asset_id, ts);

-- Numeric metric history (engine_hours, fuel_percent, ...). Dedup via unique.
CREATE TABLE IF NOT EXISTS telemetry_readings (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
  asset_id    INTEGER NOT NULL REFERENCES assets(id),
  metric      TEXT NOT NULL,
  ts          TEXT NOT NULL,
  value       REAL NOT NULL,
  unit        TEXT NOT NULL,
  source      TEXT NOT NULL,
  UNIQUE (asset_id, metric, ts, source)
);
CREATE INDEX IF NOT EXISTS ix_read_asset_metric_ts ON telemetry_readings (asset_id, metric, ts);

CREATE TABLE IF NOT EXISTS fault_codes (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
  asset_id    INTEGER NOT NULL REFERENCES assets(id),
  code        TEXT NOT NULL,
  spn         INTEGER,
  fmi         INTEGER,
  severity    TEXT NOT NULL,               -- low|medium|high|critical
  description TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  resolved_at TEXT,
  source      TEXT NOT NULL,
  UNIQUE (asset_id, code, occurred_at)
);
CREATE INDEX IF NOT EXISTS ix_faults_asset ON fault_codes (asset_id, active);

-- Audit trail of connector sync runs.
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id                INTEGER PRIMARY KEY,
  tenant_id         INTEGER NOT NULL REFERENCES tenants(id),
  credential_id     INTEGER REFERENCES provider_credentials(id),
  provider          TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  finished_at       TEXT,
  status            TEXT NOT NULL,          -- running|ok|error
  assets_seen       INTEGER NOT NULL DEFAULT 0,
  readings_inserted INTEGER NOT NULL DEFAULT 0,
  readings_deduped  INTEGER NOT NULL DEFAULT 0,
  faults_seen       INTEGER NOT NULL DEFAULT 0,
  error             TEXT
);
CREATE INDEX IF NOT EXISTS ix_runs_tenant ON ingestion_runs (tenant_id, started_at);

-- ---------------- field operations ----------------

CREATE TABLE IF NOT EXISTS employees (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,               -- operator|laborer|foreman|super|driver|mechanic|pm|pe
  phone       TEXT,
  certs       TEXT,                        -- JSON list
  crew_id     INTEGER REFERENCES crews(id),
  active      INTEGER NOT NULL DEFAULT 1
);

-- Field crews. Members are employees with crew_id set; jobs get a PM and a
-- PE on the jobsite row (pm_id / pe_id).
CREATE TABLE IF NOT EXISTS crews (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
  name        TEXT NOT NULL,
  jobsite_id  INTEGER REFERENCES jobsites(id),
  foreman_id  INTEGER REFERENCES employees(id),
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, name)
);

-- Small tool checkout/return.
CREATE TABLE IF NOT EXISTS tool_assignments (
  id             INTEGER PRIMARY KEY,
  tenant_id      INTEGER NOT NULL REFERENCES tenants(id),
  asset_id       INTEGER NOT NULL REFERENCES assets(id),
  jobsite_id     INTEGER REFERENCES jobsites(id),
  employee_id    INTEGER REFERENCES employees(id),
  checked_out_at TEXT NOT NULL,
  due_back       TEXT,
  checked_in_at  TEXT,
  condition_out  TEXT,
  condition_in   TEXT,
  notes          TEXT
);
CREATE INDEX IF NOT EXISTS ix_tools_open ON tool_assignments (tenant_id, checked_in_at);

-- Truck haul cycles (manual tickets today, CAN/J1939 feeds later).
CREATE TABLE IF NOT EXISTS haul_cycles (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
  asset_id    INTEGER NOT NULL REFERENCES assets(id),
  jobsite_id  INTEGER REFERENCES jobsites(id),
  date        TEXT NOT NULL,
  material    TEXT NOT NULL,
  loads       INTEGER NOT NULL DEFAULT 0,
  tons        REAL,
  cubic_yards REAL,
  source      TEXT NOT NULL DEFAULT 'manual',
  notes       TEXT
);

-- Production plan lines from the estimate/plans.
CREATE TABLE IF NOT EXISTS production_plans (
  id            INTEGER PRIMARY KEY,
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
  jobsite_id    INTEGER NOT NULL REFERENCES jobsites(id),
  phase         TEXT NOT NULL,
  activity      TEXT NOT NULL,
  unit          TEXT NOT NULL,              -- CY, LF, SY, TON, EA
  planned_qty   REAL NOT NULL,
  planned_hours REAL NOT NULL,
  planned_start TEXT,
  planned_end   TEXT
);

-- Daily production actuals; AI-suggested rows carry source='ai_auto' and can
-- be corrected in place (corrected=1 keeps the audit trail honest).
CREATE TABLE IF NOT EXISTS production_entries (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
  plan_id     INTEGER NOT NULL REFERENCES production_plans(id),
  date        TEXT NOT NULL,
  qty         REAL NOT NULL,
  hours       REAL NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual',  -- manual | ai_auto
  corrected   INTEGER NOT NULL DEFAULT 0,
  notes       TEXT,
  UNIQUE (plan_id, date, source)
);

-- Per-feature AI automation toggles. The field can turn any of it off.
CREATE TABLE IF NOT EXISTS ai_settings (
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
  feature     TEXT NOT NULL,               -- production_auto|timecards_auto|projections_auto|fault_triage_auto|idle_alerts_auto
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (tenant_id, feature)
);

-- AI outputs land here as reviewable suggestions, never silent mutations.
CREATE TABLE IF NOT EXISTS ai_insights (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
  jobsite_id  INTEGER REFERENCES jobsites(id),
  asset_id    INTEGER REFERENCES assets(id),
  kind        TEXT NOT NULL,               -- projection|idle_alert|fault_triage|production|timecard
  severity    TEXT NOT NULL DEFAULT 'info',-- info|warning|critical
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  data        TEXT,                        -- JSON payload backing the insight
  status      TEXT NOT NULL DEFAULT 'suggested', -- suggested|accepted|dismissed|corrected
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_insights ON ai_insights (tenant_id, status, created_at);

CREATE TABLE IF NOT EXISTS timecards (
  id           INTEGER PRIMARY KEY,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id),
  employee_id  INTEGER NOT NULL REFERENCES employees(id),
  jobsite_id   INTEGER REFERENCES jobsites(id),
  date         TEXT NOT NULL,
  start_time   TEXT,
  end_time     TEXT,
  hours        REAL NOT NULL,
  cost_code    TEXT,
  asset_id     INTEGER REFERENCES assets(id),  -- equipment operated
  source       TEXT NOT NULL DEFAULT 'manual', -- manual | ai_auto
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft|submitted|approved
  corrected    INTEGER NOT NULL DEFAULT 0,
  notes        TEXT,
  UNIQUE (employee_id, date, source)
);

-- Job Safety Analyses + incidents.
CREATE TABLE IF NOT EXISTS jsa_forms (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
  jobsite_id  INTEGER NOT NULL REFERENCES jobsites(id),
  date        TEXT NOT NULL,
  task        TEXT NOT NULL,
  hazards     TEXT NOT NULL,               -- JSON [{hazard, control}]
  crew        TEXT,                        -- JSON [names]
  created_by  TEXT,
  status      TEXT NOT NULL DEFAULT 'open' -- open|signed|closed
);

CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id),
  jobsite_id  INTEGER REFERENCES jobsites(id),
  date        TEXT NOT NULL,
  type        TEXT NOT NULL,               -- near_miss|first_aid|recordable|property|utility_strike
  severity    TEXT NOT NULL DEFAULT 'low',
  description TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open'
);

-- Generated report documents (daily, utilization, safety, timecard rollups).
CREATE TABLE IF NOT EXISTS reports (
  id           INTEGER PRIMARY KEY,
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id),
  jobsite_id   INTEGER REFERENCES jobsites(id),
  date         TEXT NOT NULL,
  kind         TEXT NOT NULL,              -- daily|production|utilization|safety|timecards
  title        TEXT NOT NULL,
  payload      TEXT NOT NULL,              -- JSON document body
  generated_by TEXT NOT NULL DEFAULT 'manual', -- manual | ai
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
