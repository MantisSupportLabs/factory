import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { useCanEdit } from "./permissions";
import { money, number, today, type ERPData, type Project } from "./types";
import { Badge, Empty, Field, Modal, SectionHead } from "./ui";

interface PurchaseOrder {
  id: number;
  jobsite_id: number;
  jobsite_name: string;
  jobsite_code: string;
  vendor: string;
  description: string;
  cost_code: string;
  amount: number;
  status: "draft" | "approved" | "received";
  order_date: string;
  expected_date: string | null;
}
interface ProjectControl {
  id: number;
  jobsite_id: number;
  jobsite_name: string;
  jobsite_code: string;
  kind: "rfi" | "change_order" | "issue";
  title: string;
  description: string;
  owner_id: number | null;
  owner_name: string | null;
  due_date: string | null;
  status: "open" | "closed";
  amount: number | null;
}
interface CommercialData {
  purchase_orders: PurchaseOrder[];
  controls: ProjectControl[];
}
const emptyCommercial: CommercialData = { purchase_orders: [], controls: [] };
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Unable to save this record.";
const controlKind = (kind: ProjectControl["kind"]) =>
  kind === "rfi" ? "RFI" : kind === "issue" ? "Field issue" : "Change request";

function useCommercial() {
  const [data, setData] = useState<CommercialData>(emptyCommercial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get<CommercialData>("/erp/commercial"));
      setError("");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, loading, error, setError, reload };
}

function LoadError({ error, retry }: { error: string; retry: () => void }) {
  return error ? (
    <div className="erp-alert" role="alert">
      {error}{" "}
      <button type="button" className="erp-button" onClick={retry}>
        Retry loading
      </button>
    </div>
  ) : null;
}

