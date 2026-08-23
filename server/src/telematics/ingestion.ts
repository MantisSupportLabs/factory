/**
 * Telemetry ingestion service.
 *
 * Every INGEST_INTERVAL_SEC it walks all enabled tenant credentials, runs the
 * matching connector, and lands the normalized result:
 *
 *   upsert asset identity → dedup-insert history rows (unique indexes +
 *   INSERT OR IGNORE) → update per-asset latest state → sync fault list →
 *   auto-assign jobsite by geofence → record an ingestion_runs audit row.
 *
 * Manual sync ("Sync now" in the UI) calls the same runCredentialSync.
 */

import { all, get, nowIso, run, transaction } from '../db/database.js';
import { getConnector, hasConnector } from './connector.js';
import { decryptCredentials, listEnabledCredentials, markSync, type StoredCredential } from './credentials.js';
import type { NormalizedAssetSnapshot } from './model.js';
import { config } from '../config.js';

export interface IngestStats {
  provider: string;
  assetsSeen: number;
  readingsInserted: number;
  readingsDeduped: number;
  faultsSeen: number;
  warnings: string[];
}

export async function runCredentialSync(
  cred: StoredCredential & { ciphertext: string },
): Promise<IngestStats> {
  const startedAt = nowIso();
  const runRow = run(
    `INSERT INTO ingestion_runs (tenant_id, credential_id, provider, started_at, status)
     VALUES (?, ?, ?, ?, 'running')`,
    cred.tenant_id, cred.id, cred.provider, startedAt,
  );
  const runId = Number(runRow.lastInsertRowid);

  try {
    if (!hasConnector(cred.provider)) {
      throw new Error(`no connector registered for provider '${cred.provider}'`);
    }
    const connector = getConnector(cred.provider);
    const result = await connector.sync({
      tenantId: cred.tenant_id,
      credentialId: cred.id,
      credentials: decryptCredentials(cred.ciphertext),
      lastSyncAt: cred.last_sync_at,
      log: (msg) => console.log(`[ingest] ${msg}`),
    });

    const stats: IngestStats = {
      provider: cred.provider,
      assetsSeen: 0,
      readingsInserted: 0,
      readingsDeduped: 0,
      faultsSeen: 0,
      warnings: result.warnings,
    };

    transaction(() => {
      for (const snap of result.snapshots) {
        ingestSnapshot(cred, snap, stats);
      }
    });

    run(
      `UPDATE ingestion_runs SET finished_at = ?, status = 'ok', assets_seen = ?,
        readings_inserted = ?, readings_deduped = ?, faults_seen = ? WHERE id = ?`,
      nowIso(), stats.assetsSeen, stats.readingsInserted, stats.readingsDeduped, stats.faultsSeen, runId,
    );
    markSync(cred.id, 'ok');
    return stats;
  } catch (err) {
    const message = (err as Error).message;
    run(
      `UPDATE ingestion_runs SET finished_at = ?, status = 'error', error = ? WHERE id = ?`,
      nowIso(), message, runId,
    );
    markSync(cred.id, `error: ${message}`);
    throw err;
  }
}

