/**
 * Truck fleet endpoints. Trucks are assets with kind='truck'; haul production
 * lives in haul_cycles (manual tickets today, CAN/J1939 feeds later).
 *
 *   GET    /api/fleet/trucks    trucks + latest state + today's haul rollup
 *   GET    /api/fleet/hauls?from=&to=&asset_id=&jobsite_id=
 *   POST   /api/fleet/hauls     record a manual haul ticket
 *   GET    /api/fleet/summary?days=7
 */

import { Router } from 'express';
import { all, get, nowIso, run, type Row } from '../../db/database.js';

export const fleetRouter = Router();

fleetRouter.get('/fleet/trucks', (req, res) => {
  interface TruckRow extends Row {
    today_loads: number;
    today_tons: number;
  }
  const today = nowIso().slice(0, 10);
  const rows = all<TruckRow>(
    `SELECT a.id, a.kind, a.name, a.make, a.model, a.category, a.jobsite_id, a.provider,
       a.tracking_mode, a.status, a.operator, a.meta,
       s.ts, s.lat, s.lng, s.heading_deg, s.speed_kph, s.location_ts, s.engine_status,
       s.engine_hours, s.idle_hours, s.fuel_percent, s.fuel_used_l, s.def_percent,
       s.odometer_km, s.utilization_pct, s.payload_tons, s.battery_pct, s.active_faults, s.source,
       COALESCE(h.loads, 0) AS today_loads, COALESCE(h.tons, 0) AS today_tons
     FROM assets a
     LEFT JOIN asset_state s ON s.asset_id = a.id
     LEFT JOIN (
       SELECT asset_id, SUM(loads) AS loads, COALESCE(SUM(tons), 0) AS tons
       FROM haul_cycles WHERE tenant_id = ? AND date = ?
       GROUP BY asset_id
     ) h ON h.asset_id = a.id
     WHERE a.tenant_id = ? AND a.kind = 'truck' AND a.status != 'retired'
     ORDER BY a.name`,
    req.tenant.id, today, req.tenant.id,
  );
  res.json(rows.map(({ today_loads, today_tons, ...truck }) => ({
    ...truck,
    today: { loads: today_loads, tons: today_tons },
  })));
});

fleetRouter.get('/fleet/hauls', (req, res) => {
  const { from, to, asset_id, jobsite_id } = req.query as Record<string, string | undefined>;
  const clauses = ['h.tenant_id = ?'];
  const params: (string | number)[] = [req.tenant.id];
  if (from) { clauses.push('h.date >= ?'); params.push(from); }
  if (to) { clauses.push('h.date <= ?'); params.push(to); }
  if (asset_id) { clauses.push('h.asset_id = ?'); params.push(Number(asset_id)); }
  if (jobsite_id) { clauses.push('h.jobsite_id = ?'); params.push(Number(jobsite_id)); }
  const rows = all(
    `SELECT h.*, a.name AS asset_name, j.name AS jobsite_name
     FROM haul_cycles h
     JOIN assets a ON a.id = h.asset_id
     LEFT JOIN jobsites j ON j.id = h.jobsite_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY h.date DESC, h.id DESC
     LIMIT 200`,
    ...params,
  );
  res.json(rows);
});

fleetRouter.post('/fleet/hauls', (req, res) => {
  const t = req.tenant.id;
  const b = req.body as Record<string, unknown>;
  if (!b.asset_id || !b.date || !b.material || b.loads == null) {
    res.status(400).json({ error: 'asset_id, date, material and loads are required' });
    return;
  }
  const asset = get<{ id: number }>(
    `SELECT id FROM assets WHERE tenant_id = ? AND id = ?`, t, Number(b.asset_id),
  );
  if (!asset) { res.status(404).json({ error: 'asset not found' }); return; }
  const result = run(
    `INSERT INTO haul_cycles (tenant_id, asset_id, jobsite_id, date, material, loads,
       tons, cubic_yards, source, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
    t, Number(b.asset_id),
    b.jobsite_id ? Number(b.jobsite_id) : null,
    String(b.date), String(b.material), Number(b.loads),
    b.tons == null ? null : Number(b.tons),
    b.cubic_yards == null ? null : Number(b.cubic_yards),
    (b.notes as string) ?? null,
  );
  res.status(201).json(get(`SELECT * FROM haul_cycles WHERE id = ?`, Number(result.lastInsertRowid)));
});

fleetRouter.get('/fleet/summary', (req, res) => {
  const t = req.tenant.id;
  const days = Math.min(Math.max(Number(req.query.days ?? 7) || 7, 1), 365);
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const daily = all(
    `SELECT date, SUM(loads) AS loads, COALESCE(SUM(tons), 0) AS tons
     FROM haul_cycles WHERE tenant_id = ? AND date >= ?
     GROUP BY date ORDER BY date`,
    t, since,
  );
  const materials = all(
    `SELECT material, SUM(loads) AS loads, COALESCE(SUM(tons), 0) AS tons
     FROM haul_cycles WHERE tenant_id = ? AND date >= ?
     GROUP BY material ORDER BY tons DESC`,
    t, since,
  );
  res.json({ daily, materials });
});
