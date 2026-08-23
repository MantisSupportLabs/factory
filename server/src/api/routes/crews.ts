/**
 * Crew organization + job schedule endpoints.
 *
 *   GET    /crews                        crews with members, foreman/jobsite names
 *   POST   /crews                        {name, jobsite_id?, foreman_id?, notes?}
 *   PATCH  /crews/:id                    edit name/jobsite/foreman/notes
 *   DELETE /crews/:id                    disband (members become unassigned)
 *   POST   /crews/:id/members            {employee_id} → assign
 *   DELETE /crews/:id/members/:empId     unassign
 *   PATCH  /employees/:id                {role?, crew_id?, active?, phone?}
 *
 *   GET    /schedule                     timeline: per jobsite → phases with
 *                                        dates, % complete and behind/ahead
 *                                        status derived from the projection
 *                                        engine (not hand-entered)
 *   POST   /schedule/phases              add a plan line (phase/activity/dates)
 */

import { Router } from 'express';
import { all, get, run } from '../../db/database.js';
import { computeProjections } from '../../services/ai-engine.js';

export const crewsRouter = Router();

interface EmployeeRow {
  id: number; name: string; role: string; phone: string | null;
  crew_id: number | null; active: number;
}

function crewPayload(tenantId: number) {
  const crews = all<{
    id: number; name: string; jobsite_id: number | null; foreman_id: number | null;
    notes: string | null; jobsite_name: string | null; foreman_name: string | null;
  }>(
    `SELECT c.id, c.name, c.jobsite_id, c.foreman_id, c.notes,
       j.name AS jobsite_name, e.name AS foreman_name
     FROM crews c
     LEFT JOIN jobsites j ON j.id = c.jobsite_id
     LEFT JOIN employees e ON e.id = c.foreman_id
     WHERE c.tenant_id = ? ORDER BY c.name`,
    tenantId,
  );
  const members = all<EmployeeRow>(
    `SELECT id, name, role, phone, crew_id, active FROM employees
     WHERE tenant_id = ? AND active = 1 ORDER BY name`,
    tenantId,
  );
  return crews.map((c) => ({
    ...c,
    members: members.filter((m) => m.crew_id === c.id),
  }));
}

crewsRouter.get('/crews', (req, res) => {
  res.json(crewPayload(req.tenant.id));
});

crewsRouter.post('/crews', (req, res) => {
  const b = req.body as { name?: string; jobsite_id?: number; foreman_id?: number; notes?: string };
  if (!b.name) { res.status(400).json({ error: 'name is required' }); return; }
  const result = run(
    `INSERT INTO crews (tenant_id, name, jobsite_id, foreman_id, notes) VALUES (?, ?, ?, ?, ?)`,
    req.tenant.id, b.name, b.jobsite_id ?? null, b.foreman_id ?? null, b.notes ?? null,
  );
  res.status(201).json(get(`SELECT * FROM crews WHERE id = ?`, Number(result.lastInsertRowid)));
});

crewsRouter.patch('/crews/:id', (req, res) => {
  const t = req.tenant.id;
  const id = Number(req.params.id);
  if (!get(`SELECT id FROM crews WHERE tenant_id = ? AND id = ?`, t, id)) {
    res.status(404).json({ error: 'crew not found' });
    return;
  }
  const b = req.body as Record<string, unknown>;
  const fields: string[] = [];
  const params: (string | number | null)[] = [];
  const allow: Record<string, (v: unknown) => string | number | null> = {
    name: (v) => String(v),
    jobsite_id: (v) => (v === null ? null : Number(v)),
    foreman_id: (v) => (v === null ? null : Number(v)),
    notes: (v) => (v === null ? null : String(v)),
  };
  for (const [key, fn] of Object.entries(allow)) {
    if (key in b) { fields.push(`${key} = ?`); params.push(fn(b[key])); }
  }
  if (fields.length === 0) { res.status(400).json({ error: 'no editable fields supplied' }); return; }
  params.push(id);
  run(`UPDATE crews SET ${fields.join(', ')} WHERE id = ?`, ...params);
  res.json(get(`SELECT * FROM crews WHERE id = ?`, id));
});

