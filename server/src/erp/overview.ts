import { all, get } from "../db/database.js";
import { businessDate } from "./calendar.js";

export interface WorkItem {
  id: number;
  jobsite_id: number;
  jobsite_name: string;
  phase: string;
  activity: string;
  unit: string;
  planned_qty: number;
  planned_hours: number;
  planned_start: string | null;
  planned_end: string | null;
  cost_code: string;
  budget: number;
  actual_qty: number;
  actual_hours: number;
  actual_cost: number;
  progress_pct: number;
  rate: number | null;
  planned_rate: number | null;
}
interface ReportLine {
  id: number;
  report_id: number;
  plan_id: number;
  qty: number;
  labor_hours: number;
  equipment_hours: number;
  labor_cost: number;
  equipment_cost: number;
  material_cost: number;
}
interface DailyReport {
  id: number;
  jobsite_id: number;
  jobsite_name: string;
  crew_id: number;
  crew_name: string;
  date: string;
  weather: string;
  notes: string;
  rough_pct: number | null;
  status: "draft" | "submitted" | "approved";
  created_by: string;
  created_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
  reversed_by: string | null;
  revision: number;
  corrected_from_report_id: number | null;
  replacement_report_id: number | null;
  lines: ReportLine[];
}
interface ProjectBase {
  id: number;
  name: string;
  code: string;
  status: string;
  client: string;
  pm_id: number | null;
  pm_name: string | null;
  contract_value: number;
  budget: number;
  start_date: string | null;
  end_date: string | null;
  superintendent: string | null;
  lat: number;
  lng: number;
  address: string | null;
  crew_count: number;
  asset_count: number;
}
interface WeeklyUpdate {
  id: number;
  jobsite_id: number;
  jobsite_name: string;
  pm_id: number;
  pm_name: string;
  week_ending: string;
  rough_pct: number;
  forecast_finish: string | null;
  forecast_cost: number | null;
  health: string;
  blockers: string;
  next_steps: string;
  notes: string;
  created_at: string;
}
interface CostEntry {
  id: number;
  jobsite_id: number;
  jobsite_name: string;
  date: string;
  cost_code: string;
  category: string;
  amount: number;
  description: string;
}

