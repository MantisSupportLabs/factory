/**
 * Jobsite REST endpoints.
 *
 *   GET    /api/jobsites             list (all columns), ordered by name
 *   POST   /api/jobsites             create
 *   GET    /api/jobsites/:id         detail + rollup summary counts
 *   PATCH  /api/jobsites/:id         edit
 *   GET    /api/jobsites/:id/plans   production plans + actuals + % complete
 */

import { Router } from 'express';
import { all, get, nowIso, run } from '../../db/database.js';

export const jobsitesRouter = Router();

jobsitesRouter.get('/jobsites', (req, res) => {
  const rows = all(
    `SELECT j.*, pm.name AS pm_name, pe.name AS pe_name
     FROM jobsites j
     LEFT JOIN employees pm ON pm.id = j.pm_id
     LEFT JOIN employees pe ON pe.id = j.pe_id
     WHERE j.tenant_id = ? ORDER BY j.name`,
    req.tenant.id,
  );
  res.json(rows);
});

jobsitesRouter.post('/jobsites', (req, res) => {
  const t = req.tenant.id;
  const b = req.body as Record<string, unknown>;
  const { name, code, lat, lng } = b;
  if (!name || !code || typeof lat !== 'number' || typeof lng !== 'number') {
    res.status(400).json({ error: 'name, code, lat and lng are required' });
    return;
  }
  const result = run(
    `INSERT INTO jobsites (tenant_id, name, code, lat, lng, address, superintendent,
       start_date, end_date, notes, boundary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    t, String(name), String(code), lat, lng,
    (b.address as string) ?? null, (b.superintendent as string) ?? null,
    (b.start_date as string) ?? null, (b.end_date as string) ?? null,
    (b.notes as string) ?? null,
    b.boundary ? (typeof b.boundary === 'string' ? b.boundary : JSON.stringify(b.boundary)) : null,
  );
  res.status(201).json(get(`SELECT * FROM jobsites WHERE id = ?`, Number(result.lastInsertRowid)));
});

jobsitesRouter.get('/jobsites/:id', (req, res) => {
  const t = req.tenant.id;
  const id = Number(req.params.id);
  const row = get(`SELECT * FROM jobsites WHERE tenant_id = ? AND id = ?`, t, id);
  if (!row) { res.status(404).json({ error: 'jobsite not found' }); return; }
  const kinds = get<{ machines: number; trucks: number; small_tools: number; cameras: number }>(
    `SELECT
       COUNT(CASE WHEN kind = 'machine' THEN 1 END) AS machines,
       COUNT(CASE WHEN kind = 'truck' THEN 1 END) AS trucks,
       COUNT(CASE WHEN kind = 'small_tool' THEN 1 END) AS small_tools,
       COUNT(CASE WHEN kind = 'camera' THEN 1 END) AS cameras
     FROM assets WHERE tenant_id = ? AND jobsite_id = ?`,
    t, id,
  );
  const activity = get<{ active_faults: number; tools_out: number; timecards_today: number }>(
    `SELECT
       (SELECT COUNT(*) FROM fault_codes f JOIN assets a ON a.id = f.asset_id
         WHERE f.tenant_id = ? AND a.jobsite_id = ? AND f.active = 1) AS active_faults,
       (SELECT COUNT(*) FROM tool_assignments
         WHERE tenant_id = ? AND jobsite_id = ? AND checked_in_at IS NULL) AS tools_out,
       (SELECT COUNT(*) FROM timecards
         WHERE tenant_id = ? AND jobsite_id = ? AND date = ?) AS timecards_today`,
    t, id, t, id, t, id, nowIso().slice(0, 10),
  );
  res.json({
    ...row,
    summary: {
      machines: kinds?.machines ?? 0,
      trucks: kinds?.trucks ?? 0,
      small_tools: kinds?.small_tools ?? 0,
      cameras: kinds?.cameras ?? 0,
      active_faults: activity?.active_faults ?? 0,
      tools_out: activity?.tools_out ?? 0,
      timecards_today: activity?.timecards_today ?? 0,
    },
  });
});

jobsitesRouter.patch('/jobsites/:id', (req, res) => {
  const t = req.tenant.id;
  const id = Number(req.params.id);
  const existing = get<{ id: number }>(`SELECT id FROM jobsites WHERE tenant_id = ? AND id = ?`, t, id);
  if (!existing) { res.status(404).json({ error: 'jobsite not found' }); return; }
  const b = req.body as Record<string, unknown>;
  const fields: string[] = [];
  const params: (string | number | null)[] = [];
  const allow: Record<string, (v: unknown) => string | number | null> = {
    name: (v) => String(v),
    status: (v) => String(v),
    superintendent: (v) => (v === null ? null : String(v)),
    notes: (v) => (v === null ? null : String(v)),
    address: (v) => (v === null ? null : String(v)),
    boundary: (v) => (v === null ? null : typeof v === 'string' ? v : JSON.stringify(v)),
    start_date: (v) => (v === null ? null : String(v)),
    end_date: (v) => (v === null ? null : String(v)),
    pm_id: (v) => (v === null ? null : Number(v)),
    pe_id: (v) => (v === null ? null : Number(v)),
  };
  for (const [key, fn] of Object.entries(allow)) {
    if (key in b) { fields.push(`${key} = ?`); params.push(fn(b[key])); }
  }
  if (fields.length === 0) { res.status(400).json({ error: 'no editable fields supplied' }); return; }
  params.push(id);
  run(`UPDATE jobsites SET ${fields.join(', ')} WHERE id = ?`, ...params);
  res.json(get(`SELECT * FROM jobsites WHERE id = ?`, id));
});

jobsitesRouter.get('/jobsites/:id/plans', (req, res) => {
  interface PlanRow {
    id: number; tenant_id: number; jobsite_id: number; phase: string; activity: string;
    unit: string; planned_qty: number; planned_hours: number;
    planned_start: string | null; planned_end: string | null;
    actual_qty: number; actual_hours: number;
  }
  const rows = all<PlanRow>(
    `SELECT p.*, COALESCE(SUM(e.qty), 0) AS actual_qty, COALESCE(SUM(e.hours), 0) AS actual_hours
     FROM production_plans p
     LEFT JOIN production_entries e ON e.plan_id = p.id
     WHERE p.tenant_id = ? AND p.jobsite_id = ?
     GROUP BY p.id
     ORDER BY p.phase, p.activity`,
    req.tenant.id, Number(req.params.id),
  );
  res.json(rows.map((r) => {
    const pct = r.planned_qty > 0 ? Math.min(100, (r.actual_qty / r.planned_qty) * 100) : 0;
    return { ...r, pct_complete: Math.round(pct * 10) / 10 };
  }));
});