crewsRouter.delete('/crews/:id', (req, res) => {
  const t = req.tenant.id;
  const id = Number(req.params.id);
  if (!get(`SELECT id FROM crews WHERE tenant_id = ? AND id = ?`, t, id)) {
    res.status(404).json({ error: 'crew not found' });
    return;
  }
  run(`UPDATE employees SET crew_id = NULL WHERE tenant_id = ? AND crew_id = ?`, t, id);
  run(`DELETE FROM crews WHERE id = ?`, id);
  res.json({ ok: true });
});

crewsRouter.post('/crews/:id/members', (req, res) => {
  const t = req.tenant.id;
  const id = Number(req.params.id);
  const empId = Number((req.body as { employee_id?: number }).employee_id);
  if (!get(`SELECT id FROM crews WHERE tenant_id = ? AND id = ?`, t, id)) {
    res.status(404).json({ error: 'crew not found' });
    return;
  }
  if (!get(`SELECT id FROM employees WHERE tenant_id = ? AND id = ?`, t, empId)) {
    res.status(404).json({ error: 'employee not found' });
    return;
  }
  run(`UPDATE employees SET crew_id = ? WHERE id = ?`, id, empId);
  res.json({ ok: true });
});

crewsRouter.delete('/crews/:id/members/:empId', (req, res) => {
  const t = req.tenant.id;
  run(
    `UPDATE employees SET crew_id = NULL WHERE tenant_id = ? AND id = ? AND crew_id = ?`,
    t, Number(req.params.empId), Number(req.params.id),
  );
  res.json({ ok: true });
});

crewsRouter.patch('/employees/:id', (req, res) => {
  const t = req.tenant.id;
  const id = Number(req.params.id);
  if (!get(`SELECT id FROM employees WHERE tenant_id = ? AND id = ?`, t, id)) {
    res.status(404).json({ error: 'employee not found' });
    return;
  }
  const b = req.body as Record<string, unknown>;
  const fields: string[] = [];
  const params: (string | number | null)[] = [];
  const allow: Record<string, (v: unknown) => string | number | null> = {
    role: (v) => String(v),
    crew_id: (v) => (v === null ? null : Number(v)),
    active: (v) => (v ? 1 : 0),
    phone: (v) => (v === null ? null : String(v)),
  };
  for (const [key, fn] of Object.entries(allow)) {
    if (key in b) { fields.push(`${key} = ?`); params.push(fn(b[key])); }
  }
  if (fields.length === 0) { res.status(400).json({ error: 'no editable fields supplied' }); return; }
  params.push(id);
  run(`UPDATE employees SET ${fields.join(', ')} WHERE id = ?`, ...params);
  res.json(get(`SELECT id, name, role, phone, crew_id, active FROM employees WHERE id = ?`, id));
});

/* ---------------- schedule timeline ---------------- */

export interface SchedulePhase {
  phase: string;
  start: string | null;
  end: string | null;
  pct_complete: number;
  status: 'behind' | 'ahead' | 'on_track';
  days_variance: number | null;
  activities: {
    plan_id: number; activity: string; unit: string; pct_complete: number;
    planned_start: string | null; planned_end: string | null;
    days_variance: number | null; at_risk: boolean;
  }[];
}