/** Only recorded manual production and approved daily reports are measured actuals. */
export function getErpOverview(
  tenantId: number,
  options: { hidePayrollDetails?: boolean } = {},
) {
  const approvedForecasts = get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='cost_forecasts'",
  )
    ? all<{
        jobsite_id: number;
        version: number;
        as_of: string;
        forecast_finish: string;
        estimate_at_completion_cents: number;
      }>(
        "SELECT jobsite_id,version,as_of,forecast_finish,estimate_at_completion_cents FROM cost_forecasts WHERE tenant_id=? AND status='approved' ORDER BY version DESC,id DESC",
        tenantId,
      )
    : [];
  const workItems = all<WorkItem>(
    `
    WITH manual_actuals AS (
      SELECT plan_id, SUM(qty) qty, SUM(hours) hours
      FROM production_entries WHERE tenant_id = ? AND source = 'manual' GROUP BY plan_id
    ), approved_actuals AS (
      SELECT l.plan_id, SUM(l.qty) qty, SUM(l.labor_hours) hours,
        SUM(l.labor_cost + l.equipment_cost + l.material_cost) cost
      FROM daily_report_lines l JOIN daily_reports r ON r.id = l.report_id AND r.tenant_id = l.tenant_id
      WHERE l.tenant_id = ? AND r.status = 'approved'
      AND NOT EXISTS(SELECT 1 FROM daily_report_reversals v WHERE v.tenant_id=r.tenant_id AND v.report_id=r.id)
      GROUP BY l.plan_id
    ), direct_costs AS (
      SELECT c.jobsite_id, c.cost_code, SUM(c.amount) cost FROM job_cost_entries c
      WHERE c.tenant_id = ?
      AND NOT EXISTS(SELECT 1 FROM time_entry_postings p JOIN time_entry_voids v ON v.time_entry_id=p.time_entry_id AND v.tenant_id=p.tenant_id WHERE p.tenant_id=c.tenant_id AND p.job_cost_entry_id=c.id)
      GROUP BY c.jobsite_id, c.cost_code
    )
    SELECT p.id, p.jobsite_id, j.name jobsite_name, p.phase, p.activity, p.unit,
      p.planned_qty, p.planned_hours, p.planned_start, p.planned_end,
      COALESCE(w.cost_code, '') cost_code, COALESCE(w.budget, 0) budget,
      COALESCE(m.qty, 0) + COALESCE(a.qty, 0) actual_qty,
      COALESCE(m.hours, 0) + COALESCE(a.hours, 0) actual_hours,
      COALESCE(a.cost, 0) + COALESCE(d.cost, 0) actual_cost
    FROM production_plans p JOIN jobsites j ON j.id = p.jobsite_id AND j.tenant_id = p.tenant_id
    LEFT JOIN work_item_profiles w ON w.plan_id = p.id AND w.tenant_id = p.tenant_id
    LEFT JOIN manual_actuals m ON m.plan_id = p.id
    LEFT JOIN approved_actuals a ON a.plan_id = p.id
    LEFT JOIN direct_costs d ON d.jobsite_id = p.jobsite_id AND d.cost_code = w.cost_code
    WHERE p.tenant_id = ? ORDER BY j.name, p.phase, p.id
  `,
    tenantId,
    tenantId,
    tenantId,
    tenantId,
  ).map((item) => ({
    ...item,
    progress_pct:
      item.planned_qty > 0
        ? Math.min(100, Math.max(0, (item.actual_qty / item.planned_qty) * 100))
        : 0,
    rate:
      item.actual_hours > 0 &&
      Number.isFinite(item.actual_qty / item.actual_hours)
        ? item.actual_qty / item.actual_hours
        : null,
    planned_rate:
      item.planned_hours > 0 &&
      Number.isFinite(item.planned_qty / item.planned_hours)
        ? item.planned_qty / item.planned_hours
        : null,
  }));
  const people = all(
    `
    SELECT e.id, e.name, e.role, e.phone, e.certs, e.active, c.id crew_id, c.name crew_name
    FROM employees e LEFT JOIN crew_members m ON m.employee_id = e.id AND m.tenant_id = e.tenant_id
    LEFT JOIN crews c ON c.id = m.crew_id AND c.tenant_id = e.tenant_id
    WHERE e.tenant_id = ? ORDER BY e.name
  `,
    tenantId,
  );
  const members = all<{ crew_id: number; employee_id: number }>(
    "SELECT crew_id, employee_id FROM crew_members WHERE tenant_id = ? ORDER BY employee_id",
    tenantId,
  );
  const crews = all<{
    id: number;
    name: string;
    trade: string;
    foreman_id: number;
    foreman_name: string;
  }>(
    `
    SELECT c.id, c.name, c.trade, c.foreman_id, e.name foreman_name
    FROM crews c JOIN employees e ON e.id = c.foreman_id AND e.tenant_id = c.tenant_id
    WHERE c.tenant_id = ? ORDER BY c.name
  `,
    tenantId,
  ).map((crew) => {
    const ids = members
      .filter((m) => m.crew_id === crew.id)
      .map((m) => m.employee_id);
    return { ...crew, members: ids, member_count: ids.length };
  });
  const assignments = all(
    `
    SELECT a.id, a.crew_id, c.name crew_name, a.jobsite_id, j.name jobsite_name, a.date, a.task, a.cost_code
    FROM crew_assignments a JOIN crews c ON c.id = a.crew_id AND c.tenant_id = a.tenant_id
    JOIN jobsites j ON j.id = a.jobsite_id AND j.tenant_id = a.tenant_id
    WHERE a.tenant_id = ? ORDER BY a.date DESC, c.name
  `,
    tenantId,
  );
  const costEntries = all<CostEntry>(
    `
    SELECT c.id, c.jobsite_id, j.name jobsite_name, c.date, c.cost_code, c.category, c.amount, c.description
    FROM job_cost_entries c JOIN jobsites j ON j.id = c.jobsite_id AND j.tenant_id = c.tenant_id
    WHERE c.tenant_id = ?
    AND NOT EXISTS(SELECT 1 FROM time_entry_postings p JOIN time_entry_voids v ON v.time_entry_id=p.time_entry_id AND v.tenant_id=p.tenant_id WHERE p.tenant_id=c.tenant_id AND p.job_cost_entry_id=c.id)
    ORDER BY c.date DESC, c.id DESC
  `,
    tenantId,
  );
  const reportLines = all<ReportLine>(
    `
    SELECT id, report_id, plan_id, qty, labor_hours, equipment_hours, labor_cost, equipment_cost, material_cost
    FROM daily_report_lines WHERE tenant_id = ? ORDER BY id
  `,
    tenantId,
  );
  const dailyReports = all<Omit<DailyReport, "lines">>(
    `
    SELECT r.id, r.jobsite_id, j.name jobsite_name, r.crew_id, c.name crew_name,
      r.date, r.weather, r.notes, r.rough_pct, r.status, r.created_by, r.created_at,
      r.submitted_at, r.approved_at, r.approved_by, r.revision,
      v.reversed_at,v.reason reversal_reason,v.reversed_by,
      (SELECT original_report_id FROM daily_report_replacements x WHERE x.tenant_id=r.tenant_id AND x.replacement_report_id=r.id) corrected_from_report_id,
      (SELECT replacement_report_id FROM daily_report_replacements x WHERE x.tenant_id=r.tenant_id AND x.original_report_id=r.id) replacement_report_id,
      (SELECT rejected_at FROM daily_report_rejections x WHERE x.tenant_id=r.tenant_id AND x.report_id=r.id ORDER BY x.id DESC LIMIT 1) rejected_at,
      (SELECT reason FROM daily_report_rejections x WHERE x.tenant_id=r.tenant_id AND x.report_id=r.id ORDER BY x.id DESC LIMIT 1) rejection_reason,
      (SELECT rejected_by FROM daily_report_rejections x WHERE x.tenant_id=r.tenant_id AND x.report_id=r.id ORDER BY x.id DESC LIMIT 1) rejected_by
    FROM daily_reports r JOIN jobsites j ON j.id = r.jobsite_id AND j.tenant_id = r.tenant_id
    JOIN crews c ON c.id = r.crew_id AND c.tenant_id = r.tenant_id
    LEFT JOIN daily_report_reversals v ON v.report_id=r.id AND v.tenant_id=r.tenant_id
    WHERE r.tenant_id = ? ORDER BY r.date DESC, r.id DESC
  `,
    tenantId,
  ).map((report) => ({
    ...report,
    lines: reportLines.filter((line) => line.report_id === report.id),
  }));
  const weeklyUpdates = all<WeeklyUpdate>(
    `
    SELECT u.id, u.jobsite_id, j.name jobsite_name, u.pm_id, e.name pm_name, u.week_ending,
      u.rough_pct, u.forecast_finish, u.forecast_cost, u.health, u.blockers, u.next_steps, u.notes, u.created_at
    FROM weekly_updates u JOIN jobsites j ON j.id = u.jobsite_id AND j.tenant_id = u.tenant_id
    JOIN employees e ON e.id = u.pm_id AND e.tenant_id = u.tenant_id
    WHERE u.tenant_id = ? ORDER BY u.week_ending DESC, u.id DESC
  `,
    tenantId,
  );
  const today = businessDate();
  const projects = all<ProjectBase>(
    `
    SELECT j.id, j.name, j.code, j.status, COALESCE(p.client, '') client, p.pm_id, e.name pm_name,
      COALESCE(p.contract_value, 0) contract_value, COALESCE(p.budget, 0) budget,
      j.start_date, j.end_date, j.superintendent, j.lat, j.lng, j.address,
      (SELECT COUNT(*) FROM crew_assignments a WHERE a.tenant_id = j.tenant_id AND a.jobsite_id = j.id AND a.date = ?) crew_count,
      (SELECT COUNT(*) FROM assets a WHERE a.tenant_id = j.tenant_id AND a.jobsite_id = j.id AND a.status != 'retired') asset_count
    FROM jobsites j LEFT JOIN project_profiles p ON p.jobsite_id = j.id AND p.tenant_id = j.tenant_id
    LEFT JOIN employees e ON e.id = p.pm_id AND e.tenant_id = j.tenant_id
    WHERE j.tenant_id = ? ORDER BY j.name
  `,
    today,
    tenantId,
  ).map((project) => {
    const items = workItems.filter((item) => item.jobsite_id === project.id);
    const weightedBudget = items.reduce((sum, item) => sum + item.budget, 0);
    const earnedBudget = items.reduce(
      (sum, item) => sum + (item.budget * item.progress_pct) / 100,
      0,
    );
    const approvedCost = dailyReports
      .filter(
        (r) =>
          r.jobsite_id === project.id &&
          r.status === "approved" &&
          !r.reversed_at,
      )
      .reduce(
        (sum, report) =>
          sum +
          report.lines.reduce(
            (n, line) =>
              n + line.labor_cost + line.equipment_cost + line.material_cost,
            0,
          ),
        0,
      );
    const actualCost =
      approvedCost +
      costEntries
        .filter((c) => c.jobsite_id === project.id)
        .reduce((sum, c) => sum + c.amount, 0);
    const hasCostEvidence = items
      .filter((item) => item.actual_qty > 0 || item.actual_hours > 0)
      .every((item) => item.actual_cost > 0);
    const budgetCovered = weightedBudget + 0.01 >= project.budget;
    const calculatedForecast =
      earnedBudget > 0 &&
      actualCost > 0 &&
      hasCostEvidence &&
      weightedBudget > 0 &&
      budgetCovered
        ? actualCost +
          (Math.max(
            0,
            Math.max(project.budget, weightedBudget) - earnedBudget,
          ) *
            actualCost) /
            earnedBudget
        : null;
    const forecast =
      calculatedForecast !== null && Number.isFinite(calculatedForecast)
        ? calculatedForecast
        : null;
    const approvedForecast = approvedForecasts.find(
      (forecast) => forecast.jobsite_id === project.id,
    );
    const latest = weeklyUpdates.find(
      (update) => update.jobsite_id === project.id,
    );
    return {
      ...project,
      progress_pct:
        weightedBudget > 0 ? (earnedBudget / weightedBudget) * 100 : 0,
      progress_basis:
        weightedBudget > 0
          ? "Budget-weighted approved quantities plus recorded manual production"
          : "No budgeted work items",
      budget_coverage_pct:
        project.budget > 0
          ? Math.min(100, (weightedBudget / project.budget) * 100)
          : null,
      unbudgeted_work_item_count: items.filter((item) => item.budget <= 0)
        .length,
      actual_cost: actualCost,
      approved_forecast_cost: approvedForecast
        ? approvedForecast.estimate_at_completion_cents / 100
        : null,
      approved_forecast_finish: approvedForecast?.forecast_finish ?? null,
      approved_forecast_as_of: approvedForecast?.as_of ?? null,
      approved_forecast_version: approvedForecast?.version ?? null,
      forecast_cost: forecast,
      forecast_basis: !budgetCovered
        ? "Project budget is not fully allocated to work items"
        : forecast === null
          ? "Insufficient recorded cost and production evidence"
          : "Estimate from recorded cost per earned budget; incomplete costs can change this forecast",
      latest_rough_pct: latest?.rough_pct ?? null,
      latest_forecast_finish: latest?.forecast_finish ?? null,
      latest_health: latest?.health ?? null,
      latest_forecast_cost: latest?.forecast_cost ?? null,
      latest_week_ending: latest?.week_ending ?? null,
    };
  });
  const payrollCostIds = options.hidePayrollDetails
    ? new Set(
        all<{ job_cost_entry_id: number }>(
          "SELECT job_cost_entry_id FROM time_entry_postings WHERE tenant_id=?",
          tenantId,
        ).map((row) => row.job_cost_entry_id),
      )
    : new Set<number>();
  return {
    projects,
    people,
    crews,
    assignments,
    work_items: workItems,
    daily_reports: dailyReports,
    cost_entries: costEntries.filter((entry) => !payrollCostIds.has(entry.id)),
    weekly_updates: weeklyUpdates,
  };
}
