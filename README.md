# DirtWorks

Asset-deployment and fleet-telematics platform for heavy-civil contractors — dirt work, roads, utilities, site development. One map answers the questions a super asks all day: where is every machine, is it running, what's it burning, what broke, who's on the clock, and are we on schedule.

Built iPad-first and map-centric: top menu bar, left module sidebar, the live map in the center, and a right-hand inspector for whatever asset or jobsite is selected. Content-heavy modules (reports, timecards, safety, AI insights, connectors) open in a wide drawer over the map. Touch targets are sized for gloves.

## Features

| Area | What you get |
|---|---|
| **Jobsites** | Sites with geofence boundaries, status, superintendent, production plans vs. actuals, per-site rollups (machines, faults, tools out, timecards today) |
| **Equipment telematics** | OEM feeds via **ISO 15143-3 (AEMP 2.0)**: Cat VisionLink, John Deere JDLink, Komatsu KOMTRAX, Volvo CareTrack, Hitachi ConSite, DEVELON. Live position, engine status, hours, fuel/DEF, utilization, fault codes. **Read-only by design** — DirtWorks never sends commands to a machine |
| **Manual tracking** | Anything without telematics gets a pin: tap-to-place on the map, position locked against telemetry overwrites |
| **Small tools** | Checkout/check-in against employees and jobsites, due-back dates, overdue flags, condition notes, full assignment history |
| **Cameras** | Ubiquiti / UniFi Protect site cameras on the map with live status (online, recording, last motion) |
| **Connectivity** | Starlink-to-job-trailer monitoring per site: kit status, throughput, latency, obstruction, plus UniFi gateway health |
| **Truck fleet** | On-highway dumps and support trucks, haul tickets (loads/tons/material), daily and per-material summaries |
| **AI automation** | Production entries, quantity projections, and draft timecards generated from telemetry — every feature has an **off switch**, and every auto row can be corrected by hand (with an audit trail) |
| **Reports** | Daily, production, utilization, safety, and timecard reports generated on demand and stored |
| **Safety** | JSAs (task, hazards/controls, crew, sign-off) and incident log with days-since-recordable |

## Quickstart

```bash
npm install
npm run build
npm start        # → http://localhost:4000
```

That's it. On first boot the server creates the SQLite database, seeds the demo tenant, and starts the simulated OEM feeds — the map is live with a working fleet within one ingest cycle.

Dev mode (hot reload):

```bash
npm run dev      # server on :4000, Vite on http://localhost:5173 proxying /api → :4000
```

## Demo notes

- The seeded tenant is **Summit DirtWorks & Paving**, a North Texas dirt/paving contractor with three active jobsites, crew, trucks, tools, cameras, Starlink kits, plans, haul tickets, timecards, JSAs, and incidents.
- Six mock **ISO 15143-3** feeds (one per OEM) simulate the iron fleet. Machines work a 7am–5pm day on a compressed clock: they move, burn fuel, accumulate hours, park at night, and occasionally throw fault codes. `DEMO_TIME_SCALE` controls the compression (default 12 — a full work day plays out in about two real hours).
- The mock feeds go through the **same** connector → normalization → ingestion pipeline as real OEM APIs; only the credential's `baseUrl` (`mock://<provider>`) differs. The seed never writes fake telemetry rows directly.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | HTTP port for API + web app |
| `DB_PATH` | `server/data/dirtworks.db` | SQLite database file |
| `CREDENTIALS_KEY` | fixed dev key | 32 bytes of hex for AES-256-GCM credential encryption. **Set this in any real deployment** |
| `INGEST_INTERVAL_SEC` | `45` | OEM feed poll interval |
| `DEMO_TIME_SCALE` | `12` | Simulated fleet clock speed (1 = real time) |
| `WEB_DIST` | `web/dist` | Built web app served in single-process mode |
| `VITE_MAPBOX_TOKEN` | – | Mapbox public token for satellite-streets/dark basemaps (put it in `web/.env.local`, see `web/.env.example`); without it the map falls back to Esri/OSM rasters. Also settable at runtime via `localStorage['dirtworks.mapboxToken']` |

## Multi-tenancy

The schema is tenant-scoped from day one: every business table carries `tenant_id`, OEM credentials are stored per tenant (encrypted), and no query runs untenanted. Today the API resolves the tenant from the `X-Tenant-Id` header (id or slug), falling back to the demo tenant — the SaaS deployment swaps in subdomain/auth-based resolution with no schema changes.

## Demo vs. production

Honest accounting of what's demo-grade and what the production swap looks like:

| Concern | Demo today | Production |
|---|---|---|
| Database | SQLite (WAL) | Postgres — schema written to port 1:1 |
| Credential key | Fixed dev key fallback | `CREDENTIALS_KEY` from KMS |
| Telematics | Mock `mock://` feeds | Real OEM credentials in the same connectors |
| Map tiles | MapLibre GL with public Esri imagery / OSM rasters | Drop in a Mapbox (or other) token + style |
| Tenancy | `X-Tenant-Id` header, seeded tenant | Auth/subdomain-based tenant resolution |

## Roadmap

- **Aftermarket CAN/J1939 trackers** for trucks and older iron — new source (`can_j1939`) feeding the same normalized asset tables; haul cycles derived from payload/location instead of paper tickets.
- **BLE tool tags** — small tools flip from manual pins to `ble_tracker` source, same asset rows.
- **Offline-first iPad sync** — field crews keep working through dead zones; Starlink trailer backhaul syncs when it can.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — pipeline, normalized model, connector abstraction, security, REST surface.
- [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) — per-route contract for the feature modules.
