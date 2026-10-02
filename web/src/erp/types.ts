export interface Project {
  id: number;
  name: string;
  code: string;
  status: string;
  client: string;
  lat: number;
  lng: number;
  address: string | null;
  pm_id: number | null;
  pm_name: string | null;
  contract_value: number;
  budget: number;
  start_date: string | null;
  end_date: string | null;
  superintendent: string | null;
  progress_pct: number;
  actual_cost: number;
  forecast_cost: number | null;
  approved_forecast_cost?: number | null;
  approved_forecast_finish?: string | null;
  approved_forecast_as_of?: string | null;
  approved_forecast_version?: number | null;
  forecast_basis?: string;
  crew_count: number;
  asset_count: number;
  budget_coverage_pct?: number | null;
  unbudgeted_work_item_count?: number;
  latest_rough_pct?: number | null;
  latest_forecast_finish?: string | null;
  latest_health?: string | null;
}
export interface Person {
  id: number;
  name: string;
  role: string;
  phone: string | null;
  certs: string | null;
  active: number;
  crew_id: number | null;
  crew_name: string | null;
}
export interface Crew {
  id: number;
  name: string;
  foreman_id: number | null;
  foreman_name: string | null;
  trade: string;
  members: number[];
  member_count: number;
}
export interface Assignment {
  id: number;
  crew_id: number;
  crew_name: string;
  jobsite_id: number;
  jobsite_name: string;
  date: string;
  task: string;
  cost_code: string;
}
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
  progress_pct: number;
  rate: number | null;
  planned_rate: number | null;
}
export interface ReportLine {
  id?: number;
  plan_id: number;
  qty: number;
  labor_hours: number;
  equipment_hours: number;
  labor_cost: number;
  equipment_cost: number;
  material_cost: number;
}
export interface DailyReport {
  revision?: number;
  reversed_at?: string | null;
  reversal_reason?: string | null;
  reversed_by?: string | null;
  rejected_at?: string | null;
  rejection_reason?: string | null;
  rejected_by?: string | null;
  corrected_from_report_id?: number | null;
  replacement_report_id?: number | null;
  id: number;
  jobsite_id: number;
  jobsite_name: string;
  crew_id: number | null;
  crew_name: string | null;
  date: string;
  weather: string;
  notes: string;
  rough_pct: number | null;
  status: "draft" | "submitted" | "approved";
  created_by: string;
  lines: ReportLine[];
}
export interface CostEntry {
  id: number;
  jobsite_id: number;
  jobsite_name: string;
  date: string;
  cost_code: string;
  category: string;
  amount: number;
  description: string;
}
export interface WeeklyUpdate {
  id: number;
  jobsite_id: number;
  jobsite_name: string;
  pm_id: number;
  pm_name: string;
  week_ending: string;
  rough_pct: number;
  forecast_finish: string | null;
  forecast_cost: number;
  health: "on_track" | "at_risk" | "delayed";
  blockers: string;
  next_steps: string;
  notes: string;
  created_at: string;
}
export interface ERPData {
  projects: Project[];
  people: Person[];
  crews: Crew[];
  assignments: Assignment[];
  work_items: WorkItem[];
  daily_reports: DailyReport[];
  cost_entries: CostEntry[];
  weekly_updates: WeeklyUpdate[];
}
export const emptyERP: ERPData = {
  projects: [],
  people: [],
  crews: [],
  assignments: [],
  work_items: [],
  daily_reports: [],
  cost_entries: [],
  weekly_updates: [],
};
export const money = (n: number | null | undefined) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(n);
export const number = (n: number | null | undefined, digits = 0) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(
        n,
      );
export const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
