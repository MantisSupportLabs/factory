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

import { Router, type Response } from 'express';
import { all, get, nowIso, run } from '../../db/database.js';
import { assertLegacyTimecardDoesNotOverlap } from '../../erp/workforce-planning.js';
import { ErpError } from '../../erp/validation.js';

export const workforceRouter = Router();

const TIMECARD_STATUSES = ['draft', 'submitted', 'approved'];
function checkSplitTime(tenantId:number,card:Parameters<typeof assertLegacyTimecardDoesNotOverlap>[1],res:Response):boolean {
  try {assertLegacyTimecardDoesNotOverlap(tenantId,card);return true;}
  catch(error) {if(error instanceof ErpError){res.status(error.status).json({error:error.message});return false;}throw error;}
}

function validId(value: unknown): boolean {
  return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== ''))
    && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateTimecard(tenantId: number, body: Record<string, unknown>): { status: number; error: string } | null {
  if ('hours' in body && (!(typeof body.hours === 'number' || (typeof body.hours === 'string' && body.hours.trim() !== ''))
    || !Number.isFinite(Number(body.hours)) || Number(body.hours) < 0 || Number(body.hours) > 24)) {
    return { status: 400, error: 'hours must be a finite number between 0 and 24' };
  }
  if ('date' in body && !validDate(body.date)) {
    return { status: 400, error: 'date must be a valid calendar date in YYYY-MM-DD format' };
  }
  if ('status' in body && (typeof body.status !== 'string' || !TIMECARD_STATUSES.includes(body.status))) {
    return { status: 400, error: `status must be one of: ${TIMECARD_STATUSES.join(', ')}` };
  }
  for (const field of ['start_time', 'end_time']) {
    const value = body[field];
    if (field in body && value !== null && (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value))) {
      return { status: 400, error: `${field} must be a valid 24-hour time (HH:MM or HH:MM:SS) or null` };
    }
  }
  for (const field of ['cost_code', 'notes']) {
    if (field in body && body[field] !== null && typeof body[field] !== 'string') {
      return { status: 400, error: `${field} must be a string or null` };
    }
  }
  // Related IDs must belong to the same company as the timecard.
  for (const [field, table, label] of [
    ['jobsite_id', 'jobsites', 'jobsite'], ['asset_id', 'assets', 'asset'],
  ] as const) {
    if (!(field in body) || body[field] === null) continue;
    if (!validId(body[field])) return { status: 400, error: `${field} must be a positive integer or null` };
    if (!get(`SELECT id FROM ${table} WHERE tenant_id = ? AND id = ?`, tenantId, Number(body[field]))) {
      return { status: 404, error: `${label} not found` };
    }
  }
  return null;
}

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
  const validation = validateTimecard(req.tenant.id, {
    ...(date !== undefined ? { date } : {}),
    ...(jobsite_id !== undefined ? { jobsite_id } : {}),
    ...(status !== undefined ? { status } : {}),
  });
  if (validation) { res.status(validation.status).json({ error: validation.error }); return; }
  const clauses = ['tc.tenant_id = ?', 'tc.date = ?'];
  const params: (string | number)[] = [req.tenant.id, date ?? nowIso().slice(0, 10)];
  if (jobsite_id) { clauses.push('tc.jobsite_id = ?'); params.push(Number(jobsite_id)); }
  if (status) { clauses.push('tc.status = ?'); params.push(status); }
  const rows = all(
    `SELECT tc.*, e.name AS employee_name, e.role AS employee_role,
       j.name AS jobsite_name, a.name AS asset_name
     FROM timecards tc
     JOIN employees e ON e.id = tc.employee_id AND e.tenant_id = tc.tenant_id
     LEFT JOIN jobsites j ON j.id = tc.jobsite_id AND j.tenant_id = tc.tenant_id
     LEFT JOIN assets a ON a.id = tc.asset_id AND a.tenant_id = tc.tenant_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY e.name`,
    ...params,
  );
  res.json(rows);
});