export function Purchasing({ projects }: { projects: Project[] }) {
  const canEdit = useCanEdit("pm", "accountant");
  const { data, loading, error, setError, reload } = useCommercial();
  const [project, setProject] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [form, setForm] = useState({
    jobsite_id: "",
    vendor: "",
    description: "",
    cost_code: "",
    amount: "",
    order_date: today(),
    expected_date: "",
  });
  const close = useCallback(() => setOpen(false), []);
  const scoped = data.purchase_orders.filter(
    (order) => !project || order.jobsite_id === Number(project),
  );
  const rows = scoped.filter((order) => !status || order.status === status);
  const sum = (orders: PurchaseOrder[]) =>
    orders.reduce((total, order) => total + order.amount, 0);
  const committed = scoped.filter((order) => order.status !== "draft");
  const awaiting = scoped.filter((order) => order.status === "approved");
  const received = scoped.filter((order) => order.status === "received");
  const drafts = scoped.filter((order) => order.status === "draft");
  const startCreate = () => {
    setForm({
      jobsite_id: project || String(projects[0]?.id ?? ""),
      vendor: "",
      description: "",
      cost_code: "",
      amount: "",
      order_date: today(),
      expected_date: "",
    });
    setFormError("");
    setOpen(true);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      await api.post("/erp/purchase-orders", {
        ...form,
        jobsite_id: Number(form.jobsite_id),
        amount: Number(form.amount),
        expected_date: form.expected_date || null,
      });
      setOpen(false);
      await reload();
    } catch (failure) {
      setFormError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };
  const advance = async (order: PurchaseOrder) => {
    setBusy(order.id);
    setError("");
    try {
      await api.patch(`/erp/purchase-orders/${order.id}`, {
        status: order.status === "draft" ? "approved" : "received",
      });
      await reload();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="erp-stack">
      <SectionHead
        title="Purchasing & commitments"
        description="Track material and subcontract orders from draft through approval and whole-order receipt."
        action={
          <button
            type="button"
            className="erp-button primary"
            disabled={!canEdit || !projects.length}
            onClick={startCreate}
          >
            New purchase order
          </button>
        }
      />
      <LoadError
        error={error}
        retry={() => {
          void reload();
        }}
      />
      <div className="erp-metrics">
        <div className="erp-metric">
          <span>Approved commitments</span>
          <strong>{money(sum(committed))}</strong>
          <small>{number(committed.length)} approved or received orders</small>
        </div>
        <div className="erp-metric">
          <span>Awaiting receipt</span>
          <strong>{money(sum(awaiting))}</strong>
          <small>{number(awaiting.length)} approved orders</small>
        </div>
        <div className="erp-metric">
          <span>Received order value</span>
          <strong>{money(sum(received))}</strong>
          <small>{number(received.length)} orders received in full</small>
        </div>
        <div className="erp-metric">
          <span>Draft requests</span>
          <strong>{money(sum(drafts))}</strong>
          <small>Not included in approved commitments</small>
        </div>
      </div>
      <div className="erp-card">
        <p>
          Commitments are separate from posted actual job costs. Receiving an
          order records receipt of the entire order; invoices, partial
          deliveries, and cost posting are not recorded by this action.
        </p>
      </div>
      <div className="erp-card">
        <div className="erp-toolbar">
          <Field label="Project">
            <select
              value={project}
              onChange={(event) => setProject(event.target.value)}
            >
              <option value="">All projects</option>
              {projects.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.code} · {job.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Order status">
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">All statuses</option>
              <option value="draft">Draft</option>
              <option value="approved">Approved</option>
              <option value="received">Received in full</option>
            </select>
          </Field>
        </div>
        {loading ? (
          <Empty>Loading purchase orders…</Empty>
        ) : !rows.length ? (
          <Empty>
            {project || status
              ? "No purchase orders match these filters."
              : "Create a purchase order to track a job commitment."}
          </Empty>
        ) : (
          <div className="erp-table-wrap">
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Order / vendor</th>
                  <th>Project</th>
                  <th>Cost code</th>
                  <th>Order value</th>
                  <th>Dates</th>
                  <th>Status</th>
                  <th>Next action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <strong>
                        PO-{String(order.id).padStart(4, "0")} · {order.vendor}
                      </strong>
                      {order.description && (
                        <>
                          <br />
                          <small>{order.description}</small>
                        </>
                      )}
                    </td>
                    <td>
                      {order.jobsite_name}
                      <br />
                      <small>{order.jobsite_code}</small>
                    </td>
                    <td>{order.cost_code || "Unassigned"}</td>
                    <td>
                      <strong>{money(order.amount)}</strong>
                      <br />
                      <small>
                        {order.status === "draft"
                          ? "Draft request"
                          : "Approved commitment"}
                      </small>
                    </td>
                    <td>
                      <small>Ordered {order.order_date}</small>
                      <br />
                      <small>
                        {order.expected_date
                          ? `Expected ${order.expected_date}`
                          : "No expected date"}
                      </small>
                    </td>
                    <td>
                      <Badge
                        tone={
                          order.status === "received"
                            ? "success"
                            : order.status === "approved"
                              ? "info"
                              : "neutral"
                        }
                      >
                        {order.status === "received"
                          ? "Received in full"
                          : order.status}
                      </Badge>
                    </td>
                    <td>
                      {order.status === "received" ? (
                        <small>Receipt recorded</small>
                      ) : (
                        <button
                          type="button"
                          className="erp-button"
                          disabled={!canEdit || busy !== null}
                          onClick={() => {
                            void advance(order);
                          }}
                        >
                          {busy === order.id
                            ? "Saving…"
                            : order.status === "draft"
                              ? "Approve order"
                              : "Mark fully received"}
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
      {open && (
        <Modal title="New purchase order" onClose={close}>
          <form onSubmit={save} className="erp-stack">
            {formError && (
              <div className="erp-alert" role="alert">
                {formError}
              </div>
            )}
            <div className="erp-form-grid">
              <Field label="Project">
                <select
                  required
                  value={form.jobsite_id}
                  onChange={(event) =>
                    setForm({ ...form, jobsite_id: event.target.value })
                  }
                >
                  <option value="">Select a project</option>
                  {projects.map((job) => (
                    <option key={job.id} value={job.id}>
                      {job.code} · {job.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Vendor / subcontractor">
                <input
                  required
                  maxLength={200}
                  value={form.vendor}
                  onChange={(event) =>
                    setForm({ ...form, vendor: event.target.value })
                  }
                />
              </Field>
              <Field label="Cost code">
                <input
                  maxLength={80}
                  placeholder="e.g. 4200-STORM"
                  value={form.cost_code}
                  onChange={(event) =>
                    setForm({ ...form, cost_code: event.target.value })
                  }
                />
              </Field>
              <Field label="Total order value ($)">
                <input
                  required
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.amount}
                  onChange={(event) =>
                    setForm({ ...form, amount: event.target.value })
                  }
                />
              </Field>
              <Field label="Order date">
                <input
                  required
                  type="date"
                  value={form.order_date}
                  onChange={(event) =>
                    setForm({ ...form, order_date: event.target.value })
                  }
                />
              </Field>
              <Field label="Expected delivery">
                <input
                  type="date"
                  value={form.expected_date}
                  onChange={(event) =>
                    setForm({ ...form, expected_date: event.target.value })
                  }
                />
              </Field>
              <Field label="Scope / description" wide>
                <textarea
                  rows={3}
                  maxLength={4000}
                  value={form.description}
                  onChange={(event) =>
                    setForm({ ...form, description: event.target.value })
                  }
                />
              </Field>
            </div>
            <p>
              <small>
                Saved as a draft. Approval adds the order to commitments and
                leaves actual costs unchanged.
              </small>
            </p>
            <div className="erp-form-actions">
              <button
                type="button"
                className="erp-button"
                disabled={saving}
                onClick={close}
              >
                Cancel
              </button>
              <button className="erp-button primary" disabled={saving}>
                {saving ? "Saving…" : "Create draft order"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export function ProjectControls({ data: erp }: { data: ERPData }) {
  const canEdit = useCanEdit("pm");
  const { data, loading, error, setError, reload } = useCommercial();
  const [project, setProject] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("open");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [form, setForm] = useState({
    jobsite_id: "",
    kind: "rfi" as ProjectControl["kind"],
    title: "",
    description: "",
    owner_id: "",
    due_date: "",
    amount: "",
  });
  const close = useCallback(() => setOpen(false), []);
  const scoped = data.controls.filter(
    (record) => !project || record.jobsite_id === Number(project),
  );
  const active = scoped.filter((record) => record.status === "open");
  const rows = scoped.filter(
    (record) =>
      (!kind || record.kind === kind) && (!status || record.status === status),
  );
  const localToday = today();
  const overdue = active.filter(
    (record) => record.due_date && record.due_date < localToday,
  );
  const exposure = active
    .filter((record) => record.kind === "change_order")
    .reduce((total, record) => total + (record.amount ?? 0), 0);
  const startCreate = () => {
    setForm({
      jobsite_id: project || String(erp.projects[0]?.id ?? ""),
      kind: (kind || "rfi") as ProjectControl["kind"],
      title: "",
      description: "",
      owner_id: "",
      due_date: "",
      amount: "",
    });
    setFormError("");
    setOpen(true);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      await api.post("/erp/controls", {
        ...form,
        jobsite_id: Number(form.jobsite_id),
        owner_id: form.owner_id ? Number(form.owner_id) : null,
        due_date: form.due_date || null,
        amount: form.kind === "change_order" ? Number(form.amount) : null,
      });
      setOpen(false);
      await reload();
    } catch (failure) {
      setFormError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };
  const toggle = async (record: ProjectControl) => {
    setBusy(record.id);
    setError("");
    try {
      await api.patch(`/erp/controls/${record.id}`, {
        status: record.status === "open" ? "closed" : "open",
      });
      await reload();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="erp-stack">
      <SectionHead
        title="Project controls"
        description="Keep RFIs, field issues, and requested changes with a project, owner, and due date."
        action={
          <button
            type="button"
            className="erp-button primary"
            disabled={!canEdit || !erp.projects.length}
            onClick={startCreate}
          >
            New project record
          </button>
        }
      />
      <LoadError
        error={error}
        retry={() => {
          void reload();
        }}
      />
      <div className="erp-metrics">
        <div className="erp-metric">
          <span>Open RFIs</span>
          <strong>
            {number(active.filter((record) => record.kind === "rfi").length)}
          </strong>
          <small>Questions awaiting resolution</small>
        </div>
        <div className="erp-metric">
          <span>Open field issues</span>
          <strong>
            {number(active.filter((record) => record.kind === "issue").length)}
          </strong>
          <small>Constraints and action items</small>
        </div>
        <div className="erp-metric">
          <span>Requested change exposure</span>
          <strong>{money(exposure)}</strong>
          <small>Open requests · unapproved amounts</small>
        </div>
        <div className="erp-metric">
          <span>Overdue records</span>
          <strong>{number(overdue.length)}</strong>
          <small>Open with a due date before today</small>
        </div>
      </div>
      <div className="erp-card">
        <p>
          Change amounts are requested and unapproved. Closing a record resolves
          its tracking status; it does not approve a change, revise the
          contract, or post job costs.
        </p>
      </div>
      <div className="erp-card">
        <div className="erp-toolbar">
          <Field label="Project">
            <select
              value={project}
              onChange={(event) => setProject(event.target.value)}
            >
              <option value="">All projects</option>
              {erp.projects.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.code} · {job.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Record type">
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="">All types</option>
              <option value="rfi">RFI</option>
              <option value="issue">Field issue</option>
              <option value="change_order">Change request</option>
            </select>
          </Field>
          <Field label="Status">
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">All statuses</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
          </Field>
        </div>
        {loading ? (
          <Empty>Loading project controls…</Empty>
        ) : !rows.length ? (
          <Empty>No project records match these filters.</Empty>
        ) : (
          <div className="erp-table-wrap">
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Record</th>
                  <th>Project</th>
                  <th>Owner / due date</th>
                  <th>Requested amount</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((record) => (
                  <tr key={record.id}>
                    <td>
                      <Badge
                        tone={
                          record.kind === "change_order" ? "warning" : "info"
                        }
                      >
                        {controlKind(record.kind)}
                      </Badge>
                      <br />
                      <strong>{record.title}</strong>
                      {record.description && (
                        <>
                          <br />
                          <small>{record.description}</small>
                        </>
                      )}
                    </td>
                    <td>
                      {record.jobsite_name}
                      <br />
                      <small>{record.jobsite_code}</small>
                    </td>
                    <td>
                      {record.owner_name || "Unassigned"}
                      <br />
                      {record.due_date ? (
                        <small>
                          Due {record.due_date}{" "}
                          {record.status === "open" &&
                            record.due_date < localToday && (
                              <Badge tone="danger">Overdue</Badge>
                            )}
                        </small>
                      ) : (
                        <small>No due date</small>
                      )}
                    </td>
                    <td>
                      {record.kind === "change_order" ? (
                        <>
                          <strong>{money(record.amount)}</strong>
                          <br />
                          <small>Requested · unapproved</small>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <Badge
                        tone={
                          record.status === "closed" ? "success" : "neutral"
                        }
                      >
                        {record.status}
                      </Badge>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="erp-button"
                        disabled={!canEdit || busy !== null}
                        onClick={() => {
                          void toggle(record);
                        }}
                      >
                        {busy === record.id
                          ? "Saving…"
                          : record.status === "open"
                            ? "Close record"
                            : "Reopen"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {open && (
        <Modal title="New project record" onClose={close}>
          <form onSubmit={save} className="erp-stack">
            {formError && (
              <div className="erp-alert" role="alert">
                {formError}
              </div>
            )}
            <div className="erp-form-grid">
              <Field label="Project">
                <select
                  required
                  value={form.jobsite_id}
                  onChange={(event) =>
                    setForm({ ...form, jobsite_id: event.target.value })
                  }
                >
                  <option value="">Select a project</option>
                  {erp.projects.map((job) => (
                    <option key={job.id} value={job.id}>
                      {job.code} · {job.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Record type">
                <select
                  value={form.kind}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      kind: event.target.value as ProjectControl["kind"],
                    })
                  }
                >
                  <option value="rfi">RFI</option>
                  <option value="issue">Field issue</option>
                  <option value="change_order">Change request</option>
                </select>
              </Field>
              <Field label="Title" wide>
                <input
                  required
                  maxLength={240}
                  value={form.title}
                  onChange={(event) =>
                    setForm({ ...form, title: event.target.value })
                  }
                />
              </Field>
              <Field label="Owner">
                <select
                  value={form.owner_id}
                  onChange={(event) =>
                    setForm({ ...form, owner_id: event.target.value })
                  }
                >
                  <option value="">Unassigned</option>
                  {erp.people
                    .filter((person) => person.active)
                    .map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Due date">
                <input
                  type="date"
                  value={form.due_date}
                  onChange={(event) =>
                    setForm({ ...form, due_date: event.target.value })
                  }
                />
              </Field>
              {form.kind === "change_order" && (
                <Field label="Requested amount ($)">
                  <input
                    required
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.amount}
                    onChange={(event) =>
                      setForm({ ...form, amount: event.target.value })
                    }
                  />
                </Field>
              )}
              <Field label="Description / required action" wide>
                <textarea
                  rows={4}
                  maxLength={4000}
                  value={form.description}
                  onChange={(event) =>
                    setForm({ ...form, description: event.target.value })
                  }
                />
              </Field>
            </div>
            {form.kind === "change_order" && (
              <p>
                <small>
                  This records an unapproved change request. Contract value and
                  posted actual costs remain unchanged.
                </small>
              </p>
            )}
            <div className="erp-form-actions">
              <button
                type="button"
                className="erp-button"
                disabled={saving}
                onClick={close}
              >
                Cancel
              </button>
              <button className="erp-button primary" disabled={saving}>
                {saving ? "Saving…" : "Create record"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
