/**
 * Workforce endpoints: the employee roster and daily timecards. AI-drafted
 * timecards carry source='ai_auto'; a manual edit of their hours flips
 * corrected=1 so the audit trail stays honest.
 *
 *   GET    /api/employees                 active roster
 *   GET    /api/timecards?date=&jobsite_id=&status=
 *   POST   /api/timecards                 manual timecard entry
 *   PATCH  /api/timecards/:id             edit (hours, times, codes, status, ...)
 *   POST   /api/timecards/:id/approve
 */

import { Router } from 'express';
import { all, get, nowIso, run } from '../../db/database.js';

export const workforceRouter = Router();

workforceRouter.get('/employees', (req, res) => {
  const rows = all(
    `SELECT id, name, role, phone, certs, active
     FROM employees WHERE tenant_id = ? AND active = 1
     ORDER BY name`,
    req.tenant.id,
  );
  res.json(rows);
});

workforceRouter.get('/timecards', (req, res) => {
  const { date, jobsite_id, status } = req.query as Record<string, string | undefined>;
  const clauses = ['tc.tenant_id = ?', 'tc.date = ?'];
  const params: (string | number)[] = [req.tenant.id, date ?? nowIso().slice(0, 10)];
  if (jobsite_id) { clauses.push('tc.jobsite_id = ?'); params.push(Number(jobsite_id)); }
  if (status) { clauses.push('tc.status = ?'); params.push(status); }
  const rows = all(
    `SELECT tc.*, e.name AS employee_name, e.role AS employee_role,
       j.name AS jobsite_name, a.name AS asset_name
     FROM timecards tc
     JOIN employees e ON e.id = tc.employee_id
     LEFT JOIN jobsites j ON j.id = tc.jobsite_id
     LEFT JOIN assets a ON a.id = tc.asset_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY e.name`,
    ...params,
  );
  res.json(rows);
});

workforceRouter.post('/timecards', (req, res) => {
  const t = req.tenant.id;
  const b = req.body as Record<string, unknown>;
  if (!b.employee_id || !b.date || b.hours == null) {
    res.status(400).json({ error: 'employee_id, date and hours are required' });
    return;
  }
  const employee = get<{ id: number }>(
    `SELECT id FROM employees WHERE tenant_id = ? AND id = ?`, t, Number(b.employee_id),
  );
  if (!employee) { res.status(404).json({ error: 'employee not found' }); return; }
  const dup = get<{ id: number }>(
    `SELECT id FROM timecards WHERE employee_id = ? AND date = ? AND source = 'manual'`,
    Number(b.employee_id), String(b.date),
  );
  if (dup) {
    res.status(409).json({ error: 'a manual timecard already exists for this employee and date' });
    return;
  }
  const result = run(
    `INSERT INTO timecards (tenant_id, employee_id, jobsite_id, date, start_time, end_time,
       hours, cost_code, asset_id, source, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'draft', ?)`,
    t, Number(b.employee_id),
    b.jobsite_id ? Number(b.jobsite_id) : null,
    String(b.date),
    (b.start_time as string) ?? null,
    (b.end_time as string) ?? null,
    Number(b.hours),
    (b.cost_code as string) ?? null,
    b.asset_id ? Number(b.asset_id) : null,
    (b.notes as string) ?? null,
  );
  res.status(201).json(get(`SELECT * FROM timecards WHERE id = ?`, Number(result.lastInsertRowid)));
});

workforceRouter.patch('/timecards/:id', (req, res) => {
  const t = req.tenant.id;
  const id = Number(req.params.id);
  const existing = get<{ id: number; source: string; hours: number }>(
    `SELECT id, source, hours FROM timecards WHERE tenant_id = ? AND id = ?`, t, id,
  );
  if (!existing) { res.status(404).json({ error: 'timecard not found' }); return; }
  const b = req.body as Record<string, unknown>;
  const fields: string[] = [];
  const params: (string | number | null)[] = [];
  const allow: Record<string, (v: unknown) => string | number | null> = {
    hours: (v) => Number(v),
    start_time: (v) => (v === null ? null : String(v)),
    end_time: (v) => (v === null ? null : String(v)),
    cost_code: (v) => (v === null ? null : String(v)),
    jobsite_id: (v) => (v === null ? null : Number(v)),
    asset_id: (v) => (v === null ? null : Number(v)),
    status: (v) => String(v),
    notes: (v) => (v === null ? null : String(v)),
  };
  for (const [key, fn] of Object.entries(allow)) {
    if (key in b) { fields.push(`${key} = ?`); params.push(fn(b[key])); }
  }
  if (fields.length === 0) { res.status(400).json({ error: 'no editable fields supplied' }); return; }
  // Manual correction of an AI-drafted timecard's hours is flagged for audit.
  if ('hours' in b && existing.source === 'ai_auto' && Number(b.hours) !== existing.hours) {
    fields.push('corrected = 1');
  }
  params.push(id);
  run(`UPDATE timecards SET ${fields.join(', ')} WHERE id = ?`, ...params);
  res.json(get(`SELECT * FROM timecards WHERE id = ?`, id));
});

workforceRouter.post('/timecards/:id/approve', (req, res) => {
  const id = Number(req.params.id);
  const existing = get<{ id: number }>(
    `SELECT id FROM timecards WHERE tenant_id = ? AND id = ?`, req.tenant.id, id,
  );
  if (!existing) { res.status(404).json({ error: 'timecard not found' }); return; }
  run(`UPDATE timecards SET status = 'approved' WHERE id = ?`, id);
  res.json(get(`SELECT * FROM timecards WHERE id = ?`, id));
});
