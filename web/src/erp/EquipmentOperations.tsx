import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { api } from "../api/client";
import { useApp } from "../state/store";
import { money, number, today, type ERPData } from "./types";
import { Badge, Empty, Field, Modal, SectionHead } from "./ui";

interface Reservation {
  id: number;
  asset_id: number;
  asset_name: string;
  jobsite_name: string;
  start_at: string;
  end_at: string;
  task: string;
  status: string;
}
interface Transfer {
  id: number;
  asset_name: string;
  from_jobsite_name: string | null;
  to_jobsite_name: string;
  custodian_name: string | null;
  requested_date: string;
  status: string;
  accepted_at: string | null;
}
interface WorkOrder {
  id: number;
  asset_id: number;
  asset_name: string;
  type: string;
  title: string;
  assigned_to_name: string | null;
  status: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  parts_cost: number;
  labor_cost: number;
  jobsite_name: string | null;
  cost_entry_id: number | null;
  completed_meter: number | null;
  notes: string;
}
interface ServiceRule {
  asset_id: number;
  id: number;
  asset_name: string;
  name: string;
  interval_hours: number | null;
  interval_days: number | null;
  engine_hours: number | null;
  meter_observed_at: string | null;
  last_completed_meter: number | null;
  last_completed_date: string | null;
  next_due_meter: number | null;
  next_due_date: string | null;
  due: boolean;
  baseline_missing: boolean;
}
interface Inspection {
  id: number;
  asset_name: string;
  date: string;
  inspector_name: string;
  passed: number;
  findings: string;
}
interface EquipmentData {
  reservations: Reservation[];
  transfers: Transfer[];
  work_orders: WorkOrder[];
  service_rules: ServiceRule[];
  inspections: Inspection[];
}
const empty: EquipmentData = {
  reservations: [],
  transfers: [],
  work_orders: [],
  service_rules: [],
  inspections: [],
};
type Tab = "reservations" | "transfers" | "maintenance" | "inspections";
type Editor = Tab | "service" | "complete";
const label: Record<Editor, string> = {
  reservations: "Reserve equipment",
  transfers: "Request asset transfer",
  maintenance: "New maintenance work order",
  inspections: "Record equipment inspection",
  service: "New service rule",
  complete: "Complete work order",
};
const displayTime = (value: string | null) =>
  value
    ? new Date(value).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Unscheduled";
const failure = (error: unknown) =>
  error instanceof Error ? error.message : "Unable to save equipment record.";
const localTime = () => {
  const value = new Date();
  value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
  return value.toISOString().slice(0, 16);
};

