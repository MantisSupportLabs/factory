# DirtWorks Architecture

Engineering reference for the telematics pipeline, the normalized data model, and the application layers on top of it. Paths are relative to the repo root.

## The pipeline

Everything telemetry-shaped flows through one pipeline, regardless of where it came from:

```
   OEM APIs (ISO 15143-3 / AEMP 2.0)          demo: mock://<provider>
   Cat VisionLink · JDLink · KOMTRAX          in-process simulator
   CareTrack · ConSite · MY DEVELON           (same payload shapes)
          │                                          │
          ▼                                          ▼
┌───────────────────────────────────────────────────────────────┐
│  Connectors            server/src/telematics/connectors/*     │
│  one per OEM; auth + fetch; registry keyed by provider slug   │
└───────────────────────────────┬───────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────┐
│  Normalization         server/src/telematics/model.ts,        │
│                        aemp/normalize.ts                      │
│  OEM payloads → NormalizedAssetSnapshot (identity, location,  │
│  metrics, engine status, faults) — units + names unified      │
└───────────────────────────────┬───────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────┐
│  Ingestion             server/src/telematics/ingestion.ts     │
│  poll loop; upsert identity, dedup history, latest-state      │
│  upsert, fault lifecycle, geofence auto-assign, audit row     │
└───────────────────────────────┬───────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────┐
│  Database              server/src/db/schema.sql (SQLite)      │
│  assets · asset_state · location_history · telemetry_readings │
│  fault_codes · ingestion_runs  (+ field-ops tables)           │
└───────────────────────────────┬───────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────┐
│  Application API       server/src/api/*  (Express, /api/...)  │
│  tenant middleware → feature route modules → JSON             │
└───────────────────────────────┬───────────────────────────────┘
                                ▼
┌───────────────────────────────────────────────────────────────┐
│  Web                   web/src/*  (React + MapLibre GL +      │
│  zustand)  10s poll of /assets/state + /jobsites → live map   │
└───────────────────────────────────────────────────────────────┘
```

The AI engine (`server/src/services/ai-engine.ts`) sits beside the API and reads the same tables on a 5-minute schedule; it never talks to connectors.

## Normalized asset model

`server/src/telematics/model.ts` defines the internal vocabulary. Every feed — AEMP OEM APIs today, aftermarket CAN/J1939 trackers and BLE tool tags tomorrow, and plain manual entry — is converted to these shapes **before** anything touches the database:

- `NormalizedAssetIdentity` — provider asset id (AEMP EquipmentID/PIN), make, model, serial, category.
- `GeoPoint` — lat/lng/altitude/heading/speed with the OEM's own timestamp.
- `MetricReading` — one sample of a `NormalizedMetric` (`engine_hours`, `idle_hours`, `fuel_percent`, `fuel_used_l`, `def_percent`, `odometer_km`, `utilization_pct`, `payload_tons`, `battery_pct`) with a canonical unit.
- `NormalizedFault` — code (SPN/FMI aware), severity, description, occurred-at.
- `NormalizedAssetSnapshot` — one asset's identity + everything above; all telemetry fields optional because OEM coverage differs.

Why one model: the application layer (API, map, AI engine, reports) never sees an OEM-specific shape. All sources land in the **same tables** (`assets`, `asset_state`, `location_history`, `telemetry_readings`, `fault_codes`), distinguished only by a `source` column (`oem_telematics | can_j1939 | ble_tracker | manual`). Adding a new class of hardware means writing a normalizer, not touching queries, panels, or reports — a BLE tag on a plate compactor is just an asset whose `source` flips from `manual` to `ble_tracker`.

## Connector abstraction

`server/src/telematics/connector.ts`. A connector adapts exactly one OEM API to the normalized model:

```ts
interface TelematicsConnector {
  readonly info: ConnectorInfo;   // slug, display name, aemp2 flag, auth type, capabilities
  testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail: string }>;
  sync(ctx: ConnectorContext): Promise<ConnectorSyncResult>;  // fully normalized snapshots
}
```

- `ConnectorContext` carries the tenant id, the **decrypted** credentials, `lastSyncAt` for incremental fetches, and a logger. That is the only place plaintext credentials ever appear outside the vault module.
- `testConnection` must not throw on bad credentials — it returns `ok:false` with a reason, which the UI shows verbatim.
- `sync` returns `{ provider, snapshots, warnings }`; warnings are non-fatal (a machine whose history endpoint failed still lands its fleet-snapshot data).
- Connectors live in a registry keyed by provider slug (`registerConnector` / `getConnector` / `listConnectors`). Ingestion and the API only ever talk to the interface.