workforceRouter.post('/timecards', (req, res) => {
  const t = req.tenant.id;
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (!b.employee_id || !b.date || b.hours == null) {
    res.status(400).json({ error: 'employee_id, date and hours are required' });
    return;
  }
  if (!validId(b.employee_id)) {
    res.status(400).json({ error: 'employee_id must be a positive integer' });
    return;
  }
  const validation = validateTimecard(t, b);
  if (validation) { res.status(validation.status).json({ error: validation.error }); return; }
  const employee = get<{ id: number }>(
    `SELECT id FROM employees WHERE tenant_id = ? AND id = ?`, t, Number(b.employee_id),
  );
  if (!employee) { res.status(404).json({ error: 'employee not found' }); return; }
  const dup = get<{ id: number }>(
    `SELECT id FROM timecards WHERE tenant_id = ? AND employee_id = ? AND date = ? AND source = 'manual'`,
    t, Number(b.employee_id), String(b.date),
  );
  if (dup) {
    res.status(409).json({ error: 'a manual timecard already exists for this employee and date' });
    return;
  }
  if(!checkSplitTime(t,{employee_id:Number(b.employee_id),date:String(b.date),hours:Number(b.hours),start_time:b.start_time as string|null|undefined,end_time:b.end_time as string|null|undefined},res)) return;
  const result = run(
    `INSERT INTO timecards (tenant_id, employee_id, jobsite_id, date, start_time, end_time,
       hours, cost_code, asset_id, source, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`,
    t, Number(b.employee_id),
    b.jobsite_id != null ? Number(b.jobsite_id) : null,
    String(b.date),
    (b.start_time as string) ?? null,
    (b.end_time as string) ?? null,
    Number(b.hours),
    (b.cost_code as string) ?? null,
    b.asset_id != null ? Number(b.asset_id) : null,
    (b.status as string) ?? 'draft',
    (b.notes as string) ?? null,
  );
  res.status(201).json(get(`SELECT * FROM timecards WHERE id = ?`, Number(result.lastInsertRowid)));
});

workforceRouter.patch('/timecards/:id', (req, res) => {
  const t = req.tenant.id;
  const id = Number(req.params.id);
  const existing = get<{ id: number; source: string; hours: number; status: string; employee_id:number; date:string; start_time:string|null;end_time:string|null }>(
    `SELECT * FROM timecards WHERE tenant_id = ? AND id = ?`, t, id,
  );
  if (!existing) { res.status(404).json({ error: 'timecard not found' }); return; }
  if(existing.status==='approved'){res.status(409).json({error:'Approved timecards are locked. Capture future corrections through the reviewed split-time workflow.'});return;}
  const b = (req.body ?? {}) as Record<string, unknown>;
  const validation = validateTimecard(t, b);
  if (validation) { res.status(validation.status).json({ error: validation.error }); return; }
  if (b.status === 'approved' && !['draft', 'submitted'].includes(existing.status)) {
    res.status(409).json({ error: 'only draft or submitted timecards can be approved' });
    return;
  }
  if(!checkSplitTime(t,{...existing,hours:Number(b.hours??existing.hours),start_time:('start_time' in b?b.start_time:existing.start_time) as string|null,end_time:('end_time' in b?b.end_time:existing.end_time) as string|null},res)) return;
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
  params.push(id, t);
  run(`UPDATE timecards SET ${fields.join(', ')} WHERE id = ? AND tenant_id = ?`, ...params);
  res.json(get(`SELECT * FROM timecards WHERE id = ?`, id));
});

workforceRouter.post('/timecards/:id/approve', (req, res) => {
  const id = Number(req.params.id);
  const existing = get<{ id: number; status: string;employee_id:number;date:string;hours:number;start_time:string|null;end_time:string|null }>(
    `SELECT * FROM timecards WHERE tenant_id = ? AND id = ?`, req.tenant.id, id,
  );
  if (!existing) { res.status(404).json({ error: 'timecard not found' }); return; }
  if (!['draft', 'submitted'].includes(existing.status)) {
    res.status(409).json({ error: 'only draft or submitted timecards can be approved' });
    return;
  }
  if(!checkSplitTime(req.tenant.id,existing,res)) return;
  run(`UPDATE timecards SET status = 'approved' WHERE id = ? AND tenant_id = ?`, id, req.tenant.id);
  res.json(get(`SELECT * FROM timecards WHERE id = ?`, id));
});
