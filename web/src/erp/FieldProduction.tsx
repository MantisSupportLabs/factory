import { useState, type FormEvent } from "react";
import { api, saveDailyDraft } from "../api/client";
import {
  type DailyReport,
  type ERPData,
  type ReportLine,
  money,
  number,
  today,
} from "./types";
import { Badge, Empty, Field, Modal, Progress, SectionHead } from "./ui";
import { useAccess } from "./Access";

type WorkForm = {
  jobsite_id: string;
  phase: string;
  activity: string;
  unit: string;
  planned_qty: number;
  planned_hours: number;
  cost_code: string;
  budget: number;
  planned_start: string;
  planned_end: string;
};
type DailyForm = {
  id?: number;
  jobsite_id: string;
  crew_id: string;
  date: string;
  weather: string;
  notes: string;
  created_by: string;
  status: "draft" | "submitted";
  lines: ReportLine[];
};
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
const blankLine = (planId = 0): ReportLine => ({
  plan_id: planId,
  qty: 0,
  labor_hours: 0,
  equipment_hours: 0,
  labor_cost: 0,
  equipment_cost: 0,
  material_cost: 0,
});
const lineCost = (line: ReportLine) =>
  line.labor_cost + line.equipment_cost + line.material_cost;
const reportCost = (report: DailyReport) =>
  report.lines.reduce((sum, line) => sum + lineCost(line), 0);
const exactMoney = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    value,
  );
const tone = (status: string) =>
  status === "approved"
    ? "success"
    : status === "submitted"
      ? "warning"
      : "neutral";

