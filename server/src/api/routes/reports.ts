/**
 * Generated report documents. Payloads are built live from the DB at
 * generation time and stored as JSON, so a report is a frozen snapshot the
 * office can pull up later even after the numbers move.
 *
 *   GET  /api/reports?kind=&jobsite_id=   list (no payloads)
 *   GET  /api/reports/:id                 full report, payload parsed
 *   POST /api/reports/generate            build + store → 201 full row
 */

import { Router } from 'express';
import { all, get, nowIso, run } from '../../db/database.js';
import { computeProjections } from '../../services/ai-engine.js';

export const reportsRouter = Router();

const REPORT_KINDS = ['daily', 'production', 'utilization', 'safety', 'timecards'] as const;
type ReportKind = (typeof REPORT_KINDS)[number];

const KIND_TITLES: Record<ReportKind, string> = {
  daily: 'Daily Report',
  production: 'Production Report',
  utilization: 'Utilization Report',
  safety: 'Safety Report',
  timecards: 'Timecards Report',
};

const REPORT_COLS = `id, jobsite_id, date, kind, title, generated_by, created_at`;

reportsRouter.get('/reports', (req, res) => {
  const clauses = ['tenant_id = ?'];
  const params: (string | number)[] = [req.tenant.id];
  const { kind, jobsite_id } = req.query as Record<string, string | undefined>;
  if (kind) { clauses.push('kind = ?'); params.push(kind); }
  if (jobsite_id) { clauses.push('jobsite_id = ?'); params.push(Number(jobsite_id)); }
  const rows = all(
    `SELECT ${REPORT_COLS} FROM reports WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC, id DESC LIMIT 100`,
    ...params,
  );
  res.json(rows);
});

reportsRouter.get('/reports/:id', (req, res) => {
  const row = get<{ payload: string }>(
    `SELECT ${REPORT_COLS}, payload FROM reports WHERE tenant_id = ? AND id = ?`,
    req.tenant.id, Number(req.params.id),
  );
  if (!row) {
    res.status(404).json({ error: 'report not found' });
    return;
  }
  res.json({ ...row, payload: JSON.parse(row.payload) as unknown });
});

reportsRouter.post('/reports/generate', (req, res) => {
  const t = req.tenant.id;
  const b = req.body as { kind?: unknown; jobsite_id?: unknown; date?: unknown };
  const kindRaw = typeof b.kind === 'string' ? b.kind : '';
  if (!(REPORT_KINDS as readonly string[]).includes(kindRaw)) {
    res.status(400).json({ error: `kind must be one of: ${REPORT_KINDS.join(', ')}` });
    return;
  }
  const kind = kindRaw as ReportKind;
  const date = typeof b.date === 'string' && b.date ? b.date : nowIso().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    return;
  }
  const jobsiteId = b.jobsite_id != null ? Number(b.jobsite_id) : null;
  let jobsiteName: string | null = null;
  if (jobsiteId !== null) {
    const site = get<{ name: string }>(`SELECT name FROM jobsites WHERE tenant_id = ? AND id = ?`, t, jobsiteId);
    if (!site) {
      res.status(404).json({ error: 'jobsite not found' });
      return;
    }
    jobsiteName = site.name;
  }

  const payload = buildPayload(t, kind, date, jobsiteId, jobsiteName);
  const title = [KIND_TITLES[kind], jobsiteName, date].filter(Boolean).join(' — ');
  const result = run(
    `INSERT INTO reports (tenant_id, jobsite_id, date, kind, title, payload, generated_by)
     VALUES (?, ?, ?, ?, ?, ?, 'manual')`,
    t, jobsiteId, date, kind, title, JSON.stringify(payload),
  );
  const row = get<{ payload: string }>(
    `SELECT ${REPORT_COLS}, payload FROM reports WHERE id = ?`,
    Number(result.lastInsertRowid),
  );
  if (!row) {
    res.status(500).json({ error: 'report insert failed' });
    return;
  }
  res.status(201).json({ ...row, payload: JSON.parse(row.payload) as unknown });
});

/* ------------------------------------------------------------------ */
/* Payload builders — live queries, optionally scoped to one jobsite   */
/* ------------------------------------------------------------------ */

function basePayload(jobsiteName: string | null): Record<string, unknown> {
  const p: Record<string, unknown> = { generated_at: nowIso() };
  if (jobsiteName) p.jobsite_name = jobsiteName;
  return p;
}

function buildPayload(
  t: number,
  kind: ReportKind,
  date: string,
  jobsiteId: number | null,
  jobsiteName: string | null,
): Record<string, unknown> {
  const base = basePayload(jobsiteName);
  switch (kind) {
    case 'daily': return { ...base, ...dailyPayload(t, date, jobsiteId) };
    case 'production': return { ...base, ...productionPayload(t, jobsiteId) };
    case 'utilization': return { ...base, ...utilizationPayload(t, jobsiteId) };
    case 'safety': return { ...base, ...safetyPayload(t, date, jobsiteId) };
    case 'timecards': return { ...base, ...timecardsPayload(t, date, jobsiteId) };
  }
}

