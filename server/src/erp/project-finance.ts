import { all, get, getDb, run, nowIso } from "../db/database.js";
import { getErpOverview } from "./overview.js";
import { ErpError } from "./validation.js";

export function initializeProjectFinance() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS project_calendars (
      jobsite_id INTEGER PRIMARY KEY REFERENCES jobsites(id), tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      weekdays TEXT NOT NULL, holidays TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS work_dependencies (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), jobsite_id INTEGER NOT NULL REFERENCES jobsites(id),
      predecessor_id INTEGER NOT NULL REFERENCES production_plans(id), successor_id INTEGER NOT NULL REFERENCES production_plans(id),
      lag_days INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(tenant_id,predecessor_id,successor_id), CHECK(predecessor_id != successor_id)
    );
    CREATE TABLE IF NOT EXISTS project_baselines (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), jobsite_id INTEGER NOT NULL REFERENCES jobsites(id),
      version INTEGER NOT NULL, title TEXT NOT NULL, explanation TEXT NOT NULL, snapshot TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','approved')), created_at TEXT NOT NULL, approved_at TEXT, approved_by TEXT,
      UNIQUE(tenant_id,jobsite_id,version)
    );
    CREATE TRIGGER IF NOT EXISTS baseline_freeze BEFORE UPDATE ON project_baselines WHEN OLD.status='approved'
      BEGIN SELECT RAISE(ABORT,'Approved baselines are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS baseline_delete_guard BEFORE DELETE ON project_baselines
      BEGIN SELECT RAISE(ABORT,'Baseline history cannot be deleted'); END;
    CREATE TABLE IF NOT EXISTS cost_forecasts (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), jobsite_id INTEGER NOT NULL REFERENCES jobsites(id),
      version INTEGER NOT NULL, as_of TEXT NOT NULL, forecast_finish TEXT NOT NULL, explanation TEXT NOT NULL,
      actual_cost_cents INTEGER NOT NULL, remaining_cost_cents INTEGER NOT NULL, estimate_at_completion_cents INTEGER NOT NULL,
      committed_reference_cents INTEGER NOT NULL, working_days_remaining INTEGER NOT NULL, calendar_snapshot TEXT NOT NULL,
      lines TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','approved')), created_at TEXT NOT NULL, approved_at TEXT, approved_by TEXT,
      UNIQUE(tenant_id,jobsite_id,version)
    );
    CREATE TRIGGER IF NOT EXISTS cost_forecast_freeze BEFORE UPDATE ON cost_forecasts WHEN OLD.status='approved'
      BEGIN SELECT RAISE(ABORT,'Approved cost forecasts are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS cost_forecast_delete_guard BEFORE DELETE ON cost_forecasts
      BEGIN SELECT RAISE(ABORT,'Forecast history cannot be deleted'); END;
    CREATE TABLE IF NOT EXISTS billing_pay_items (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), jobsite_id INTEGER NOT NULL REFERENCES jobsites(id),
      code TEXT NOT NULL, description TEXT NOT NULL, unit TEXT NOT NULL, total_qty REAL NOT NULL,
      scheduled_value_cents INTEGER NOT NULL CHECK(scheduled_value_cents>0), plan_id INTEGER REFERENCES production_plans(id),
      created_at TEXT NOT NULL, UNIQUE(tenant_id,jobsite_id,code)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS billing_one_work_item ON billing_pay_items(tenant_id,plan_id) WHERE plan_id IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS billing_pay_item_update_guard BEFORE UPDATE ON billing_pay_items
      BEGIN SELECT RAISE(ABORT,'Pay item schedule history cannot be changed'); END;
    CREATE TRIGGER IF NOT EXISTS billing_pay_item_delete_guard BEFORE DELETE ON billing_pay_items
      BEGIN SELECT RAISE(ABORT,'Pay item schedule history cannot be deleted'); END;
    CREATE TABLE IF NOT EXISTS payment_applications (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), jobsite_id INTEGER NOT NULL REFERENCES jobsites(id),
      number INTEGER NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, retainage_pct REAL NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft','submitted','approved','void')), evidence_reference TEXT NOT NULL,
      previous_earned_cents INTEGER NOT NULL, cumulative_earned_cents INTEGER NOT NULL, current_earned_cents INTEGER NOT NULL,
      retainage_cents INTEGER NOT NULL, due_cents INTEGER NOT NULL, lines TEXT NOT NULL, created_at TEXT NOT NULL,
      submitted_at TEXT, approved_at TEXT, approved_by TEXT, void_reason TEXT, UNIQUE(tenant_id,jobsite_id,number)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS billing_one_open_application ON payment_applications(tenant_id,jobsite_id) WHERE status IN ('draft','submitted');
    CREATE TRIGGER IF NOT EXISTS payment_application_freeze BEFORE UPDATE ON payment_applications WHEN OLD.status='approved'
      BEGIN SELECT RAISE(ABORT,'Approved payment applications are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS payment_application_delete_guard BEFORE DELETE ON payment_applications
      BEGIN SELECT RAISE(ABORT,'Payment application history cannot be deleted'); END;
    CREATE TABLE IF NOT EXISTS customer_payments (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), application_id INTEGER NOT NULL REFERENCES payment_applications(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents>0), received_date TEXT NOT NULL, reference TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(tenant_id,reference)
    );
    CREATE TABLE IF NOT EXISTS retainage_releases (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), jobsite_id INTEGER NOT NULL REFERENCES jobsites(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents>0), release_date TEXT NOT NULL, acceptance_reference TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(tenant_id,jobsite_id,acceptance_reference)
    );
    CREATE TABLE IF NOT EXISTS retainage_payments (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), release_id INTEGER NOT NULL REFERENCES retainage_releases(id),
      amount_cents INTEGER NOT NULL CHECK(amount_cents>0), received_date TEXT NOT NULL, reference TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(tenant_id,reference)
    );
    CREATE TABLE IF NOT EXISTS project_closeout_items (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), jobsite_id INTEGER NOT NULL REFERENCES jobsites(id),
      title TEXT NOT NULL, required INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL CHECK(status IN ('open','complete')),
      evidence_reference TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS project_closeouts (
      jobsite_id INTEGER PRIMARY KEY REFERENCES jobsites(id), tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      acceptance_reference TEXT NOT NULL, closed_at TEXT NOT NULL, closed_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS finance_baselines_tenant_job ON project_baselines(tenant_id,jobsite_id,version);
    CREATE INDEX IF NOT EXISTS finance_forecasts_tenant_job ON cost_forecasts(tenant_id,jobsite_id,version);
    CREATE INDEX IF NOT EXISTS finance_billing_tenant_job ON payment_applications(tenant_id,jobsite_id,status);
  `);
  for (const table of [
    "customer_payments",
    "retainage_releases",
    "retainage_payments",
    "project_closeouts",
  ]) {
    getDb()
      .exec(`CREATE TRIGGER IF NOT EXISTS ${table}_update_guard BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Finance history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_delete_guard BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Finance history cannot be deleted'); END;`);
  }
}