function ingestSnapshot(
  cred: StoredCredential,
  snap: NormalizedAssetSnapshot,
  stats: IngestStats,
): void {
  stats.assetsSeen++;
  const t = cred.tenant_id;
  const id = snap.identity;

  // 1. Upsert asset identity keyed on (tenant, provider, providerAssetId).
  let asset = get<{ id: number; jobsite_id: number | null; meta: string | null; tracking_mode: string }>(
    `SELECT id, jobsite_id, meta, tracking_mode FROM assets
     WHERE tenant_id = ? AND provider = ? AND provider_asset_id = ?`,
    t, cred.provider, id.providerAssetId,
  );
  if (!asset) {
    const res = run(
      `INSERT INTO assets (tenant_id, kind, name, make, model, serial_number, year, category,
         source, provider, provider_asset_id, credential_id, tracking_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'oem_telematics', ?, ?, ?, 'auto')`,
      t, snap.kind ?? 'machine', id.name ?? id.providerAssetId, id.make, id.model,
      id.serialNumber, id.year ?? null, id.category ?? null,
      cred.provider, id.providerAssetId, cred.id,
    );
    asset = { id: Number(res.lastInsertRowid), jobsite_id: null, meta: null, tracking_mode: 'auto' };
  } else {
    run(
      `UPDATE assets SET make = ?, model = ?, serial_number = ?, category = COALESCE(?, category),
         updated_at = ? WHERE id = ?`,
      id.make, id.model, id.serialNumber, id.category ?? null, nowIso(), asset.id,
    );
  }
  const assetId = asset.id;

  // Manual-mode assets keep their hand-set position; telemetry still records
  // metrics/faults but does not move the pin.
  const allowAutoLocation = asset.tracking_mode !== 'manual';

  // 2. Location history (dedup on (asset, ts, source)).
  const locations = [...(snap.locationHistory ?? [])];
  if (snap.location) locations.push(snap.location);
  for (const p of locations) {
    const res = run(
      `INSERT OR IGNORE INTO location_history
         (tenant_id, asset_id, ts, lat, lng, altitude_m, heading_deg, speed_kph, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'oem_telematics')`,
      t, assetId, p.ts, p.lat, p.lng, p.altitudeM ?? null, p.headingDeg ?? null, p.speedKph ?? null,
    );
    if (Number(res.changes) > 0) stats.readingsInserted++;
    else stats.readingsDeduped++;
  }

  // 3. Metric history (dedup on (asset, metric, ts, source)).
  for (const m of snap.metrics) {
    const res = run(
      `INSERT OR IGNORE INTO telemetry_readings (tenant_id, asset_id, metric, ts, value, unit, source)
       VALUES (?, ?, ?, ?, ?, ?, 'oem_telematics')`,
      t, assetId, m.metric, m.ts, m.value, m.unit,
    );
    if (Number(res.changes) > 0) stats.readingsInserted++;
    else stats.readingsDeduped++;
  }

  // 4. Faults: insert new, keep (asset, code, occurred_at) unique, resolve
  //    ones the OEM no longer reports as active.
  stats.faultsSeen += snap.faults.length;
  for (const f of snap.faults) {
    run(
      `INSERT OR IGNORE INTO fault_codes
         (tenant_id, asset_id, code, spn, fmi, severity, description, occurred_at, active, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'oem_telematics')`,
      t, assetId, f.code, f.spn ?? null, f.fmi ?? null, f.severity, f.description, f.occurredAt,
    );
  }
  const activeKeys = new Set(snap.faults.map((f) => `${f.code}@${f.occurredAt}`));
  const openFaults = all<{ id: number; code: string; occurred_at: string }>(
    `SELECT id, code, occurred_at FROM fault_codes WHERE asset_id = ? AND active = 1`,
    assetId,
  );
  for (const f of openFaults) {
    if (!activeKeys.has(`${f.code}@${f.occurred_at}`)) {
      run(`UPDATE fault_codes SET active = 0, resolved_at = ? WHERE id = ?`, nowIso(), f.id);
    }
  }

  // 5. Latest state row (single-row upsert per asset).
  const metric = (name: string) => snap.metrics.filter((m) => m.metric === name).at(-1);
  const loc = allowAutoLocation ? (snap.location ?? locations.at(-1)) : undefined;
  const activeCount = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM fault_codes WHERE asset_id = ? AND active = 1`, assetId,
  )?.n ?? 0;

  const engineStatus = snap.engineStatus?.status ?? null;
  run(
    `INSERT INTO asset_state (asset_id, tenant_id, ts, lat, lng, altitude_m, heading_deg, speed_kph,
       location_ts, engine_status, engine_status_ts, engine_hours, idle_hours, fuel_percent,
       fuel_used_l, def_percent, odometer_km, utilization_pct, payload_tons, active_faults, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'oem_telematics')
     ON CONFLICT(asset_id) DO UPDATE SET
       ts = COALESCE(excluded.ts, asset_state.ts),
       lat = COALESCE(excluded.lat, asset_state.lat),
       lng = COALESCE(excluded.lng, asset_state.lng),
       altitude_m = COALESCE(excluded.altitude_m, asset_state.altitude_m),
       heading_deg = COALESCE(excluded.heading_deg, asset_state.heading_deg),
       speed_kph = COALESCE(excluded.speed_kph, asset_state.speed_kph),
       location_ts = COALESCE(excluded.location_ts, asset_state.location_ts),
       engine_status = COALESCE(excluded.engine_status, asset_state.engine_status),
       engine_status_ts = COALESCE(excluded.engine_status_ts, asset_state.engine_status_ts),
       engine_hours = COALESCE(excluded.engine_hours, asset_state.engine_hours),
       idle_hours = COALESCE(excluded.idle_hours, asset_state.idle_hours),
       fuel_percent = COALESCE(excluded.fuel_percent, asset_state.fuel_percent),
       fuel_used_l = COALESCE(excluded.fuel_used_l, asset_state.fuel_used_l),
       def_percent = COALESCE(excluded.def_percent, asset_state.def_percent),
       odometer_km = COALESCE(excluded.odometer_km, asset_state.odometer_km),
       utilization_pct = COALESCE(excluded.utilization_pct, asset_state.utilization_pct),
       payload_tons = COALESCE(excluded.payload_tons, asset_state.payload_tons),
       active_faults = excluded.active_faults,
       source = excluded.source`,
    assetId, t, snap.lastTelemetryAt ?? nowIso(),
    loc?.lat ?? null, loc?.lng ?? null, loc?.altitudeM ?? null, loc?.headingDeg ?? null, loc?.speedKph ?? null,
    loc?.ts ?? null, engineStatus, snap.engineStatus?.ts ?? null,
    metric('engine_hours')?.value ?? null, metric('idle_hours')?.value ?? null,
    metric('fuel_percent')?.value ?? null, metric('fuel_used_l')?.value ?? null,
    metric('def_percent')?.value ?? null, metric('odometer_km')?.value ?? null,
    metric('utilization_pct')?.value ?? null, metric('payload_tons')?.value ?? null,
    activeCount,
  );

  // 6. Geofence auto-assignment: put the asset on the jobsite it's sitting
  //    on, unless a human locked the assignment.
  const meta = asset.meta ? safeJson(asset.meta) : {};
  if (loc && !meta.jobsiteLocked) {
    const site = nearestJobsite(t, loc.lat, loc.lng);
    if (site && site.id !== asset.jobsite_id) {
      run(`UPDATE assets SET jobsite_id = ?, updated_at = ? WHERE id = ?`, site.id, nowIso(), assetId);
    }
  }
}

function nearestJobsite(tenantId: number, lat: number, lng: number): { id: number } | undefined {
  const sites = all<{ id: number; lat: number; lng: number }>(
    `SELECT id, lat, lng FROM jobsites WHERE tenant_id = ? AND status != 'complete'`, tenantId,
  );
  const RADIUS_KM = 2.5;
  let best: { id: number; d: number } | undefined;
  for (const s of sites) {
    const d = haversineKm(lat, lng, s.lat, s.lng);
    if (d <= RADIUS_KM && (!best || d < best.d)) best = { id: s.id, d };
  }
  return best ? { id: best.id } : undefined;
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                           */
/* ------------------------------------------------------------------ */

let timer: NodeJS.Timeout | null = null;
let running = false;

export async function ingestAllOnce(): Promise<IngestStats[]> {
  if (running) return [];
  running = true;
  const out: IngestStats[] = [];
  try {
    for (const cred of listEnabledCredentials()) {
      try {
        out.push(await runCredentialSync(cred));
      } catch (err) {
        console.error(`[ingest] ${cred.provider}#${cred.id} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    running = false;
  }
  return out;
}

export function startIngestionService(): void {
  if (timer) return;
  const tick = () => {
    ingestAllOnce().catch((err) => console.error('[ingest] cycle failed', err));
  };
  tick(); // immediate first sync so the demo map is warm at boot
  timer = setInterval(tick, config.ingestIntervalSec * 1000);
  timer.unref?.();
  console.log(`[ingest] service started — every ${config.ingestIntervalSec}s`);
}

export function stopIngestionService(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
