import { Router, type Request, type Response } from "express";
import { all, get, run, transaction, nowIso } from "../../db/database.js";
import { getErpOverview } from "../../erp/overview.js";
import {
  body,
  date,
  dateRange,
  ErpError,
  id,
  number,
  related,
  text,
  option,
} from "../../erp/validation.js";
import {
  cents,
  dollars,
  financeRelated,
  getProjectFinance,
  measuredQuantity,
  priorApplication,
  projectCalendar,
  validateApplicationEvidence,
  workingDays,
  type Application,
  type BillingLine,
  type PayItem,
} from "../../erp/project-finance.js";

export const projectFinanceRouter = Router();
const handle =
  (fn: (req: Request, res: Response) => void) =>
  (req: Request, res: Response, next: (error?: unknown) => void) => {
    try {
      fn(req, res);
    } catch (error) {
      if (error instanceof ErpError)
        res.status(error.status).json({ error: error.message });
      else if (
        error instanceof Error &&
        /UNIQUE constraint failed/.test(error.message)
      )
        res
          .status(409)
          .json({ error: "A conflicting finance record already exists" });
      else next(error);
    }
  };
const actor = (req: Request) => req.authUser?.name ?? "Demo user";
const array = (value: unknown, field: string, max = 2000): unknown[] => {
  if (!Array.isArray(value) || value.length > max)
    throw new ErpError(
      400,
      `${field} must be an array of up to ${max} records`,
    );
  return value;
};
function assertOpenProject(tenant: number, project: number) {
  if (
    get(
      "SELECT jobsite_id FROM project_closeouts WHERE tenant_id=? AND jobsite_id=?",
      tenant,
      project,
    )
  )
    throw new ErpError(409, "This project is closed out");
}
function actualCostThrough(
  tenant: number,
  project: number,
  through: string,
): number {
  const reversal = get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='daily_report_reversals'",
  )
    ? "AND NOT EXISTS(SELECT 1 FROM daily_report_reversals x WHERE x.tenant_id=r.tenant_id AND x.report_id=r.id)"
    : "";
  const voidedLabor = get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='time_entry_voids'",
  )
    ? "AND NOT EXISTS(SELECT 1 FROM time_entry_postings p JOIN time_entry_voids v ON v.time_entry_id=p.time_entry_id AND v.tenant_id=p.tenant_id WHERE p.job_cost_entry_id=c.id AND p.tenant_id=c.tenant_id)"
    : "";
  const cost = get<{ amount: number }>(
    `SELECT COALESCE(SUM(c.amount),0) amount FROM job_cost_entries c WHERE c.tenant_id=? AND c.jobsite_id=? AND c.date<=? ${voidedLabor}`,
    tenant,
    project,
    through,
  )!.amount;
  const report = get<{ amount: number }>(
    `SELECT COALESCE(SUM(l.labor_cost+l.equipment_cost+l.material_cost),0) amount FROM daily_report_lines l JOIN daily_reports r ON r.id=l.report_id AND r.tenant_id=l.tenant_id WHERE r.tenant_id=? AND r.jobsite_id=? AND r.date<=? AND r.status='approved' ${reversal}`,
    tenant,
    project,
    through,
  )!.amount;
  return cents(cost + report);
}
projectFinanceRouter.get(
  "/erp/project-finance",
  handle((req, res) => res.json(getProjectFinance(req.tenant.id))),
);
projectFinanceRouter.put(
  "/erp/project-calendars/:jobsiteId",
  handle((req, res) => {
    const tenant = req.tenant.id,
      project = related(tenant, "jobsites", req.params.jobsiteId, "jobsite_id"),
      b = body(req.body);
    const weekdays = [
      ...new Set(
        array(b.weekdays, "weekdays", 7).map((v) => number(v, "weekday", 0, 6)),
      ),
    ];
    if (!weekdays.length || weekdays.some((v) => !Number.isInteger(v)))
      throw new ErpError(
        400,
        "Choose at least one whole-number weekday (0 Sunday to 6 Saturday)",
      );
    const holidays = [
      ...new Set(
        array(b.holidays ?? [], "holidays", 1000).map((v) =>
          date(v, "holiday")!,
        ),
      ),
    ].sort();
    assertOpenProject(tenant, project);
    run(
      "INSERT INTO project_calendars(jobsite_id,tenant_id,weekdays,holidays,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(jobsite_id) DO UPDATE SET weekdays=excluded.weekdays,holidays=excluded.holidays,updated_at=excluded.updated_at",
      project,
      tenant,
      JSON.stringify(weekdays.sort()),
      JSON.stringify(holidays),
      nowIso(),
    );
    res.json({ jobsite_id: project, weekdays, holidays });
  }),
);
projectFinanceRouter.post(
  "/erp/work-dependencies",
  handle((req, res) => {
    const tenant = req.tenant.id,
      b = body(req.body),
      predecessor = related(
        tenant,
        "production_plans",
        b.predecessor_id,
        "predecessor_id",
      ),
      successor = related(
        tenant,
        "production_plans",
        b.successor_id,
        "successor_id",
      );
    const first = get<{ jobsite_id: number }>(
        "SELECT jobsite_id FROM production_plans WHERE tenant_id=? AND id=?",
        tenant,
        predecessor,
      )!,
      second = get<{ jobsite_id: number }>(
        "SELECT jobsite_id FROM production_plans WHERE tenant_id=? AND id=?",
        tenant,
        successor,
      )!;
    if (first.jobsite_id !== second.jobsite_id || predecessor === successor)
      throw new ErpError(
        400,
        "Dependencies must connect different work items on the same project",
      );
    const lag = number(b.lag_days ?? 0, "lag_days", 0, 3650);
    if (!Number.isInteger(lag))
      throw new ErpError(400, "Lag must be whole working days");
    const record = transaction(() => {
      assertOpenProject(tenant, first.jobsite_id);
      const cycle = get(
        `WITH RECURSIVE reach(id) AS (SELECT successor_id FROM work_dependencies WHERE tenant_id=? AND predecessor_id=? UNION SELECT d.successor_id FROM work_dependencies d JOIN reach r ON d.predecessor_id=r.id WHERE d.tenant_id=?) SELECT id FROM reach WHERE id=?`,
        tenant,
        successor,
        tenant,
        predecessor,
      );
      if (cycle)
        throw new ErpError(409, "This dependency would create a cycle");
      const recordId = Number(
        run(
          "INSERT INTO work_dependencies(tenant_id,jobsite_id,predecessor_id,successor_id,lag_days,created_at) VALUES(?,?,?,?,?,?)",
          tenant,
          first.jobsite_id,
          predecessor,
          successor,
          lag,
          nowIso(),
        ).lastInsertRowid,
      );
      return financeRelated(tenant, "work_dependencies", recordId);
    });
    res.status(201).json(record);
  }),
);
projectFinanceRouter.delete(
  "/erp/work-dependencies/:id",
  handle((req, res) => {
    const row = financeRelated<{ jobsite_id: number }>(
      req.tenant.id,
      "work_dependencies",
      id(req.params.id),
    );
    assertOpenProject(req.tenant.id, row.jobsite_id);
    run(
      "DELETE FROM work_dependencies WHERE tenant_id=? AND id=?",
      req.tenant.id,
      id(req.params.id),
    );
    res.status(204).end();
  }),
);
projectFinanceRouter.post(
  "/erp/project-baselines",
  handle((req, res) => {
    const tenant = req.tenant.id,
      b = body(req.body),
      project = related(tenant, "jobsites", b.jobsite_id, "jobsite_id");
    const title = text(b.title, "title", true, 200),
      explanation = text(b.explanation, "explanation", true, 4000);
    const record = transaction(() => {
      assertOpenProject(tenant, project);
      const overview = getErpOverview(tenant),
        job = overview.projects.find((p) => p.id === project)!,
        items = overview.work_items.filter((i) => i.jobsite_id === project);
      if (!items.length)
        throw new ErpError(
          400,
          "Create work items before capturing a baseline",
        );
      const version = get<{ n: number }>(
        "SELECT COALESCE(MAX(version),0)+1 n FROM project_baselines WHERE tenant_id=? AND jobsite_id=?",
        tenant,
        project,
      )!.n;
      const snapshot = {
        project: {
          name: job.name,
          contract_value: job.contract_value,
          budget: job.budget,
          start_date: job.start_date,
          end_date: job.end_date,
        },
        calendar: projectCalendar(tenant, project),
        dependencies: all(
          "SELECT predecessor_id,successor_id,lag_days FROM work_dependencies WHERE tenant_id=? AND jobsite_id=?",
          tenant,
          project,
        ),
        work_items: items.map((i) => ({
          id: i.id,
          cost_code: i.cost_code,
          phase: i.phase,
          activity: i.activity,
          unit: i.unit,
          planned_qty: i.planned_qty,
          planned_hours: i.planned_hours,
          budget: i.budget,
          planned_start: i.planned_start,
          planned_end: i.planned_end,
        })),
      };
      const recordId = Number(
        run(
          "INSERT INTO project_baselines(tenant_id,jobsite_id,version,title,explanation,snapshot,status,created_at) VALUES(?,?,?,?,?,?,'draft',?)",
          tenant,
          project,
          version,
          title,
          explanation,
          JSON.stringify(snapshot),
          nowIso(),
        ).lastInsertRowid,
      );
      return financeRelated(tenant, "project_baselines", recordId);
    });
    res.status(201).json(record);
  }),
);
projectFinanceRouter.post(
  "/erp/project-baselines/:id/approve",
  handle((req, res) => {
    const tenant = req.tenant.id,
      recordId = id(req.params.id),
      row = financeRelated<{ jobsite_id: number; status: string }>(
        tenant,
        "project_baselines",
        recordId,
      );
    if (row.status !== "draft")
      throw new ErpError(409, "Baseline is already approved");
    assertOpenProject(tenant, row.jobsite_id);
    run(
      "UPDATE project_baselines SET status='approved',approved_at=?,approved_by=? WHERE tenant_id=? AND id=? AND status='draft'",
      nowIso(),
      actor(req),
      tenant,
      recordId,
    );
    res.json(financeRelated(tenant, "project_baselines", recordId));
  }),
);
projectFinanceRouter.post(
  "/erp/cost-forecasts",
  handle((req, res) => {
    const tenant = req.tenant.id,
      b = body(req.body),
      project = related(tenant, "jobsites", b.jobsite_id, "jobsite_id"),
      asOf = date(b.as_of, "as_of")!,
      finish = date(b.forecast_finish, "forecast_finish")!,
      explanation = text(b.explanation, "explanation", true, 4000);
    dateRange(asOf, finish);
    if (Date.parse(finish) - Date.parse(asOf) > 36525 * 86400000)
      throw new ErpError(400, "Forecast horizon must be within 100 years");
    if (b.complete_scope_confirmed !== true)
      throw new ErpError(
        400,
        "Confirm the remaining cost estimate covers the complete project scope, including outstanding commitments",
      );
    const categories = [
      "labor",
      "equipment",
      "material",
      "subcontract",
      "other",
    ] as const;
    const lines = array(b.lines, "lines").map((v) => {
      const row = body(v),
        code = text(row.cost_code, "cost_code", true, 80),
        costs = Object.fromEntries(
          categories.map((c) => [c, cents(number(row[c] ?? 0, c, 0, 1e12))]),
        );
      return {
        cost_code: code,
        ...costs,
        notes: text(row.notes ?? "", "notes", false, 1000),
      };
    });
    if (
      !lines.length ||
      new Set(lines.map((l) => l.cost_code)).size !== lines.length
    )
      throw new ErpError(400, "Forecast requires distinct cost-code lines");
    const record = transaction(() => {
      assertOpenProject(tenant, project);
      const expected = all<{ cost_code: string }>(
        "SELECT w.cost_code FROM work_item_profiles w JOIN production_plans p ON p.id=w.plan_id AND p.tenant_id=w.tenant_id WHERE p.tenant_id=? AND p.jobsite_id=?",
        tenant,
        project,
      ).map((i) => i.cost_code);
      if (expected.some((code) => !lines.some((l) => l.cost_code === code)))
        throw new ErpError(
          400,
          "Include every current work-item cost code in the remaining cost estimate",
        );
      const calendar = projectCalendar(tenant, project),
        actual = actualCostThrough(tenant, project, asOf),
        remaining = lines.reduce(
          (n, l) =>
            n +
            categories.reduce((m, c) => m + Number(l[c as keyof typeof l]), 0),
          0,
        );
      const committed = cents(
        get<{ amount: number }>(
          "SELECT COALESCE(SUM(amount),0) amount FROM purchase_orders WHERE tenant_id=? AND jobsite_id=? AND status IN ('approved','received')",
          tenant,
          project,
        )?.amount ?? 0,
      );
      if (
        !Number.isSafeInteger(remaining) ||
        !Number.isSafeInteger(actual + remaining)
      )
        throw new ErpError(
          400,
          "Forecast total exceeds supported cent precision",
        );
      const version = get<{ n: number }>(
        "SELECT COALESCE(MAX(version),0)+1 n FROM cost_forecasts WHERE tenant_id=? AND jobsite_id=?",
        tenant,
        project,
      )!.n;
      const recordId = Number(
        run(
          "INSERT INTO cost_forecasts(tenant_id,jobsite_id,version,as_of,forecast_finish,explanation,actual_cost_cents,remaining_cost_cents,estimate_at_completion_cents,committed_reference_cents,working_days_remaining,calendar_snapshot,lines,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?)",
          tenant,
          project,
          version,
          asOf,
          finish,
          explanation,
          actual,
          remaining,
          actual + remaining,
          committed,
          workingDays(asOf, finish, calendar),
          JSON.stringify(calendar),
          JSON.stringify(lines),
          nowIso(),
        ).lastInsertRowid,
      );
      return financeRelated(tenant, "cost_forecasts", recordId);
    });
    res.status(201).json(record);
  }),
);
projectFinanceRouter.post(
  "/erp/cost-forecasts/:id/approve",
  handle((req, res) => {
    const tenant = req.tenant.id,
      recordId = id(req.params.id);
    const record = transaction(() => {
      const row = financeRelated<{
        jobsite_id: number;
        status: string;
        as_of: string;
        remaining_cost_cents: number;
      }>(tenant, "cost_forecasts", recordId);
      if (row.status !== "draft")
        throw new ErpError(409, "Forecast is already approved");
      assertOpenProject(tenant, row.jobsite_id);
      const actual = actualCostThrough(tenant, row.jobsite_id, row.as_of);
      run(
        "UPDATE cost_forecasts SET status='approved',actual_cost_cents=?,estimate_at_completion_cents=?,approved_at=?,approved_by=? WHERE tenant_id=? AND id=? AND status='draft'",
        actual,
        actual + row.remaining_cost_cents,
        nowIso(),
        actor(req),
        tenant,
        recordId,
      );
      return financeRelated(tenant, "cost_forecasts", recordId);
    });
    res.json(record);
  }),
);
projectFinanceRouter.post(
  "/erp/pay-items",
  handle((req, res) => {
    const tenant = req.tenant.id,
      b = body(req.body),
      project = related(tenant, "jobsites", b.jobsite_id, "jobsite_id"),
      code = text(b.code, "code", true, 80),
      description = text(b.description, "description", true, 500),
      unit = text(b.unit, "unit", true, 20),
      qty = number(b.total_qty, "total_qty", 0.000001, 1e12),
      value = cents(number(b.scheduled_value, "scheduled_value", 0.01, 1e12));
    const plan =
      b.plan_id == null || b.plan_id === ""
        ? null
        : related(tenant, "production_plans", b.plan_id, "plan_id");
    const record = transaction(() => {
      assertOpenProject(tenant, project);
      if (
        get(
          "SELECT id FROM payment_applications WHERE tenant_id=? AND jobsite_id=? AND status IN ('draft','submitted')",
          tenant,
          project,
        )
      )
        throw new ErpError(
          409,
          "Complete or withdraw the open payment application before adding pay items",
        );
      if (plan !== null) {
        const item = get<{
          jobsite_id: number;
          unit: string;
          planned_qty: number;
        }>(
          "SELECT jobsite_id,unit,planned_qty FROM production_plans WHERE tenant_id=? AND id=?",
          tenant,
          plan,
        )!;
        if (
          item.jobsite_id !== project ||
          item.unit !== unit ||
          Math.abs(item.planned_qty - qty) > 1e-7
        )
          throw new ErpError(
            400,
            "A mapped pay item must match its project, work-item unit, and planned quantity",
          );
      }
      const contract = cents(
          get<{ contract_value: number }>(
            "SELECT contract_value FROM project_profiles WHERE tenant_id=? AND jobsite_id=?",
            tenant,
            project,
          )?.contract_value ?? 0,
        ),
        scheduled = get<{ amount: number }>(
          "SELECT COALESCE(SUM(scheduled_value_cents),0) amount FROM billing_pay_items WHERE tenant_id=? AND jobsite_id=?",
          tenant,
          project,
        )!.amount;
      if (scheduled + value > contract)
        throw new ErpError(
          409,
          "The schedule of values exceeds the current approved contract",
        );
      const recordId = Number(
        run(
          "INSERT INTO billing_pay_items(tenant_id,jobsite_id,code,description,unit,total_qty,scheduled_value_cents,plan_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          tenant,
          project,
          code,
          description,
          unit,
          qty,
          value,
          plan,
          nowIso(),
        ).lastInsertRowid,
      );
      return financeRelated(tenant, "billing_pay_items", recordId);
    });
    res.status(201).json(record);
  }),
);
projectFinanceRouter.post(
  "/erp/payment-applications",
  handle((req, res) => {
    const tenant = req.tenant.id,
      b = body(req.body),
      project = related(tenant, "jobsites", b.jobsite_id, "jobsite_id"),
      start = date(b.period_start, "period_start")!,
      end = date(b.period_end, "period_end")!,
      rate = number(b.retainage_pct, "retainage_pct", 0, 100),
      evidence = text(b.evidence_reference, "evidence_reference", true, 1000);
    dateRange(start, end);
    const submitted = array(b.lines, "lines").map((v) => body(v));
    if (!submitted.length)
      throw new ErpError(400, "Add at least one earned billing line");
    const record = transaction(() => {
      assertOpenProject(tenant, project);
      if (
        get(
          "SELECT id FROM payment_applications WHERE tenant_id=? AND jobsite_id=? AND status IN ('draft','submitted')",
          tenant,
          project,
        )
      )
        throw new ErpError(
          409,
          "This project already has an open payment application",
        );
      const previous = priorApplication(tenant, project),
        priorLines = previous
          ? (JSON.parse(previous.lines) as BillingLine[])
          : [];
      if (previous && start <= previous.period_end)
        throw new ErpError(
          409,
          "Billing periods must follow the previous approved period without overlap",
        );
      if (previous && Math.abs(previous.retainage_pct - rate) > 1e-7)
        throw new ErpError(
          409,
          "Keep the certified retainage rate consistent; release retainage through final acceptance",
        );
      const payItems = all<PayItem>(
        "SELECT * FROM billing_pay_items WHERE tenant_id=? AND jobsite_id=? ORDER BY id",
        tenant,
        project,
      );
      if (!payItems.length)
        throw new ErpError(400, "Set up the schedule of values before billing");
      const ids = submitted.map((l) => id(l.pay_item_id, "pay_item_id"));
      if (new Set(ids).size !== ids.length)
        throw new ErpError(400, "Each pay item can appear only once");
      for (const itemId of ids)
        if (!payItems.some((p) => p.id === itemId))
          throw new ErpError(404, "Pay item not found on this project");
      const lines: BillingLine[] = payItems.map((item) => {
        const old = priorLines.find((l) => l.pay_item_id === item.id),
          input = submitted.find((l) => Number(l.pay_item_id) === item.id),
          prevQty = old?.cumulative_qty ?? 0,
          prevEarned = old?.cumulative_earned_cents ?? 0;
        let cumulativeQty: number | null =
            old?.cumulative_qty ?? (item.plan_id === null ? null : 0),
          earned = prevEarned;
        if (input) {
          if (item.plan_id !== null) {
            if (input.cumulative_amount !== undefined)
              throw new ErpError(
                400,
                "Mapped quantity pay items must use cumulative_qty",
              );
            cumulativeQty = number(
              input.cumulative_qty,
              "cumulative_qty",
              prevQty,
              item.total_qty,
            );
            if (
              cumulativeQty >
              measuredQuantity(tenant, item.plan_id, end) + 1e-7
            )
              throw new ErpError(
                409,
                `Pay item ${item.code} exceeds measured accepted quantity through ${end}`,
              );
            earned = Math.round(
              (cumulativeQty / item.total_qty) * item.scheduled_value_cents,
            );
          } else {
            if (input.cumulative_qty !== undefined)
              throw new ErpError(
                400,
                "Verified amount pay items must use cumulative_amount",
              );
            earned = cents(
              number(
                input.cumulative_amount,
                "cumulative_amount",
                dollars(prevEarned),
                dollars(item.scheduled_value_cents),
              ),
            );
            cumulativeQty = null;
          }
        }
        return {
          pay_item_id: item.id,
          code: item.code,
          description: item.description,
          unit: item.unit,
          scheduled_value_cents: item.scheduled_value_cents,
          total_qty: item.total_qty,
          plan_id: item.plan_id,
          previous_qty: prevQty,
          cumulative_qty: cumulativeQty,
          previous_earned_cents: prevEarned,
          cumulative_earned_cents: earned,
          current_earned_cents: earned - prevEarned,
        };
      });
      const cumulative = lines.reduce(
          (n, l) => n + l.cumulative_earned_cents,
          0,
        ),
        prev = previous?.cumulative_earned_cents ?? 0,
        current = cumulative - prev;
      if (current <= 0)
        throw new ErpError(400, "The application must earn additional value");
      const contract = cents(
        get<{ contract_value: number }>(
          "SELECT contract_value FROM project_profiles WHERE tenant_id=? AND jobsite_id=?",
          tenant,
          project,
        )?.contract_value ?? 0,
      );
      if (cumulative > contract)
        throw new ErpError(
          409,
          "Cumulative earned billing exceeds the current approved contract",
        );
      const previousRetained = get<{ amount: number }>(
        "SELECT COALESCE(SUM(retainage_cents),0) amount FROM payment_applications WHERE tenant_id=? AND jobsite_id=? AND status='approved'",
        tenant,
        project,
      )!.amount;
      const retainage =
          Math.round((cumulative * rate) / 100) - previousRetained,
        sequence = get<{ n: number }>(
          "SELECT COALESCE(MAX(number),0)+1 n FROM payment_applications WHERE tenant_id=? AND jobsite_id=?",
          tenant,
          project,
        )!.n;
      const recordId = Number(
        run(
          "INSERT INTO payment_applications(tenant_id,jobsite_id,number,period_start,period_end,retainage_pct,status,evidence_reference,previous_earned_cents,cumulative_earned_cents,current_earned_cents,retainage_cents,due_cents,lines,created_at) VALUES(?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?)",
          tenant,
          project,
          sequence,
          start,
          end,
          rate,
          evidence,
          prev,
          cumulative,
          current,
          retainage,
          current - retainage,
          JSON.stringify(lines),
          nowIso(),
        ).lastInsertRowid,
      );
      return financeRelated(tenant, "payment_applications", recordId);
    });
    res.status(201).json(record);
  }),
);
for (const action of ["submit", "approve"] as const)
  projectFinanceRouter.post(
    `/erp/payment-applications/:id/${action}`,
    handle((req, res) => {
      const tenant = req.tenant.id,
        recordId = id(req.params.id);
      const record = transaction(() => {
        const row = financeRelated<Application>(
            tenant,
            "payment_applications",
            recordId,
          ),
          expected = action === "submit" ? "draft" : "submitted";
        if (row.status !== expected)
          throw new ErpError(
            409,
            `Only ${expected} applications can be ${action === "submit" ? "submitted" : "approved"}`,
          );
        assertOpenProject(tenant, row.jobsite_id);
        validateApplicationEvidence(tenant, row);
        if (action === "submit")
          run(
            "UPDATE payment_applications SET status='submitted',submitted_at=? WHERE tenant_id=? AND id=? AND status='draft'",
            nowIso(),
            tenant,
            recordId,
          );
        else
          run(
            "UPDATE payment_applications SET status='approved',approved_at=?,approved_by=? WHERE tenant_id=? AND id=? AND status='submitted'",
            nowIso(),
            actor(req),
            tenant,
            recordId,
          );
        return financeRelated(tenant, "payment_applications", recordId);
      });
      res.json(record);
    }),
  );