export const cents = (value: number) => {
  const amount = Math.round((value + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(amount))
    throw new ErpError(
      400,
      "Money amount exceeds the supported cent precision",
    );
  return amount;
};
export const dollars = (value: number) => value / 100;
export function financeRelated<T extends Record<string, unknown>>(
  tenantId: number,
  table: string,
  recordId: number,
): T {
  const allowed = [
    "project_baselines",
    "cost_forecasts",
    "billing_pay_items",
    "payment_applications",
    "project_closeout_items",
    "retainage_releases",
    "work_dependencies",
  ];
  if (!allowed.includes(table)) throw new Error("Unsupported finance table");
  const row = get<T>(
    `SELECT * FROM ${table} WHERE tenant_id=? AND id=?`,
    tenantId,
    recordId,
  );
  if (!row) throw new ErpError(404, "Finance record not found");
  return row;
}
export function projectCalendar(
  tenantId: number,
  jobsiteId: number,
): { weekdays: number[]; holidays: string[] } {
  const row = get<{ weekdays: string; holidays: string }>(
    "SELECT weekdays,holidays FROM project_calendars WHERE tenant_id=? AND jobsite_id=?",
    tenantId,
    jobsiteId,
  );
  return row
    ? { weekdays: JSON.parse(row.weekdays), holidays: JSON.parse(row.holidays) }
    : { weekdays: [1, 2, 3, 4, 5], holidays: [] };
}
export function workingDays(
  start: string,
  finish: string,
  calendar: { weekdays: number[]; holidays: string[] },
): number {
  let count = 0;
  for (
    let d = new Date(`${start}T00:00:00Z`),
      end = new Date(`${finish}T00:00:00Z`);
    d <= end;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    if (
      calendar.weekdays.includes(d.getUTCDay()) &&
      !calendar.holidays.includes(d.toISOString().slice(0, 10))
    )
      count++;
    if (count > 36600)
      throw new ErpError(400, "Forecast horizon must be within 100 years");
  }
  return count;
}
/** Billing evidence is measured production through the application period; machine estimates are excluded. */
export function measuredQuantity(
  tenantId: number,
  planId: number,
  through: string,
): number {
  const reversalTable = get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='daily_report_reversals'",
  );
  const reversalClause = reversalTable
    ? "AND NOT EXISTS(SELECT 1 FROM daily_report_reversals x WHERE x.report_id=r.id AND x.tenant_id=r.tenant_id)"
    : "";
  const manual = get<{ quantity: number }>(
    "SELECT COALESCE(SUM(qty),0) quantity FROM production_entries WHERE tenant_id=? AND plan_id=? AND date<=? AND source='manual'",
    tenantId,
    planId,
    through,
  )!.quantity;
  const daily = get<{ quantity: number }>(
    `SELECT COALESCE(SUM(l.qty),0) quantity FROM daily_report_lines l JOIN daily_reports r ON r.id=l.report_id AND r.tenant_id=l.tenant_id
    WHERE l.tenant_id=? AND l.plan_id=? AND r.status='approved' AND r.date<=? ${reversalClause}`,
    tenantId,
    planId,
    through,
  )!.quantity;
  return manual + daily;
}
export interface PayItem extends Record<string, unknown> {
  id: number;
  tenant_id: number;
  jobsite_id: number;
  code: string;
  description: string;
  unit: string;
  total_qty: number;
  scheduled_value_cents: number;
  plan_id: number | null;
}
export interface BillingLine {
  pay_item_id: number;
  code: string;
  description: string;
  unit: string;
  scheduled_value_cents: number;
  total_qty: number;
  plan_id: number | null;
  previous_qty: number;
  cumulative_qty: number | null;
  previous_earned_cents: number;
  cumulative_earned_cents: number;
  current_earned_cents: number;
}
export interface Application extends Record<string, unknown> {
  id: number;
  tenant_id: number;
  jobsite_id: number;
  number: number;
  period_start: string;
  period_end: string;
  retainage_pct: number;
  status: "draft" | "submitted" | "approved" | "void";
  lines: string;
  previous_earned_cents: number;
  cumulative_earned_cents: number;
  current_earned_cents: number;
  retainage_cents: number;
  due_cents: number;
}
export function priorApplication(
  tenant: number,
  project: number,
): Application | undefined {
  return get<Application>(
    "SELECT * FROM payment_applications WHERE tenant_id=? AND jobsite_id=? AND status='approved' ORDER BY number DESC LIMIT 1",
    tenant,
    project,
  );
}
export function validateApplicationEvidence(tenant: number, app: Application) {
  const contract =
    get<{ contract_value: number }>(
      "SELECT contract_value FROM project_profiles WHERE tenant_id=? AND jobsite_id=?",
      tenant,
      app.jobsite_id,
    )?.contract_value ?? 0;
  if (app.cumulative_earned_cents > cents(contract))
    throw new ErpError(
      409,
      "Cumulative earned billing exceeds the current approved contract",
    );
  const previous = priorApplication(tenant, app.jobsite_id);
  if ((previous?.cumulative_earned_cents ?? 0) !== app.previous_earned_cents)
    throw new ErpError(
      409,
      "Another approved application changed the billing baseline; withdraw and recreate this application",
    );
  for (const line of JSON.parse(app.lines) as BillingLine[]) {
    if (
      line.plan_id !== null &&
      (line.cumulative_qty ?? 0) >
        measuredQuantity(tenant, line.plan_id, app.period_end) + 1e-7
    ) {
      throw new ErpError(
        409,
        `Pay item ${line.code} exceeds measured accepted quantity through ${app.period_end}`,
      );
    }
  }
}
export function getProjectFinance(tenant: number) {
  const overview = getErpOverview(tenant);
  const projectNames = new Map(overview.projects.map((p) => [p.id, p.name]));
  const withProject = <T extends { jobsite_id: number }>(row: T) => ({
    ...row,
    jobsite_name: projectNames.get(row.jobsite_id) ?? "",
  });
  const baselines = all<
    Record<string, unknown> & { jobsite_id: number; snapshot: string }
  >(
    "SELECT * FROM project_baselines WHERE tenant_id=? ORDER BY id DESC",
    tenant,
  ).map((row) => withProject({ ...row, snapshot: JSON.parse(row.snapshot) }));
  const forecasts = all<
    Record<string, unknown> & {
      jobsite_id: number;
      lines: string;
      calendar_snapshot: string;
      actual_cost_cents: number;
      remaining_cost_cents: number;
      estimate_at_completion_cents: number;
      committed_reference_cents: number;
    }
  >(
    "SELECT * FROM cost_forecasts WHERE tenant_id=? ORDER BY id DESC",
    tenant,
  ).map((row) =>
    withProject({
      ...row,
      lines: JSON.parse(row.lines),
      calendar_snapshot: JSON.parse(row.calendar_snapshot),
      actual_cost: dollars(row.actual_cost_cents),
      remaining_cost: dollars(row.remaining_cost_cents),
      estimate_at_completion: dollars(row.estimate_at_completion_cents),
      committed_reference: dollars(row.committed_reference_cents),
    }),
  );
  const payItems = all<PayItem>(
    "SELECT * FROM billing_pay_items WHERE tenant_id=? ORDER BY jobsite_id,code",
    tenant,
  ).map((row) =>
    withProject({
      ...row,
      scheduled_value: dollars(row.scheduled_value_cents),
      measured_qty:
        row.plan_id === null
          ? null
          : measuredQuantity(tenant, row.plan_id, "9999-12-31"),
    }),
  );
  const applications = all<Application>(
    "SELECT * FROM payment_applications WHERE tenant_id=? ORDER BY id DESC",
    tenant,
  ).map((row) => {
    const paid = get<{ amount: number }>(
      "SELECT COALESCE(SUM(amount_cents),0) amount FROM customer_payments WHERE tenant_id=? AND application_id=?",
      tenant,
      row.id,
    )!.amount;
    const lines = JSON.parse(row.lines) as BillingLine[];
    return withProject({
      ...row,
      lines,
      previous_earned: dollars(row.previous_earned_cents),
      cumulative_earned: dollars(row.cumulative_earned_cents),
      current_earned: dollars(row.current_earned_cents),
      retainage: dollars(row.retainage_cents),
      due: dollars(row.due_cents),
      paid: dollars(paid),
      unpaid: dollars(row.due_cents - paid),
      evidence_warning:
        row.status === "approved" &&
        lines.some(
          (l) =>
            l.plan_id !== null &&
            (l.cumulative_qty ?? 0) >
              measuredQuantity(tenant, l.plan_id, "9999-12-31") + 1e-7,
        )
          ? "Recorded quantity was subsequently reversed; review this certified application."
          : null,
    });
  });
  const releases = all<
    Record<string, unknown> & {
      id: number;
      jobsite_id: number;
      amount_cents: number;
    }
  >(
    "SELECT * FROM retainage_releases WHERE tenant_id=? ORDER BY id DESC",
    tenant,
  ).map((row) => {
    const paid = get<{ amount: number }>(
      "SELECT COALESCE(SUM(amount_cents),0) amount FROM retainage_payments WHERE tenant_id=? AND release_id=?",
      tenant,
      row.id,
    )!.amount;
    return withProject({
      ...row,
      amount: dollars(row.amount_cents),
      paid: dollars(paid),
      unpaid: dollars(row.amount_cents - paid),
    });
  });
  return {
    calendars: overview.projects.map((p) => ({
      jobsite_id: p.id,
      jobsite_name: p.name,
      ...projectCalendar(tenant, p.id),
    })),
    dependencies: all<{ jobsite_id: number }>(
      "SELECT * FROM work_dependencies WHERE tenant_id=? ORDER BY id",
      tenant,
    ).map(withProject),
    baselines,
    forecasts,
    pay_items: payItems,
    applications,
    payments: all(
      "SELECT p.*,a.jobsite_id,j.name jobsite_name,p.amount_cents/100.0 amount FROM customer_payments p JOIN payment_applications a ON a.id=p.application_id AND a.tenant_id=p.tenant_id JOIN jobsites j ON j.id=a.jobsite_id AND j.tenant_id=a.tenant_id WHERE p.tenant_id=? ORDER BY p.id DESC",
      tenant,
    ),
    retainage_releases: releases,
    retainage_payments: all(
      "SELECT p.*,r.jobsite_id,p.amount_cents/100.0 amount FROM retainage_payments p JOIN retainage_releases r ON r.id=p.release_id AND r.tenant_id=p.tenant_id WHERE p.tenant_id=? ORDER BY p.id DESC",
      tenant,
    ),
    closeout_items: all<{ jobsite_id: number }>(
      "SELECT * FROM project_closeout_items WHERE tenant_id=? ORDER BY id",
      tenant,
    ).map(withProject),
    closeouts: all<{ jobsite_id: number }>(
      "SELECT * FROM project_closeouts WHERE tenant_id=? ORDER BY closed_at DESC",
      tenant,
    ).map(withProject),
  };
}