**Adding an OEM is three steps, zero core changes:**

1. **File** — write `server/src/telematics/connectors/<provider>.ts` implementing `TelematicsConnector` (for an AEMP-compliant OEM this is mostly auth + the shared client; see `caterpillar.ts`, the reference implementation).
2. **Register** — add one `registerConnector(...)` line in `connectors/index.ts`.
3. **Credentials row** — create a `provider_credentials` row for the tenant (via `POST /api/credentials` or the Connectors panel). The next ingest cycle picks it up.

## ISO 15143-3 / AEMP 2.0 usage

Most iron OEMs expose the same standard, so the transport is shared: `server/src/telematics/aemp/client.ts`.

- **Fleet snapshot**: `GET /Fleet/{page}` — paged; the client follows `rel:"next"` links with a hard 50-page stop.
- **Per-equipment time series**: `GET /Equipment/{oem}/{serial}/Locations/{start}/{end}/{page}` and `.../FaultCodes/{start}/{end}/{page}` — used to backfill history since `lastSyncAt` (24h lookback on first sync).
- Connectors supply only an `AempTransport` (base URL + auth headers); paging, encoding, and error handling are shared. `staticAuth` covers API keys and pre-fetched OAuth bearer tokens; the Cat connector shows a full OAuth2 client-credentials flow.
- `aemp/normalize.ts` maps AEMP structures (`CumulativeOperatingHours`, `FuelRemaining`, `DEFRemaining`, `Distance`, `CumulativePayloadTotals`, `FaultCodes`, ...) to `NormalizedMetric` names with canonical units, so a Komatsu hour and a Volvo hour are the same column.

Because demo credentials set `baseUrl` to `mock://<provider>`, the identical client/normalizer/ingestion path serves demo and production — the transport is the only seam.

## Ingestion

`server/src/telematics/ingestion.ts`. A scheduler ticks every `INGEST_INTERVAL_SEC` (45s default, immediate first run so the demo map is warm at boot), walking all enabled `provider_credentials` rows and running `runCredentialSync` for each. Manual "Sync now" (`POST /api/credentials/:id/sync`) calls the same function. Per snapshot, inside one transaction:

1. **Identity upsert** — assets are keyed on `(tenant_id, provider, provider_asset_id)` (partial unique index `ux_assets_provider`). New machines self-register; existing ones get make/model/serial refreshed.
2. **History dedup** — location and metric rows are `INSERT OR IGNORE` against unique indexes (`(asset_id, ts, source)` and `(asset_id, metric, ts, source)`). Re-polling an OEM window is idempotent; the run stats count inserted vs. deduped.
3. **Latest state** — `asset_state` is a single row per asset, upserted with `ON CONFLICT ... COALESCE` so a partial report (say, fuel only) never nulls out fields another cycle filled. The map reads only this table.
4. **Fault lifecycle** — faults insert under `UNIQUE(asset_id, code, occurred_at)`; any open fault the OEM no longer reports is flipped `active=0` with `resolved_at`. Open → resolved is fully automatic.
5. **Geofence auto-assign** — the asset is attached to the nearest active jobsite within 2.5 km (haversine), unless `meta.jobsiteLocked` is set (a human pinned the assignment — e.g. trailers). Manual-tracking-mode assets additionally keep their hand-set position: telemetry still records metrics/faults but never moves the pin.
6. **Audit** — every sync writes an `ingestion_runs` row (status, timings, counters, error text), surfaced at `GET /api/ingestion/runs`.

## Credential security

`server/src/telematics/credentials.ts` is the vault:

- Credentials are encrypted at rest with **AES-256-GCM** (random 12-byte IV, auth tag, stored as one base64 blob in `provider_credentials.ciphertext`).
- One row per tenant/provider/label — tenants never share credentials.
- The key is `CREDENTIALS_KEY` (32 bytes hex). The demo falls back to a fixed dev key; the SaaS deployment sources it from KMS. Rotating the key means re-encrypting rows, nothing else.
- Plaintext never leaves the module except into a `ConnectorContext` at sync time. The list API (`GET /api/credentials`) explicitly selects around the ciphertext; no route returns secrets.

## Multi-tenancy

Every business table carries `tenant_id`, and `server/src/api/tenancy.ts` resolves a concrete tenant for every request (from `X-Tenant-Id` — id or slug — defaulting to the demo tenant) before any handler runs, so no query executes untenanted. Uniqueness constraints are tenant-scoped (`UNIQUE(tenant_id, code)` on jobsites, the provider-asset index, credential labels). The demo runs one tenant; SaaS is a tenant-resolution change (auth/subdomain), not a schema change. The schema is SQLite-dialect but written to port 1:1 to Postgres.