projectFinanceRouter.post(
  "/erp/payment-applications/:id/withdraw",
  handle((req, res) => {
    const tenant = req.tenant.id,
      recordId = id(req.params.id),
      row = financeRelated<Application>(
        tenant,
        "payment_applications",
        recordId,
      ),
      reason = text(body(req.body).reason, "reason", true, 2000);
    if (!["draft", "submitted"].includes(row.status))
      throw new ErpError(409, "Only unapproved applications can be withdrawn");
    run(
      "UPDATE payment_applications SET status='void',void_reason=? WHERE tenant_id=? AND id=? AND status IN ('draft','submitted')",
      reason,
      tenant,
      recordId,
    );
    res.json(financeRelated(tenant, "payment_applications", recordId));
  }),
);
projectFinanceRouter.post(
  "/erp/customer-payments",
  handle((req, res) => {
    const tenant = req.tenant.id,
      b = body(req.body),
      appId = id(b.application_id, "application_id"),
      amount = cents(number(b.amount, "amount", 0.01, 1e12)),
      received = date(b.received_date, "received_date")!,
      reference = text(b.reference, "reference", true, 200);
    const recordId = transaction(() => {
      const app = financeRelated<Application>(
        tenant,
        "payment_applications",
        appId,
      );
      if (app.status !== "approved")
        throw new ErpError(
          409,
          "Only certified payment applications can receive payments",
        );
      if (received < app.period_end)
        throw new ErpError(
          400,
          "Payment date must be on or after the application period end",
        );
      const paid = get<{ amount: number }>(
        "SELECT COALESCE(SUM(amount_cents),0) amount FROM customer_payments WHERE tenant_id=? AND application_id=?",
        tenant,
        appId,
      )!.amount;
      if (paid + amount > app.due_cents)
        throw new ErpError(409, "Payment exceeds the unpaid certified amount");
      return Number(
        run(
          "INSERT INTO customer_payments(tenant_id,application_id,amount_cents,received_date,reference,created_at) VALUES(?,?,?,?,?,?)",
          tenant,
          appId,
          amount,
          received,
          reference,
          nowIso(),
        ).lastInsertRowid,
      );
    });
    res
      .status(201)
      .json({ id: recordId, application_id: appId, amount: dollars(amount) });
  }),
);
projectFinanceRouter.post(
  "/erp/retainage-releases",
  handle((req, res) => {
    const tenant = req.tenant.id,
      b = body(req.body),
      project = related(tenant, "jobsites", b.jobsite_id, "jobsite_id"),
      amount = cents(number(b.amount, "amount", 0.01, 1e12)),
      release = date(b.release_date, "release_date")!,
      reference = text(
        b.acceptance_reference,
        "acceptance_reference",
        true,
        1000,
      );
    const recordId = transaction(() => {
      if (
        !get(
          "SELECT jobsite_id FROM project_closeouts WHERE tenant_id=? AND jobsite_id=?",
          tenant,
          project,
        )
      )
        throw new ErpError(
          409,
          "Record final project acceptance and closeout before releasing retainage",
        );
      const retained = get<{ amount: number }>(
          "SELECT COALESCE(SUM(retainage_cents),0) amount FROM payment_applications WHERE tenant_id=? AND jobsite_id=? AND status='approved'",
          tenant,
          project,
        )!.amount,
        released = get<{ amount: number }>(
          "SELECT COALESCE(SUM(amount_cents),0) amount FROM retainage_releases WHERE tenant_id=? AND jobsite_id=?",
          tenant,
          project,
        )!.amount;
      const latest = get<{ period_end: string }>(
        "SELECT MAX(period_end) period_end FROM payment_applications WHERE tenant_id=? AND jobsite_id=? AND status='approved'",
        tenant,
        project,
      )?.period_end;
      if (latest && release < latest)
        throw new ErpError(
          400,
          "Release date must follow the final billing period",
        );
      if (released + amount > retained)
        throw new ErpError(
          409,
          "Release exceeds the unreleased retained amount",
        );
      return Number(
        run(
          "INSERT INTO retainage_releases(tenant_id,jobsite_id,amount_cents,release_date,acceptance_reference,created_at) VALUES(?,?,?,?,?,?)",
          tenant,
          project,
          amount,
          release,
          reference,
          nowIso(),
        ).lastInsertRowid,
      );
    });
    res
      .status(201)
      .json({ id: recordId, jobsite_id: project, amount: dollars(amount) });
  }),
);
projectFinanceRouter.post(
  "/erp/retainage-payments",
  handle((req, res) => {
    const tenant = req.tenant.id,
      b = body(req.body),
      releaseId = id(b.release_id, "release_id"),
      amount = cents(number(b.amount, "amount", 0.01, 1e12)),
      received = date(b.received_date, "received_date")!,
      reference = text(b.reference, "reference", true, 200);
    const recordId = transaction(() => {
      const release = financeRelated<{
          amount_cents: number;
          release_date: string;
        }>(tenant, "retainage_releases", releaseId),
        paid = get<{ amount: number }>(
          "SELECT COALESCE(SUM(amount_cents),0) amount FROM retainage_payments WHERE tenant_id=? AND release_id=?",
          tenant,
          releaseId,
        )!.amount;
      if (received < release.release_date)
        throw new ErpError(
          400,
          "Payment date must follow the retainage release",
        );
      if (paid + amount > release.amount_cents)
        throw new ErpError(409, "Payment exceeds unpaid released retainage");
      return Number(
        run(
          "INSERT INTO retainage_payments(tenant_id,release_id,amount_cents,received_date,reference,created_at) VALUES(?,?,?,?,?,?)",
          tenant,
          releaseId,
          amount,
          received,
          reference,
          nowIso(),
        ).lastInsertRowid,
      );
    });
    res
      .status(201)
      .json({ id: recordId, release_id: releaseId, amount: dollars(amount) });
  }),
);
projectFinanceRouter.post(
  "/erp/closeout-items",
  handle((req, res) => {
    const tenant = req.tenant.id,
      b = body(req.body),
      project = related(tenant, "jobsites", b.jobsite_id, "jobsite_id"),
      title = text(b.title, "title", true, 500),
      required =
        b.required === undefined || b.required === true
          ? 1
          : b.required === false
            ? 0
            : null;
    if (required === null)
      throw new ErpError(400, "required must be true or false");
    assertOpenProject(tenant, project);
    const recordId = Number(
      run(
        "INSERT INTO project_closeout_items(tenant_id,jobsite_id,title,required,status,created_at) VALUES(?,?,?,?,'open',?)",
        tenant,
        project,
        title,
        required,
        nowIso(),
      ).lastInsertRowid,
    );
    res
      .status(201)
      .json(financeRelated(tenant, "project_closeout_items", recordId));
  }),
);
projectFinanceRouter.patch(
  "/erp/closeout-items/:id",
  handle((req, res) => {
    const tenant = req.tenant.id,
      recordId = id(req.params.id),
      row = financeRelated<{ jobsite_id: number; required: number }>(
        tenant,
        "project_closeout_items",
        recordId,
      ),
      b = body(req.body),
      status = option(b.status, "status", ["open", "complete"] as const),
      evidence = text(
        b.evidence_reference ?? "",
        "evidence_reference",
        status === "complete" && row.required === 1,
        1000,
      );
    assertOpenProject(tenant, row.jobsite_id);
    run(
      "UPDATE project_closeout_items SET status=?,evidence_reference=?,completed_at=? WHERE tenant_id=? AND id=?",
      status,
      evidence,
      status === "complete" ? nowIso() : null,
      tenant,
      recordId,
    );
    res.json(financeRelated(tenant, "project_closeout_items", recordId));
  }),
);
projectFinanceRouter.post(
  "/erp/project-closeout/:jobsiteId",
  handle((req, res) => {
    const tenant = req.tenant.id,
      project = related(tenant, "jobsites", req.params.jobsiteId, "jobsite_id"),
      reference = text(
        body(req.body).acceptance_reference,
        "acceptance_reference",
        true,
        1000,
      );
    transaction(() => {
      assertOpenProject(tenant, project);
      const items = get<{ n: number }>(
        "SELECT COUNT(*) n FROM project_closeout_items WHERE tenant_id=? AND jobsite_id=?",
        tenant,
        project,
      )!.n;
      if (!items)
        throw new ErpError(
          409,
          "Create and complete a closeout checklist before final acceptance",
        );
      if (
        get(
          "SELECT id FROM project_closeout_items WHERE tenant_id=? AND jobsite_id=? AND required=1 AND status='open'",
          tenant,
          project,
        )
      )
        throw new ErpError(409, "Required closeout items remain open");
      const work = getErpOverview(tenant).work_items.filter(
        (i) => i.jobsite_id === project,
      );
      if (!work.length || work.some((i) => i.actual_qty + 1e-7 < i.planned_qty))
        throw new ErpError(
          409,
          "Measured work quantities must be complete before final acceptance",
        );
      if (
        get(
          "SELECT id FROM payment_applications WHERE tenant_id=? AND jobsite_id=? AND status IN ('draft','submitted')",
          tenant,
          project,
        )
      )
        throw new ErpError(
          409,
          "Complete or withdraw the open billing application before closeout",
        );
      if (
        get(
          "SELECT id FROM project_controls WHERE tenant_id=? AND jobsite_id=? AND status='open'",
          tenant,
          project,
        )
      )
        throw new ErpError(
          409,
          "Resolve open RFIs, change requests, and project issues before closeout",
        );
      if (
        get(
          "SELECT id FROM daily_reports WHERE tenant_id=? AND jobsite_id=? AND status IN ('draft','submitted')",
          tenant,
          project,
        )
      ) {
        throw new ErpError(
          409,
          "Resolve unapproved daily reports before final acceptance",
        );
      }
      if (
        get(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='procurement_orders'",
        ) &&
        get(
          `
        SELECT l.id FROM po_lines l JOIN purchase_orders o ON o.id=l.order_id AND o.tenant_id=l.tenant_id
        WHERE l.tenant_id=? AND o.jobsite_id=? AND o.status IN ('approved','received') AND (
          COALESCE((SELECT SUM(r.quantity) FROM material_receipt_lines r WHERE r.tenant_id=l.tenant_id AND r.line_id=l.id),0) + 0.0000001 < l.quantity
          OR COALESCE((SELECT SUM(r.quantity) FROM material_receipt_lines r WHERE r.tenant_id=l.tenant_id AND r.line_id=l.id),0)
            - COALESCE((SELECT SUM(i.quantity) FROM material_issues i WHERE i.tenant_id=l.tenant_id AND i.line_id=l.id),0) > 0.0000001)
        LIMIT 1`,
          tenant,
          project,
        )
      ) {
        throw new ErpError(
          409,
          "Complete approved material deliveries and record remaining job stock usage before final acceptance",
        );
      }
      const legacyOrders = get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='procurement_orders'",
      )
        ? "AND NOT EXISTS(SELECT 1 FROM procurement_orders p WHERE p.order_id=o.id AND p.tenant_id=o.tenant_id)"
        : "";
      if (
        get(
          `SELECT o.id FROM purchase_orders o WHERE o.tenant_id=? AND o.jobsite_id=? AND o.status='approved' ${legacyOrders}`,
          tenant,
          project,
        )
      ) {
        throw new ErpError(
          409,
          "Resolve approved whole-order deliveries before final acceptance",
        );
      }
      run(
        "INSERT INTO project_closeouts(jobsite_id,tenant_id,acceptance_reference,closed_at,closed_by) VALUES(?,?,?,?,?)",
        project,
        tenant,
        reference,
        nowIso(),
        actor(req),
      );
      run(
        "UPDATE jobsites SET status='complete' WHERE tenant_id=? AND id=?",
        tenant,
        project,
      );
    });
    res.json({
      jobsite_id: project,
      status: "complete",
      acceptance_reference: reference,
    });
  }),
);
