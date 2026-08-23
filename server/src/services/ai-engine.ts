/**
 * AI analysis engine — deterministic heuristics over telemetry + field data.
 *
 * Every feature is gated by its ai_settings toggle (missing row = enabled),
 * so the field can switch any piece of automation off. Outputs land as
 * reviewable rows — ai_insights suggestions, draft timecards, ai_auto
 * production entries — never silent mutations of human-entered data:
 * "AI automated, manually overridable."
 */

import { all, get, nowIso, run } from '../db/database.js';

export interface AiRunStats {
  insightsCreated: number;
  productionEntries: number;
  timecardsSuggested: number;
}

export interface ProjectionRow {
  plan_id: number;
  jobsite_id: number;
  jobsite_name: string;
  phase: string;
  activity: string;
  unit: string;
  planned_qty: number;
  planned_hours: number;
  actual_qty: number;
  actual_hours: number;
  pct_complete: number;
  rate_qty_per_day: number;
  projected_finish: string | null;
  planned_end: string | null;
  days_variance: number | null;
  at_risk: boolean;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Today as a UTC date string (YYYY-MM-DD) — matches ISO timestamps lexically. */
function utcToday(): string {
  return nowIso().slice(0, 10);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** ai_settings gate — a missing row means the feature is enabled. */
function featureEnabled(tenantId: number, feature: string): boolean {
  const row = get<{ enabled: number }>(
    `SELECT enabled FROM ai_settings WHERE tenant_id = ? AND feature = ?`,
    tenantId, feature,
  );
  return row ? row.enabled === 1 : true;
}

function createInsight(
  tenantId: number,
  i: {
    jobsite_id: number | null;
    asset_id: number | null;
    kind: string;
    severity: string;
    title: string;
    body: string;
    data: unknown;
  },
): void {
  run(
    `INSERT INTO ai_insights (tenant_id, jobsite_id, asset_id, kind, severity, title, body, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    tenantId, i.jobsite_id, i.asset_id, i.kind, i.severity, i.title, i.body, JSON.stringify(i.data),
  );
}

/**
 * Engine-hours worked today per asset. Start of day = earliest engine_hours
 * reading with ts >= today's UTC date; delta = latest − earliest. Assets with
 * fewer than 2 readings today have no usable baseline and are skipped.
 */
function engineHoursToday(tenantId: number, today: string): Map<number, number> {
  const rows = all<{ asset_id: number; value: number }>(
    `SELECT asset_id, value FROM telemetry_readings
     WHERE tenant_id = ? AND metric = 'engine_hours' AND ts >= ?
     ORDER BY asset_id, ts`,
    tenantId, today,
  );
  const acc = new Map<number, { first: number; last: number; count: number }>();
  for (const r of rows) {
    const cur = acc.get(r.asset_id);
    if (!cur) acc.set(r.asset_id, { first: r.value, last: r.value, count: 1 });
    else { cur.last = r.value; cur.count++; }
  }
  const deltas = new Map<number, number>();
  for (const [assetId, v] of acc) {
    if (v.count < 2) continue;
    deltas.set(assetId, Math.max(0, v.last - v.first));
  }
  return deltas;
}

/**
 * production_auto: for each plan on an active jobsite whose machines produced
 * telemetry today, upsert today's ai_auto production entry. Hours = summed
 * engine-hour deltas of the jobsite's machines; qty = hours at the planned
 * rate (planned_qty / planned_hours). A human-corrected row is left alone.
 */
function runProductionAuto(tenantId: number, today: string, deltas: Map<number, number>): number {
  const plans = all<{ id: number; jobsite_id: number; planned_qty: number; planned_hours: number }>(
    `SELECT p.id, p.jobsite_id, p.planned_qty, p.planned_hours
     FROM production_plans p JOIN jobsites j ON j.id = p.jobsite_id
     WHERE p.tenant_id = ? AND j.status = 'active'`,
    tenantId,
  );
  const machines = all<{ id: number; jobsite_id: number | null }>(
    `SELECT id, jobsite_id FROM assets WHERE tenant_id = ? AND kind = 'machine'`,
    tenantId,
  );
  const siteHours = new Map<number, number>();
  for (const m of machines) {
    const d = deltas.get(m.id);
    if (m.jobsite_id === null || d === undefined) continue;
    siteHours.set(m.jobsite_id, (siteHours.get(m.jobsite_id) ?? 0) + d);
  }
  let upserted = 0;
  for (const p of plans) {
    const hours = round2(siteHours.get(p.jobsite_id) ?? 0);
    if (hours <= 0 || p.planned_hours <= 0) continue;
    const qty = round1(hours * (p.planned_qty / p.planned_hours));
    // UNIQUE(plan_id, date, source): insert once, then refresh today's numbers
    // unless the field corrected the row (corrected=1 wins).
    run(
      `INSERT OR IGNORE INTO production_entries (tenant_id, plan_id, date, qty, hours, source)
       VALUES (?, ?, ?, ?, ?, 'ai_auto')`,
      tenantId, p.id, today, qty, hours,
    );
    run(
      `UPDATE production_entries SET qty = ?, hours = ?
       WHERE plan_id = ? AND date = ? AND source = 'ai_auto' AND corrected = 0`,
      qty, hours, p.id, today,
    );
    upserted++;
  }
  return upserted;
}

/**
 * timecards_auto: draft a timecard for each operator/driver whose assigned
 * machine (assets.operator = employees.name) ran today. Hours are the engine
 * delta rounded to the half hour, clamped to a plausible 4..12h shift.
 * UNIQUE(employee, date, source) keeps one draft per person per day.
 */
function runTimecardsAuto(tenantId: number, today: string, deltas: Map<number, number>): number {
  const pairs = all<{ employee_id: number; asset_id: number; jobsite_id: number | null }>(
    `SELECT e.id AS employee_id, a.id AS asset_id, a.jobsite_id
     FROM employees e
     JOIN assets a ON a.tenant_id = e.tenant_id AND a.operator = e.name
     WHERE e.tenant_id = ? AND e.active = 1 AND e.role IN ('operator', 'driver')
     ORDER BY e.id, a.id`,
    tenantId,
  );
  let suggested = 0;
  for (const p of pairs) {
    const delta = deltas.get(p.asset_id);
    if (delta === undefined || delta <= 0.5) continue;
    const hours = Math.min(12, Math.max(4, Math.round(delta * 2) / 2));
    const res = run(
      `INSERT OR IGNORE INTO timecards
         (tenant_id, employee_id, jobsite_id, date, hours, asset_id, source, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, 'ai_auto', 'draft', ?)`,
      tenantId, p.employee_id, p.jobsite_id, today, hours, p.asset_id,
      `Auto-drafted from ${round1(delta)} engine hours`,
    );
    if (Number(res.changes) > 0) suggested++;
  }
  return suggested;
}

/**
 * projections_auto: surface at-risk plans (projected finish past planned end)
 * as warning insights, one open suggestion per jobsite at a time.
 */
function runProjectionsAuto(tenantId: number): number {
  let created = 0;
  for (const p of computeProjections(tenantId)) {
    if (!p.at_risk) continue;
    const dup = get<{ id: number }>(
      `SELECT id FROM ai_insights
       WHERE tenant_id = ? AND kind = 'projection' AND jobsite_id = ? AND status = 'suggested'
       LIMIT 1`,
      tenantId, p.jobsite_id,
    );
    if (dup) continue;
    createInsight(tenantId, {
      jobsite_id: p.jobsite_id,
      asset_id: null,
      kind: 'projection',
      severity: 'warning',
      title: `Schedule risk — ${p.activity} at ${p.jobsite_name}`,
      body:
        `${p.activity} (${p.phase}) is ${p.pct_complete}% complete at ` +
        `${p.rate_qty_per_day} ${p.unit}/day. Projected finish ${p.projected_finish} runs ` +
        `${p.days_variance} day(s) past the planned end ${p.planned_end}.`,
      data: p,
    });
    created++;
  }
  return created;
}

/**
 * idle_alerts_auto: a machine burning fuel at under 55% utilization is money
 * idling — one open suggestion per machine at a time.
 */
function runIdleAlerts(tenantId: number): number {
  const machines = all<{
    id: number; jobsite_id: number | null; name: string;
    utilization_pct: number; idle_hours: number | null;
  }>(
    `SELECT a.id, a.jobsite_id, a.name, s.utilization_pct, s.idle_hours
     FROM assets a JOIN asset_state s ON s.asset_id = a.id
     WHERE a.tenant_id = ? AND a.kind = 'machine' AND s.engine_status = 'running'
       AND s.utilization_pct IS NOT NULL AND s.utilization_pct < 55
     ORDER BY a.id`,
    tenantId,
  );
  let created = 0;
  for (const m of machines) {
    const dup = get<{ id: number }>(
      `SELECT id FROM ai_insights
       WHERE tenant_id = ? AND kind = 'idle_alert' AND asset_id = ? AND status = 'suggested'
       LIMIT 1`,
      tenantId, m.id,
    );
    if (dup) continue;
    createInsight(tenantId, {
      jobsite_id: m.jobsite_id,
      asset_id: m.id,
      kind: 'idle_alert',
      severity: 'info',
      title: `Excessive idle — ${m.name}`,
      body:
        `${m.name} is running at ${round1(m.utilization_pct)}% utilization` +
        `${m.idle_hours != null ? ` (${round1(m.idle_hours)} lifetime idle hours)` : ''}. ` +
        `Consider shutting it down or re-tasking it.`,
      data: { asset_id: m.id, utilization_pct: m.utilization_pct, idle_hours: m.idle_hours },
    });
    created++;
  }
  return created;
}

/**
 * fault_triage_auto: turn active critical/high fault codes into triage
 * suggestions with a concrete next step. Deduped per asset + fault code so
 * a recurring code doesn't spam the queue while a suggestion is open.
 */
function runFaultTriage(tenantId: number): number {
  const faults = all<{
    asset_id: number; jobsite_id: number | null; asset_name: string;
    code: string; severity: string; description: string; occurred_at: string;
  }>(
    `SELECT f.asset_id, a.jobsite_id, a.name AS asset_name,
       f.code, f.severity, f.description, f.occurred_at
     FROM fault_codes f JOIN assets a ON a.id = f.asset_id
     WHERE f.tenant_id = ? AND f.active = 1 AND f.severity IN ('critical', 'high')
     ORDER BY f.asset_id, f.code`,
    tenantId,
  );
  let created = 0;
  for (const f of faults) {
    const open = all<{ data: string | null }>(
      `SELECT data FROM ai_insights
       WHERE tenant_id = ? AND kind = 'fault_triage' AND asset_id = ? AND status = 'suggested'`,
      tenantId, f.asset_id,
    );
    const alreadySuggested = open.some((r) => {
      try {
        return (JSON.parse(r.data ?? '{}') as { code?: string }).code === f.code;
      } catch {
        return false;
      }
    });
    if (alreadySuggested) continue;
    const critical = f.severity === 'critical';
    const suggestion = critical
      ? 'Stop the machine and dispatch a mechanic before further operation.'
      : 'Schedule a service visit within 24 hours and monitor the machine.';
    createInsight(tenantId, {
      jobsite_id: f.jobsite_id,
      asset_id: f.asset_id,
      kind: 'fault_triage',
      severity: critical ? 'critical' : 'warning',
      title: `Fault ${f.code} on ${f.asset_name}`,
      body: `${f.description} (active since ${f.occurred_at}). ${suggestion}`,
      data: { asset_id: f.asset_id, code: f.code, severity: f.severity, occurred_at: f.occurred_at },
    });
    created++;
  }
  return created;
}

/** One full analysis pass for a tenant. Each feature honors its toggle. */
export function runAiAnalysis(tenantId: number): AiRunStats {
  const today = utcToday();
  const deltas = engineHoursToday(tenantId, today);
  const stats: AiRunStats = { insightsCreated: 0, productionEntries: 0, timecardsSuggested: 0 };
  if (featureEnabled(tenantId, 'production_auto')) {
    stats.productionEntries = runProductionAuto(tenantId, today, deltas);
  }
  if (featureEnabled(tenantId, 'timecards_auto')) {
    stats.timecardsSuggested = runTimecardsAuto(tenantId, today, deltas);
  }
  if (featureEnabled(tenantId, 'projections_auto')) {
    stats.insightsCreated += runProjectionsAuto(tenantId);
  }
  if (featureEnabled(tenantId, 'idle_alerts_auto')) {
    stats.insightsCreated += runIdleAlerts(tenantId);
  }
  if (featureEnabled(tenantId, 'fault_triage_auto')) {
    stats.insightsCreated += runFaultTriage(tenantId);
  }
  return stats;
}

/**
 * Plan-by-plan schedule projection. Rate = average qty per distinct entry
 * day; projected finish = today + remaining qty at that rate; at_risk when
 * the projection lands past the planned end date.
 */
export function computeProjections(tenantId: number): ProjectionRow[] {
  const today = utcToday();
  const plans = all<{
    id: number; jobsite_id: number; jobsite_name: string; phase: string; activity: string;
    unit: string; planned_qty: number; planned_hours: number; planned_end: string | null;
    actual_qty: number | null; actual_hours: number | null; entry_days: number;
  }>(
    `SELECT p.id, p.jobsite_id, j.name AS jobsite_name, p.phase, p.activity, p.unit,
       p.planned_qty, p.planned_hours, p.planned_end,
       SUM(e.qty) AS actual_qty, SUM(e.hours) AS actual_hours,
       COUNT(DISTINCT e.date) AS entry_days
     FROM production_plans p
     JOIN jobsites j ON j.id = p.jobsite_id
     LEFT JOIN production_entries e ON e.plan_id = p.id
     WHERE p.tenant_id = ?
     GROUP BY p.id
     ORDER BY j.name, p.phase, p.activity`,
    tenantId,
  );
  return plans.map((p) => {
    const actualQty = p.actual_qty ?? 0;
    const actualHours = p.actual_hours ?? 0;
    const pctComplete = p.planned_qty > 0
      ? Math.min(100, round1((actualQty / p.planned_qty) * 100))
      : 0;
    const rate = p.entry_days > 0 ? round1(actualQty / p.entry_days) : 0;
    const projectedFinish = rate > 0
      ? addDays(today, Math.ceil(Math.max(0, p.planned_qty - actualQty) / rate))
      : null;
    const daysVariance = projectedFinish && p.planned_end
      ? Math.round((Date.parse(projectedFinish) - Date.parse(p.planned_end)) / 86_400_000)
      : null;
    return {
      plan_id: p.id,
      jobsite_id: p.jobsite_id,
      jobsite_name: p.jobsite_name,
      phase: p.phase,
      activity: p.activity,
      unit: p.unit,
      planned_qty: p.planned_qty,
      planned_hours: p.planned_hours,
      actual_qty: round1(actualQty),
      actual_hours: round1(actualHours),
      pct_complete: pctComplete,
      rate_qty_per_day: rate,
      projected_finish: projectedFinish,
      planned_end: p.planned_end,
      days_variance: daysVariance,
      at_risk: daysVariance !== null && daysVariance > 0,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Scheduler                                                           */
/* ------------------------------------------------------------------ */

const AI_INTERVAL_MS = 5 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;

export function startAiScheduler(): void {
  if (timer) return;
  const tick = () => {
    for (const t of all<{ id: number }>(`SELECT id FROM tenants ORDER BY id`)) {
      try {
        runAiAnalysis(t.id);
      } catch (err) {
        console.error(`[ai] analysis for tenant ${t.id} failed: ${(err as Error).message}`);
      }
    }
  };
  tick(); // first pass at boot so the demo has insights immediately
  timer = setInterval(tick, AI_INTERVAL_MS);
  timer.unref?.();
  console.log('[ai] scheduler started — every 5 min');
}
