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
import { getErpOverview } from '../../erp/overview.js';
import { assertProjectStatusEdit } from '../../erp/project-state.js';
import { ErpError } from '../../erp/validation.js';

export const jobsitesRouter = Router();

jobsitesRouter.get('/jobsites', (req, res) => {
  const rows = all(
    `SELECT * FROM jobsites WHERE tenant_id = ? ORDER BY name`,
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
  const existing = get<{ id: number; status: string }>(`SELECT id,status FROM jobsites WHERE tenant_id = ? AND id = ?`, t, id);
  if (!existing) { res.status(404).json({ error: 'jobsite not found' }); return; }
  const b = req.body as Record<string, unknown>;
  try { assertProjectStatusEdit(t,id,existing.status,b.status); }
  catch(error) {
    if(error instanceof ErpError) {res.status(error.status).json({error:error.message});return;}
    throw error;
  }
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
  }
  const actuals = new Map(getErpOverview(req.tenant.id).work_items.map((item) => [item.id, item]));
  const rows = all<PlanRow>(
    `SELECT p.* FROM production_plans p
     WHERE p.tenant_id = ? AND p.jobsite_id = ?
     ORDER BY p.phase, p.activity`,
    req.tenant.id, Number(req.params.id),
  );
  res.json(rows.map((r) => {
    const measured = actuals.get(r.id);
    // Share accepted quantities with the ERP; engine-hour drafts remain separate.
    return {
      ...r, actual_qty: measured?.actual_qty ?? 0, actual_hours: measured?.actual_hours ?? 0,
      pct_complete: Math.round((measured?.progress_pct ?? 0) * 10) / 10,
      actuals_basis: 'approved_reports_and_manual_field_entries',
    };
  }));
});