export function EquipmentOperations({
  data,
  refresh,
}: {
  data: ERPData;
  refresh: () => Promise<void> | void;
}) {
  const assets = useApp((state) => state.assets);
  const [records, setRecords] = useState<EquipmentData>(empty),
    [tab, setTab] = useState<Tab>("reservations"),
    [editor, setEditor] = useState<Editor | null>(null);
  const [selectedOrder, setSelectedOrder] = useState<WorkOrder | null>(null),
    [assetFilter, setAssetFilter] = useState(""),
    [selectedAsset, setSelectedAsset] = useState("");
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [formError, setFormError] = useState(""),
    [message, setMessage] = useState("");
  const [jobSelection, setJobSelection] = useState(""),
    [hoursRule, setHoursRule] = useState(true),
    [daysRule, setDaysRule] = useState(false);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setRecords(await api.get<EquipmentData>("/erp/equipment-operations"));
      setError("");
    } catch (error) {
      setError(failure(error));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const update = async () => {
    await reload();
    await refresh();
  };
  const start = (type: Editor, order?: WorkOrder) => {
    setEditor(type);
    setSelectedOrder(order ?? null);
    setSelectedAsset(
      String(
        order?.asset_id ??
          assets.find((asset) => asset.status === "active")?.id ??
          assets[0]?.id ??
          "",
      ),
    );
    setJobSelection("");
    setFormError("");
  };
  const close = () => {
    if (!busy) setEditor(null);
  };
  const act = async (path: string, text: string) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api.post(path, {});
      await update();
      setMessage(text);
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      value = (name: string) => String(form.get(name) ?? ""),
      optionalId = (name: string) => (value(name) ? Number(value(name)) : null);
    const asset_id = Number(selectedAsset);
    let endpoint = "",
      payload: Record<string, unknown> = {};
    if (editor === "reservations") {
      endpoint = "/erp/equipment-reservations";
      payload = {
        asset_id,
        jobsite_id: Number(value("jobsite_id")),
        start_at: new Date(value("start_at")).toISOString(),
        end_at: new Date(value("end_at")).toISOString(),
        task: value("task"),
      };
    }
    if (editor === "transfers") {
      endpoint = "/erp/asset-transfers";
      payload = {
        asset_id,
        from_jobsite_id:
          assets.find((asset) => asset.id === asset_id)?.jobsite_id ?? null,
        to_jobsite_id: Number(value("to_jobsite_id")),
        custodian_id: optionalId("custodian_id"),
        requested_date: value("requested_date"),
        notes: value("notes"),
      };
    }
    if (editor === "maintenance") {
      endpoint = "/erp/equipment-work-orders";
      payload = {
        asset_id,
        type: value("type"),
        title: value("title"),
        assigned_to_id: optionalId("assigned_to_id"),
        service_rule_id: optionalId("service_rule_id"),
        scheduled_start: value("scheduled_start")
          ? new Date(value("scheduled_start")).toISOString()
          : null,
        scheduled_end: value("scheduled_end")
          ? new Date(value("scheduled_end")).toISOString()
          : null,
        parts_cost: Number(value("parts_cost")),
        labor_cost: Number(value("labor_cost")),
        jobsite_id: optionalId("jobsite_id"),
        cost_code: jobSelection ? value("cost_code") : null,
        notes: value("notes"),
      };
    }
    if (editor === "inspections") {
      endpoint = "/erp/equipment-inspections";
      payload = {
        asset_id,
        date: value("date"),
        inspector_id: Number(value("inspector_id")),
        passed: value("passed") === "passed",
        findings: value("findings"),
      };
    }
    if (editor === "service") {
      endpoint = "/erp/equipment-service-rules";
      payload = {
        asset_id,
        name: value("name"),
        interval_hours: hoursRule ? Number(value("interval_hours")) : null,
        interval_days: daysRule ? Number(value("interval_days")) : null,
        last_completed_date: value("last_completed_date") || null,
        last_completed_meter: value("last_completed_meter")
          ? Number(value("last_completed_meter"))
          : null,
      };
    }
    if (editor === "complete" && selectedOrder) {
      endpoint = `/erp/equipment-work-orders/${selectedOrder.id}/complete`;
      payload = {
        return_to_service: value("return_to_service") === "yes",
        completed_meter: value("completed_meter")
          ? Number(value("completed_meter"))
          : null,
        notes: value("notes"),
      };
    }
    setBusy(true);
    setFormError("");
    setMessage("");
    try {
      await api.post(endpoint, payload);
      setEditor(null);
      await update();
      setMessage(
        editor === "complete"
          ? "Work order completed and costs reconciled."
          : "Equipment record saved.",
      );
    } catch (error) {
      setFormError(failure(error));
    } finally {
      setBusy(false);
    }
  };
  const options = assets.filter((asset) =>
    [
      "machine",
      "truck",
      "attachment",
      "small_tool",
      "trailer",
      "network",
      "camera",
    ].includes(asset.kind),
  );
  const chosen = assets.find((asset) => String(asset.id) === selectedAsset);
  const assetSelect = (
    <Field label="Asset">
      <select
        required
        value={selectedAsset}
        onChange={(event) => setSelectedAsset(event.target.value)}
      >
        <option value="">Select an asset</option>
        {options.map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.name} · {asset.status}
          </option>
        ))}
      </select>
    </Field>
  );
  const jobs = (name: string, required = true): ReactNode => (
    <Field label={name === "to_jobsite_id" ? "Destination project" : "Project"}>
      <select name={name} required={required} defaultValue="">
        <option value="">Select a project</option>
        {data.projects.map((job) => (
          <option key={job.id} value={job.id}>
            {job.code} · {job.name}
          </option>
        ))}
      </select>
    </Field>
  );
  const people = (name: string, title: string, required = false): ReactNode => (
    <Field label={title}>
      <select name={name} required={required} defaultValue="">
        <option value="">
          {required ? "Select a person" : "Unassigned / retain current"}
        </option>
        {data.people
          .filter((person) => person.active)
          .map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
      </select>
    </Field>
  );
  const filtered = (assetId: number) =>
    !assetFilter || String(assetId) === assetFilter;
  const reservations = records.reservations.filter((row) =>
    filtered(row.asset_id),
  );
  const orders = records.work_orders.filter((row) => filtered(row.asset_id));
  return (
    <div className="erp-stack">
      <SectionHead
        title="Equipment operations"
        description="Reserve resources across jobs, accept transfers, and control inspection and service downtime."
        action={
          <button
            className="erp-button primary"
            disabled={!assets.length || busy}
            onClick={() => start(tab)}
          >
            {label[tab]}
          </button>
        }
      />
      {error && (
        <div className="erp-alert" role="alert">
          {error}{" "}
          <button className="erp-button" onClick={() => void reload()}>
            Retry loading
          </button>
        </div>
      )}
      {message && (
        <div className="erp-notice" role="status">
          {message}
        </div>
      )}
      <div className="erp-metrics">
        <div className="erp-metric">
          <span>Active reservations</span>
          <strong>
            {
              records.reservations.filter(
                (row) =>
                  row.status === "reserved" &&
                  row.end_at > new Date().toISOString(),
              ).length
            }
          </strong>
          <small>Timed job allocations</small>
        </div>
        <div className="erp-metric">
          <span>Transfers awaiting receipt</span>
          <strong>
            {records.transfers.filter((row) => row.status === "pending").length}
          </strong>
          <small>Move and custody acceptance</small>
        </div>
        <div className="erp-metric">
          <span>Open maintenance</span>
          <strong>
            {
              records.work_orders.filter((row) => row.status !== "completed")
                .length
            }
          </strong>
          <small>
            {
              records.work_orders.filter((row) => row.status === "in_progress")
                .length
            }{" "}
            in progress
          </small>
        </div>
        <div className="erp-metric">
          <span>Service rules due</span>
          <strong>
            {records.service_rules.filter((row) => row.due).length}
          </strong>
          <small>Meter and calendar evidence</small>
        </div>
      </div>
      <div className="erp-card">
        <div
          className="erp-toolbar"
          role="tablist"
          aria-label="Equipment workflows"
        >
          {(
            ["reservations", "transfers", "maintenance", "inspections"] as Tab[]
          ).map((item) => (
            <button
              role="tab"
              aria-selected={tab === item}
              className={`erp-button ${tab === item ? "primary" : ""}`}
              key={item}
              onClick={() => {
                setTab(item);
                setAssetFilter("");
              }}
            >
              {item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
          {(tab === "reservations" || tab === "maintenance") && (
            <Field label="Filter by asset">
              <select
                value={assetFilter}
                onChange={(event) => setAssetFilter(event.target.value)}
              >
                <option value="">All assets</option>
                {assets.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      </div>
      {loading ? (
        <Empty>Loading equipment operations…</Empty>
      ) : (
        <>
          {tab === "reservations" && (
            <div className="erp-card">
              <SectionHead
                title="Timed equipment reservations"
                description="Overlapping reservations and planned maintenance are checked when you save."
              />
              {!reservations.length ? (
                <Empty>
                  No equipment reservations. Reserve a resource for the next
                  work front.
                </Empty>
              ) : (
                <div className="erp-table-wrap">
                  <table className="erp-table">
                    <thead>
                      <tr>
                        <th>Asset / task</th>
                        <th>Project</th>
                        <th>Reserved window</th>
                        <th>Status</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reservations.map((row) => (
                        <tr key={row.id}>
                          <td>
                            <strong>{row.asset_name}</strong>
                            <br />
                            <small>{row.task}</small>
                          </td>
                          <td>{row.jobsite_name}</td>
                          <td>
                            {displayTime(row.start_at)}
                            <br />
                            <small>to {displayTime(row.end_at)}</small>
                          </td>
                          <td>
                            <Badge
                              tone={
                                row.status === "reserved" ? "info" : "neutral"
                              }
                            >
                              {row.status}
                            </Badge>
                          </td>
                          <td>
                            {row.status === "reserved" && (
                              <button
                                className="erp-button"
                                disabled={busy}
                                onClick={() =>
                                  void act(
                                    `/erp/equipment-reservations/${row.id}/cancel`,
                                    "Reservation cancelled.",
                                  )
                                }
                              >
                                Cancel reservation
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
          )}
          {tab === "transfers" && (
            <div className="erp-card">
              <SectionHead
                title="Transfer and custody history"
                description="Accept the move when equipment arrives. Acceptance records the prior project and preserves asset metadata."
              />
              {!records.transfers.length ? (
                <Empty>
                  No transfers recorded. Request a move between jobs to
                  establish its acceptance history.
                </Empty>
              ) : (
                <div className="erp-table-wrap">
                  <table className="erp-table">
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th>Movement</th>
                        <th>Custodian / date</th>
                        <th>Status</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.transfers.map((row) => (
                        <tr key={row.id}>
                          <td>
                            <strong>{row.asset_name}</strong>
                          </td>
                          <td>
                            {row.from_jobsite_name || "Unassigned"}
                            <br />
                            <small>→ {row.to_jobsite_name}</small>
                          </td>
                          <td>
                            {row.custodian_name || "Retain current operator"}
                            <br />
                            <small>{row.requested_date}</small>
                          </td>
                          <td>
                            <Badge
                              tone={
                                row.status === "accepted"
                                  ? "success"
                                  : "neutral"
                              }
                            >
                              {row.status}
                            </Badge>
                            {row.accepted_at && (
                              <>
                                <br />
                                <small>{displayTime(row.accepted_at)}</small>
                              </>
                            )}
                          </td>
                          <td>
                            {row.status === "pending" && (
                              <div className="erp-form-actions">
                                <button
                                  className="erp-button primary"
                                  disabled={busy}
                                  onClick={() =>
                                    void act(
                                      `/erp/asset-transfers/${row.id}/accept`,
                                      "Transfer accepted and asset location updated.",
                                    )
                                  }
                                >
                                  Accept receipt
                                </button>
                                <button
                                  className="erp-button"
                                  disabled={busy}
                                  onClick={() =>
                                    void act(
                                      `/erp/asset-transfers/${row.id}/cancel`,
                                      "Transfer cancelled.",
                                    )
                                  }
                                >
                                  Cancel
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          {tab === "maintenance" && (
            <>
              <div className="erp-card">
                <SectionHead
                  title="Maintenance work orders"
                  description="Starting work makes the asset unavailable. Completion requires an explicit return-to-service decision."
                />
                {!orders.length ? (
                  <Empty>No maintenance work orders.</Empty>
                ) : (
                  <div className="erp-table-wrap">
                    <table className="erp-table">
                      <thead>
                        <tr>
                          <th>Work order</th>
                          <th>Mechanic / window</th>
                          <th>Cost allocation</th>
                          <th>Status</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {orders.map((row) => (
                          <tr key={row.id}>
                            <td>
                              <strong>
                                #{row.id} · {row.title}
                              </strong>
                              <br />
                              <small>
                                {row.asset_name} · {row.type}
                              </small>
                              {row.notes && (
                                <>
                                  <br />
                                  <small>{row.notes}</small>
                                </>
                              )}
                            </td>
                            <td>
                              {row.assigned_to_name || "Unassigned"}
                              <br />
                              <small>
                                {displayTime(row.scheduled_start)}
                                {row.scheduled_end && (
                                  <> – {displayTime(row.scheduled_end)}</>
                                )}
                              </small>
                            </td>
                            <td>
                              <strong>
                                {money(row.parts_cost + row.labor_cost)}
                              </strong>
                              <br />
                              <small>
                                {row.jobsite_name || "Internal shop cost"}
                                {row.cost_entry_id
                                  ? " · Posted once"
                                  : row.jobsite_name
                                    ? " · Posts at completion"
                                    : ""}
                              </small>
                            </td>
                            <td>
                              <Badge
                                tone={
                                  row.status === "completed"
                                    ? "success"
                                    : row.status === "in_progress"
                                      ? "warning"
                                      : "neutral"
                                }
                              >
                                {row.status.replaceAll("_", " ")}
                              </Badge>
                            </td>
                            <td>
                              {row.status === "open" && (
                                <button
                                  className="erp-button"
                                  disabled={busy}
                                  onClick={() =>
                                    void act(
                                      `/erp/equipment-work-orders/${row.id}/start`,
                                      "Work order started. Asset placed in maintenance.",
                                    )
                                  }
                                >
                                  Start work
                                </button>
                              )}
                              {row.status === "in_progress" && (
                                <button
                                  className="erp-button primary"
                                  disabled={busy}
                                  onClick={() => start("complete", row)}
                                >
                                  Complete work
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
                  title="Preventive service rules"
                  description="Engine-hour readings remain telemetry evidence. Enter a verified service baseline to calculate the next due point."
                  action={
                    <button
                      className="erp-button"
                      disabled={!assets.length || busy}
                      onClick={() => start("service")}
                    >
                      Add service rule
                    </button>
                  }
                />
                {!records.service_rules.length ? (
                  <Empty>
                    No service rules. Add the manufacturer service interval and
                    last completed meter/date.
                  </Empty>
                ) : (
                  <div className="erp-table-wrap">
                    <table className="erp-table">
                      <thead>
                        <tr>
                          <th>Asset / service</th>
                          <th>Intervals</th>
                          <th>Observed meter</th>
                          <th>Next due</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {records.service_rules.map((rule) => (
                          <tr key={rule.id}>
                            <td>
                              <strong>{rule.asset_name}</strong>
                              <br />
                              <small>{rule.name}</small>
                            </td>
                            <td>
                              {rule.interval_hours && (
                                <>
                                  {number(rule.interval_hours)} hours
                                  <br />
                                </>
                              )}
                              {rule.interval_days && (
                                <>{number(rule.interval_days)} days</>
                              )}
                            </td>
                            <td>
                              {number(rule.engine_hours, 1)} h<br />
                              <small>
                                {rule.meter_observed_at
                                  ? displayTime(rule.meter_observed_at)
                                  : "No observed meter"}
                              </small>
                            </td>
                            <td>
                              {rule.next_due_meter !== null && (
                                <>
                                  {number(rule.next_due_meter)} h<br />
                                </>
                              )}
                              {rule.next_due_date ??
                                "Calendar baseline pending"}
                            </td>
                            <td>
                              <Badge
                                tone={
                                  rule.due
                                    ? "danger"
                                    : rule.baseline_missing
                                      ? "warning"
                                      : "success"
                                }
                              >
                                {rule.due
                                  ? "Due"
                                  : rule.baseline_missing
                                    ? "Baseline needed"
                                    : "Scheduled"}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
          {tab === "inspections" && (
            <div className="erp-card">
              <SectionHead
                title="Inspection register"
                description="A failed inspection marks the asset down. Passing a later inspection does not release it; complete a repair work order and explicitly return it to service."
              />
              {!records.inspections.length ? (
                <Empty>
                  No inspections recorded. Capture the prestart result and
                  safety findings.
                </Empty>
              ) : (
                <div className="erp-table-wrap">
                  <table className="erp-table">
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th>Date / inspector</th>
                        <th>Result</th>
                        <th>Findings</th>
                      </tr>
                    </thead>
                    <tbody>
                      {records.inspections.map((row) => (
                        <tr key={row.id}>
                          <td>
                            <strong>{row.asset_name}</strong>
                          </td>
                          <td>
                            {row.date}
                            <br />
                            <small>{row.inspector_name}</small>
                          </td>
                          <td>
                            <Badge tone={row.passed ? "success" : "danger"}>
                              {row.passed ? "Passed" : "Failed · asset down"}
                            </Badge>
                          </td>
                          <td>{row.findings || "No findings recorded"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
      {editor && (
        <Modal title={label[editor]} onClose={close}>
          <form onSubmit={submit} className="erp-stack">
            {formError && (
              <div className="erp-alert" role="alert">
                {formError}
              </div>
            )}
            <div className="erp-form-grid">
              {editor !== "complete" && assetSelect}
              {editor === "reservations" && (
                <>
                  {jobs("jobsite_id")}
                  <Field label="Start (your local time)">
                    <input
                      required
                      type="datetime-local"
                      name="start_at"
                      defaultValue={localTime()}
                    />
                  </Field>
                  <Field label="End (your local time)">
                    <input required type="datetime-local" name="end_at" />
                  </Field>
                  <Field label="Task / work front" wide>
                    <input name="task" required maxLength={500} />
                  </Field>
                </>
              )}
              {editor === "transfers" && (
                <>
                  <Field label="Current project">
                    <input
                      readOnly
                      value={
                        data.projects.find(
                          (project) => project.id === chosen?.jobsite_id,
                        )?.name || "Unassigned"
                      }
                    />
                  </Field>
                  {jobs("to_jobsite_id")}
                  {people("custodian_id", "Receiving custodian / operator")}
                  <Field label="Requested move date">
                    <input
                      type="date"
                      name="requested_date"
                      required
                      defaultValue={today()}
                    />
                  </Field>
                  <Field label="Transfer notes" wide>
                    <textarea name="notes" rows={3} maxLength={4000} />
                  </Field>
                </>
              )}
              {editor === "maintenance" && (
                <>
                  <Field label="Work type">
                    <select name="type">
                      <option value="preventive">Preventive service</option>
                      <option value="repair">Repair</option>
                      <option value="inspection">Inspection</option>
                    </select>
                  </Field>
                  <Field label="Title" wide>
                    <input required name="title" maxLength={240} />
                  </Field>
                  <Field label="Completed service rule (preventive work)">
                    <select name="service_rule_id" defaultValue="">
                      <option value="">No service rule linked</option>
                      {records.service_rules
                        .filter(
                          (rule) => String(rule.asset_id) === selectedAsset,
                        )
                        .map((rule) => (
                          <option key={rule.id} value={rule.id}>
                            {rule.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                  {people("assigned_to_id", "Assigned mechanic")}
                  <Field label="Scheduled start (local time)">
                    <input type="datetime-local" name="scheduled_start" />
                  </Field>
                  <Field label="Scheduled end (local time)">
                    <input type="datetime-local" name="scheduled_end" />
                  </Field>
                  <Field label="Parts cost ($)">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      name="parts_cost"
                      defaultValue="0"
                      required
                    />
                  </Field>
                  <Field label="Labor cost ($)">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      name="labor_cost"
                      defaultValue="0"
                      required
                    />
                  </Field>
                  <Field label="Charge project">
                    <select
                      name="jobsite_id"
                      value={jobSelection}
                      onChange={(event) => setJobSelection(event.target.value)}
                    >
                      <option value="">Internal shop cost</option>
                      {data.projects.map((job) => (
                        <option key={job.id} value={job.id}>
                          {job.code} · {job.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {jobSelection && (
                    <Field label="Equipment cost code">
                      <input
                        name="cost_code"
                        required
                        maxLength={80}
                        list="equipment-cost-codes"
                      />
                      <datalist id="equipment-cost-codes">
                        {[
                          ...new Set(
                            data.work_items
                              .filter(
                                (item) =>
                                  String(item.jobsite_id) === jobSelection,
                              )
                              .map((item) => item.cost_code),
                          ),
                        ].map((code) => (
                          <option key={code} value={code} />
                        ))}
                      </datalist>
                    </Field>
                  )}
                  <Field label="Scope / notes" wide>
                    <textarea name="notes" maxLength={4000} rows={3} />
                  </Field>
                </>
              )}
              {editor === "inspections" && (
                <>
                  <Field label="Inspection date">
                    <input
                      type="date"
                      name="date"
                      required
                      defaultValue={today()}
                    />
                  </Field>
                  {people("inspector_id", "Inspector", true)}
                  <Field label="Inspection result">
                    <select name="passed">
                      <option value="passed">Passed</option>
                      <option value="failed">Failed · take asset down</option>
                    </select>
                  </Field>
                  <Field label="Findings (required if failed)" wide>
                    <textarea name="findings" rows={4} maxLength={4000} />
                  </Field>
                </>
              )}
              {editor === "service" && (
                <>
                  <Field label="Service name">
                    <input
                      required
                      name="name"
                      maxLength={200}
                      placeholder="Engine oil and filters"
                    />
                  </Field>
                  <Field label="Meter interval">
                    <select
                      value={String(hoursRule)}
                      onChange={(event) =>
                        setHoursRule(event.target.value === "true")
                      }
                    >
                      <option value="true">Track engine hours</option>
                      <option value="false">No hour interval</option>
                    </select>
                  </Field>
                  {hoursRule && (
                    <Field label="Interval hours">
                      <input
                        required
                        type="number"
                        min="0.01"
                        step="0.01"
                        name="interval_hours"
                        defaultValue="250"
                      />
                    </Field>
                  )}
                  <Field label="Calendar interval">
                    <select
                      value={String(daysRule)}
                      onChange={(event) =>
                        setDaysRule(event.target.value === "true")
                      }
                    >
                      <option value="false">No calendar interval</option>
                      <option value="true">Track days</option>
                    </select>
                  </Field>
                  {daysRule && (
                    <Field label="Interval days">
                      <input
                        required
                        type="number"
                        min="1"
                        name="interval_days"
                        defaultValue="90"
                      />
                    </Field>
                  )}
                  <Field label="Last verified service date">
                    <input type="date" name="last_completed_date" />
                  </Field>
                  <Field label="Last verified service meter (hours)">
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      name="last_completed_meter"
                    />
                  </Field>
                </>
              )}
              {editor === "complete" && selectedOrder && (
                <>
                  <Field label="Work order" wide>
                    <input
                      readOnly
                      value={`#${selectedOrder.id} · ${selectedOrder.asset_name} · ${selectedOrder.title}`}
                    />
                  </Field>
                  <Field label="Return to service">
                    <select required name="return_to_service" defaultValue="">
                      <option value="">Select an explicit decision</option>
                      <option value="yes">Safe to return to service</option>
                      <option value="no">Keep asset down</option>
                    </select>
                  </Field>
                  <Field label="Verified completion meter (hours)">
                    <input
                      type="number"
                      name="completed_meter"
                      min="0"
                      step="0.1"
                    />
                  </Field>
                  <Field label="Completion notes" wide>
                    <textarea
                      name="notes"
                      rows={4}
                      maxLength={4000}
                      defaultValue={selectedOrder.notes}
                    />
                  </Field>
                </>
              )}
            </div>
            {editor === "maintenance" && (
              <p>
                <small>
                  Job charges post once at completion. Shop costs stay in this
                  maintenance register. A scheduled window needs both start and
                  end.
                </small>
              </p>
            )}
            {editor === "complete" && (
              <p>
                <small>
                  The asset stays unavailable while another work order is in
                  progress. Verified completion meters do not overwrite observed
                  telemetry.
                </small>
              </p>
            )}
            <div className="erp-form-actions">
              <button
                type="button"
                className="erp-button"
                disabled={busy}
                onClick={close}
              >
                Cancel
              </button>
              <button className="erp-button primary" disabled={busy}>
                {busy ? "Saving…" : "Save record"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
export default EquipmentOperations;
