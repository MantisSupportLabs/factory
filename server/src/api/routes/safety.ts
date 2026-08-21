/**
 * Safety endpoints: Job Safety Analyses and incident log. JSA hazards/crew
 * arrive as JSON values and are stored (and returned) as JSON strings.
 *
 *   GET    /api/safety/jsas?jobsite_id=
 *   POST   /api/safety/jsas
 *   PATCH  /api/safety/jsas/:id            {status} open|signed|closed
 *   GET    /api/safety/incidents
 *   POST   /api/safety/incidents
 *   PATCH  /api/safety/incidents/:id       {status?, severity?}
 *   GET    /api/safety/summary
 */

import { Router } from 'express';
import { all, get, run } from '../../db/database.js';

export const safetyRouter = Router();

const JSA_STATUSES = ['open', 'signed', 'closed'];

safetyRouter.get('/safety/jsas', (req, res) => {
  const { jobsite_id } = req.query as Record<string, string | undefined>;
  const clauses = ['f.tenant_id = ?'];
  const params: (string | number)[] = [req.tenant.id];
  if (jobsite_id) { clauses.push('f.jobsite_id = ?'); params.push(Number(jobsite_id)); }
  const rows = all(
    `SELECT f.*, j.name AS jobsite_name
     FROM jsa_forms f
     JOIN jobsites j ON j.id = f.jobsite_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY f.date DESC, f.id DESC
     LIMIT 200`,
    ...params,
  );
  res.json(rows);
});

safetyRouter.post('/safety/jsas', (req, res) => {
  const t = req.tenant.id;
  const b = req.body as Record<string, unknown>;
  if (!b.jobsite_id || !b.date || !b.task || b.hazards == null) {
    res.status(400).json({ error: 'jobsite_id, date, task and hazards are required' });
    return;
  }
  const result = run(
    `INSERT INTO jsa_forms (tenant_id, jobsite_id, date, task, hazards, crew, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    t, Number(b.jobsite_id), String(b.date), String(b.task),
    JSON.stringify(b.hazards),
    b.crew == null ? null : JSON.stringify(b.crew),
    (b.created_by as string) ?? null,
  );
  res.status(201).json(get(`SELECT * FROM jsa_forms WHERE id = ?`, Number(result.lastInsertRowid)));
});

safetyRouter.patch('/safety/jsas/:id', (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body as { status?: string };
  if (!status || !JSA_STATUSES.includes(status)) {
    res.status(400).json({ error: `status must be one of: ${JSA_STATUSES.join(', ')}` });
    return;
  }
  const existing = get<{ id: number }>(
    `SELECT id FROM jsa_forms WHERE tenant_id = ? AND id = ?`, req.tenant.id, id,
  );
  if (!existing) { res.status(404).json({ error: 'jsa not found' }); return; }
  run(`UPDATE jsa_forms SET status = ? WHERE id = ?`, status, id);
  res.json(get(`SELECT * FROM jsa_forms WHERE id = ?`, id));
});

safetyRouter.get('/safety/incidents', (req, res) => {
  const rows = all(
    `SELECT i.*, j.name AS jobsite_name
     FROM incidents i
     LEFT JOIN jobsites j ON j.id = i.jobsite_id
     WHERE i.tenant_id = ?
     ORDER BY i.date DESC, i.id DESC
     LIMIT 200`,
    req.tenant.id,
  );
  res.json(rows);
});

safetyRouter.post('/safety/incidents', (req, res) => {
  const t = req.tenant.id;
  const b = req.body as Record<string, unknown>;
  if (!b.date || !b.type || !b.severity || !b.description) {
    res.status(400).json({ error: 'date, type, severity and description are required' });
    return;
  }
  const result = run(
    `INSERT INTO incidents (tenant_id, jobsite_id, date, type, severity, description)
     VALUES (?, ?, ?, ?, ?, ?)`,
    t, b.jobsite_id ? Number(b.jobsite_id) : null,
    String(b.date), String(b.type), String(b.severity), String(b.description),
  );
  res.status(201).json(get(`SELECT * FROM incidents WHERE id = ?`, Number(result.lastInsertRowid)));
});

safetyRouter.patch('/safety/incidents/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = get<{ id: number }>(
    `SELECT id FROM incidents WHERE tenant_id = ? AND id = ?`, req.tenant.id, id,
  );
  if (!existing) { res.status(404).json({ error: 'incident not found' }); return; }
  const b = req.body as Record<string, unknown>;
  const fields: string[] = [];
  const params: (string | number)[] = [];
  if ('status' in b) { fields.push('status = ?'); params.push(String(b.status)); }
  if ('severity' in b) { fields.push('severity = ?'); params.push(String(b.severity)); }
  if (fields.length === 0) { res.status(400).json({ error: 'no editable fields supplied' }); return; }
  params.push(id);
  run(`UPDATE incidents SET ${fields.join(', ')} WHERE id = ?`, ...params);
  res.json(get(`SELECT * FROM incidents WHERE id = ?`, id));
});

safetyRouter.get('/safety/summary', (req, res) => {
  const t = req.tenant.id;
  const cutoff30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const openJsas = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM jsa_forms WHERE tenant_id = ? AND status = 'open'`, t,
  );
  const incidents30 = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM incidents WHERE tenant_id = ? AND date >= ?`, t, cutoff30,
  );
  const openIncidents = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM incidents WHERE tenant_id = ? AND status = 'open'`, t,
  );
  const lastRecordable = get<{ last: string | null }>(
    `SELECT MAX(date) AS last FROM incidents WHERE tenant_id = ? AND type = 'recordable'`, t,
  );
  const daysSinceRecordable = lastRecordable?.last
    ? Math.max(0, Math.floor((Date.now() - Date.parse(lastRecordable.last)) / 86400000))
    : null;
  res.json({
    open_jsas: openJsas?.n ?? 0,
    incidents_30d: incidents30?.n ?? 0,
    open_incidents: openIncidents?.n ?? 0,
    days_since_recordable: daysSinceRecordable,
  });
});