## The AI layer

`server/src/services/ai-engine.ts` is **deterministic heuristics over the telemetry tables** — not a model, deliberately explainable. Every number it produces can be traced to engine-hour deltas and plan rates:

- `production_auto` — today's production entry per active plan: hours = jobsite machines' engine-hour delta since start of day, qty = hours × planned rate.
- `timecards_auto` — draft timecards for operators whose assigned machine ran today (hours from the same delta, rounded to half hours, clamped 4–12).
- `projections_auto` — run-rate finish dates per plan; at-risk plans raise an insight.
- `idle_alerts_auto` / `fault_triage_auto` — utilization and active-fault insights with dedup.

Guardrails, enforced in schema and API:

- **Per-feature toggles** — `ai_settings` rows the field can flip via `PUT /api/ai/settings/:feature`; the engine skips disabled features.
- **Suggestions, not silent mutations** — insights land in `ai_insights` with a `suggested → accepted/dismissed` status flow.
- **Correction audit** — auto-generated rows carry `source='ai_auto'`; unique constraints (`UNIQUE(plan_id, date, source)`, `UNIQUE(employee_id, date, source)`) keep AI and manual rows separate. When a human edits an `ai_auto` row, `corrected=1` is set and the engine stops overwriting it. Reports show the source mix.

The scheduler runs every 5 minutes per tenant; `POST /api/ai/analyze` runs it on demand.

## Read-only OEM stance

OEM integrations are strictly read-only **by construction**: the `TelematicsConnector` interface has exactly two methods, `testConnection` and `sync`, both fetch-only. No remote start/stop, disable, or machine-control path exists anywhere in the codebase — there is nothing to misconfigure, and a compromised DirtWorks deployment cannot command a machine.

## Demo simulator

`server/src/telematics/mock/mock-aemp.ts` is an in-process ISO 15143-3 endpoint serving the same `/Fleet`, `/Locations`, `/FaultCodes` payload shapes a real OEM would. Demo credentials set `baseUrl: "mock://<provider>"`, which swaps the AEMP client's HTTP transport for the mock one — connectors, normalization, and ingestion are byte-for-byte the production path.

The simulation is **deterministic in wall-clock time** (seeded PRNGs per machine/day): machines work a 7am–5pm Mon–Sat day, loop paths around their jobsite, burn fuel on a sawtooth (refueling when low), accumulate engine/idle hours, and throw catalog fault codes on ~12% of machine-days. `DEMO_TIME_SCALE` compresses the sim clock (default 12) so movement is visible between polls, while every *reported* timestamp stays real wall time — consumers never see future dates, and every poll agrees on history (so dedup works exactly as it would against a real API).

## REST surface

All routes under `/api`, tenant from `X-Tenant-Id`. Full request/response contracts in [`API_CONTRACT.md`](API_CONTRACT.md).

| Area | Endpoints |
|---|---|
| Core | `GET /health` · `GET /tenants` |
| Assets | `GET/POST /assets` · `GET /assets/state` · `GET/PATCH /assets/:id` · `POST /assets/:id/position` (tap-to-place) · `GET /assets/:id/telemetry/latest` · `.../telemetry/history` · `.../locations` · `.../faults` · `GET /faults` |
| Connectors | `GET /connectors` · `GET/POST /credentials` · `POST /credentials/:id/enabled` · `.../test` · `.../sync` · `GET /ingestion/runs` |
| Jobsites | `GET/POST /jobsites` · `GET/PATCH /jobsites/:id` · `GET /jobsites/:id/plans` |
| Small tools | `GET /tools` · `POST /tools/:assetId/checkout` · `.../checkin` · `GET /tools/assignments` |
| Cameras | `GET/POST /cameras` |
| Connectivity | `GET /connectivity` |
| Truck fleet | `GET /fleet/trucks` · `GET/POST /fleet/hauls` · `GET /fleet/summary` |
| Workforce | `GET /employees` · `GET/POST /timecards` · `PATCH /timecards/:id` · `POST /timecards/:id/approve` |
| Safety | `GET/POST /safety/jsas` · `PATCH /safety/jsas/:id` · `GET/POST /safety/incidents` · `PATCH /safety/incidents/:id` · `GET /safety/summary` |
| AI | `GET /ai/settings` · `PUT /ai/settings/:feature` · `POST /ai/analyze` · `GET /ai/insights` · `POST /ai/insights/:id/accept` / `.../dismiss` · `GET /ai/projections` |
| Reports | `GET /reports` · `GET /reports/:id` · `POST /reports/generate` |
