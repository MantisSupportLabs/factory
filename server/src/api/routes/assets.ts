/**
 * Asset + telemetry REST endpoints (the core integration-layer API).
 *
 *   GET    /api/assets                     list (filters: kind, jobsite_id, provider, q)
 *   POST   /api/assets                     create a manually tracked asset
 *   GET    /api/assets/state               fleet-wide latest state (map feed)
 *   GET    /api/assets/:id                 asset detail (+ state, jobsite)
 *   PATCH  /api/assets/:id                 edit (name, jobsite, tracking_mode, status, operator, meta)
 *   POST   /api/assets/:id/position        manual position drop (field correction)
 *   GET    /api/assets/:id/telemetry/latest
 *   GET    /api/assets/:id/telemetry/history?metric=engine_hours&from=&to=&limit=
 *   GET    /api/assets/:id/locations?from=&to=&limit=
 *   GET    /api/assets/:id/faults?active=1
 *   GET    /api/faults?active=1            tenant-wide fault board
 */

import { Router } from 'express';
import { all, get, nowIso, run } from '../../db/database.js';

export const assetsRouter = Router();

const ASSET_COLS = `a.id, a.kind, a.name, a.make, a.model, a.serial_number, a.year, a.category,
  a.jobsite_id, a.source, a.provider, a.provider_asset_id, a.tracking_mode, a.status,
  a.operator, a.icon, a.meta, a.created_at, a.updated_at`;

const ASSET_KINDS = ['machine', 'truck', 'small_tool', 'attachment', 'camera', 'network', 'trailer'];
const ASSET_STATUSES = ['active', 'down', 'maintenance', 'retired'];
const TRACKING_MODES = ['auto', 'manual'];
const ASSET_SOURCES = ['oem_telematics', 'can_j1939', 'ble_tracker', 'manual'];

function validId(value: unknown): boolean {
  return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
    && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function validPosition(lat: unknown, lng: unknown): boolean {
  return typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) <= 90
    && typeof lng === 'number' && Number.isFinite(lng) && Math.abs(lng) <= 180;
}

function isMeta(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMeta(raw: string | null): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    return isMeta(value) ? value : {};
  } catch {
    return {};
  }
}

