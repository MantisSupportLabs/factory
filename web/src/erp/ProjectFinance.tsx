import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { api } from "../api/client";
import { number, today, type ERPData } from "./types";
import { Badge, Empty, Field, Modal, SectionHead } from "./ui";
import { useAccess } from "./Access";

interface Calendar {
  jobsite_id: number;
  weekdays: number[];
  holidays: string[];
}
interface Dependency {
  id: number;
  jobsite_id: number;
  predecessor_id: number;
  successor_id: number;
  lag_days: number;
}
interface Baseline {
  id: number;
  jobsite_id: number;
  version: number;
  title: string;
  explanation: string;
  status: string;
  approved_at: string | null;
  snapshot: {
    project: { budget: number; contract_value: number };
    calendar: Calendar;
    work_items: {
      id: number;
      activity: string;
      unit: string;
      planned_qty: number;
      planned_hours: number;
      budget: number;
      cost_code: string;
    }[];
  };
}
interface Forecast {
  id: number;
  jobsite_id: number;
  version: number;
  as_of: string;
  forecast_finish: string;
  explanation: string;
  actual_cost: number;
  remaining_cost: number;
  estimate_at_completion: number;
  committed_reference: number;
  working_days_remaining: number;
  status: string;
  lines: {
    cost_code: string;
    labor: number;
    equipment: number;
    material: number;
    subcontract: number;
    other: number;
    notes: string;
  }[];
}
interface PayItem {
  id: number;
  jobsite_id: number;
  code: string;
  description: string;
  unit: string;
  total_qty: number;
  scheduled_value: number;
  plan_id: number | null;
  measured_qty: number | null;
}
interface BillLine {
  pay_item_id: number;
  code: string;
  description: string;
  unit: string;
  total_qty: number;
  plan_id: number | null;
  previous_qty: number;
  cumulative_qty: number | null;
  previous_earned_cents: number;
  cumulative_earned_cents: number;
  current_earned_cents: number;
}
interface Application {
  id: number;
  jobsite_id: number;
  number: number;
  status: "draft" | "submitted" | "approved" | "void";
  period_start: string;
  period_end: string;
  retainage_pct: number;
  current_earned: number;
  cumulative_earned: number;
  retainage: number;
  due: number;
  paid: number;
  unpaid: number;
  evidence_reference: string;
  evidence_warning: string | null;
  lines: BillLine[];
}
interface Payment {
  id: number;
  application_id: number;
  amount: number;
  received_date: string;
  reference: string;
  jobsite_id: number;
}
interface Release {
  id: number;
  jobsite_id: number;
  amount: number;
  paid: number;
  unpaid: number;
  release_date: string;
  acceptance_reference: string;
}
interface RetainagePayment {
  id: number;
  release_id: number;
  amount: number;
  received_date: string;
  reference: string;
  jobsite_id: number;
}
interface CloseoutItem {
  id: number;
  jobsite_id: number;
  title: string;
  required: number;
  status: string;
  evidence_reference: string;
}
interface FinanceData {
  calendars: Calendar[];
  dependencies: Dependency[];
  baselines: Baseline[];
  forecasts: Forecast[];
  pay_items: PayItem[];
  applications: Application[];
  payments: Payment[];
  retainage_releases: Release[];
  retainage_payments: RetainagePayment[];
  closeout_items: CloseoutItem[];
  closeouts: {
    jobsite_id: number;
    acceptance_reference: string;
    closed_at: string;
  }[];
}
const emptyFinance: FinanceData = {
  calendars: [],
  dependencies: [],
  baselines: [],
  forecasts: [],
  pay_items: [],
  applications: [],
  payments: [],
  retainage_releases: [],
  retainage_payments: [],
  closeout_items: [],
  closeouts: [],
};
const cash = (value: number | null | undefined) =>
  value == null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(value);
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Unable to save this record";
const val = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const num = (form: FormData, key: string) => Number(val(form, key));
const categories = [
  "labor",
  "equipment",
  "material",
  "subcontract",
  "other",
] as const;
const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
function useFinance(refresh: () => Promise<void>) {
  const [finance, setFinance] = useState<FinanceData>(emptyFinance),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    try {
      setFinance(await api.get<FinanceData>("/erp/project-finance"));
      setError("");
    } catch (failure) {
      setError(message(failure));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const syncSaved = async () => {
    await reload();
    try {
      await refresh();
    } catch (failure) {
      setError(
        `Saved successfully, but the project overview could not refresh: ${message(failure)}`,
      );
    }
  };
  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await syncSaved();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };
  return { finance, error, loading, busy, reload, perform, syncSaved };
}
function useFinancePermissions() {
  const access = useAccess(),
    privileged =
      access.mode === "demo" ||
      access.role === "owner" ||
      access.role === "admin";
  return {
    canPlan: privileged || access.role === "pm",
    canPrepare:
      privileged || access.role === "pm" || access.role === "accountant",
    canCertify: privileged || access.role === "accountant",
  };
}
function ProjectSelect({
  data,
  value,
  onChange,
}: {
  data: ERPData;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Field label="Project">
      <select
        value={value || String(data.projects[0]?.id ?? "")}
        onChange={(e) => onChange(e.target.value)}
      >
        {data.projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.code} · {p.name}
          </option>
        ))}
      </select>
    </Field>
  );
}
function Editor({
  title,
  onClose,
  save,
  children,
  submit = "Save record",
}: {
  title: string;
  onClose: () => void;
  save: (form: FormData) => Promise<unknown>;
  children: ReactNode;
  submit?: string;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await save(new FormData(event.currentTarget));
      onClose();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form className="erp-stack" onSubmit={send}>
        {error && (
          <div className="erp-alert" role="alert">
            {error}
          </div>
        )}
        {children}
        <div className="erp-form-actions">
          <button
            type="button"
            className="erp-button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="erp-button primary" disabled={busy}>
            {busy ? "Saving…" : submit}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function TextField({
  label,
  name,
  defaultValue = "",
  required = true,
  type = "text",
  min,
  step = "any",
}: {
  label: string;
  name: string;
  defaultValue?: string | number;
  required?: boolean;
  type?: string;
  min?: number;
  step?: string;
}) {
  return (
    <Field label={label}>
      <input
        name={name}
        required={required}
        type={type}
        min={min}
        step={type === "number" ? step : undefined}
        defaultValue={defaultValue}
      />
    </Field>
  );
}
function Note({
  label = "Explanation",
  name = "explanation",
  defaultValue = "",
  required = true,
}: {
  label?: string;
  name?: string;
  defaultValue?: string;
  required?: boolean;
}) {
  return (
    <Field label={label} wide>
      <textarea
        name={name}
        defaultValue={defaultValue}
        required={required}
        maxLength={4000}
        rows={3}
      />
    </Field>
  );
}

export function Forecasts({
  data,
  refresh,
}: {
  data: ERPData;
  refresh: () => Promise<void>;
}) {
  const { finance, error, loading, busy, reload, perform, syncSaved } =
    useFinance(refresh);
  const { canPlan, canPrepare, canCertify } = useFinancePermissions();
  const [selected, setSelected] = useState(""),
    [editor, setEditor] = useState<
      "" | "calendar" | "dependency" | "baseline" | "forecast"
    >(""),
    [detail, setDetail] = useState<Baseline | Forecast | null>(null);
  const projectId = Number(selected || data.projects[0]?.id),
    project = data.projects.find((p) => p.id === projectId),
    items = data.work_items.filter((i) => i.jobsite_id === projectId);
  const calendar = finance.calendars.find(
    (c) => c.jobsite_id === projectId,
  ) ?? { weekdays: [1, 2, 3, 4, 5], holidays: [] };
  const baselines = finance.baselines.filter((b) => b.jobsite_id === projectId),
    forecasts = finance.forecasts.filter((f) => f.jobsite_id === projectId),
    dependencies = finance.dependencies.filter(
      (d) => d.jobsite_id === projectId,
    ),
    latest = forecasts.find((f) => f.status === "approved");
  const save = async (form: FormData) => {
    if (editor === "calendar")
      await api.put(`/erp/project-calendars/${projectId}`, {
        weekdays: form.getAll("weekday").map(Number),
        holidays: val(form, "holidays")
          .split(/[\s,]+/)
          .filter(Boolean),
      });
    if (editor === "dependency")
      await api.post("/erp/work-dependencies", {
        predecessor_id: num(form, "predecessor_id"),
        successor_id: num(form, "successor_id"),
        lag_days: num(form, "lag_days"),
      });
    if (editor === "baseline")
      await api.post("/erp/project-baselines", {
        jobsite_id: projectId,
        title: val(form, "title"),
        explanation: val(form, "explanation"),
      });
    if (editor === "forecast") {
      const lines = items.map((i) => ({
        cost_code: i.cost_code,
        ...Object.fromEntries(
          categories.map((c) => [c, num(form, `${i.id}_${c}`)]),
        ),
        notes: val(form, `${i.id}_notes`),
      }));
      if (num(form, "overhead") > 0)
        lines.push({
          cost_code: "PROJECT-OVERHEAD",
          labor: 0,
          equipment: 0,
          material: 0,
          subcontract: 0,
          other: num(form, "overhead"),
          notes: "Remaining project overhead",
        } as (typeof lines)[number]);
      await api.post("/erp/cost-forecasts", {
        jobsite_id: projectId,
        as_of: val(form, "as_of"),
        forecast_finish: val(form, "forecast_finish"),
        explanation: val(form, "explanation"),
        complete_scope_confirmed: form.get("complete_scope_confirmed") === "on",
        lines,
      });
    }
    await syncSaved();
  };
  if (!data.projects.length)
    return (
      <Empty>
        Create a project to manage its plan and completion forecast.
      </Empty>
    );
  return (
    <div className="erp-stack">
      <SectionHead
        title="Plans & cost to complete"
        description="Capture an approved baseline and estimate remaining cost by cost code. Weekly PM rough forecasts remain separate."
        action={
          <button
            className="erp-button primary"
            disabled={!canPrepare || !items.length}
            onClick={() => setEditor("forecast")}
          >
            New cost forecast
          </button>
        }
      />
      {error && (
        <div className="erp-alert" role="alert">
          {error}
          <button className="erp-button" onClick={() => void reload()}>
            Retry
          </button>
        </div>
      )}
      <div className="erp-card">
        <div className="erp-toolbar">
          <ProjectSelect data={data} value={selected} onChange={setSelected} />
          <button
            className="erp-button"
            disabled={!canPlan}
            onClick={() => setEditor("calendar")}
          >
            Work calendar
          </button>
          <button
            className="erp-button"
            disabled={!canPlan || items.length < 2}
            onClick={() => setEditor("dependency")}
          >
            Add dependency
          </button>
          <button
            className="erp-button"
            disabled={!canPrepare || !items.length}
            onClick={() => setEditor("baseline")}
          >
            Capture baseline
          </button>
        </div>
        <p>
          Workdays: {calendar.weekdays.map((d) => weekdays[d]).join(", ")}.{" "}
          {calendar.holidays.length} excluded holidays. Dependencies record
          finish-to-start sequencing and working-day lag.
        </p>
      </div>
      <div className="erp-metrics">
        <div className="erp-metric">
          <span>Project cost budget</span>
          <strong>{cash(project?.budget)}</strong>
          <small>Current approved scope</small>
        </div>
        <div className="erp-metric">
          <span>Approved remaining cost</span>
          <strong>{cash(latest?.remaining_cost)}</strong>
          <small>
            {latest
              ? `Forecast version ${latest.version}`
              : "Awaiting forecast approval"}
          </small>
        </div>
        <div className="erp-metric">
          <span>Approved estimated final cost</span>
          <strong>{cash(latest?.estimate_at_completion)}</strong>
          <small>Recorded cost + remaining cost</small>
        </div>
        <div className="erp-metric">
          <span>Forecast completion</span>
          <strong>{latest?.forecast_finish ?? "—"}</strong>
          <small>
            {latest
              ? `${latest.working_days_remaining} working days from ${latest.as_of}`
              : "No approved bottom-up forecast"}
          </small>
        </div>
      </div>
      <div className="erp-card">
        <SectionHead
          title="Forecast versions"
          description="Each approved forecast retains its cost snapshot. Purchase commitments are shown for review; include unspent amounts in the remaining cost lines once."
        />
        {loading ? (
          <Empty>Loading forecasts…</Empty>
        ) : !forecasts.length ? (
          <Empty>
            Create the first complete remaining-cost estimate for this job.
          </Empty>
        ) : (
          <div className="erp-table-wrap">
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Version / as of</th>
                  <th>Recorded cost</th>
                  <th>Remaining cost</th>
                  <th>Estimated final cost</th>
                  <th>Finish / workdays</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {forecasts.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <button
                        className="erp-table-link"
                        onClick={() => setDetail(f)}
                      >
                        Version {f.version}
                      </button>
                      <small>{f.as_of}</small>
                    </td>
                    <td>{cash(f.actual_cost)}</td>
                    <td>{cash(f.remaining_cost)}</td>
                    <td>
                      <strong>{cash(f.estimate_at_completion)}</strong>
                    </td>
                    <td>
                      {f.forecast_finish}
                      <small>{f.working_days_remaining} workdays</small>
                    </td>
                    <td>
                      <Badge tone={f.status === "approved" ? "green" : "amber"}>
                        {f.status}
                      </Badge>
                    </td>
                    <td>
                      {canCertify && f.status === "draft" && (
                        <button
                          className="erp-button"
                          disabled={busy}
                          onClick={() =>
                            void perform(() =>
                              api.post(`/erp/cost-forecasts/${f.id}/approve`),
                            )
                          }
                        >
                          Approve forecast
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="erp-card">
        <SectionHead
          title="Baseline history"
          description="Quantity, budget, schedule, calendar, and sequencing snapshots stay fixed after approval."
        />
        {!baselines.length ? (
          <Empty>No baseline captured for this job.</Empty>
        ) : (
          <div className="erp-table-wrap">
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Baseline</th>
                  <th>Work-item budget</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {baselines.map((b) => (
                  <tr key={b.id}>
                    <td>V{b.version}</td>
                    <td>
                      <button
                        className="erp-table-link"
                        onClick={() => setDetail(b)}
                      >
                        {b.title}
                      </button>
                      <small>{b.explanation}</small>
                    </td>
                    <td>
                      {cash(
                        b.snapshot.work_items.reduce((s, i) => s + i.budget, 0),
                      )}
                    </td>
                    <td>
                      <Badge tone={b.status === "approved" ? "green" : "amber"}>
                        {b.status}
                      </Badge>
                    </td>
                    <td>
                      {canCertify && b.status === "draft" && (
                        <button
                          className="erp-button"
                          disabled={busy}
                          onClick={() =>
                            void perform(() =>
                              api.post(
                                `/erp/project-baselines/${b.id}/approve`,
                              ),
                            )
                          }
                        >
                          Approve baseline
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {!!dependencies.length && (
        <div className="erp-card">
          <SectionHead title="Work sequencing" />
          <div className="erp-table-wrap">
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Finish predecessor</th>
                  <th>Then start successor</th>
                  <th>Lag</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {dependencies.map((d) => (
                  <tr key={d.id}>
                    <td>
                      {items.find((i) => i.id === d.predecessor_id)?.activity}
                    </td>
                    <td>
                      {items.find((i) => i.id === d.successor_id)?.activity}
                    </td>
                    <td>{d.lag_days} working days</td>
                    <td>
                      <button
                        className="erp-button"
                        disabled={busy || !canPlan}
                        onClick={() =>
                          void perform(() =>
                            api.del(`/erp/work-dependencies/${d.id}`),
                          )
                        }
                      >
                        Remove link
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {editor && (
        <Editor
          title={
            editor === "calendar"
              ? "Project work calendar"
              : editor === "dependency"
                ? "Finish-to-start dependency"
                : editor === "baseline"
                  ? "Capture project baseline"
                  : "Complete remaining-cost forecast"
          }
          onClose={() => setEditor("")}
          save={save}
          submit={editor === "forecast" ? "Save forecast draft" : "Save record"}
        >
          {editor === "calendar" && (
            <>
              <fieldset>
                <legend>Working weekdays</legend>
                {weekdays.map((day, index) => (
                  <label
                    key={day}
                    style={{ display: "block", padding: "5px 0" }}
                  >
                    <input
                      type="checkbox"
                      name="weekday"
                      value={index}
                      defaultChecked={calendar.weekdays.includes(index)}
                    />{" "}
                    {day}
                  </label>
                ))}
              </fieldset>
              <Note
                label="Excluded holiday dates (YYYY-MM-DD, one per line)"
                name="holidays"
                defaultValue={calendar.holidays.join("\n")}
                required={false}
              />
            </>
          )}
          {editor === "dependency" && (
            <div className="erp-form-grid">
              <Field label="Finish this work item">
                <select required name="predecessor_id">
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.cost_code} · {i.activity}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Then start this work item">
                <select
                  required
                  name="successor_id"
                  defaultValue={items[1]?.id}
                >
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.cost_code} · {i.activity}
                    </option>
                  ))}
                </select>
              </Field>
              <TextField
                name="lag_days"
                label="Lag in working days"
                type="number"
                min={0}
                step="1"
                defaultValue={0}
              />
            </div>
          )}
          {editor === "baseline" && (
            <>
              <TextField
                name="title"
                label="Baseline title"
                defaultValue={`Project baseline ${baselines.length + 1}`}
              />
              <Note label="Reason and scope of baseline" />
              <p>
                This captures the current {items.length} work items and current
                project calendar.
              </p>
            </>
          )}
          {editor === "forecast" && (
            <>
              <div className="erp-form-grid">
                <TextField
                  name="as_of"
                  label="As-of date"
                  type="date"
                  defaultValue={today()}
                />
                <TextField
                  name="forecast_finish"
                  label="Forecast finish"
                  type="date"
                  defaultValue={project?.end_date ?? today()}
                />
              </div>
              <p>
                Enter the costs still needed to finish each cost code, including
                unspent purchase and subcontract commitments. Zero means no
                remaining cost in that category.
              </p>
              <div className="erp-table-wrap">
                <table className="erp-table">
                  <thead>
                    <tr>
                      <th>Cost code / work item</th>
                      {categories.map((c) => (
                        <th key={c}>Remaining {c} ($)</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.id}>
                        <td>
                          {i.cost_code}
                          <small>{i.activity}</small>
                          <input
                            name={`${i.id}_notes`}
                            aria-label={`${i.cost_code} forecast notes`}
                            placeholder="Estimate basis / notes"
                          />
                        </td>
                        {categories.map((c) => (
                          <td key={c}>
                            <input
                              style={{ minWidth: 85 }}
                              type="number"
                              min="0"
                              step="0.01"
                              required
                              name={`${i.id}_${c}`}
                              defaultValue="0"
                              aria-label={`${i.cost_code} remaining ${c}`}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <TextField
                name="overhead"
                label="Other remaining project overhead ($)"
                defaultValue={0}
                type="number"
                min={0}
                step="0.01"
              />
              <Note label="Estimate basis, risks, and treatment of outstanding commitments" />
              <label>
                <input
                  required
                  type="checkbox"
                  name="complete_scope_confirmed"
                />{" "}
                I included all remaining project scope and unspent commitments
                in this estimate.
              </label>
            </>
          )}
        </Editor>
      )}
      {detail && (
        <Modal
          title={
            "title" in detail
              ? `Baseline V${detail.version}: ${detail.title}`
              : `Forecast V${detail.version}`
          }
          onClose={() => setDetail(null)}
        >
          <div className="erp-stack">
            <p>{detail.explanation}</p>
            {"snapshot" in detail ? (
              <div className="erp-table-wrap">
                <table className="erp-table">
                  <thead>
                    <tr>
                      <th>Cost code</th>
                      <th>Activity</th>
                      <th>Baseline quantity</th>
                      <th>Hours</th>
                      <th>Budget</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.snapshot.work_items.map((i) => (
                      <tr key={i.id}>
                        <td>{i.cost_code}</td>
                        <td>{i.activity}</td>
                        <td>
                          {number(i.planned_qty, 2)} {i.unit}
                        </td>
                        <td>{number(i.planned_hours, 2)}</td>
                        <td>{cash(i.budget)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <>
                <p>
                  Original approved / received PO values at capture:{" "}
                  {cash(detail.committed_reference)}. These are review
                  information; the remaining-cost lines contain the amounts
                  still expected to be spent.
                </p>
                <div className="erp-table-wrap">
                  <table className="erp-table">
                    <thead>
                      <tr>
                        <th>Cost code</th>
                        {categories.map((c) => (
                          <th key={c}>{c}</th>
                        ))}
                        <th>Basis</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.lines.map((l) => (
                        <tr key={l.cost_code}>
                          <td>{l.cost_code}</td>
                          {categories.map((c) => (
                            <td key={c}>{cash(l[c] / 100)}</td>
                          ))}
                          <td>{l.notes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <button className="erp-button" onClick={() => setDetail(null)}>
              Close details
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function Billing({
  data,
  refresh,
}: {
  data: ERPData;
  refresh: () => Promise<void>;
}) {
  const { finance, error, loading, busy, reload, perform, syncSaved } =
    useFinance(refresh);
  const { canPlan, canPrepare, canCertify } = useFinancePermissions();
  const [selected, setSelected] = useState(""),
    [editor, setEditor] = useState<
      | ""
      | "pay-item"
      | "application"
      | "payment"
      | "release"
      | "retainage-payment"
      | "checklist"
      | "complete-item"
      | "closeout"
      | "withdraw"
    >(""),
    [recordId, setRecordId] = useState(0),
    [payPlan, setPayPlan] = useState(""),
    [detail, setDetail] = useState<Application | null>(null);
  const projectId = Number(selected || data.projects[0]?.id),
    project = data.projects.find((p) => p.id === projectId),
    items = data.work_items.filter((i) => i.jobsite_id === projectId),
    payItems = finance.pay_items.filter((p) => p.jobsite_id === projectId),
    applications = finance.applications.filter(
      (a) => a.jobsite_id === projectId,
    ),
    certified = applications.filter((a) => a.status === "approved"),
    previous = certified[0],
    releases = finance.retainage_releases.filter(
      (r) => r.jobsite_id === projectId,
    ),
    closeout = finance.closeouts.find((c) => c.jobsite_id === projectId),
    checklist = finance.closeout_items.filter(
      (c) => c.jobsite_id === projectId,
    ),
    payments = finance.payments.filter((p) => p.jobsite_id === projectId),
    retainagePayments = finance.retainage_payments.filter(
      (p) => p.jobsite_id === projectId,
    );
  const retained = certified.reduce((n, a) => n + a.retainage, 0),
    released = releases.reduce((n, r) => n + r.amount, 0),
    received =
      certified.reduce((n, a) => n + a.paid, 0) +
      releases.reduce((n, r) => n + r.paid, 0),
    openApp = applications.some(
      (a) => a.status === "draft" || a.status === "submitted",
    ),
    scheduled = payItems.reduce((n, p) => n + p.scheduled_value, 0),
    mapped = items.find((i) => i.id === Number(payPlan));
  const start = (mode: typeof editor, id = 0) => {
    setRecordId(id);
    setPayPlan("");
    setEditor(mode);
  };
  const save = async (form: FormData) => {
    if (editor === "pay-item")
      await api.post("/erp/pay-items", {
        jobsite_id: projectId,
        code: val(form, "code"),
        description: val(form, "description"),
        unit: val(form, "unit"),
        total_qty: num(form, "total_qty"),
        scheduled_value: num(form, "scheduled_value"),
        plan_id: payPlan ? Number(payPlan) : null,
      });
    if (editor === "application")
      await api.post("/erp/payment-applications", {
        jobsite_id: projectId,
        period_start: val(form, "period_start"),
        period_end: val(form, "period_end"),
        retainage_pct: num(form, "retainage_pct"),
        evidence_reference: val(form, "evidence_reference"),
        lines: payItems.map((p) => ({
          pay_item_id: p.id,
          ...(p.plan_id !== null
            ? { cumulative_qty: num(form, `earned_${p.id}`) }
            : { cumulative_amount: num(form, `earned_${p.id}`) }),
        })),
      });
    if (editor === "payment")
      await api.post("/erp/customer-payments", {
        application_id: recordId,
        amount: num(form, "amount"),
        received_date: val(form, "received_date"),
        reference: val(form, "reference"),
      });
    if (editor === "release")
      await api.post("/erp/retainage-releases", {
        jobsite_id: projectId,
        amount: num(form, "amount"),
        release_date: val(form, "release_date"),
        acceptance_reference: val(form, "acceptance_reference"),
      });
    if (editor === "retainage-payment")
      await api.post("/erp/retainage-payments", {
        release_id: recordId,
        amount: num(form, "amount"),
        received_date: val(form, "received_date"),
        reference: val(form, "reference"),
      });
    if (editor === "checklist")
      await api.post("/erp/closeout-items", {
        jobsite_id: projectId,
        title: val(form, "title"),
        required: form.get("required") === "on",
      });
    if (editor === "complete-item")
      await api.patch(`/erp/closeout-items/${recordId}`, {
        status: "complete",
        evidence_reference: val(form, "evidence_reference"),
      });
    if (editor === "closeout")
      await api.post(`/erp/project-closeout/${projectId}`, {
        acceptance_reference: val(form, "acceptance_reference"),
      });
    if (editor === "withdraw")
      await api.post(`/erp/payment-applications/${recordId}/withdraw`, {
        reason: val(form, "reason"),
      });
    await syncSaved();
  };
  const appForPayment = applications.find((a) => a.id === recordId),
    releaseForPayment = releases.find((r) => r.id === recordId);
  const editorTitle = {
    "pay-item": "Add contract pay item",
    application: "Draft progress payment application",
    payment: "Record customer payment",
    release: "Release accepted-project retainage",
    "retainage-payment": "Record retainage payment",
    checklist: "Add closeout checklist item",
    "complete-item": "Complete closeout item",
    closeout: "Final project acceptance",
    withdraw: "Withdraw unapproved application",
  };
  if (!data.projects.length)
    return <Empty>Create a project before setting up owner billing.</Empty>;
  return (
    <div className="erp-stack">
      <SectionHead
        title="Owner billing & closeout"
        description="Build the contract schedule of values, certify progress, track cash received and retained balances, and record final acceptance."
        action={
          <button
            className="erp-button primary"
            disabled={!canPrepare || !payItems.length || openApp || !!closeout}
            onClick={() => start("application")}
          >
            New payment application
          </button>
        }
      />
      {error && (
        <div className="erp-alert" role="alert">
          {error}
          <button className="erp-button" onClick={() => void reload()}>
            Retry
          </button>
        </div>
      )}
      <div className="erp-card">
        <div className="erp-toolbar">
          <ProjectSelect data={data} value={selected} onChange={setSelected} />
          {closeout ? (
            <Badge tone="green">
              Accepted {closeout.closed_at.slice(0, 10)}
            </Badge>
          ) : (
            <Badge>{project?.status}</Badge>
          )}
        </div>
      </div>
      <div className="erp-metrics">
        <div className="erp-metric">
          <span>Current approved contract</span>
          <strong>{cash(project?.contract_value)}</strong>
          <small>
            {cash(scheduled)} scheduled across {payItems.length} pay items
          </small>
        </div>
        <div className="erp-metric">
          <span>Certified earned value</span>
          <strong>{cash(previous?.cumulative_earned ?? 0)}</strong>
          <small>{certified.length} certified applications</small>
        </div>
        <div className="erp-metric">
          <span>Customer cash received</span>
          <strong>{cash(received)}</strong>
          <small>Application and released-retainage receipts</small>
        </div>
        <div className="erp-metric">
          <span>Unreleased retainage</span>
          <strong>{cash(retained - released)}</strong>
          <small>
            {cash(releases.reduce((n, r) => n + r.unpaid, 0))} released and
            awaiting payment
          </small>
        </div>
      </div>
      <div className="erp-card">
        <SectionHead
          title="Contract schedule of values"
          description="Mapped quantity lines use recorded manual production and approved field reports through the billing period. Other lines require an explicit verification reference."
          action={
            <button
              className="erp-button"
              disabled={!canPrepare || openApp || !!closeout}
              onClick={() => start("pay-item")}
            >
              Add pay item
            </button>
          }
        />
        {loading ? (
          <Empty>Loading billing…</Empty>
        ) : !payItems.length ? (
          <Empty>
            Add unit-price or verified-amount pay items to allocate the approved
            contract.
          </Empty>
        ) : (
          <div className="erp-table-wrap">
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Pay item</th>
                  <th>Basis</th>
                  <th>Contract quantity</th>
                  <th>Scheduled value</th>
                  <th>Certified earned</th>
                </tr>
              </thead>
              <tbody>
                {payItems.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>
                        {p.code} · {p.description}
                      </strong>
                    </td>
                    <td>
                      {p.plan_id === null
                        ? "Verified amount"
                        : `Measured quantity · ${number(p.measured_qty, 2)} ${p.unit} recorded`}
                    </td>
                    <td>
                      {number(p.total_qty, 2)} {p.unit}
                    </td>
                    <td>{cash(p.scheduled_value)}</td>
                    <td>
                      {cash(
                        (previous?.lines.find((l) => l.pay_item_id === p.id)
                          ?.cumulative_earned_cents ?? 0) / 100,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="erp-card">
        <SectionHead
          title="Payment applications"
          description="Approval freezes earned quantities and retention. Receipts reduce the certified balance; they do not change job costs."
        />
        {!applications.length ? (
          <Empty>No payment application for this project yet.</Empty>
        ) : (
          <div className="erp-table-wrap">
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Application / period</th>
                  <th>This period earned</th>
                  <th>Retained</th>
                  <th>Net certified</th>
                  <th>Unpaid</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {applications.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <button
                        className="erp-table-link"
                        onClick={() => setDetail(a)}
                      >
                        Application {a.number}
                      </button>
                      <small>
                        {a.period_start} – {a.period_end}
                      </small>
                      {a.evidence_warning && (
                        <small className="erp-negative">
                          {a.evidence_warning}
                        </small>
                      )}
                    </td>
                    <td>{cash(a.current_earned)}</td>
                    <td>{cash(a.retainage)}</td>
                    <td>{cash(a.due)}</td>
                    <td>{a.status === "approved" ? cash(a.unpaid) : "—"}</td>
                    <td>
                      <Badge
                        tone={
                          a.status === "approved"
                            ? "green"
                            : a.status === "void"
                              ? "neutral"
                              : "amber"
                        }
                      >
                        {a.status}
                      </Badge>
                    </td>
                    <td>
                      <div className="erp-form-actions">
                        {canPrepare && a.status === "draft" && (
                          <button
                            className="erp-button"
                            disabled={busy}
                            onClick={() =>
                              void perform(() =>
                                api.post(
                                  `/erp/payment-applications/${a.id}/submit`,
                                ),
                              )
                            }
                          >
                            Submit
                          </button>
                        )}
                        {canCertify && a.status === "submitted" && (
                          <button
                            className="erp-button"
                            disabled={busy}
                            onClick={() =>
                              void perform(() =>
                                api.post(
                                  `/erp/payment-applications/${a.id}/approve`,
                                ),
                              )
                            }
                          >
                            Certify application
                          </button>
                        )}
                        {canCertify &&
                          a.status === "approved" &&
                          a.unpaid > 0 && (
                            <button
                              className="erp-button"
                              onClick={() => start("payment", a.id)}
                            >
                              Record payment
                            </button>
                          )}
                        {canPrepare &&
                          ["draft", "submitted"].includes(a.status) && (
                            <button
                              className="erp-button"
                              onClick={() => start("withdraw", a.id)}
                            >
                              Withdraw
                            </button>
                          )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {!!payments.length && (
        <div className="erp-card">
          <SectionHead title="Customer payment receipts" />
          <div className="erp-table-wrap">
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Application</th>
                  <th>Reference</th>
                  <th>Amount received</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td>{p.received_date}</td>
                    <td>
                      Application{" "}
                      {
                        applications.find((a) => a.id === p.application_id)
                          ?.number
                      }
                    </td>
                    <td>{p.reference}</td>
                    <td>{cash(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="erp-card">
        <SectionHead
          title="Retainage releases"
          description="Signed final acceptance releases retained value into a separate receivable. Record its receipt when cash arrives."
          action={
            <button
              className="erp-button"
              disabled={!canCertify || !closeout || retained - released <= 0}
              onClick={() => start("release")}
            >
              Release retainage
            </button>
          }
        />
        {!releases.length ? (
          <Empty>
            {closeout
              ? "No retainage release recorded."
              : "Complete project acceptance to release retainage."}
          </Empty>
        ) : (
          <div className="erp-table-wrap">
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Release date</th>
                  <th>Acceptance reference</th>
                  <th>Released</th>
                  <th>Received</th>
                  <th>Unpaid</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {releases.map((r) => (
                  <tr key={r.id}>
                    <td>{r.release_date}</td>
                    <td>{r.acceptance_reference}</td>
                    <td>{cash(r.amount)}</td>
                    <td>{cash(r.paid)}</td>
                    <td>{cash(r.unpaid)}</td>
                    <td>
                      {canCertify && r.unpaid > 0 && (
                        <button
                          className="erp-button"
                          onClick={() => start("retainage-payment", r.id)}
                        >
                          Record retainage receipt
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!!retainagePayments.length && (
          <p>
            Retainage receipts:{" "}
            {retainagePayments
              .map(
                (p) =>
                  `${p.received_date} · ${p.reference} · ${cash(p.amount)}`,
              )
              .join("; ")}
          </p>
        )}
      </div>
      <div className="erp-card">
        <SectionHead
          title="Closeout checklist"
          description="Resolve required punch items and record evidence before final acceptance. Complete measured quantities and resolve open RFIs, changes, and issues first."
          action={
            <div className="erp-form-actions">
              <button
                className="erp-button"
                disabled={!canPlan || !!closeout}
                onClick={() => start("checklist")}
              >
                Add closeout item
              </button>
              <button
                className="erp-button"
                disabled={!canPlan || !!closeout || !checklist.length}
                onClick={() => start("closeout")}
              >
                Record final acceptance
              </button>
            </div>
          }
        />
        {closeout && (
          <p>
            Accepted by reference {closeout.acceptance_reference} on{" "}
            {closeout.closed_at.slice(0, 10)}.
          </p>
        )}
        {!checklist.length ? (
          <Empty>
            Add required records, inspections, as-builts, and punch items for
            this job.
          </Empty>
        ) : (
          <div className="erp-table-wrap">
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Required record / punch item</th>
                  <th>Required</th>
                  <th>Status</th>
                  <th>Evidence</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {checklist.map((c) => (
                  <tr key={c.id}>
                    <td>{c.title}</td>
                    <td>{c.required ? "Yes" : "Optional"}</td>
                    <td>
                      <Badge tone={c.status === "complete" ? "green" : "amber"}>
                        {c.status}
                      </Badge>
                    </td>
                    <td>{c.evidence_reference || "—"}</td>
                    <td>
                      {canPlan &&
                        !closeout &&
                        (c.status === "open" ? (
                          <button
                            className="erp-button"
                            onClick={() => start("complete-item", c.id)}
                          >
                            Complete with evidence
                          </button>
                        ) : (
                          <button
                            className="erp-button"
                            disabled={busy}
                            onClick={() =>
                              void perform(() =>
                                api.patch(`/erp/closeout-items/${c.id}`, {
                                  status: "open",
                                  evidence_reference: "",
                                }),
                              )
                            }
                          >
                            Reopen
                          </button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editor && (
        <Editor
          key={`${editor}-${recordId}`}
          title={editorTitle[editor]}
          onClose={() => setEditor("")}
          save={save}
          submit={
            editor === "closeout"
              ? "Accept and close project"
              : editor === "application"
                ? "Save billing draft"
                : "Save record"
          }
        >
          {editor === "pay-item" && (
            <>
              <Field label="Evidence basis">
                <select
                  value={payPlan}
                  onChange={(e) => setPayPlan(e.target.value)}
                >
                  <option value="">Verified amount / lump sum</option>
                  {items
                    .filter((i) => !payItems.some((p) => p.plan_id === i.id))
                    .map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.cost_code} · {i.activity} (measured quantity)
                      </option>
                    ))}
                </select>
              </Field>
              <div className="erp-form-grid" key={payPlan}>
                <TextField
                  label="Pay item code"
                  name="code"
                  defaultValue={mapped?.cost_code ?? ""}
                />
                <TextField
                  label="Description"
                  name="description"
                  defaultValue={mapped?.activity ?? ""}
                />
                <TextField
                  label="Contract unit"
                  name="unit"
                  defaultValue={mapped?.unit ?? "LS"}
                />
                <TextField
                  label="Contract quantity"
                  name="total_qty"
                  type="number"
                  min={0.000001}
                  defaultValue={mapped?.planned_qty ?? 1}
                />
                <TextField
                  label="Scheduled contract value ($)"
                  name="scheduled_value"
                  type="number"
                  min={0.01}
                  step="0.01"
                />
              </div>
              <p>
                Remaining contract value available to schedule:{" "}
                {cash((project?.contract_value ?? 0) - scheduled)}.
              </p>
            </>
          )}
          {editor === "application" && (
            <>
              <div className="erp-form-grid">
                <TextField
                  label="Period start"
                  name="period_start"
                  type="date"
                  defaultValue={
                    previous
                      ? new Date(Date.parse(previous.period_end) + 86400000)
                          .toISOString()
                          .slice(0, 10)
                      : (project?.start_date ?? today())
                  }
                />
                <TextField
                  label="Period end"
                  name="period_end"
                  type="date"
                  defaultValue={today()}
                />
                <TextField
                  label="Retainage (%)"
                  name="retainage_pct"
                  type="number"
                  min={0}
                  defaultValue={previous?.retainage_pct ?? 5}
                />
              </div>
              <Note
                label="Owner measurement / verification reference"
                name="evidence_reference"
              />
              <p>
                Enter cumulative earned quantities or cumulative verified
                amounts through this period. Prior certified value is deducted
                automatically.
              </p>
              <div className="erp-table-wrap">
                <table className="erp-table">
                  <thead>
                    <tr>
                      <th>Pay item / basis</th>
                      <th>Prior cumulative</th>
                      <th>Cumulative this period</th>
                      <th>Available evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payItems.map((p) => {
                      const old = previous?.lines.find(
                          (l) => l.pay_item_id === p.id,
                        ),
                        value =
                          p.plan_id !== null
                            ? (old?.cumulative_qty ?? 0)
                            : (old?.cumulative_earned_cents ?? 0) / 100;
                      return (
                        <tr key={p.id}>
                          <td>
                            {p.code}
                            <small>{p.description}</small>
                          </td>
                          <td>
                            {p.plan_id !== null
                              ? `${number(value, 2)} ${p.unit}`
                              : cash(value)}
                          </td>
                          <td>
                            <input
                              type="number"
                              required
                              min={value}
                              max={
                                p.plan_id !== null
                                  ? p.total_qty
                                  : p.scheduled_value
                              }
                              step="any"
                              name={`earned_${p.id}`}
                              defaultValue={value}
                              aria-label={`${p.code} cumulative ${p.plan_id !== null ? "quantity" : "earned amount"}`}
                            />
                          </td>
                          <td>
                            {p.plan_id !== null
                              ? `${number(p.measured_qty, 2)} ${p.unit} recorded`
                              : `${cash(p.scheduled_value)} scheduled`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {(editor === "payment" || editor === "retainage-payment") && (
            <>
              <p>
                Unpaid certified balance:{" "}
                {cash(
                  editor === "payment"
                    ? appForPayment?.unpaid
                    : releaseForPayment?.unpaid,
                )}
                .
              </p>
              <div className="erp-form-grid">
                <TextField
                  name="amount"
                  label="Amount received ($)"
                  type="number"
                  min={0.01}
                  step="0.01"
                  defaultValue={
                    editor === "payment"
                      ? appForPayment?.unpaid
                      : releaseForPayment?.unpaid
                  }
                />
                <TextField
                  name="received_date"
                  label="Receipt date"
                  type="date"
                  defaultValue={today()}
                />
                <TextField
                  name="reference"
                  label="Bank / check receipt reference"
                />
              </div>
            </>
          )}
          {editor === "release" && (
            <>
              <p>
                Unreleased retainage available: {cash(retained - released)}.
              </p>
              <div className="erp-form-grid">
                <TextField
                  name="amount"
                  label="Retainage to release ($)"
                  type="number"
                  min={0.01}
                  step="0.01"
                  defaultValue={retained - released}
                />
                <TextField
                  name="release_date"
                  label="Release date"
                  type="date"
                  defaultValue={today()}
                />
                <TextField
                  name="acceptance_reference"
                  label="Signed retainage release reference"
                />
              </div>
            </>
          )}
          {editor === "checklist" && (
            <>
              <TextField label="Required record or punch item" name="title" />
              <label>
                <input type="checkbox" defaultChecked name="required" />{" "}
                Required for final acceptance
              </label>
            </>
          )}
          {editor === "complete-item" && (
            <>
              <p>{checklist.find((c) => c.id === recordId)?.title}</p>
              <TextField
                label="Inspection, document, or sign-off reference"
                name="evidence_reference"
              />
            </>
          )}
          {editor === "closeout" && (
            <>
              <p>
                Final acceptance closes this job. The server checks completed
                measured quantities, open required records, open issues, and
                unapproved billing.
              </p>
              <TextField
                name="acceptance_reference"
                label="Signed customer final acceptance reference"
              />
            </>
          )}
          {editor === "withdraw" && (
            <Note label="Reason for withdrawal and replacement" name="reason" />
          )}
        </Editor>
      )}
      {detail && (
        <Modal
          title={`Payment application ${detail.number}`}
          onClose={() => setDetail(null)}
        >
          <div className="erp-stack">
            <p>
              {detail.period_start} – {detail.period_end} ·{" "}
              {detail.evidence_reference}
            </p>
            {detail.evidence_warning && (
              <div className="erp-alert" role="alert">
                {detail.evidence_warning}
              </div>
            )}
            <div className="erp-table-wrap">
              <table className="erp-table">
                <thead>
                  <tr>
                    <th>Pay item</th>
                    <th>Cumulative quantity</th>
                    <th>Previously earned</th>
                    <th>Cumulative earned</th>
                    <th>Earned this period</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.map((l) => (
                    <tr key={l.pay_item_id}>
                      <td>
                        {l.code}
                        <small>{l.description}</small>
                      </td>
                      <td>
                        {l.cumulative_qty === null
                          ? "Verified amount"
                          : `${number(l.cumulative_qty, 2)} ${l.unit}`}
                      </td>
                      <td>{cash(l.previous_earned_cents / 100)}</td>
                      <td>{cash(l.cumulative_earned_cents / 100)}</td>
                      <td>{cash(l.current_earned_cents / 100)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Earned {cash(detail.current_earned)} − retained{" "}
              {cash(detail.retainage)} = certified due {cash(detail.due)}.
              Received {cash(detail.paid)}.
            </p>
            <button className="erp-button" onClick={() => setDetail(null)}>
              Close details
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