export function FieldProduction({
  data,
  refresh,
}: {
  data: ERPData;
  refresh: () => Promise<void>;
}) {
  const access = useAccess();
  const canManage =
    access.mode === "demo" ||
    Boolean(access.role && ["owner", "admin", "pm"].includes(access.role));
  const canAuthor = canManage || access.role === "foreman";
  const [tab, setTab] = useState<"production" | "reports">("production");
  const [projectId, setProjectId] = useState("all");
  const [reportStatus, setReportStatus] = useState("all");
  const [workForm, setWorkForm] = useState<WorkForm | null>(null);
  const [dailyForm, setDailyForm] = useState<DailyForm | null>(null);
  const [approval, setApproval] = useState<DailyReport | null>(null);
  const [correction, setCorrection] = useState<{
    report: DailyReport;
    action: "reject" | "reverse";
  } | null>(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [expanded, setExpanded] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [workingReport, setWorkingReport] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const items = data.work_items.filter(
    (item) => projectId === "all" || item.jobsite_id === Number(projectId),
  );
  const projectReports = data.daily_reports.filter(
    (report) => projectId === "all" || report.jobsite_id === Number(projectId),
  );
  const reports = projectReports
    .filter(
      (report) =>
        reportStatus === "all" ||
        (reportStatus === "reversed"
          ? Boolean(report.reversed_at)
          : report.status === reportStatus && !report.reversed_at),
    )
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  const formItems = dailyForm
    ? data.work_items.filter(
        (item) => item.jobsite_id === Number(dailyForm.jobsite_id),
      )
    : [];

  function startWork() {
    setError("");
    setSuccess("");
    setWorkForm({
      jobsite_id:
        projectId === "all" ? String(data.projects[0]?.id ?? "") : projectId,
      phase: "",
      activity: "",
      unit: "CY",
      planned_qty: 0,
      planned_hours: 0,
      cost_code: "",
      budget: 0,
      planned_start: "",
      planned_end: "",
    });
  }
  function startDaily() {
    setError("");
    setSuccess("");
    const job =
      projectId === "all" ? String(data.projects[0]?.id ?? "") : projectId;
    const firstItem = data.work_items.find(
      (item) => item.jobsite_id === Number(job),
    );
    setDailyForm({
      jobsite_id: job,
      crew_id: "",
      date: today(),
      weather: "",
      notes: "",
      created_by: "",
      status: "draft",
      lines: firstItem ? [blankLine(firstItem.id)] : [],
    });
  }
  function editDaily(report: DailyReport) {
    setError("");
    setSuccess("");
    setDailyForm({
      id: report.id,
      jobsite_id: String(report.jobsite_id),
      crew_id: String(report.crew_id ?? ""),
      date: report.date,
      weather: report.weather,
      notes: report.notes,
      created_by: report.created_by,
      status: "draft",
      lines: report.lines.map(({ id: _id, ...line }) => ({ ...line })),
    });
  }
  function addLine() {
    if (!dailyForm) return;
    const next = formItems.find(
      (item) => !dailyForm.lines.some((line) => line.plan_id === item.id),
    );
    if (next)
      setDailyForm({
        ...dailyForm,
        lines: [...dailyForm.lines, blankLine(next.id)],
      });
  }
  function updateLine(index: number, values: Partial<ReportLine>) {
    setDailyForm((current) =>
      current
        ? {
            ...current,
            lines: current.lines.map((line, i) =>
              i === index ? { ...line, ...values } : line,
            ),
          }
        : current,
    );
  }
  async function refreshSaved(message: string) {
    setSuccess(message);
    try {
      await refresh();
    } catch (refreshError) {
      setError(
        `Saved successfully, but production could not refresh: ${errorText(refreshError)}`,
      );
    }
  }
  async function saveWork(event: FormEvent) {
    event.preventDefault();
    if (!workForm) return;
    if (
      workForm.planned_start &&
      workForm.planned_end &&
      workForm.planned_end < workForm.planned_start
    ) {
      setError("Planned finish must be on or after the planned start.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api.post("/erp/work-items", {
        ...workForm,
        jobsite_id: Number(workForm.jobsite_id),
        phase: workForm.phase.trim(),
        activity: workForm.activity.trim(),
        unit: workForm.unit.trim(),
        cost_code: workForm.cost_code.trim(),
        planned_start: workForm.planned_start || null,
        planned_end: workForm.planned_end || null,
      });
      setWorkForm(null);
      await refreshSaved("Measured work item added.");
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  }
  async function saveDaily(event: FormEvent) {
    event.preventDefault();
    if (!dailyForm) return;
    if (!dailyForm.lines.length && !dailyForm.notes.trim()) {
      setError(
        "Add notes explaining the day when there are no production lines.",
      );
      return;
    }
    setSaving(true);
    setError("");
    try {
      const { id: reportId, ...form } = dailyForm;
      const payload = {
        ...form,
        jobsite_id: Number(form.jobsite_id),
        crew_id: Number(form.crew_id),
        created_by: form.created_by.trim(),
        notes: form.notes.trim(),
        rough_pct: null,
      };
      if (reportId) await api.patch(`/erp/daily-reports/${reportId}`, payload);
      else if (form.status === "draft") {
        const result = await saveDailyDraft<DailyReport>(payload);
        if ("queued" in result) {
          setDailyForm(null);
          setTab("reports");
          setSuccess("Draft saved on this device; upload when connected.");
          return;
        }
      } else await api.post("/erp/daily-reports", payload);
      setDailyForm(null);
      setTab("reports");
      await refreshSaved(
        dailyForm.status === "submitted"
          ? "Daily report submitted for approval."
          : "Daily report saved as a draft.",
      );
    } catch (saveError) {
      setError(errorText(saveError));
    } finally {
      setSaving(false);
    }
  }
  async function transition(report: DailyReport, action: "submit" | "approve") {
    setWorkingReport(report.id);
    setError("");
    setSuccess("");
    try {
      await api.post(`/erp/daily-reports/${report.id}/${action}`);
      setApproval(null);
      await refreshSaved(
        action === "approve"
          ? "Report approved. Quantities, hours, and costs are now posted to the job."
          : "Report submitted for approval.",
      );
    } catch (actionError) {
      setError(errorText(actionError));
    } finally {
      setWorkingReport(null);
    }
  }

  async function changeReport(event: FormEvent) {
    event.preventDefault();
    if (!correction) return;
    setWorkingReport(correction.report.id);
    setError("");
    try {
      await api.post(
        `/erp/daily-reports/${correction.report.id}/${correction.action}`,
        { reason: correctionReason },
      );
      setCorrection(null);
      await refreshSaved(
        correction.action === "reject"
          ? "Report returned to draft for correction; the review reason is retained."
          : "Approval reversed; original lines stay locked and their quantities and costs are excluded. Create a correction to replace this report.",
      );
    } catch (actionError) {
      setError(errorText(actionError));
    } finally {
      setWorkingReport(null);
    }
  }
  async function startCorrection(report: DailyReport) {
    setWorkingReport(report.id);
    setError("");
    try {
      const replacement = await api.post<DailyReport>(
        `/erp/daily-reports/${report.id}/correction`,
      );
      await refreshSaved(
        "Correction draft created for the same crew and date. Review and adjust its copied lines before submitting.",
      );
      if (replacement.status === "draft") editDaily(replacement);
    } catch (actionError) {
      setError(errorText(actionError));
    } finally {
      setWorkingReport(null);
    }
  }

  return (
    <div className="erp-stack">
      <SectionHead
        title="Field production"
        description="Track installed quantities and labor against each activity. Approved daily reports drive measured progress."
        action={
          <div className="erp-form-actions">
            {canManage && (
              <button
                className="erp-button"
                disabled={!data.projects.length}
                onClick={startWork}
              >
                + Work item
              </button>
            )}
            {canAuthor && (
              <button
                className="erp-button primary"
                disabled={!data.projects.length || !data.crews.length}
                onClick={startDaily}
              >
                + Daily report
              </button>
            )}
          </div>
        }
      />
      {error && !workForm && !dailyForm && !approval && !correction && (
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
          <span>Measured activities</span>
          <strong>{items.length}</strong>
          <small>
            {items.filter((item) => item.progress_pct >= 100).length} complete
          </small>
        </div>
        <div className="erp-metric">
          <span>Recorded labor hours</span>
          <strong>
            {number(
              items.reduce((sum, item) => sum + item.actual_hours, 0),
              1,
            )}
          </strong>
          <small>Approved reports and recorded manual production</small>
        </div>
        <div className="erp-metric">
          <span>Reports awaiting approval</span>
          <strong>
            {
              projectReports.filter((report) => report.status === "submitted")
                .length
            }
          </strong>
          <small>
            {
              projectReports.filter((report) => report.status === "draft")
                .length
            }{" "}
            drafts in progress
          </small>
        </div>
        <div className="erp-metric">
          <span>Approved report costs</span>
          <strong>
            {money(
              projectReports
                .filter(
                  (report) =>
                    report.status === "approved" && !report.reversed_at,
                )
                .reduce((sum, report) => sum + reportCost(report), 0),
            )}
          </strong>
          <small>Labor, equipment, and materials</small>
        </div>
      </div>
      <div className="erp-toolbar">
        <div
          className="erp-tabs"
          role="group"
          aria-label="Field production view"
        >
          <button
            className={`erp-button ${tab === "production" ? "primary" : ""}`}
            aria-pressed={tab === "production"}
            onClick={() => setTab("production")}
          >
            Measured work
          </button>
          <button
            className={`erp-button ${tab === "reports" ? "primary" : ""}`}
            aria-pressed={tab === "reports"}
            onClick={() => setTab("reports")}
          >
            Daily reports
          </button>
        </div>
        <Field label="Project">
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="all">All projects</option>
            {data.projects.map((project) => (
              <option value={project.id} key={project.id}>
                {project.code} · {project.name}
              </option>
            ))}
          </select>
        </Field>
        {tab === "reports" && (
          <Field label="Report status">
            <select
              value={reportStatus}
              onChange={(event) => setReportStatus(event.target.value)}
            >
              <option value="all">All statuses</option>
              <option value="draft">Draft</option>
              <option value="submitted">Submitted</option>
              <option value="approved">Approved</option>
              <option value="reversed">Reversed approvals</option>
            </select>
          </Field>
        )}
      </div>

      {tab === "production" && (
        <section className="erp-card">
          <SectionHead
            title="Installed quantities & productivity"
            description="Rates are units per labor hour for the same activity. Mixed units stay separate; completion comes from approved reports and recorded installed quantities."
          />
          {items.length ? (
            <div className="erp-table-wrap">
              <table className="erp-table">
                <thead>
                  <tr>
                    <th>Job / activity</th>
                    <th>Cost code</th>
                    <th>Installed / planned</th>
                    <th>Measured completion</th>
                    <th>Labor hours</th>
                    <th>Actual rate</th>
                    <th>Target rate</th>
                    <th>Performance</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const performance =
                      item.rate !== null &&
                      item.planned_rate !== null &&
                      item.planned_rate > 0
                        ? (item.rate / item.planned_rate) * 100
                        : null;
                    return (
                      <tr key={item.id}>
                        <td>
                          <strong>{item.activity}</strong>
                          <div className="erp-muted">
                            {item.jobsite_name} · {item.phase}
                          </div>
                        </td>
                        <td>{item.cost_code || "—"}</td>
                        <td>
                          <strong>{number(item.actual_qty, 1)}</strong> /{" "}
                          {number(item.planned_qty, 1)} {item.unit}
                        </td>
                        <td>
                          <strong>{number(item.progress_pct, 1)}%</strong>
                          <Progress value={item.progress_pct} />
                        </td>
                        <td>
                          {number(item.actual_hours, 1)} /{" "}
                          {number(item.planned_hours, 1)}
                        </td>
                        <td>
                          {item.rate === null
                            ? "—"
                            : `${number(item.rate, 2)} ${item.unit}/hr`}
                        </td>
                        <td>
                          {item.planned_rate === null
                            ? "—"
                            : `${number(item.planned_rate, 2)} ${item.unit}/hr`}
                        </td>
                        <td>
                          {performance === null ? (
                            <Badge>No rate yet</Badge>
                          ) : (
                            <Badge
                              tone={
                                performance >= 100
                                  ? "success"
                                  : performance >= 80
                                    ? "warning"
                                    : "danger"
                              }
                            >
                              {number(performance)}% of target
                            </Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>
              Add planned work quantities for this project, then record daily
              installed quantities.
            </Empty>
          )}
        </section>
      )}

      {tab === "reports" && (
        <section className="erp-card">
          <SectionHead
            title="Daily report register"
            description="Draft → Submitted → Approved. Return submissions for correction, or reverse an approved report and create a linked replacement."
          />
          {reports.length ? (
            <div className="erp-stack">
              {reports.map((report) => {
                const isExpanded = expanded.includes(report.id);
                const projectItems = data.work_items.filter(
                  (item) => item.jobsite_id === report.jobsite_id,
                );
                return (
                  <article className="erp-report" key={report.id}>
                    <div className="erp-report-head">
                      <div>
                        <h3>{report.jobsite_name}</h3>
                        <p className="erp-muted">
                          {report.date} · {report.crew_name ?? "No crew"} ·{" "}
                          {report.created_by}
                        </p>
                      </div>
                      <Badge
                        tone={
                          report.reversed_at ? "danger" : tone(report.status)
                        }
                      >
                        {report.reversed_at
                          ? "Reversed"
                          : report.status.charAt(0).toUpperCase() +
                            report.status.slice(1)}
                      </Badge>
                    </div>
                    <div className="erp-toolbar">
                      <span>
                        {report.lines.length} production{" "}
                        {report.lines.length === 1 ? "line" : "lines"}
                      </span>
                      <span>
                        {number(
                          report.lines.reduce(
                            (sum, line) => sum + line.labor_hours,
                            0,
                          ),
                          1,
                        )}{" "}
                        labor hours
                      </span>
                      <span>{money(reportCost(report))} recorded costs</span>
                      <div className="erp-form-actions">
                        <button
                          className="erp-button"
                          aria-expanded={isExpanded}
                          aria-controls={`report-details-${report.id}`}
                          onClick={() =>
                            setExpanded((current) =>
                              isExpanded
                                ? current.filter((id) => id !== report.id)
                                : [...current, report.id],
                            )
                          }
                        >
                          {isExpanded ? "Hide details" : "View details"}
                        </button>
                        {canAuthor && report.status === "draft" && (
                          <button
                            className="erp-button"
                            disabled={workingReport !== null}
                            onClick={() => editDaily(report)}
                          >
                            Edit draft
                          </button>
                        )}
                        {canAuthor && report.status === "draft" && (
                          <button
                            className="erp-button"
                            disabled={workingReport !== null}
                            onClick={() => void transition(report, "submit")}
                          >
                            {workingReport === report.id
                              ? "Submitting…"
                              : "Submit"}
                          </button>
                        )}
                        {canManage && report.status === "submitted" && (
                          <button
                            className="erp-button primary"
                            disabled={workingReport !== null}
                            onClick={() => {
                              setError("");
                              setApproval(report);
                            }}
                          >
                            Review & approve
                          </button>
                        )}
                        {canManage && report.status === "submitted" && (
                          <button
                            className="erp-button"
                            disabled={workingReport !== null}
                            onClick={() => {
                              setError("");
                              setCorrectionReason("");
                              setCorrection({ report, action: "reject" });
                            }}
                          >
                            Return for correction
                          </button>
                        )}
                        {canManage &&
                          report.status === "approved" &&
                          !report.reversed_at && (
                            <button
                              className="erp-button"
                              disabled={workingReport !== null}
                              onClick={() => {
                                setError("");
                                setCorrectionReason("");
                                setCorrection({ report, action: "reverse" });
                              }}
                            >
                              Reverse approval
                            </button>
                          )}
                        {canManage &&
                          report.reversed_at &&
                          !report.replacement_report_id && (
                            <button
                              className="erp-button"
                              disabled={workingReport !== null}
                              onClick={() => void startCorrection(report)}
                            >
                              Create correction
                            </button>
                          )}
                      </div>
                    </div>
                    {report.corrected_from_report_id && (
                      <p className="erp-muted">
                        Correction of report #{report.corrected_from_report_id}{" "}
                        · revision {report.revision ?? 1}
                      </p>
                    )}
                    {report.replacement_report_id && (
                      <p className="erp-muted">
                        Replaced by correction report #
                        {report.replacement_report_id}
                      </p>
                    )}
                    {report.rejection_reason && (
                      <p className="erp-preserve-lines">
                        <strong>Returned for correction:</strong>{" "}
                        {report.rejection_reason}
                      </p>
                    )}
                    {report.reversed_at && (
                      <p className="erp-preserve-lines">
                        <strong>Reversed:</strong> {report.reversal_reason} ·{" "}
                        {report.reversed_at.slice(0, 10)}. Original lines remain
                        locked and excluded from job totals.
                      </p>
                    )}
                    {isExpanded && (
                      <div id={`report-details-${report.id}`}>
                        <p>
                          <strong>Weather:</strong>{" "}
                          {report.weather || "Not recorded"}
                        </p>
                        {report.notes && (
                          <p className="erp-preserve-lines">
                            <strong>Field notes:</strong> {report.notes}
                          </p>
                        )}
                        {report.lines.length ? (
                          <div className="erp-table-wrap">
                            <table className="erp-table">
                              <thead>
                                <tr>
                                  <th>Activity</th>
                                  <th>Installed qty</th>
                                  <th>Labor hours</th>
                                  <th>Equipment hours</th>
                                  <th>Labor cost</th>
                                  <th>Equipment cost</th>
                                  <th>Material cost</th>
                                </tr>
                              </thead>
                              <tbody>
                                {report.lines.map((line, index) => {
                                  const item = projectItems.find(
                                    (work) => work.id === line.plan_id,
                                  );
                                  return (
                                    <tr key={line.id ?? index}>
                                      <td>
                                        {item?.activity ??
                                          `Work item ${line.plan_id}`}
                                      </td>
                                      <td>
                                        {number(line.qty, 2)} {item?.unit}
                                      </td>
                                      <td>{number(line.labor_hours, 1)}</td>
                                      <td>{number(line.equipment_hours, 1)}</td>
                                      <td>{money(line.labor_cost)}</td>
                                      <td>{money(line.equipment_cost)}</td>
                                      <td>{money(line.material_cost)}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <p className="erp-muted">
                            No production recorded for this day.
                          </p>
                        )}
                        {report.status === "approved" && (
                          <p className="erp-muted">
                            {report.reversed_at
                              ? "This reversed report is retained as locked history. Its quantities and costs are excluded from the job."
                              : "Approved quantities and costs are posted to the job. This report is locked; use a reversal and linked correction to amend it."}
                          </p>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <Empty>
              No daily reports match these filters. Record field production or a
              day without production.
            </Empty>
          )}
        </section>
      )}

      {workForm && (
        <Modal
          title="Add measured work item"
          onClose={() => {
            if (!saving) {
              setWorkForm(null);
              setError("");
            }
          }}
        >
          <form onSubmit={saveWork}>
            <fieldset className="erp-form-fields" disabled={saving}>
              <div className="erp-form-grid">
                <Field label="Project">
                  <select
                    required
                    value={workForm.jobsite_id}
                    onChange={(event) =>
                      setWorkForm({
                        ...workForm,
                        jobsite_id: event.target.value,
                      })
                    }
                  >
                    <option value="">Choose project</option>
                    {data.projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.code} · {project.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Phase">
                  <input
                    required
                    maxLength={100}
                    placeholder="Earthwork, storm sewer, paving…"
                    value={workForm.phase}
                    onChange={(event) =>
                      setWorkForm({ ...workForm, phase: event.target.value })
                    }
                  />
                </Field>
                <Field label="Activity" wide>
                  <input
                    required
                    maxLength={200}
                    placeholder="Mass excavation — south basin"
                    value={workForm.activity}
                    onChange={(event) =>
                      setWorkForm({ ...workForm, activity: event.target.value })
                    }
                  />
                </Field>
                <Field label="Unit">
                  <input
                    required
                    maxLength={20}
                    list="erp-units"
                    value={workForm.unit}
                    onChange={(event) =>
                      setWorkForm({ ...workForm, unit: event.target.value })
                    }
                  />
                  <datalist id="erp-units">
                    <option value="CY" />
                    <option value="LF" />
                    <option value="SY" />
                    <option value="SF" />
                    <option value="TON" />
                    <option value="EA" />
                  </datalist>
                </Field>
                <Field label="Planned quantity">
                  <input
                    required
                    type="number"
                    min="0.01"
                    step="any"
                    value={workForm.planned_qty}
                    onChange={(event) =>
                      setWorkForm({
                        ...workForm,
                        planned_qty: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="Planned labor hours">
                  <input
                    required
                    type="number"
                    min="0.01"
                    step="any"
                    value={workForm.planned_hours}
                    onChange={(event) =>
                      setWorkForm({
                        ...workForm,
                        planned_hours: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="Cost code">
                  <input
                    required
                    placeholder="02-110"
                    maxLength={80}
                    value={workForm.cost_code}
                    onChange={(event) =>
                      setWorkForm({
                        ...workForm,
                        cost_code: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="Activity budget ($)">
                  <input
                    required
                    type="number"
                    min="0"
                    step="0.01"
                    value={workForm.budget}
                    onChange={(event) =>
                      setWorkForm({
                        ...workForm,
                        budget: Number(event.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="Planned start">
                  <input
                    type="date"
                    value={workForm.planned_start}
                    onChange={(event) =>
                      setWorkForm({
                        ...workForm,
                        planned_start: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="Planned finish">
                  <input
                    type="date"
                    min={workForm.planned_start || undefined}
                    value={workForm.planned_end}
                    onChange={(event) =>
                      setWorkForm({
                        ...workForm,
                        planned_end: event.target.value,
                      })
                    }
                  />
                </Field>
              </div>
              <p className="erp-muted">
                Target productivity:{" "}
                {workForm.planned_hours > 0
                  ? `${number(workForm.planned_qty / workForm.planned_hours, 2)} ${workForm.unit}/labor hour`
                  : "Enter planned quantity and labor hours."}
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
                  disabled={saving}
                  onClick={() => {
                    setWorkForm(null);
                    setError("");
                  }}
                >
                  Cancel
                </button>
                <button
                  className="erp-button primary"
                  disabled={
                    saving ||
                    !workForm.activity.trim() ||
                    !workForm.phase.trim() ||
                    !workForm.unit.trim() ||
                    !workForm.cost_code.trim() ||
                    workForm.planned_qty <= 0 ||
                    workForm.planned_hours <= 0
                  }
                >
                  {saving ? "Saving…" : "Add work item"}
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}

      {dailyForm && (
        <Modal
          title={
            dailyForm.id
              ? "Edit draft field report"
              : "Create daily field report"
          }
          onClose={() => {
            if (!saving) {
              setDailyForm(null);
              setError("");
            }
          }}
        >
          <form onSubmit={saveDaily}>
            <fieldset className="erp-form-fields" disabled={saving}>
              <div className="erp-form-grid">
                <Field label="Project">
                  <select
                    required
                    value={dailyForm.jobsite_id}
                    onChange={(event) => {
                      const job = event.target.value;
                      const firstItem = data.work_items.find(
                        (item) => item.jobsite_id === Number(job),
                      );
                      setDailyForm({
                        ...dailyForm,
                        jobsite_id: job,
                        lines: firstItem ? [blankLine(firstItem.id)] : [],
                      });
                    }}
                  >
                    <option value="">Choose project</option>
                    {data.projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.code} · {project.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Crew">
                  <select
                    required
                    value={dailyForm.crew_id}
                    onChange={(event) => {
                      const crew = data.crews.find(
                        (item) => item.id === Number(event.target.value),
                      );
                      setDailyForm({
                        ...dailyForm,
                        crew_id: event.target.value,
                        created_by:
                          dailyForm.created_by || crew?.foreman_name || "",
                      });
                    }}
                  >
                    <option value="">Choose reporting crew</option>
                    {data.crews.map((crew) => (
                      <option key={crew.id} value={crew.id}>
                        {crew.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Report date">
                  <input
                    required
                    type="date"
                    value={dailyForm.date}
                    onChange={(event) =>
                      setDailyForm({ ...dailyForm, date: event.target.value })
                    }
                  />
                </Field>
                <Field label="Prepared by">
                  <input
                    required
                    maxLength={150}
                    list="erp-report-authors"
                    value={dailyForm.created_by}
                    onChange={(event) =>
                      setDailyForm({
                        ...dailyForm,
                        created_by: event.target.value,
                      })
                    }
                  />
                  <datalist id="erp-report-authors">
                    {data.people
                      .filter((person) => person.active)
                      .map((person) => (
                        <option key={person.id} value={person.name} />
                      ))}
                  </datalist>
                </Field>
                <Field label="Weather">
                  <input
                    maxLength={300}
                    placeholder="Clear, 74°F; rain stopped work at 2 pm"
                    value={dailyForm.weather}
                    onChange={(event) =>
                      setDailyForm({
                        ...dailyForm,
                        weather: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field label="Save as">
                  <select
                    value={dailyForm.status}
                    onChange={(event) =>
                      setDailyForm({
                        ...dailyForm,
                        status: event.target.value as DailyForm["status"],
                      })
                    }
                  >
                    <option value="draft">Draft</option>
                    <option value="submitted">Submitted for approval</option>
                  </select>
                </Field>
              </div>
              <SectionHead
                title="Production lines"
                description="Record each activity in its own unit. Hours and costs belong to that activity."
                action={
                  <button
                    type="button"
                    className="erp-button"
                    disabled={dailyForm.lines.length >= formItems.length}
                    onClick={addLine}
                  >
                    + Add line
                  </button>
                }
              />
              {!formItems.length && (
                <div className="erp-alert">
                  This project has no measured work items yet. You can save a
                  report with notes for a day without production, or add work
                  items first.
                </div>
              )}
              {!dailyForm.lines.length && (
                <p className="erp-muted">
                  No production lines. Notes are required to explain the day.
                </p>
              )}
              {dailyForm.lines.map((line, index) => {
                const item = formItems.find((work) => work.id === line.plan_id);
                return (
                  <fieldset className="erp-production-line" key={index}>
                    <legend>Activity {index + 1}</legend>
                    <div className="erp-form-grid">
                      <Field label="Work item" wide>
                        <select
                          required
                          value={line.plan_id || ""}
                          onChange={(event) =>
                            updateLine(index, {
                              plan_id: Number(event.target.value),
                            })
                          }
                        >
                          <option value="">Choose activity</option>
                          {formItems.map((work) => (
                            <option
                              key={work.id}
                              value={work.id}
                              disabled={dailyForm.lines.some(
                                (other, otherIndex) =>
                                  otherIndex !== index &&
                                  other.plan_id === work.id,
                              )}
                            >
                              {work.activity} · {work.cost_code} · {work.unit}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field
                        label={`Installed quantity (${item?.unit ?? "unit"})`}
                      >
                        <input
                          required
                          type="number"
                          min="0"
                          step="any"
                          value={line.qty}
                          onChange={(event) =>
                            updateLine(index, {
                              qty: Number(event.target.value),
                            })
                          }
                        />
                      </Field>
                      <Field label="Labor hours">
                        <input
                          required
                          type="number"
                          min="0"
                          step="any"
                          value={line.labor_hours}
                          onChange={(event) =>
                            updateLine(index, {
                              labor_hours: Number(event.target.value),
                            })
                          }
                        />
                      </Field>
                      <Field label="Equipment hours">
                        <input
                          required
                          type="number"
                          min="0"
                          step="any"
                          value={line.equipment_hours}
                          onChange={(event) =>
                            updateLine(index, {
                              equipment_hours: Number(event.target.value),
                            })
                          }
                        />
                      </Field>
                      <Field label="Labor cost ($)">
                        <input
                          required
                          type="number"
                          min="0"
                          step="0.01"
                          value={line.labor_cost}
                          onChange={(event) =>
                            updateLine(index, {
                              labor_cost: Number(event.target.value),
                            })
                          }
                        />
                      </Field>
                      <Field label="Equipment cost ($)">
                        <input
                          required
                          type="number"
                          min="0"
                          step="0.01"
                          value={line.equipment_cost}
                          onChange={(event) =>
                            updateLine(index, {
                              equipment_cost: Number(event.target.value),
                            })
                          }
                        />
                      </Field>
                      <Field label="Material cost ($)">
                        <input
                          required
                          type="number"
                          min="0"
                          step="0.01"
                          value={line.material_cost}
                          onChange={(event) =>
                            updateLine(index, {
                              material_cost: Number(event.target.value),
                            })
                          }
                        />
                      </Field>
                    </div>
                    <div className="erp-toolbar">
                      <span className="erp-muted">
                        {line.labor_hours > 0 && item
                          ? `Daily rate: ${number(line.qty / line.labor_hours, 2)} ${item.unit}/labor hour · `
                          : ""}
                        Line costs: {money(lineCost(line))}
                      </span>
                      <button
                        type="button"
                        className="erp-button"
                        aria-label={`Remove production line ${index + 1}`}
                        onClick={() =>
                          setDailyForm({
                            ...dailyForm,
                            lines: dailyForm.lines.filter(
                              (_, i) => i !== index,
                            ),
                          })
                        }
                      >
                        Remove line
                      </button>
                    </div>
                  </fieldset>
                );
              })}
              <Field
                label={
                  dailyForm.lines.length
                    ? "Field notes, delays, deliveries, and safety observations"
                    : "Notes explaining the day (required)"
                }
                wide
              >
                <textarea
                  required={!dailyForm.lines.length}
                  maxLength={10000}
                  rows={3}
                  value={dailyForm.notes}
                  placeholder="Record what happened, constraints, and handoff information…"
                  onChange={(event) =>
                    setDailyForm({ ...dailyForm, notes: event.target.value })
                  }
                />
              </Field>
              <p className="erp-muted">
                Report totals:{" "}
                {number(
                  dailyForm.lines.reduce(
                    (sum, line) => sum + line.labor_hours,
                    0,
                  ),
                  1,
                )}{" "}
                labor hours ·{" "}
                {money(
                  dailyForm.lines.reduce(
                    (sum, line) => sum + lineCost(line),
                    0,
                  ),
                )}{" "}
                costs. Approval posts these values to the job.
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
                  disabled={saving}
                  onClick={() => {
                    setDailyForm(null);
                    setError("");
                  }}
                >
                  Cancel
                </button>
                <button
                  className="erp-button primary"
                  disabled={
                    saving ||
                    !dailyForm.created_by.trim() ||
                    !dailyForm.crew_id ||
                    (!dailyForm.lines.length && !dailyForm.notes.trim())
                  }
                >
                  {saving
                    ? "Saving…"
                    : dailyForm.status === "submitted"
                      ? "Submit report"
                      : "Save draft"}
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}

      {correction && (
        <Modal
          title={
            correction.action === "reject"
              ? "Return report for correction"
              : "Reverse approved report"
          }
          onClose={() => {
            if (workingReport === null) {
              setCorrection(null);
              setError("");
            }
          }}
        >
          <form onSubmit={changeReport}>
            <fieldset
              className="erp-form-fields"
              disabled={workingReport !== null}
            >
              <p>
                <strong>{correction.report.jobsite_name}</strong> ·{" "}
                {correction.report.date} · {correction.report.crew_name}
              </p>
              <p>
                {correction.action === "reject"
                  ? "The report will return to draft so the foreman can correct it. The review reason remains in history."
                  : "The approved quantities, hours, and costs will be excluded from job totals. The original lines remain locked. Then create a linked correction draft for this same crew and date."}
              </p>
              <Field
                label={
                  correction.action === "reject"
                    ? "What needs correction?"
                    : "Reason for reversing approval"
                }
              >
                <textarea
                  required
                  maxLength={2000}
                  value={correctionReason}
                  onChange={(event) => setCorrectionReason(event.target.value)}
                />
              </Field>
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
                    setCorrection(null);
                    setError("");
                  }}
                >
                  Cancel
                </button>
                <button className="erp-button primary">
                  {workingReport !== null
                    ? "Saving…"
                    : correction.action === "reject"
                      ? "Return to draft"
                      : "Reverse approval"}
                </button>
              </div>
            </fieldset>
          </form>
        </Modal>
      )}
      {approval && (
        <Modal
          title="Review & approve daily report"
          onClose={() => {
            if (workingReport === null) {
              setApproval(null);
              setError("");
            }
          }}
        >
          <p>
            <strong>{approval.jobsite_name}</strong> · {approval.date} ·{" "}
            {approval.crew_name ?? "No crew"}
          </p>
          <div className="erp-alert warning">
            Approval locks this report and posts installed quantities, labor
            hours, and recorded costs to the job. Reversals preserve the
            original record. Review values and reconcile any labor already
            posted through individual shifts before approving.
          </div>
          {approval.weather && (
            <p>
              <strong>Weather:</strong> {approval.weather}
            </p>
          )}
          {approval.notes && (
            <p className="erp-preserve-lines">
              <strong>Notes:</strong> {approval.notes}
            </p>
          )}
          {approval.lines.length ? (
            <div className="erp-table-wrap">
              <table className="erp-table">
                <thead>
                  <tr>
                    <th>Activity</th>
                    <th>Installed quantity</th>
                    <th>Labor hours</th>
                    <th>Equipment hours</th>
                    <th>Costs to post</th>
                  </tr>
                </thead>
                <tbody>
                  {approval.lines.map((line, index) => {
                    const item = data.work_items.find(
                      (work) => work.id === line.plan_id,
                    );
                    return (
                      <tr key={line.id ?? index}>
                        <td>{item?.activity ?? `Work item ${line.plan_id}`}</td>
                        <td>
                          {number(line.qty, 6)} {item?.unit}
                        </td>
                        <td>{number(line.labor_hours, 6)}</td>
                        <td>{number(line.equipment_hours, 6)}</td>
                        <td>
                          {exactMoney(lineCost(line))}
                          <div className="erp-muted">
                            Labor {exactMoney(line.labor_cost)} · Equipment{" "}
                            {exactMoney(line.equipment_cost)} · Material{" "}
                            {exactMoney(line.material_cost)}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No production quantities or costs will be posted.</p>
          )}
          <p>
            <strong>
              Total costs to post: {exactMoney(reportCost(approval))}
            </strong>
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
              disabled={workingReport !== null}
              onClick={() => {
                setApproval(null);
                setError("");
              }}
            >
              Cancel
            </button>
            <button
              className="erp-button primary"
              disabled={workingReport !== null}
              onClick={() => void transition(approval, "approve")}
            >
              {workingReport !== null ? "Approving…" : "Approve & post to job"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