assetsRouter.get('/assets', (req, res) => {
  const t = req.tenant.id;
  const clauses: string[] = ['a.tenant_id = ?'];
  const params: (string | number)[] = [t];
  const { kind, jobsite_id, provider, q, status } = req.query as Record<string, string | undefined>;
  if (kind) { clauses.push('a.kind = ?'); params.push(kind); }
  if (jobsite_id) { clauses.push('a.jobsite_id = ?'); params.push(Number(jobsite_id)); }
  if (provider) { clauses.push('a.provider = ?'); params.push(provider); }
  if (status) { clauses.push('a.status = ?'); params.push(status); }
  if (q) {
    clauses.push('(a.name LIKE ? OR a.model LIKE ? OR a.serial_number LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const rows = all(
    `SELECT ${ASSET_COLS},
       s.ts AS state_ts, s.lat, s.lng, s.engine_status, s.engine_hours, s.idle_hours,
       s.fuel_percent, s.def_percent, s.utilization_pct, s.active_faults,
       j.name AS jobsite_name
     FROM assets a
     LEFT JOIN asset_state s ON s.asset_id = a.id
     LEFT JOIN jobsites j ON j.id = a.jobsite_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY a.kind, a.name`,
    ...params,
  );
  res.json(rows);
});

assetsRouter.post('/assets', (req, res) => {
  const t = req.tenant.id;
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.name !== 'string' || !b.name.trim() || typeof b.kind !== 'string' || !ASSET_KINDS.includes(b.kind)) {
    res.status(400).json({ error: `name is required and kind must be one of: ${ASSET_KINDS.join(', ')}` });
    return;
  }
  const trackingMode = b.tracking_mode ?? 'manual';
  const status = b.status ?? 'active';
  const source = b.source ?? 'manual';
  if (typeof trackingMode !== 'string' || !TRACKING_MODES.includes(trackingMode)
    || typeof status !== 'string' || !ASSET_STATUSES.includes(status)
    || typeof source !== 'string' || !ASSET_SOURCES.includes(source)) {
    res.status(400).json({ error: 'invalid tracking_mode, status or source' });
    return;
  }
  if (b.jobsite_id != null && !validId(b.jobsite_id)) {
    res.status(400).json({ error: 'jobsite_id must be a positive integer or null' });
    return;
  }
  const jobsiteId = b.jobsite_id != null ? Number(b.jobsite_id) : null;
  if (jobsiteId !== null && !get(`SELECT id FROM jobsites WHERE tenant_id = ? AND id = ?`, t, jobsiteId)) {
    res.status(404).json({ error: 'jobsite not found' });
    return;
  }
  if ((b.lat != null || b.lng != null) && !validPosition(b.lat, b.lng)) {
    res.status(400).json({ error: 'lat and lng must be finite numbers within geographic bounds' });
    return;
  }
  if (b.meta != null && !isMeta(b.meta)) {
    res.status(400).json({ error: 'meta must be an object or null' });
    return;
  }
  if (['make', 'model', 'serial_number', 'category', 'operator'].some((field) => b[field] != null && typeof b[field] !== 'string')) {
    res.status(400).json({ error: 'make, model, serial_number, category and operator must be strings or null' });
    return;
  }
  if (b.year != null && (!validId(b.year) || Number(b.year) > 9999)) {
    res.status(400).json({ error: 'year must be a positive integer no greater than 9999 or null' });
    return;
  }
  const meta = { ...(isMeta(b.meta) ? b.meta : {}) };
  // A dispatcher's assignment must survive later telemetry/geofence updates.
  if ('jobsite_id' in b) meta.jobsiteLocked = true;
  const result = run(
    `INSERT INTO assets (tenant_id, kind, name, make, model, serial_number, year, category,
       jobsite_id, source, tracking_mode, status, operator, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    t, b.kind, b.name.trim(),
    (b.make as string) ?? null, (b.model as string) ?? null, (b.serial_number as string) ?? null,
    b.year != null ? Number(b.year) : null, (b.category as string) ?? null,
    jobsiteId, source, trackingMode, status,
    (b.operator as string) ?? null,
    Object.keys(meta).length > 0 ? JSON.stringify(meta) : null,
  );
  const id = Number(result.lastInsertRowid);
  // Manual assets dropped with a position get a state row immediately.
  if (validPosition(b.lat, b.lng)) {
    const lat = b.lat as number;
    const lng = b.lng as number;
    run(
      `INSERT INTO asset_state (asset_id, tenant_id, ts, lat, lng, location_ts, source)
       VALUES (?, ?, ?, ?, ?, ?, 'manual')`,
      id, t, nowIso(), lat, lng, nowIso(),
    );
    run(
      `INSERT OR IGNORE INTO location_history (tenant_id, asset_id, ts, lat, lng, source)
       VALUES (?, ?, ?, ?, ?, 'manual')`,
      t, id, nowIso(), lat, lng,
    );
  }
  res.status(201).json(get(`SELECT ${ASSET_COLS} FROM assets a WHERE a.id = ?`, id));
});

/** Fleet-wide latest state — one row per asset, drives the live map. */
assetsRouter.get('/assets/state', (req, res) => {
  const rows = all(
    `SELECT a.id, a.kind, a.name, a.make, a.model, a.category, a.jobsite_id, a.provider,
       a.tracking_mode, a.status, a.operator, a.meta,
       s.ts, s.lat, s.lng, s.heading_deg, s.speed_kph, s.location_ts, s.engine_status,
       s.engine_hours, s.idle_hours, s.fuel_percent, s.fuel_used_l, s.def_percent,
       s.odometer_km, s.utilization_pct, s.payload_tons, s.battery_pct, s.active_faults, s.source
     FROM assets a
     LEFT JOIN asset_state s ON s.asset_id = a.id
     WHERE a.tenant_id = ? AND a.status != 'retired'
     ORDER BY a.name`,
    req.tenant.id,
  );
  res.json(rows);
});

assetsRouter.get('/assets/:id', (req, res) => {
  const row = get(
    `SELECT ${ASSET_COLS}, j.name AS jobsite_name
     FROM assets a LEFT JOIN jobsites j ON j.id = a.jobsite_id
     WHERE a.tenant_id = ? AND a.id = ?`,
    req.tenant.id, Number(req.params.id),
  );
  if (!row) { res.status(404).json({ error: 'asset not found' }); return; }
  const state = get(`SELECT * FROM asset_state WHERE asset_id = ?`, Number(req.params.id));
  res.json({ ...row, state: state ?? null });
});

assetsRouter.patch('/assets/:id', (req, res) => {
  const t = req.tenant.id;
  const id = Number(req.params.id);
  const existing = get<{ id: number; meta: string | null }>(`SELECT id, meta FROM assets WHERE tenant_id = ? AND id = ?`, t, id);
  if (!existing) { res.status(404).json({ error: 'asset not found' }); return; }
  const b = (req.body ?? {}) as Record<string, unknown>;
  if ('name' in b && (typeof b.name !== 'string' || !b.name.trim())) {
    res.status(400).json({ error: 'name must be a nonempty string' });
    return;
  }
  for (const [field, options] of [['tracking_mode', TRACKING_MODES], ['status', ASSET_STATUSES]] as const) {
    if (field in b && (typeof b[field] !== 'string' || !options.includes(b[field] as string))) {
      res.status(400).json({ error: `${field} must be one of: ${options.join(', ')}` });
      return;
    }
  }
  if ('jobsite_id' in b && b.jobsite_id !== null) {
    if (!validId(b.jobsite_id)) {
      res.status(400).json({ error: 'jobsite_id must be a positive integer or null' });
      return;
    }
    if (!get(`SELECT id FROM jobsites WHERE tenant_id = ? AND id = ?`, t, Number(b.jobsite_id))) {
      res.status(404).json({ error: 'jobsite not found' });
      return;
    }
  }
  if ('meta' in b && b.meta !== null && !isMeta(b.meta)) {
    res.status(400).json({ error: 'meta must be an object or null' });
    return;
  }
  if (['operator', 'category'].some((field) => field in b && b[field] !== null && typeof b[field] !== 'string')) {
    res.status(400).json({ error: 'operator and category must be strings or null' });
    return;
  }
  if ('meta' in b || 'jobsite_id' in b) {
    const currentMeta = parseMeta(existing.meta);
    const meta = b.meta === null
      ? (currentMeta.jobsiteLocked ? { jobsiteLocked: true } : {})
      : { ...currentMeta, ...(isMeta(b.meta) ? b.meta : {}) };
    // Merge metadata so unrelated kit/tracker settings remain intact.
    if ('jobsite_id' in b) meta.jobsiteLocked = true;
    b.meta = Object.keys(meta).length > 0 ? meta : null;
  }
  const fields: string[] = [];
  const params: (string | number | null)[] = [];
  const allow: Record<string, (v: unknown) => string | number | null> = {
    name: (v) => String(v).trim(),
    jobsite_id: (v) => (v === null ? null : Number(v)),
    tracking_mode: (v) => String(v),
    status: (v) => String(v),
    operator: (v) => (v === null ? null : String(v)),
    category: (v) => (v === null ? null : String(v)),
    meta: (v) => (v === null ? null : JSON.stringify(v)),
  };
  for (const [key, fn] of Object.entries(allow)) {
    if (key in b) { fields.push(`${key} = ?`); params.push(fn(b[key])); }
  }
  if (fields.length === 0) { res.status(400).json({ error: 'no editable fields supplied' }); return; }
  fields.push(`updated_at = ?`);
  params.push(nowIso(), id);
  params.push(t);
  run(`UPDATE assets SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`, ...params);
  res.json(get(`SELECT ${ASSET_COLS} FROM assets a WHERE a.id = ?`, id));
});

/** Manual position drop — the field correcting or placing an asset by hand. */
assetsRouter.post('/assets/:id/position', (req, res) => {
  const t = req.tenant.id;
  const id = Number(req.params.id);
  const { lat, lng } = (req.body ?? {}) as { lat?: number; lng?: number };
  if (!validPosition(lat, lng)) {
    res.status(400).json({ error: 'lat and lng must be finite numbers within geographic bounds' });
    return;
  }
  const existing = get<{ id: number }>(`SELECT id FROM assets WHERE tenant_id = ? AND id = ?`, t, id);
  if (!existing) { res.status(404).json({ error: 'asset not found' }); return; }
  const ts = nowIso();
  run(
    `INSERT OR IGNORE INTO location_history (tenant_id, asset_id, ts, lat, lng, source)
     VALUES (?, ?, ?, ?, ?, 'manual')`,
    t, id, ts, lat!, lng!,
  );
  run(
    `INSERT INTO asset_state (asset_id, tenant_id, ts, lat, lng, location_ts, source)
     VALUES (?, ?, ?, ?, ?, ?, 'manual')
     ON CONFLICT(asset_id) DO UPDATE SET
       ts = excluded.ts, lat = excluded.lat, lng = excluded.lng,
       location_ts = excluded.location_ts, source = 'manual'`,
    id, t, ts, lat!, lng!, ts,
  );
  res.json({ ok: true, ts });
});

assetsRouter.get('/assets/:id/telemetry/latest', (req, res) => {
  const state = get(
    `SELECT s.* FROM asset_state s JOIN assets a ON a.id = s.asset_id
     WHERE a.tenant_id = ? AND s.asset_id = ?`,
    req.tenant.id, Number(req.params.id),
  );
  if (!state) { res.status(404).json({ error: 'no telemetry for asset' }); return; }
  res.json(state);
});

assetsRouter.get('/assets/:id/telemetry/history', (req, res) => {
  const { metric, from, to, limit } = req.query as Record<string, string | undefined>;
  const clauses = ['r.tenant_id = ?', 'r.asset_id = ?'];
  const params: (string | number)[] = [req.tenant.id, Number(req.params.id)];
  if (metric) { clauses.push('r.metric = ?'); params.push(metric); }
  if (from) { clauses.push('r.ts >= ?'); params.push(from); }
  if (to) { clauses.push('r.ts <= ?'); params.push(to); }
  const n = Math.min(Number(limit ?? 500), 5000);
  const rows = all(
    `SELECT r.metric, r.ts, r.value, r.unit, r.source
     FROM telemetry_readings r WHERE ${clauses.join(' AND ')}
     ORDER BY r.ts DESC LIMIT ${n}`,
    ...params,
  );
  res.json(rows.reverse());
});

assetsRouter.get('/assets/:id/locations', (req, res) => {
  const { from, to, limit } = req.query as Record<string, string | undefined>;
  const clauses = ['tenant_id = ?', 'asset_id = ?'];
  const params: (string | number)[] = [req.tenant.id, Number(req.params.id)];
  if (from) { clauses.push('ts >= ?'); params.push(from); }
  if (to) { clauses.push('ts <= ?'); params.push(to); }
  const n = Math.min(Number(limit ?? 500), 5000);
  const rows = all(
    `SELECT ts, lat, lng, altitude_m, heading_deg, speed_kph, source
     FROM location_history WHERE ${clauses.join(' AND ')}
     ORDER BY ts DESC LIMIT ${n}`,
    ...params,
  );
  res.json(rows.reverse());
});

assetsRouter.get('/assets/:id/faults', (req, res) => {
  const activeOnly = req.query.active === '1';
  const rows = all(
    `SELECT id, code, spn, fmi, severity, description, occurred_at, active, resolved_at, source
     FROM fault_codes WHERE tenant_id = ? AND asset_id = ? ${activeOnly ? 'AND active = 1' : ''}
     ORDER BY occurred_at DESC LIMIT 200`,
    req.tenant.id, Number(req.params.id),
  );
  res.json(rows);
});

/** Tenant-wide fault board. */
assetsRouter.get('/faults', (req, res) => {
  const activeOnly = req.query.active !== '0';
  const rows = all(
    `SELECT f.id, f.asset_id, a.name AS asset_name, a.make, a.model, f.code, f.spn, f.fmi,
       f.severity, f.description, f.occurred_at, f.active, f.resolved_at
     FROM fault_codes f JOIN assets a ON a.id = f.asset_id
     WHERE f.tenant_id = ? ${activeOnly ? 'AND f.active = 1' : ''}
     ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       f.occurred_at DESC
     LIMIT 500`,
    req.tenant.id,
  );
  res.json(rows);
});
