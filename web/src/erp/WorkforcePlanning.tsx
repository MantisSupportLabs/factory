import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { type ERPData, number, today } from "./types";
import { Badge, Empty, Field, Modal, SectionHead } from "./ui";

type Shift = {
  id: number;
  employee_id: number;
  employee_name: string;
  jobsite_id: number;
  jobsite_name: string;
  date: string;
  cost_code: string;
  start_time: string;
  end_time: string;
  break_minutes: number;
  hours: number;
  hourly_rate: number;
  burden_pct: number;
  base_cost: number;
  burden_cost: number;
  rates_pending?: number;
  status: "draft" | "submitted" | "approved";
  notes: string;
  approved_by?: string;
  voided_at?: string | null;
  void_reason?: string | null;
};
type Qualification = {
  id: number;
  employee_id: number;
  employee_name: string;
  cert_name: string;
  issued_date: string;
  expires_date: string;
  notes: string;
  validity: string;
};
type History = {
  id: number;
  crew_name: string;
  members: number[];
  member_names: string[];
  effective_date: string;
  snapshot_at: string;
  source: string;
};
type AssignmentMember = {
  assignment_id: number;
  employee_id: number;
  employee_name: string;
  crew_name: string;
  jobsite_name: string;
  date: string;
  snapshot_source: string;
};
type Workforce = {
  time_entries: Shift[];
  certifications: Qualification[];
  membership_history: History[];
  assignment_members: AssignmentMember[];
  can_view_rates?: boolean;
  can_edit_time?: boolean;
  can_edit_certifications?: boolean;
};
type ShiftForm = {
  id?: number;
  employee_id: string;
  jobsite_id: string;
  date: string;
  cost_code: string;
  start_time: string;
  end_time: string;
  break_minutes: number;
  hourly_rate: number;
  burden_pct: number;
  notes: string;
  status: "draft" | "submitted";
};
type CertForm = {
  employee_id: string;
  cert_name: string;
  issued_date: string;
  expires_date: string;
  notes: string;
};
const empty: Workforce = {
  time_entries: [],
  certifications: [],
  membership_history: [],
  assignment_members: [],
};
const currency = (value: number | null | undefined) =>
  value == null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      }).format(value);
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Unable to save the workforce record.";
const certTone = (validity: string) =>
  validity === "expired"
    ? "danger"
    : validity === "valid"
      ? "success"
      : "warning";
const certLabel = (validity: string) =>
  ({
    expired: "Expired",
    expires_today: "Expires today",
    expiring_soon: "Expires within 30 days",
    not_yet_valid: "Not yet valid",
    valid: "Valid",
  })[validity] ?? validity;

