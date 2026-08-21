/**
 * Small-tool tracking endpoints. Tools are assets with kind='small_tool';
 * an open checkout is a tool_assignments row with checked_in_at IS NULL.
 *
 *   GET    /api/tools                        list + open-assignment status
 *   POST   /api/tools/:assetId/checkout      check a tool out to an employee
 *   POST   /api/tools/:assetId/checkin       return a tool
 *   GET    /api/tools/assignments?asset_id=  assignment history
 */

import { Router } from 'express';
import { all, get, nowIso, run } from '../../db/database.js';

export const toolsRouter = Router();

toolsRouter.get('/tools', (req, res) => {
  interface ToolRow {
    id: number; name: string; make: string | null; model: string | null;
    serial_number: string | null; jobsite_id: number | null; jobsite_name: string | null;
    lat: number | null; lng: number | null; status: string;
    assignment_id: number | null; employee_id: number | null; employee_name: string | null;
    out_jobsite_id: number | null; out_jobsite_name: string | null;
    checked_out_at: string | null; due_back: string | null;
  }
  const rows = all<ToolRow>(
    `SELECT a.id, a.name, a.make, a.model, a.serial_number, a.jobsite_id,
       j.name AS jobsite_name, s.lat, s.lng, a.status,
       ta.id AS assignment_id, ta.employee_id, e.name AS employee_name,
       ta.jobsite_id AS out_jobsite_id, tj.name AS out_jobsite_name,
       ta.checked_out_at, ta.due_back
     FROM assets a
     LEFT JOIN jobsites j ON j.id = a.jobsite_id
     LEFT JOIN asset_state s ON s.asset_id = a.id
     LEFT JOIN tool_assignments ta ON ta.asset_id = a.id AND ta.checked_in_at IS NULL
     LEFT JOIN employees e ON e.id = ta.employee_id
     LEFT JOIN jobsites tj ON tj.id = ta.jobsite_id
     WHERE a.tenant_id = ? AND a.kind = 'small_tool'
     ORDER BY a.name`,
    req.tenant.id,
  );
  const now = nowIso();
  res.json(rows.map(({ assignment_id, employee_id, employee_name, out_jobsite_id,
    out_jobsite_name, checked_out_at, due_back, ...tool }) => ({
    ...tool,
    out: assignment_id === null ? null : {
      assignment_id,
      employee_id,
      employee_name,
      jobsite_id: out_jobsite_id,
      jobsite_name: out_jobsite_name,
      checked_out_at,
      due_back,
      overdue: due_back !== null && due_back < now,
    },
  })));
});

toolsRouter.post('/tools/:assetId/checkout', (req, res) => {
  const t = req.tenant.id;
  const assetId = Number(req.params.assetId);
  const b = req.body as Record<string, unknown>;
  const tool = get<{ id: number }>(
    `SELECT id FROM assets WHERE tenant_id = ? AND id = ? AND kind = 'small_tool'`, t, assetId,
  );
  if (!tool) { res.status(404).json({ error: 'tool not found' }); return; }
  if (!b.employee_id) { res.status(400).json({ error: 'employee_id is required' }); return; }
  const open = get<{ id: number }>(
    `SELECT id FROM tool_assignments WHERE tenant_id = ? AND asset_id = ? AND checked_in_at IS NULL`,
    t, assetId,
  );
  if (open) { res.status(409).json({ error: 'tool is already checked out' }); return; }
  const result = run(
    `INSERT INTO tool_assignments (tenant_id, asset_id, jobsite_id, employee_id,
       checked_out_at, due_back, condition_out, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    t, assetId,
    b.jobsite_id ? Number(b.jobsite_id) : null,
    Number(b.employee_id),
    nowIso(),
    (b.due_back as string) ?? null,
    (b.condition_out as string) ?? null,
    (b.notes as string) ?? null,
  );
  res.status(201).json(get(`SELECT * FROM tool_assignments WHERE id = ?`, Number(result.lastInsertRowid)));
});

toolsRouter.post('/tools/:assetId/checkin', (req, res) => {
  const t = req.tenant.id;
  const assetId = Number(req.params.assetId);
  const b = req.body as Record<string, unknown>;
  const tool = get<{ id: number }>(
    `SELECT id FROM assets WHERE tenant_id = ? AND id = ? AND kind = 'small_tool'`, t, assetId,
  );
  if (!tool) { res.status(404).json({ error: 'tool not found' }); return; }
  const open = get<{ id: number }>(
    `SELECT id FROM tool_assignments WHERE tenant_id = ? AND asset_id = ? AND checked_in_at IS NULL`,
    t, assetId,
  );
  if (!open) { res.status(409).json({ error: 'tool is not checked out' }); return; }
  run(
    `UPDATE tool_assignments SET checked_in_at = ?, condition_in = ?, notes = COALESCE(?, notes)
     WHERE id = ?`,
    nowIso(), (b.condition_in as string) ?? null, (b.notes as string) ?? null, open.id,
  );
  res.json(get(`SELECT * FROM tool_assignments WHERE id = ?`, open.id));
});

toolsRouter.get('/tools/assignments', (req, res) => {
  const { asset_id } = req.query as Record<string, string | undefined>;
  const clauses = ['ta.tenant_id = ?'];
  const params: (string | number)[] = [req.tenant.id];
  if (asset_id) { clauses.push('ta.asset_id = ?'); params.push(Number(asset_id)); }
  const rows = all(
    `SELECT ta.*, e.name AS employee_name, j.name AS jobsite_name
     FROM tool_assignments ta
     LEFT JOIN employees e ON e.id = ta.employee_id
     LEFT JOIN jobsites j ON j.id = ta.jobsite_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY ta.checked_out_at DESC
     LIMIT 100`,
    ...params,
  );
  res.json(rows);
});