crewsRouter.get('/schedule', (req, res) => {
  const t = req.tenant.id;
  const projections = computeProjections(t);
  const plans = all<{ id: number; jobsite_id: number; phase: string; planned_start: string | null; planned_end: string | null }>(
    `SELECT id, jobsite_id, phase, planned_start, planned_end FROM production_plans WHERE tenant_id = ?`,
    t,
  );
  const jobsites = all<{ id: number; name: string; code: string; status: string; pm_id: number | null; pe_id: number | null }>(
    `SELECT id, name, code, status, pm_id, pe_id FROM jobsites WHERE tenant_id = ? ORDER BY name`,
    t,
  );
  const names = new Map(
    all<{ id: number; name: string }>(`SELECT id, name FROM employees WHERE tenant_id = ?`, t).map((e) => [e.id, e.name]),
  );
  const projByPlan = new Map(projections.map((p) => [p.plan_id, p]));

  const out = jobsites.map((j) => {
    const sitePlans = plans.filter((p) => p.jobsite_id === j.id);
    const phaseNames = [...new Set(sitePlans.map((p) => p.phase))];
    const phases: SchedulePhase[] = phaseNames.map((phase) => {
      const rows = sitePlans.filter((p) => p.phase === phase);
      const starts = rows.map((r) => r.planned_start).filter(Boolean) as string[];
      const ends = rows.map((r) => r.planned_end).filter(Boolean) as string[];
      const activities = rows.map((r) => {
        const pj = projByPlan.get(r.id);
        return {
          plan_id: r.id,
          activity: pj?.activity ?? '',
          unit: pj?.unit ?? '',
          pct_complete: pj?.pct_complete ?? 0,
          planned_start: r.planned_start,
          planned_end: r.planned_end,
          days_variance: pj?.days_variance ?? null,
          at_risk: pj?.at_risk ?? false,
        };
      });
      const variances = activities.map((a) => a.days_variance).filter((v): v is number => v !== null);
      const worst = variances.length ? Math.max(...variances) : null;
      // Behind when any activity projects past its planned end; ahead when
      // everything projects at least 3 days early; otherwise on track.
      const status: SchedulePhase['status'] =
        worst !== null && worst > 0 ? 'behind' : worst !== null && worst <= -3 ? 'ahead' : 'on_track';
      const pct =
        activities.length > 0
          ? Math.round((activities.reduce((s, a) => s + a.pct_complete, 0) / activities.length) * 10) / 10
          : 0;
      return {
        phase,
        start: starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : null,
        end: ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : null,
        pct_complete: pct,
        status,
        days_variance: worst,
        activities,
      };
    });
    phases.sort((a, b) => (a.start ?? '9999').localeCompare(b.start ?? '9999'));
    const siteWorst = phases.map((p) => p.days_variance).filter((v): v is number => v !== null);
    const worstVar = siteWorst.length ? Math.max(...siteWorst) : null;
    return {
      jobsite_id: j.id,
      name: j.name,
      code: j.code,
      status: j.status,
      pm_id: j.pm_id,
      pm_name: j.pm_id ? (names.get(j.pm_id) ?? null) : null,
      pe_id: j.pe_id,
      pe_name: j.pe_id ? (names.get(j.pe_id) ?? null) : null,
      schedule_status:
        worstVar !== null && worstVar > 0 ? 'behind' : worstVar !== null && worstVar <= -3 ? 'ahead' : 'on_track',
      days_variance: worstVar,
      phases,
    };
  });
  res.json(out);
});

crewsRouter.post('/schedule/phases', (req, res) => {
  const t = req.tenant.id;
  const b = req.body as {
    jobsite_id?: number; phase?: string; activity?: string; unit?: string;
    planned_qty?: number; planned_hours?: number; planned_start?: string; planned_end?: string;
  };
  if (!b.jobsite_id || !b.phase || !b.activity || !b.planned_start || !b.planned_end) {
    res.status(400).json({ error: 'jobsite_id, phase, activity, planned_start, planned_end are required' });
    return;
  }
  if (!get(`SELECT id FROM jobsites WHERE tenant_id = ? AND id = ?`, t, b.jobsite_id)) {
    res.status(404).json({ error: 'jobsite not found' });
    return;
  }
  const result = run(
    `INSERT INTO production_plans (tenant_id, jobsite_id, phase, activity, unit, planned_qty, planned_hours, planned_start, planned_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    t, b.jobsite_id, b.phase, b.activity, b.unit ?? 'LS',
    b.planned_qty ?? 1, b.planned_hours ?? 0, b.planned_start, b.planned_end,
  );
  res.status(201).json(get(`SELECT * FROM production_plans WHERE id = ?`, Number(result.lastInsertRowid)));
});
