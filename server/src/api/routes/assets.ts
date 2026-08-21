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
  const b = req.body as Record<string, unknown>;
  if (!b.name || !b.kind) {
    res.status(400).json({ error: 'name and kind are required' });
    return;
  }
  const result = run(
    `INSERT INTO assets (tenant_id, kind, name, make, model, serial_number, year, category,
       jobsite_id, source, tracking_mode, status, operator, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    t, String(b.kind), String(b.name),
    (b.make as string) ?? null, (b.model as string) ?? null, (b.serial_number as string) ?? null,
    b.year ? Number(b.year) : null, (b.category as string) ?? null,
    b.jobsite_id ? Number(b.jobsite_id) : null,
    (b.source as string) ?? 'manual',
    (b.tracking_mode as string) ?? 'manual',
    (b.operator as string) ?? null,
    b.meta ? JSON.stringify(b.meta) : null,
  );
  const id = Number(result.lastInsertRowid);
  // Manual assets dropped with a position get a state row immediately.
  if (typeof b.lat === 'number' && typeof b.lng === 'number') {
    run(
      `INSERT INTO asset_state (asset_id, tenant_id, ts, lat, lng, location_ts, source)
       VALUES (?, ?, ?, ?, ?, ?, 'manual')`,
      id, t, nowIso(), b.lat, b.lng, nowIso(),
    );
    run(
      `INSERT OR IGNORE INTO location_history (tenant_id, asset_id, ts, lat, lng, source)
       VALUES (?, ?, ?, ?, ?, 'manual')`,
      t, id, nowIso(), b.lat, b.lng,
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
  const existing = get<{ id: number }>(`SELECT id FROM assets WHERE tenant_id = ? AND id = ?`, t, id);
  if (!existing) { res.status(404).json({ error: 'asset not found' }); return; }
  const b = req.body as Record<string, unknown>;
  const fields: string[] = [];
  const params: (string | number | null)[] = [];
  const allow: Record<string, (v: unknown) => string | number | null> = {
    name: (v) => String(v),
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
  run(`UPDATE assets SET ${fields.join(', ')} WHERE id = ?`, ...params);
  res.json(get(`SELECT ${ASSET_COLS} FROM assets a WHERE a.id = ?`, id));
});

/** Manual position drop — the field correcting or placing an asset by hand. */
assetsRouter.post('/assets/:id/position', (req, res) => {
  const t = req.tenant.id;
  const id = Number(req.params.id);
  const { lat, lng } = req.body as { lat?: number; lng?: number };
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    res.status(400).json({ error: 'lat and lng (numbers) are required' });
    return;
  }
  const existing = get<{ id: number }>(`SELECT id FROM assets WHERE tenant_id = ? AND id = ?`, t, id);
  if (!existing) { res.status(404).json({ error: 'asset not found' }); return; }
  const ts = nowIso();
  run(
    `INSERT OR IGNORE INTO location_history (tenant_id, asset_id, ts, lat, lng, source)
     VALUES (?, ?, ?, ?, ?, 'manual')`,
    t, id, ts, lat, lng,
  );
  run(
    `INSERT INTO asset_state (asset_id, tenant_id, ts, lat, lng, location_ts, source)
     VALUES (?, ?, ?, ?, ?, ?, 'manual')
     ON CONFLICT(asset_id) DO UPDATE SET
       ts = excluded.ts, lat = excluded.lat, lng = excluded.lng,
       location_ts = excluded.location_ts, source = 'manual'`,
    id, t, ts, lat, lng, ts,
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