function dailyPayload(t: number, date: string, jobsiteId: number | null): Record<string, unknown> {
  const site: number[] = jobsiteId !== null ? [jobsiteId] : [];
  const siteSql = (col: string) => (jobsiteId !== null ? `AND ${col} = ?` : '');

  const production = all(
    `SELECT p.activity, p.unit, e.qty, e.hours, e.source
     FROM production_entries e JOIN production_plans p ON p.id = e.plan_id
     WHERE e.tenant_id = ? AND e.date = ? ${siteSql('p.jobsite_id')}
     ORDER BY p.activity, e.source`,
    t, date, ...site,
  );

  const haulTotals = get<{ loads: number | null; tons: number | null }>(
    `SELECT SUM(loads) AS loads, SUM(tons) AS tons
     FROM haul_cycles WHERE tenant_id = ? AND date = ? ${siteSql('jobsite_id')}`,
    t, date, ...site,
  );
  const materials = all(
    `SELECT material, SUM(loads) AS loads, SUM(tons) AS tons
     FROM haul_cycles WHERE tenant_id = ? AND date = ? ${siteSql('jobsite_id')}
     GROUP BY material ORDER BY material`,
    t, date, ...site,
  );

  const labor = get<{ timecards: number; hours: number | null }>(
    `SELECT COUNT(*) AS timecards, SUM(hours) AS hours
     FROM timecards WHERE tenant_id = ? AND date = ? ${siteSql('jobsite_id')}`,
    t, date, ...site,
  );

  const equipment = get<{ machines: number; running: number | null; faults: number | null }>(
    `SELECT COUNT(*) AS machines,
       SUM(CASE WHEN s.engine_status = 'running' THEN 1 ELSE 0 END) AS running,
       SUM(COALESCE(s.active_faults, 0)) AS faults
     FROM assets a LEFT JOIN asset_state s ON s.asset_id = a.id
     WHERE a.tenant_id = ? AND a.kind = 'machine' AND a.status != 'retired' ${siteSql('a.jobsite_id')}`,
    t, ...site,
  );

  const jsas = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM jsa_forms WHERE tenant_id = ? AND date = ? ${siteSql('jobsite_id')}`,
    t, date, ...site,
  );
  const incidents = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM incidents WHERE tenant_id = ? AND date = ? ${siteSql('jobsite_id')}`,
    t, date, ...site,
  );

  return {
    production,
    hauls: { loads: haulTotals?.loads ?? 0, tons: haulTotals?.tons ?? 0, materials },
    labor: { timecards: labor?.timecards ?? 0, hours: labor?.hours ?? 0 },
    equipment: {
      machines: equipment?.machines ?? 0,
      running: equipment?.running ?? 0,
      faults: equipment?.faults ?? 0,
    },
    safety: { jsas: jsas?.n ?? 0, incidents: incidents?.n ?? 0 },
  };
}

function productionPayload(t: number, jobsiteId: number | null): Record<string, unknown> {
  const plans = computeProjections(t)
    .filter((p) => jobsiteId === null || p.jobsite_id === jobsiteId);
  return { plans };
}

function utilizationPayload(t: number, jobsiteId: number | null): Record<string, unknown> {
  const site: number[] = jobsiteId !== null ? [jobsiteId] : [];
  const machines = all(
    `SELECT a.name, a.make, a.model, s.engine_hours, s.idle_hours, s.utilization_pct,
       s.fuel_percent, COALESCE(s.active_faults, 0) AS active_faults
     FROM assets a LEFT JOIN asset_state s ON s.asset_id = a.id
     WHERE a.tenant_id = ? AND a.kind = 'machine' AND a.status != 'retired'
       ${jobsiteId !== null ? 'AND a.jobsite_id = ?' : ''}
     ORDER BY a.name`,
    t, ...site,
  );
  return { machines };
}

function safetyPayload(t: number, date: string, jobsiteId: number | null): Record<string, unknown> {
  const from = addDays(date, -30);
  const site: number[] = jobsiteId !== null ? [jobsiteId] : [];
  const siteSql = jobsiteId !== null ? 'AND jobsite_id = ?' : '';
  const jsas = all(
    `SELECT id, jobsite_id, date, task, hazards, crew, created_by, status
     FROM jsa_forms WHERE tenant_id = ? AND date >= ? AND date <= ? ${siteSql}
     ORDER BY date DESC, id DESC`,
    t, from, date, ...site,
  );
  const incidents = all(
    `SELECT id, jobsite_id, date, type, severity, description, status
     FROM incidents WHERE tenant_id = ? AND date >= ? AND date <= ? ${siteSql}
     ORDER BY date DESC, id DESC`,
    t, from, date, ...site,
  );
  return { window: { from, to: date }, jsas, incidents };
}

function timecardsPayload(t: number, date: string, jobsiteId: number | null): Record<string, unknown> {
  const site: number[] = jobsiteId !== null ? [jobsiteId] : [];
  const cards = all<{
    employee_name: string; role: string; hours: number;
    cost_code: string | null; source: string;
  }>(
    `SELECT e.name AS employee_name, e.role, tc.hours, tc.cost_code, tc.source
     FROM timecards tc JOIN employees e ON e.id = tc.employee_id
     WHERE tc.tenant_id = ? AND tc.date = ? ${jobsiteId !== null ? 'AND tc.jobsite_id = ?' : ''}
     ORDER BY e.name, tc.id`,
    t, date, ...site,
  );
  const byEmployee = new Map<string, {
    employee_name: string; role: string; hours: number;
    cost_codes: string[]; source_mix: Record<string, number>;
  }>();
  for (const c of cards) {
    let row = byEmployee.get(c.employee_name);
    if (!row) {
      row = { employee_name: c.employee_name, role: c.role, hours: 0, cost_codes: [], source_mix: {} };
      byEmployee.set(c.employee_name, row);
    }
    row.hours = Math.round((row.hours + c.hours) * 100) / 100;
    if (c.cost_code && !row.cost_codes.includes(c.cost_code)) row.cost_codes.push(c.cost_code);
    row.source_mix[c.source] = (row.source_mix[c.source] ?? 0) + 1;
  }
  return { employees: [...byEmployee.values()] };
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