export function WorkforcePlanning({
  data,
  refresh,
}: {
  data: ERPData;
  refresh: () => Promise<void>;
}) {
  const [workforce, setWorkforce] = useState<Workforce>(empty),
    [tab, setTab] = useState<"time" | "qualifications" | "history">("time");
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [saving, setSaving] = useState(false);
  const [projectId, setProjectId] = useState("all"),
    [startDate, setStartDate] = useState(""),
    [endDate, setEndDate] = useState("");
  const [shiftForm, setShiftForm] = useState<ShiftForm | null>(null),
    [certForm, setCertForm] = useState<CertForm | null>(null);
  const [reviewRate, setReviewRate] = useState(0),
    [reviewBurden, setReviewBurden] = useState(0);
  const [review, setReview] = useState<{
      shift: Shift;
      action: "approve" | "void";
    } | null>(null),
    [reason, setReason] = useState("");
  useEffect(() => {
    let alive = true;
    api
      .get<Workforce>("/erp/workforce-planning")
      .then((result) => {
        if (alive) setWorkforce(result);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  async function reload(message: string) {
    setSuccess(message);
    try {
      const result = await api.get<Workforce>("/erp/workforce-planning");
      setWorkforce(result);
      await refresh();
    } catch (e) {
      setError(
        `Saved successfully, but the current register could not refresh: ${errorText(e)}`,
      );
    }
  }
  const canRates = workforce.can_view_rates === true,
    canTime = workforce.can_edit_time === true,
    canCerts = workforce.can_edit_certifications === true;
  const shifts = workforce.time_entries.filter(
    (e) =>
      (projectId === "all" || e.jobsite_id === Number(projectId)) &&
      (!startDate || e.date >= startDate) &&
      (!endDate || e.date <= endDate),
  );
  const approved = shifts.filter(
    (e) => e.status === "approved" && !e.voided_at,
  );
  const assignmentIds = [
    ...new Set(workforce.assignment_members.map((m) => m.assignment_id)),
  ];
  const elapsed = shiftForm
    ? (Number(shiftForm.end_time.slice(0, 2)) * 60 +
        Number(shiftForm.end_time.slice(3)) -
        Number(shiftForm.start_time.slice(0, 2)) * 60 -
        Number(shiftForm.start_time.slice(3)) -
        shiftForm.break_minutes) /
      60
    : 0;
  const projectedBase = shiftForm
    ? Math.round(Math.max(0, elapsed) * shiftForm.hourly_rate * 100) / 100
    : 0;
  const projectedBurden = shiftForm
    ? Math.round(projectedBase * shiftForm.burden_pct) / 100
    : 0;
  function newShift() {
    setError("");
    setSuccess("");
    setShiftForm({
      employee_id: "",
      jobsite_id: projectId === "all" ? "" : projectId,
      date: today(),
      cost_code: "",
      start_time: "07:00",
      end_time: "15:30",
      break_minutes: 30,
      hourly_rate: 0,
      burden_pct: 0,
      notes: "",
      status: "draft",
    });
  }
  function editShift(e: Shift) {
    setError("");
    setShiftForm({
      id: e.id,
      employee_id: String(e.employee_id),
      jobsite_id: String(e.jobsite_id),
      date: e.date,
      cost_code: e.cost_code,
      start_time: e.start_time,
      end_time: e.end_time,
      break_minutes: e.break_minutes,
      hourly_rate: e.hourly_rate ?? 0,
      burden_pct: e.burden_pct ?? 0,
      notes: e.notes,
      status: "draft",
    });
  }
  async function saveShift(event: FormEvent) {
    event.preventDefault();
    if (!shiftForm) return;
    setSaving(true);
    setError("");
    try {
      const { id, ...form } = shiftForm,
        { hourly_rate, burden_pct, ...clocks } = form,
        payload = {
          ...clocks,
          ...(canRates ? { hourly_rate, burden_pct } : {}),
          employee_id: Number(form.employee_id),
          jobsite_id: Number(form.jobsite_id),
        };
      if (id) await api.patch(`/erp/time-entries/${id}`, payload);
      else await api.post("/erp/time-entries", payload);
      setShiftForm(null);
      await reload(
        form.status === "submitted"
          ? "Shift submitted for review."
          : "Shift saved as a draft.",
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  async function saveCert(event: FormEvent) {
    event.preventDefault();
    if (!certForm) return;
    setSaving(true);
    setError("");
    try {
      await api.post("/erp/certifications", {
        ...certForm,
        employee_id: Number(certForm.employee_id),
      });
      setCertForm(null);
      await reload("Dated qualification recorded.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  async function submit(e: Shift) {
    setSaving(true);
    setError("");
    try {
      await api.post(`/erp/time-entries/${e.id}/submit`);
      await reload("Shift submitted for review.");
    } catch (error) {
      setError(errorText(error));
    } finally {
      setSaving(false);
    }
  }
  async function reviewShift(event: FormEvent) {
    event.preventDefault();
    if (!review) return;
    setSaving(true);
    setError("");
    try {
      await api.post(
        `/erp/time-entries/${review.shift.id}/${review.action}`,
        review.action === "void"
          ? { reason }
          : { hourly_rate: reviewRate, burden_pct: reviewBurden },
      );
      setReview(null);
      await reload(
        review.action === "approve"
          ? "Shift approved; wage and burden cost posted to the job."
          : "Shift voided; its cost is excluded and its original record retained.",
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  function payrollExport() {
    const columns = [
      "id",
      "employee_id",
      "employee_name",
      "date",
      "start_time",
      "end_time",
      "break_minutes",
      "hours",
      "jobsite_id",
      "jobsite_name",
      "cost_code",
      "hourly_rate",
      "base_cost",
      "burden_pct",
      "burden_cost",
      "approved_by",
    ] as const;
    const value = (raw: unknown) => {
      const s = String(raw ?? "");
      return `"${(/^[=+@-]/.test(s) ? `'${s}` : s).replaceAll('"', '""')}"`;
    };
    const csv = [
      columns.join(","),
      ...approved.map((e) => columns.map((c) => value(e[c])).join(",")),
    ].join("\r\n");
    const url = URL.createObjectURL(
        new Blob([csv], { type: "text/csv;charset=utf-8" }),
      ),
      link = document.createElement("a");
    link.href = url;
    link.download = "payroll-preparation.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSuccess(
      `Exported ${approved.length} approved shifts for payroll preparation. Wage values are straight time; review overtime and payroll rules before payroll processing.`,
    );
  }
  return (
    <div className="erp-stack">
      <SectionHead
        title="Workforce planning"
        description="Person-level shifts, dated qualifications, and the roster dispatched to each job."
        action={
          <div className="erp-form-actions">
            {canCerts && (
              <button
                className="erp-button"
                onClick={() => {
                  setError("");
                  setCertForm({
                    employee_id: "",
                    cert_name: "",
                    issued_date: today(),
                    expires_date: "",
                    notes: "",
                  });
                }}
              >
                + Qualification
              </button>
            )}
            {canTime && (
              <button
                className="erp-button primary"
                disabled={
                  !data.projects.length || !data.people.some((p) => p.active)
                }
                onClick={newShift}
              >
                + Split shift
              </button>
            )}
          </div>
        }
      />
      {error && !shiftForm && !certForm && !review && (
        <div className="erp-alert error" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="erp-alert success" role="status">
          {success}
        </div>
      )}
      <div className="erp-metrics">
        <div className="erp-metric">
          <span>Approved hours</span>
          <strong>
            {number(
              approved.reduce((s, e) => s + e.hours, 0),
              2,
            )}
          </strong>
          <small>Current job and date filters</small>
        </div>
        <div className="erp-metric">
          <span>Approved labor cost</span>
          <strong>
            {canRates
              ? currency(
                  approved.reduce((s, e) => s + e.base_cost + e.burden_cost, 0),
                )
              : "Restricted"}
          </strong>
          <small>Wage + recorded burden</small>
        </div>
        <div className="erp-metric">
          <span>Awaiting time review</span>
          <strong>
            {
              shifts.filter((e) => e.status === "submitted" && !e.voided_at)
                .length
            }
          </strong>
          <small>Costs post after approval</small>
        </div>
        <div className="erp-metric">
          <span>Expired qualifications</span>
          <strong>
            {
              workforce.certifications.filter((c) => c.validity === "expired")
                .length
            }
          </strong>
          <small>
            {
              workforce.certifications.filter((c) =>
                ["expires_today", "expiring_soon"].includes(c.validity),
              ).length
            }{" "}
            expiring within 30 days
          </small>
        </div>
      </div>
      <div className="erp-toolbar">
        <div className="erp-tabs" role="group" aria-label="Workforce view">
          {(["time", "qualifications", "history"] as const).map((t) => (
            <button
              key={t}
              className={`erp-button ${tab === t ? "primary" : ""}`}
              aria-pressed={tab === t}
              onClick={() => setTab(t)}
            >
              {t === "time"
                ? "Time & payroll preparation"
                : t === "qualifications"
                  ? "Qualifications"
                  : "Crew history"}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <Empty>Loading workforce records…</Empty>
      ) : tab === "time" ? (
        <section className="erp-card">
          <SectionHead
            title="Split time register"
            description="Record one employee, job, and cost code per interval. Breaks reduce paid hours. Approved rate and burden snapshots stay locked."
            action={
              canRates ? (
                <button
                  className="erp-button"
                  disabled={!approved.length}
                  onClick={payrollExport}
                >
                  Export payroll preparation
                </button>
              ) : undefined
            }
          />
          <div className="erp-toolbar">
            <Field label="Project">
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                <option value="all">All projects</option>
                {data.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="From date">
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </Field>
            <Field label="Through date">
              <input
                type="date"
                min={startDate || undefined}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </Field>
          </div>
          <p className="erp-muted">
            Payroll preparation uses approved, unvoided straight-time shifts.
            Tax, overtime rules, withholding, and payroll processing belong in
            your payroll system.
          </p>
          {shifts.length ? (
            <div className="erp-table-wrap">
              <table className="erp-table">
                <thead>
                  <tr>
                    <th>Employee / date</th>
                    <th>Job / code</th>
                    <th>Shift / break</th>
                    <th>Hours</th>
                    {canRates && (
                      <>
                        <th>Rate / burden</th>
                        <th>Wage + burden</th>
                      </>
                    )}
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {shifts.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <strong>{e.employee_name}</strong>
                        <div className="erp-muted">{e.date}</div>
                      </td>
                      <td>
                        {e.jobsite_name}
                        <div className="erp-muted">{e.cost_code}</div>
                      </td>
                      <td>
                        {e.start_time}–{e.end_time}
                        <div className="erp-muted">
                          {e.break_minutes} min unpaid break
                        </div>
                      </td>
                      <td>{number(e.hours, 2)}</td>
                      {canRates && (
                        <>
                          <td>
                            {currency(e.hourly_rate)}/hr
                            <div className="erp-muted">
                              {number(e.burden_pct, 2)}% burden
                            </div>
                          </td>
                          <td>
                            {currency(e.base_cost + e.burden_cost)}
                            <div className="erp-muted">
                              {currency(e.base_cost)} +{" "}
                              {currency(e.burden_cost)}
                            </div>
                          </td>
                        </>
                      )}
                      <td>
                        <Badge
                          tone={
                            e.voided_at
                              ? "danger"
                              : e.status === "approved"
                                ? "success"
                                : e.status === "submitted"
                                  ? "warning"
                                  : "neutral"
                          }
                        >
                          {e.voided_at ? "Voided" : e.status}
                        </Badge>
                        {Boolean(e.rates_pending) && !e.voided_at && (
                          <div className="erp-muted">Pay review needed</div>
                        )}
                        {e.void_reason && (
                          <div className="erp-muted">{e.void_reason}</div>
                        )}
                      </td>
                      <td>
                        <div className="erp-form-actions">
                          {canTime && !e.voided_at && e.status === "draft" && (
                            <>
                              <button
                                className="erp-button"
                                disabled={saving}
                                onClick={() => editShift(e)}
                              >
                                Edit
                              </button>
                              <button
                                className="erp-button"
                                disabled={saving}
                                onClick={() => void submit(e)}
                              >
                                Submit
                              </button>
                            </>
                          )}
                          {canRates &&
                            !e.voided_at &&
                            e.status === "submitted" && (
                              <button
                                className="erp-button primary"
                                disabled={saving}
                                onClick={() => {
                                  setError("");
                                  setReviewRate(e.hourly_rate ?? 0);
                                  setReviewBurden(e.burden_pct ?? 0);
                                  setReview({ shift: e, action: "approve" });
                                }}
                              >
                                Review
                              </button>
                            )}
                          {canRates && !e.voided_at && (
                            <button
                              className="erp-button"
                              disabled={saving}
                              onClick={() => {
                                setError("");
                                setReason("");
                                setReview({ shift: e, action: "void" });
                              }}
                            >
                              Void
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>
              No shifts match these filters. Add separate intervals when an
              employee moves between jobs or cost codes.
            </Empty>
          )}
        </section>
      ) : tab === "qualifications" ? (
        <section className="erp-card">
          <SectionHead
            title="Dated qualifications"
            description="Track issued and expiry dates. Assignment requirements are selected for the work and checked on the dispatch date; there are no company-wide certification assumptions."
          />
          {workforce.certifications.length ? (
            <div className="erp-table-wrap">
              <table className="erp-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Qualification</th>
                    <th>Issued</th>
                    <th>Expires</th>
                    <th>Status</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {workforce.certifications.map((c) => (
                    <tr key={c.id}>
                      <td>{c.employee_name}</td>
                      <td>
                        <strong>{c.cert_name}</strong>
                      </td>
                      <td>{c.issued_date}</td>
                      <td>{c.expires_date}</td>
                      <td>
                        <Badge tone={certTone(c.validity)}>
                          {certLabel(c.validity)}
                        </Badge>
                      </td>
                      <td>{c.notes || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>
              Add dated certificates for operators, drivers, or specialty work.
              Roster certification tags do not establish an expiry date.
            </Empty>
          )}
        </section>
      ) : (
        <>
          <section className="erp-card">
            <SectionHead
              title="Dispatch roster snapshots"
              description="Each assignment retains its member IDs and names, even after the live crew changes."
            />
            {assignmentIds.length ? (
              <div className="erp-stack">
                {assignmentIds.map((id) => {
                  const members = workforce.assignment_members.filter(
                      (m) => m.assignment_id === id,
                    ),
                    first = members[0];
                  return (
                    <article className="erp-report" key={id}>
                      <div className="erp-report-head">
                        <div>
                          <h3>
                            {first.crew_name} · {first.jobsite_name}
                          </h3>
                          <p className="erp-muted">{first.date}</p>
                        </div>
                        <Badge>{members.length} people</Badge>
                      </div>
                      <p>{members.map((m) => m.employee_name).join(", ")}</p>
                      {first.snapshot_source !== "dated_membership" && (
                        <p className="erp-muted">
                          Recorded from the current roster when historical
                          membership was unavailable; this is not a
                          reconstructed past roster.
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>
            ) : (
              <Empty>No crew assignments have been recorded.</Empty>
            )}
          </section>
          <section className="erp-card">
            <SectionHead
              title="Membership change history"
              description="Changes append a dated snapshot; previous membership records stay available."
            />
            {workforce.membership_history.length ? (
              <div className="erp-table-wrap">
                <table className="erp-table">
                  <thead>
                    <tr>
                      <th>Crew</th>
                      <th>Effective date</th>
                      <th>Members</th>
                      <th>Captured</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workforce.membership_history.map((h) => (
                      <tr key={h.id}>
                        <td>{h.crew_name}</td>
                        <td>{h.effective_date}</td>
                        <td>{h.member_names.join(", ")}</td>
                        <td>{new Date(h.snapshot_at).toLocaleString()}</td>
                        <td>
                          {h.source === "migration_current_roster"
                            ? "Initial current-roster snapshot"
                            : h.source === "crew_create"
                              ? "Crew created"
                              : "Crew changed"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>Crew snapshots appear after a crew is created.</Empty>
            )}
          </section>
        </>
      )}
      {shiftForm && (
        <Modal
          title={shiftForm.id ? "Edit draft shift" : "Record split shift"}
          onClose={() => {
            if (!saving) {
              setShiftForm(null);
              setError("");
            }
          }}
        >
          <form onSubmit={saveShift}>
            <fieldset className="erp-form-fields" disabled={saving}>
              <div className="erp-form-grid">
                <Field label="Employee">
                  <select
                    required
                    value={shiftForm.employee_id}
                    onChange={(e) =>
                      setShiftForm({
                        ...shiftForm,
                        employee_id: e.target.value,
                      })
                    }
                  >
                    <option value="">Choose employee</option>
                    {data.people
                      .filter((p) => p.active)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Project">
                  <select
                    required
                    value={shiftForm.jobsite_id}
                    onChange={(e) =>
                      setShiftForm({
                        ...shiftForm,
                        jobsite_id: e.target.value,
                        cost_code: "",
                      })
                    }
                  >
                    <option value="">Choose project</option>
                    {data.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.code} · {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Work date">
                  <input
                    required
                    type="date"
                    value={shiftForm.date}
                    onChange={(e) =>
                      setShiftForm({ ...shiftForm, date: e.target.value })
                    }
                  />
                </Field>
                <Field label="Cost code">
                  <input
                    required
                    maxLength={100}
                    list="workforce-cost-codes"
                    value={shiftForm.cost_code}
                    onChange={(e) =>
                      setShiftForm({ ...shiftForm, cost_code: e.target.value })
                    }
                  />
                  <datalist id="workforce-cost-codes">
                    {data.work_items
                      .filter(
                        (w) => w.jobsite_id === Number(shiftForm.jobsite_id),
                      )
                      .map((w) => (
                        <option key={w.id} value={w.cost_code}>
                          {w.activity}
                        </option>
                      ))}
                  </datalist>
                </Field>
                <Field label="Start time">
                  <input
                    required
                    type="time"
                    value={shiftForm.start_time}
                    onChange={(e) =>
                      setShiftForm({ ...shiftForm, start_time: e.target.value })
                    }
                  />
                </Field>
                <Field label="End time (same day)">
                  <input
                    required
                    type="text"
                    inputMode="numeric"
                    pattern="([01][0-9]|2[0-3]):[0-5][0-9]|24:00"
                    placeholder="15:30 or 24:00"
                    value={shiftForm.end_time}
                    onChange={(e) =>
                      setShiftForm({ ...shiftForm, end_time: e.target.value })
                    }
                  />
                </Field>
                <Field label="Unpaid break minutes">
                  <input
                    required
                    type="number"
                    min={0}
                    max={1439}
                    step={1}
                    value={shiftForm.break_minutes}
                    onChange={(e) =>
                      setShiftForm({
                        ...shiftForm,
                        break_minutes: Number(e.target.value),
                      })
                    }
                  />
                </Field>
                {canRates && (
                  <>
                    <Field label="Hourly wage rate ($)">
                      <input
                        required
                        type="number"
                        min={0}
                        step="0.01"
                        value={shiftForm.hourly_rate}
                        onChange={(e) =>
                          setShiftForm({
                            ...shiftForm,
                            hourly_rate: Number(e.target.value),
                          })
                        }
                      />
                    </Field>
                    <Field label="Burden (%)">
                      <input
                        required
                        type="number"
                        min={0}
                        max={1000}
                        step="0.01"
                        value={shiftForm.burden_pct}
                        onChange={(e) =>
                          setShiftForm({
                            ...shiftForm,
                            burden_pct: Number(e.target.value),
                          })
                        }
                      />
                    </Field>
                  </>
                )}
                <Field label="Save as">
                  <select
                    value={shiftForm.status}
                    onChange={(e) =>
                      setShiftForm({
                        ...shiftForm,
                        status: e.target.value as "draft" | "submitted",
                      })
                    }
                  >
                    <option value="draft">Draft</option>
                    <option value="submitted">Submitted for review</option>
                  </select>
                </Field>
                <Field label="Notes" wide>
                  <textarea
                    maxLength={4000}
                    value={shiftForm.notes}
                    onChange={(e) =>
                      setShiftForm({ ...shiftForm, notes: e.target.value })
                    }
                  />
                </Field>
              </div>
              <p>
                {number(Math.max(0, elapsed), 2)} paid hours
                {canRates ? (
                  <>
                    {" "}
                    · Wage {currency(projectedBase)} + burden{" "}
                    {currency(projectedBurden)} ={" "}
                    {currency(projectedBase + projectedBurden)}
                  </>
                ) : (
                  <>
                    {" "}
                    · Your PM or accounting confirms private pay rates before
                    posting.
                  </>
                )}
              </p>
              <p className="erp-muted">
                Use one interval per job and cost code. Overnight work must be
                split at midnight. Job cost posts once after approval.
              </p>
              {error && (
                <div className="erp-alert error" role="alert">
                  {error}
                </div>
              )}
              <div className="erp-form-actions">
                <button
                  type="button"
                  className="erp-button"
                  onClick={() => {
                    setShiftForm(null);
                    setError("");
                  }}
                >
                  Cancel
                </button>
                <button className="erp-button primary" disabled={saving}>
                  {saving ? "Saving…" : "Save shift"}
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}
      {certForm && (
        <Modal
          title="Record dated qualification"
          onClose={() => {
            if (!saving) {
              setCertForm(null);
              setError("");
            }
          }}
        >
          <form onSubmit={saveCert}>
            <fieldset className="erp-form-fields" disabled={saving}>
              <div className="erp-form-grid">
                <Field label="Employee">
                  <select
                    required
                    value={certForm.employee_id}
                    onChange={(e) =>
                      setCertForm({ ...certForm, employee_id: e.target.value })
                    }
                  >
                    <option value="">Choose employee</option>
                    {data.people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Qualification name">
                  <input
                    required
                    maxLength={150}
                    placeholder="CDL Class A, equipment qualification…"
                    value={certForm.cert_name}
                    onChange={(e) =>
                      setCertForm({ ...certForm, cert_name: e.target.value })
                    }
                  />
                </Field>
                <Field label="Issued date">
                  <input
                    required
                    type="date"
                    value={certForm.issued_date}
                    onChange={(e) =>
                      setCertForm({ ...certForm, issued_date: e.target.value })
                    }
                  />
                </Field>
                <Field label="Expiry date">
                  <input
                    required
                    type="date"
                    min={certForm.issued_date || undefined}
                    value={certForm.expires_date}
                    onChange={(e) =>
                      setCertForm({ ...certForm, expires_date: e.target.value })
                    }
                  />
                </Field>
                <Field label="Notes" wide>
                  <textarea
                    maxLength={2000}
                    value={certForm.notes}
                    onChange={(e) =>
                      setCertForm({ ...certForm, notes: e.target.value })
                    }
                  />
                </Field>
              </div>
              <p className="erp-muted">
                Record renewals as new issued dates to retain the qualification
                history.
              </p>
              {error && (
                <div className="erp-alert error" role="alert">
                  {error}
                </div>
              )}
              <div className="erp-form-actions">
                <button
                  type="button"
                  className="erp-button"
                  onClick={() => {
                    setCertForm(null);
                    setError("");
                  }}
                >
                  Cancel
                </button>
                <button className="erp-button primary">
                  {saving ? "Saving…" : "Save qualification"}
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}
      {review && (
        <Modal
          title={
            review.action === "approve"
              ? "Approve labor posting"
              : "Void time entry"
          }
          onClose={() => {
            if (!saving) {
              setReview(null);
              setError("");
            }
          }}
        >
          <form onSubmit={reviewShift}>
            <fieldset className="erp-form-fields" disabled={saving}>
              <p>
                <strong>{review.shift.employee_name}</strong> ·{" "}
                {review.shift.date} · {review.shift.jobsite_name} ·{" "}
                {review.shift.cost_code}
              </p>
              <p>
                {number(review.shift.hours, 2)} hours ×{" "}
                {currency(review.shift.hourly_rate)}/hr ={" "}
                {currency(review.shift.base_cost)} wage +{" "}
                {currency(review.shift.burden_cost)} burden.
              </p>
              {review.action === "approve" ? (
                <>
                  <div className="erp-form-grid">
                    <Field label="Confirm hourly wage rate ($)">
                      <input
                        required
                        type="number"
                        min={0}
                        step="0.01"
                        value={reviewRate}
                        onChange={(e) => setReviewRate(Number(e.target.value))}
                      />
                    </Field>
                    <Field label="Confirm burden (%)">
                      <input
                        required
                        type="number"
                        min={0}
                        max={1000}
                        step="0.01"
                        value={reviewBurden}
                        onChange={(e) =>
                          setReviewBurden(Number(e.target.value))
                        }
                      />
                    </Field>
                  </div>
                  <p>
                    Approval posts{" "}
                    {currency(
                      Math.round(review.shift.hours * reviewRate * 100) / 100 +
                        Math.round(
                          (Math.round(review.shift.hours * reviewRate * 100) /
                            100) *
                            reviewBurden,
                        ) /
                          100,
                    )}{" "}
                    to job labor and locks these historical rates. Any aggregate
                    daily-report labor for this job, code, and date must be
                    reconciled first.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    The original shift stays in the audit history. An approved
                    shift's posting will be excluded from job costs and payroll
                    preparation.
                  </p>
                  <Field label="Reason for void">
                    <textarea
                      required
                      maxLength={2000}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </Field>
                </>
              )}
              {error && (
                <div className="erp-alert error" role="alert">
                  {error}
                </div>
              )}
              <div className="erp-form-actions">
                <button
                  type="button"
                  className="erp-button"
                  onClick={() => {
                    setReview(null);
                    setError("");
                  }}
                >
                  Cancel
                </button>
                <button className="erp-button primary">
                  {saving
                    ? "Saving…"
                    : review.action === "approve"
                      ? "Approve & post labor"
                      : "Void entry"}
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}
    </div>
  );
}
