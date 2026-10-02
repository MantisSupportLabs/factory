import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { money, number, today, type ERPData } from "./types";
import { Badge, Empty, Field, Modal, SectionHead } from "./ui";
import { useAccess } from "./Access";

interface Vendor {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
}
interface MaterialItem {
  id: number;
  description: string;
  unit: string;
}
interface OrderLine {
  id: number;
  order_id: number;
  item_id: number | null;
  description: string;
  unit: string;
  quantity: number;
  unit_price: number;
  unit_price_cents: number;
  line_amount: number;
  cost_code: string;
  received_qty: number;
  issued_qty: number;
  issued_amount_cents: number;
  invoiced_qty: number;
  invoiced_amount_cents: number;
  available_qty: number;
  unconsumed_amount: number;
}
interface Order {
  id: number;
  jobsite_id: number;
  jobsite_name: string;
  jobsite_code: string;
  vendor: string;
  vendor_id: number | null;
  description: string;
  amount: number;
  status: string;
  order_date: string;
  expected_date: string | null;
  item_tracking: boolean;
  lines: OrderLine[];
  outstanding_commitment: number;
}
interface Receipt {
  id: number;
  order_id: number;
  date: string;
  reference: string;
  lines: {
    line_id: number;
    quantity: number;
    description: string;
    unit: string;
  }[];
}
interface MaterialIssue {
  id: number;
  jobsite_id: number;
  line_id: number;
  date: string;
  reference: string;
  quantity: number;
  unit_price: number;
  amount: number;
  description: string;
  unit: string;
  jobsite_name: string;
}
interface SupplierInvoice {
  id: number;
  order_id: number;
  vendor_name: string;
  jobsite_name: string;
  reference: string;
  date: string;
  amount: number;
  paid_amount: number;
  open_amount: number;
  lines: { line_id: number; quantity: number; unit_price: number }[];
}
interface SupplierPayment {
  id: number;
  invoice_id: number;
  date: string;
  reference: string;
  amount: number;
}
interface ApprovedChange {
  id: number;
  control_id: number;
  jobsite_id: number;
  title: string;
  jobsite_name: string;
  customer_reference: string;
  effective_date: string;
  contract_delta: number;
  budget_delta: number;
  before_contract: number;
  after_contract: number;
  before_budget: number;
  after_budget: number;
  plan_id: number | null;
  quantity_delta: number | null;
  before_quantity: number | null;
  after_quantity: number | null;
}
interface ChangeRequest {
  id: number;
  kind: string;
  title: string;
  jobsite_id: number;
  amount: number | null;
  status: string;
}
interface ProcurementData {
  vendors: Vendor[];
  items: MaterialItem[];
  orders: Order[];
  receipts: Receipt[];
  issues: MaterialIssue[];
  invoices: SupplierInvoice[];
  payments: SupplierPayment[];
  changes: ApprovedChange[];
  controls: ChangeRequest[];
}
interface DraftLine {
  key: number;
  item_id: string;
  description: string;
  unit: string;
  quantity: string;
  unit_price: string;
  cost_code: string;
}
type Dialog =
  | "vendor"
  | "item"
  | "order"
  | "receive"
  | "issue"
  | "invoice"
  | "payment"
  | "change";
type Tab = "orders" | "inventory" | "invoices" | "changes";
const emptyProcurement: ProcurementData = {
  vendors: [],
  items: [],
  orders: [],
  receipts: [],
  issues: [],
  invoices: [],
  payments: [],
  changes: [],
  controls: [],
};
const emptyLine = (key: number): DraftLine => ({
  key,
  item_id: "",
  description: "",
  unit: "",
  quantity: "",
  unit_price: "",
  cost_code: "",
});
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Unable to save this record.";
const orderNumber = (id: number) => `PO-${String(id).padStart(4, "0")}`;
const price = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
const hasQty = (value: number) => value > 0.0000005;
const extension = (quantity: number, unitPrice: number) =>
  Math.round(quantity * Math.round(unitPrice * 100)) / 100;
const incrementalValue = (
  line: OrderLine,
  quantity: number,
  kind: "issue" | "invoice",
) => {
  const previousQty = kind === "issue" ? line.issued_qty : line.invoiced_qty;
  const previousCents =
    kind === "issue" ? line.issued_amount_cents : line.invoiced_amount_cents;
  return (
    (Math.round(
      (Math.round((previousQty + quantity) * 1e6) / 1e6) *
        line.unit_price_cents,
    ) -
      previousCents) /
    100
  );
};
const titles: Record<Dialog, string> = {
  vendor: "Add supplier",
  item: "Add material item",
  order: "New item order",
  receive: "Receive a delivery",
  issue: "Issue material to the job",
  invoice: "Record supplier invoice",
  payment: "Record supplier payment",
  change: "Approve signed change",
};
const tabs: { id: Tab; label: string }[] = [
  { id: "orders", label: "Item orders" },
  { id: "inventory", label: "Receipts & inventory" },
  { id: "invoices", label: "Supplier invoices" },
  { id: "changes", label: "Approved changes" },
];

export function Procurement({
  data: erp,
  refresh,
}: {
  data: ERPData;
  refresh: () => Promise<void>;
}) {
  const access = useAccess();
  const fullAccess =
    access.mode === "demo" ||
    access.role === "owner" ||
    access.role === "admin";
  const canProcure =
    fullAccess || access.role === "pm" || access.role === "accountant";
  const canReceive = canProcure || access.role === "foreman";
  const canIssue = canProcure || access.role === "foreman";
  const canInvoice = fullAccess || access.role === "accountant";
  const [data, setData] = useState<ProcurementData>(emptyProcurement);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("orders");
  const [project, setProject] = useState("");
  const [status, setStatus] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [draftLines, setDraftLines] = useState<DraftLine[]>([emptyLine(1)]);
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [busyOrder, setBusyOrder] = useState<number | null>(null);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get<ProcurementData>("/erp/procurement"));
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
  const close = useCallback(() => {
    if (!saving) setDialog(null);
  }, [saving]);
  const setValue = (key: string, value: string) =>
    setForm((previous) => ({ ...previous, [key]: value }));
  const scopedOrders = data.orders.filter(
    (order) => !project || order.jobsite_id === Number(project),
  );
  const trackedOrders = scopedOrders.filter((order) => order.item_tracking);
  const orders = scopedOrders.filter(
    (order) => !status || order.status === status,
  );
  const scopeIds = new Set(scopedOrders.map((order) => order.id));
  const lines = trackedOrders.flatMap((order) =>
    order.lines.map((line) => ({ order, line })),
  );
  const stock = lines.filter(({ line }) => hasQty(line.available_qty));
  const receivable = trackedOrders.filter(
    (order) =>
      order.status !== "draft" &&
      order.lines.some((line) => hasQty(line.quantity - line.received_qty)),
  );
  const invoiceable = trackedOrders.filter(
    (order) =>
      order.status !== "draft" &&
      order.lines.some((line) => hasQty(line.received_qty - line.invoiced_qty)),
  );
  const invoices = data.invoices.filter((invoice) =>
    scopeIds.has(invoice.order_id),
  );
  const invoiceIds = new Set(invoices.map((invoice) => invoice.id));
  const payments = data.payments.filter((payment) =>
    invoiceIds.has(payment.invoice_id),
  );
  const receipts = data.receipts.filter((receipt) =>
    scopeIds.has(receipt.order_id),
  );
  const issues = data.issues.filter(
    (issue) => !project || issue.jobsite_id === Number(project),
  );
  const changes = data.changes.filter(
    (change) => !project || change.jobsite_id === Number(project),
  );
  const pendingChanges = data.controls.filter(
    (control) =>
      control.kind === "change_order" &&
      (!project || control.jobsite_id === Number(project)) &&
      !data.changes.some((change) => change.control_id === control.id),
  );
  const selectedOrder = data.orders.find(
    (order) => order.id === Number(form.order_id),
  );
  const selectedInvoice = data.invoices.find(
    (invoice) => invoice.id === Number(form.invoice_id),
  );
  const selectedStock = data.orders
    .flatMap((order) => order.lines.map((line) => ({ order, line })))
    .find(({ line }) => line.id === Number(form.line_id));
  const selectedControl = data.controls.find(
    (control) => control.id === Number(form.control_id),
  );
  const selectedProject = erp.projects.find(
    (job) => job.id === Number(form.jobsite_id || selectedControl?.jobsite_id),
  );
  const changePlans = erp.work_items.filter(
    (plan) => plan.jobsite_id === selectedControl?.jobsite_id,
  );
  const selectedPlan = changePlans.find(
    (plan) => plan.id === Number(form.plan_id),
  );
  const receiptValue = lines.reduce(
    (sum, { line }) => sum + line.received_qty * line.unit_price,
    0,
  );
  const inventoryValue = stock.reduce(
    (sum, { line }) => sum + line.available_qty * line.unit_price,
    0,
  );
  const committed = trackedOrders
    .filter((order) => order.status !== "draft")
    .reduce((sum, order) => sum + order.outstanding_commitment, 0);
  const draftAmount = draftLines.reduce(
    (sum, line) =>
      sum + extension(Number(line.quantity) || 0, Number(line.unit_price) || 0),
    0,
  );
  const invoiceAmount =
    selectedOrder?.lines.reduce(
      (sum, line) =>
        sum +
        incrementalValue(line, Number(quantities[line.id]) || 0, "invoice"),
      0,
    ) || 0;

  const openDialog = (kind: Dialog, record?: number) => {
    const allowed =
      kind === "receive"
        ? canReceive
        : kind === "issue"
          ? canIssue
          : kind === "invoice" || kind === "payment"
            ? canInvoice
            : canProcure;
    if (!allowed) return;
    setFormError("");
    setQuantities({});
    setDraftLines([emptyLine(1)]);
    const common = {
      date: today(),
      reference: "",
      jobsite_id: project || String(erp.projects[0]?.id ?? ""),
    };
    if (kind === "order")
      setForm({
        ...common,
        vendor_id: String(data.vendors[0]?.id ?? ""),
        order_date: today(),
        expected_date: "",
        description: "",
      });
    else if (kind === "vendor") setForm({ name: "", email: "", phone: "" });
    else if (kind === "item") setForm({ description: "", unit: "" });
    else if (kind === "receive" || kind === "invoice")
      setForm({
        ...common,
        order_id: String(
          record ??
            (kind === "receive" ? receivable[0]?.id : invoiceable[0]?.id) ??
            "",
        ),
      });
    else if (kind === "issue") {
      const owner = stock.find(({ line }) => line.id === record) || stock[0];
      setForm({
        ...common,
        line_id: String(owner?.line.id ?? ""),
        jobsite_id: String(owner?.order.jobsite_id ?? ""),
        quantity: "",
      });
    } else if (kind === "payment") {
      const invoice = data.invoices.find((item) => item.id === record);
      setForm({
        ...common,
        invoice_id: String(record ?? ""),
        amount: String(invoice?.open_amount ?? ""),
      });
    } else {
      const control =
        pendingChanges.find((item) => item.id === record) || pendingChanges[0];
      setForm({
        ...common,
        control_id: String(control?.id ?? ""),
        jobsite_id: String(control?.jobsite_id ?? ""),
        customer_reference: "",
        effective_date: today(),
        contract_delta: String(control?.amount ?? 0),
        budget_delta: "0",
        plan_id: "",
        quantity_delta: "",
      });
    }
    setDialog(kind);
  };
  const updateLine = (key: number, patch: Partial<DraftLine>) =>
    setDraftLines((previous) =>
      previous.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  const selectItem = (key: number, value: string) => {
    const item = data.items.find((material) => material.id === Number(value));
    updateLine(key, {
      item_id: value,
      description: item?.description ?? "",
      unit: item?.unit ?? "",
    });
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog || saving) return;
    setSaving(true);
    setFormError("");
    setNotice("");
    let success = "Record saved.";
    try {
      if (dialog === "vendor") {
        await api.post("/erp/vendors", {
          name: form.name.trim(),
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
        });
        success = "Supplier added. You can now select them on an item order.";
      } else if (dialog === "item") {
        await api.post("/erp/material-items", {
          description: form.description.trim(),
          unit: form.unit.trim(),
        });
        success = "Material item added to the catalog.";
      } else if (dialog === "order") {
        if (!draftLines.length) throw new Error("Add at least one order line.");
        await api.post("/erp/line-orders", {
          jobsite_id: Number(form.jobsite_id),
          vendor_id: Number(form.vendor_id),
          order_date: form.order_date,
          expected_date: form.expected_date || null,
          description: form.description.trim(),
          lines: draftLines.map((line) => ({
            item_id: line.item_id ? Number(line.item_id) : null,
            description: line.description.trim(),
            unit: line.unit.trim(),
            quantity: Number(line.quantity),
            unit_price: Number(line.unit_price),
            cost_code: line.cost_code.trim(),
          })),
        });
        success =
          "Draft item order created. Approve it to authorize deliveries.";
      } else if (dialog === "receive" || dialog === "invoice") {
        if (!selectedOrder) throw new Error("Select an order.");
        const entered = selectedOrder.lines
          .filter((line) => hasQty(Number(quantities[line.id])))
          .map((line) => ({
            line_id: line.id,
            quantity: Number(quantities[line.id]),
            unit_price: line.unit_price,
          }));
        if (!entered.length)
          throw new Error("Enter a positive quantity for at least one line.");
        if (selectedOrder.lines.some((line) => Number(quantities[line.id]) < 0))
          throw new Error("Quantities cannot be negative.");
        if (dialog === "receive") {
          await api.post(`/erp/line-orders/${selectedOrder.id}/receive`, {
            date: form.date,
            reference: form.reference.trim(),
            lines: entered.map(({ line_id, quantity }) => ({
              line_id,
              quantity,
            })),
          });
          success =
            "Delivery received into project stock. No job expense was posted.";
        } else {
          await api.post("/erp/supplier-invoices", {
            order_id: selectedOrder.id,
            date: form.date,
            reference: form.reference.trim(),
            lines: entered,
          });
          success =
            "Supplier invoice recorded in accounts payable. Job costs were not duplicated.";
        }
      } else if (dialog === "issue") {
        if (!selectedStock) throw new Error("Select available project stock.");
        await api.post("/erp/material-issues", {
          jobsite_id: selectedStock.order.jobsite_id,
          line_id: selectedStock.line.id,
          quantity: Number(form.quantity),
          date: form.date,
          reference: form.reference.trim(),
        });
        success =
          "Material issued. Its value was posted to the job's material cost code.";
      } else if (dialog === "payment") {
        if (!selectedInvoice) throw new Error("Select an invoice.");
        await api.post(`/erp/supplier-invoices/${selectedInvoice.id}/pay`, {
          amount: Number(form.amount),
          date: form.date,
          reference: form.reference.trim(),
        });
        success = "Supplier payment recorded against the invoice.";
      } else {
        if (!selectedControl) throw new Error("Select a change request.");
        await api.post("/erp/change-approvals", {
          control_id: selectedControl.id,
          customer_reference: form.customer_reference.trim(),
          effective_date: form.effective_date,
          contract_delta: Number(form.contract_delta),
          budget_delta: Number(form.budget_delta),
          ...(form.plan_id
            ? {
                plan_id: Number(form.plan_id),
                quantity_delta: Number(form.quantity_delta || 0),
              }
            : {}),
        });
        success =
          "Signed change approved. Contract, budget and any selected work-item baseline are updated.";
      }
      setDialog(null);
      setNotice(success);
      await reload();
      try {
        await refresh();
      } catch (failure) {
        setError(
          `Saved, but project totals could not refresh: ${errorMessage(failure)}`,
        );
      }
    } catch (failure) {
      setFormError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };
  const approveOrder = async (order: Order) => {
    if (busyOrder !== null || !canProcure) return;
    setBusyOrder(order.id);
    setNotice("");
    setError("");
    try {
      await api.post(`/erp/line-orders/${order.id}/approve`, {});
      setNotice(
        `${orderNumber(order.id)} approved. Deliveries can now be received by line.`,
      );
      await reload();
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusyOrder(null);
    }
  };

  return (
    <div className="erp-stack">
      <SectionHead
        title="Procurement & approved scope"
        description="Follow each material order through partial delivery, job consumption, supplier invoice and payment."
        action={
          canProcure && (
            <div className="erp-form-actions">
              <button
                type="button"
                className="erp-button"
                onClick={() => openDialog("vendor")}
              >
                Add supplier
              </button>
              <button
                type="button"
                className="erp-button"
                onClick={() => openDialog("item")}
              >
                Add material
              </button>
              <button
                type="button"
                className="erp-button primary"
                disabled={
                  !erp.projects.length || !data.vendors.length || loading
                }
                onClick={() => openDialog("order")}
              >
                New item order
              </button>
            </div>
          )
        }
      />
      {error && (
        <div className="erp-alert" role="alert">
          {error}{" "}
          <button
            type="button"
            className="erp-button"
            onClick={() => {
              void reload();
            }}
          >
            Retry loading
          </button>
        </div>
      )}
      {notice && (
        <div className="erp-card-note" role="status">
          {notice}
        </div>
      )}
      <div className="erp-metrics">
        <div className="erp-metric">
          <span>Remaining material commitments</span>
          <strong>{money(committed)}</strong>
          <small>Approved order value still to be consumed</small>
        </div>
        <div className="erp-metric">
          <span>Project stock on hand</span>
          <strong>{money(inventoryValue)}</strong>
          <small>
            {number(stock.length)} material lines reserved to their jobs
          </small>
        </div>
        <div className="erp-metric">
          <span>Open supplier payables</span>
          <strong>
            {price(
              invoices.reduce((sum, invoice) => sum + invoice.open_amount, 0),
            )}
          </strong>
          <small>
            {number(
              invoices.filter((invoice) => hasQty(invoice.open_amount)).length,
            )}{" "}
            unpaid or partially paid invoices
          </small>
        </div>
        <div className="erp-metric">
          <span>Approved contract changes</span>
          <strong>
            {money(
              changes.reduce((sum, change) => sum + change.contract_delta, 0),
            )}
          </strong>
          <small>{number(changes.length)} signed customer approvals</small>
        </div>
      </div>
      <div className="erp-toolbar erp-card">
        <Field label="Project">
          <select
            value={project}
            onChange={(event) => {
              setProject(event.target.value);
              setExpanded(null);
            }}
          >
            <option value="">All projects</option>
            {erp.projects.map((job) => (
              <option key={job.id} value={job.id}>
                {job.code} · {job.name}
              </option>
            ))}
          </select>
        </Field>
        <span className="erp-muted">
          {number(data.vendors.length)} suppliers · {number(data.items.length)}{" "}
          catalog materials
        </span>
      </div>
      <div
        className="erp-tabs"
        role="tablist"
        aria-label="Procurement views"
        style={{ flexWrap: "wrap" }}
      >
        {tabs.map((item) => (
          <button
            key={item.id}
            id={`procurement-tab-${item.id}`}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`procurement-panel-${item.id}`}
            className={tab === item.id ? "active" : ""}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        id={`procurement-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`procurement-tab-${tab}`}
        className="erp-stack"
      >
        {loading ? (
          <Empty>Loading procurement records…</Empty>
        ) : tab === "orders" ? (
          <>
            <div className="erp-card">
              <p>
                Approve an item order to commit its value. Receive each delivery
                into stock, then issue material when the job consumes it. Older
                whole-order records remain visible as legacy orders.
              </p>
            </div>
            <div className="erp-card">
              <div className="erp-toolbar">
                <Field label="Order status">
                  <select
                    value={status}
                    onChange={(event) => setStatus(event.target.value)}
                  >
                    <option value="">All statuses</option>
                    {Array.from(
                      new Set(scopedOrders.map((order) => order.status)),
                    )
                      .sort()
                      .map((value) => (
                        <option key={value} value={value}>
                          {value.replaceAll("_", " ")}
                        </option>
                      ))}
                  </select>
                </Field>
                <span className="erp-muted">
                  {number(orders.length)} orders
                </span>
              </div>
              {!orders.length ? (
                <Empty>
                  {project || status
                    ? "No orders match these filters."
                    : "Add a supplier, then create your first item order."}
                </Empty>
              ) : (
                <div className="erp-table-wrap">
                  <table className="erp-table">
                    <thead>
                      <tr>
                        <th>Order / supplier</th>
                        <th>Project</th>
                        <th>Value / remaining</th>
                        <th>Delivery</th>
                        <th>Status</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orders.map((order) => (
                        <tr key={order.id}>
                          <td>
                            <strong>
                              {orderNumber(order.id)} · {order.vendor}
                            </strong>
                            <small>
                              {order.description ||
                                `${order.lines.length} material lines`}
                            </small>
                          </td>
                          <td>
                            {order.jobsite_name}
                            <small>{order.jobsite_code}</small>
                          </td>
                          <td>
                            <strong>{money(order.amount)}</strong>
                            <small>
                              {order.item_tracking
                                ? `${money(order.outstanding_commitment)} unconsumed`
                                : "Legacy whole-order amount"}
                            </small>
                          </td>
                          <td>
                            <small>Ordered {order.order_date}</small>
                            <small>
                              {order.expected_date
                                ? `Expected ${order.expected_date}`
                                : "No expected delivery"}
                            </small>
                          </td>
                          <td>
                            <Badge
                              tone={
                                order.status === "draft"
                                  ? "neutral"
                                  : order.status === "received"
                                    ? "success"
                                    : "info"
                              }
                            >
                              {order.status.replaceAll("_", " ")}
                            </Badge>
                            {!order.item_tracking && (
                              <small>Legacy order · read only</small>
                            )}
                          </td>
                          <td>
                            {order.item_tracking ? (
                              <div
                                className="erp-row"
                                style={{ flexWrap: "wrap" }}
                              >
                                <button
                                  type="button"
                                  className="erp-button small"
                                  aria-expanded={expanded === order.id}
                                  onClick={() =>
                                    setExpanded(
                                      expanded === order.id ? null : order.id,
                                    )
                                  }
                                >
                                  {expanded === order.id
                                    ? "Hide lines"
                                    : "View lines"}
                                </button>
                                {order.status === "draft" ? (
                                  canProcure && (
                                    <button
                                      type="button"
                                      className="erp-button small"
                                      disabled={busyOrder !== null || saving}
                                      onClick={() => {
                                        void approveOrder(order);
                                      }}
                                    >
                                      {busyOrder === order.id
                                        ? "Approving…"
                                        : "Approve order"}
                                    </button>
                                  )
                                ) : (
                                  <>
                                    {canReceive &&
                                      receivable.some(
                                        (item) => item.id === order.id,
                                      ) && (
                                        <button
                                          type="button"
                                          className="erp-button small"
                                          onClick={() =>
                                            openDialog("receive", order.id)
                                          }
                                        >
                                          Receive
                                        </button>
                                      )}
                                    {canInvoice &&
                                      invoiceable.some(
                                        (item) => item.id === order.id,
                                      ) && (
                                        <button
                                          type="button"
                                          className="erp-button small"
                                          onClick={() =>
                                            openDialog("invoice", order.id)
                                          }
                                        >
                                          Invoice
                                        </button>
                                      )}
                                  </>
                                )}
                              </div>
                            ) : (
                              <small>Line tracking unavailable</small>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {expanded !== null &&
              scopedOrders.find((order) => order.id === expanded) && (
                <div className="erp-card">
                  <SectionHead
                    title={`${orderNumber(expanded)} · material lines`}
                    description="Quantities show ordered, delivered, issued to job costs and invoiced separately."
                  />
                  <div className="erp-table-wrap">
                    <table className="erp-table">
                      <thead>
                        <tr>
                          <th>Material / cost code</th>
                          <th>Unit price</th>
                          <th>Ordered</th>
                          <th>Received</th>
                          <th>Issued</th>
                          <th>Invoiced</th>
                          <th>On hand</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {scopedOrders
                          .find((order) => order.id === expanded)
                          ?.lines.map((line) => (
                            <tr key={line.id}>
                              <td>
                                <strong>{line.description}</strong>
                                <small>
                                  {line.cost_code || "No cost code"}
                                </small>
                              </td>
                              <td>
                                {price(line.unit_price)} / {line.unit}
                              </td>
                              <td>{number(line.quantity, 3)}</td>
                              <td>{number(line.received_qty, 3)}</td>
                              <td>{number(line.issued_qty, 3)}</td>
                              <td>{number(line.invoiced_qty, 3)}</td>
                              <td>
                                <strong>
                                  {number(line.available_qty, 3)} {line.unit}
                                </strong>
                              </td>
                              <td>
                                {hasQty(line.available_qty) ? (
                                  canIssue ? (
                                    <button
                                      type="button"
                                      className="erp-button small"
                                      onClick={() =>
                                        openDialog("issue", line.id)
                                      }
                                    >
                                      Issue to job
                                    </button>
                                  ) : (
                                    <small>Available to project</small>
                                  )
                                ) : (
                                  <small>No available stock</small>
                                )}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
          </>
        ) : tab === "inventory" ? (
          <>
            <SectionHead
              title="Deliveries & project stock"
              description="Stock stays reserved to the purchase order's project; issue only the material actually consumed."
              action={
                (canReceive || canIssue) && (
                  <div className="erp-form-actions">
                    <button
                      type="button"
                      className="erp-button"
                      disabled={!canReceive || !receivable.length}
                      onClick={() => openDialog("receive")}
                    >
                      Receive delivery
                    </button>
                    <button
                      type="button"
                      className="erp-button primary"
                      disabled={!canIssue || !stock.length}
                      onClick={() => openDialog("issue")}
                    >
                      Issue material
                    </button>
                  </div>
                )
              }
            />
            <div className="erp-card">
              <p>
                Receiving adds project inventory and records delivered
                quantities; it does not post an expense. Issuing reduces stock
                and posts its purchase value to the job's material cost code.
                Invoice entry creates a payable without posting the same
                material cost again.
              </p>
            </div>
            <div className="erp-card">
              <SectionHead
                title="Available project stock"
                description={`${money(receiptValue)} received across tracked orders · ${money(inventoryValue)} remaining on hand`}
              />
              {!stock.length ? (
                <Empty>
                  No available stock. Receive an approved item order to add
                  material.
                </Empty>
              ) : (
                <div className="erp-table-wrap">
                  <table className="erp-table">
                    <thead>
                      <tr>
                        <th>Material</th>
                        <th>Project / order</th>
                        <th>Received</th>
                        <th>Issued</th>
                        <th>Available</th>
                        <th>Stock value</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stock.map(({ order, line }) => (
                        <tr key={line.id}>
                          <td>
                            <strong>{line.description}</strong>
                            <small>{line.cost_code || "No cost code"}</small>
                          </td>
                          <td>
                            {order.jobsite_name}
                            <small>
                              {orderNumber(order.id)} · {order.vendor}
                            </small>
                          </td>
                          <td>
                            {number(line.received_qty, 3)} {line.unit}
                          </td>
                          <td>
                            {number(line.issued_qty, 3)} {line.unit}
                          </td>
                          <td>
                            <strong>
                              {number(line.available_qty, 3)} {line.unit}
                            </strong>
                          </td>
                          <td>{money(line.available_qty * line.unit_price)}</td>
                          <td>
                            {canIssue ? (
                              <button
                                type="button"
                                className="erp-button small"
                                onClick={() => openDialog("issue", line.id)}
                              >
                                Issue to job
                              </button>
                            ) : (
                              <small>Available to project</small>
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
                title="Delivery receipts"
                description="Partial delivery history and supplier delivery references."
              />
              {!receipts.length ? (
                <Empty>No delivery receipts for these projects.</Empty>
              ) : (
                <div className="erp-table-wrap">
                  <table className="erp-table">
                    <thead>
                      <tr>
                        <th>Date / reference</th>
                        <th>Order / project</th>
                        <th>Delivered materials</th>
                      </tr>
                    </thead>
                    <tbody>
                      {receipts.map((receipt) => {
                        const order = data.orders.find(
                          (item) => item.id === receipt.order_id,
                        );
                        return (
                          <tr key={receipt.id}>
                            <td>
                              <strong>
                                {receipt.reference || `Receipt ${receipt.id}`}
                              </strong>
                              <small>{receipt.date}</small>
                            </td>
                            <td>
                              {orderNumber(receipt.order_id)}
                              <small>{order?.jobsite_name || "—"}</small>
                            </td>
                            <td>
                              {receipt.lines.map((line) => (
                                <small key={line.line_id}>
                                  {line.description}: {number(line.quantity, 3)}{" "}
                                  {line.unit}
                                </small>
                              ))}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="erp-card">
              <SectionHead
                title="Material issues & posted costs"
                description="Each issue records the stock consumed by the project."
              />
              {!issues.length ? (
                <Empty>No material has been issued to these jobs.</Empty>
              ) : (
                <div className="erp-table-wrap">
                  <table className="erp-table">
                    <thead>
                      <tr>
                        <th>Date / reference</th>
                        <th>Project</th>
                        <th>Material</th>
                        <th>Quantity</th>
                        <th>Posted job cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {issues.map((issue) => {
                        const line = lines.find(
                          (item) => item.line.id === issue.line_id,
                        )?.line;
                        return (
                          <tr key={issue.id}>
                            <td>
                              <strong>
                                {issue.reference || `Issue ${issue.id}`}
                              </strong>
                              <small>{issue.date}</small>
                            </td>
                            <td>{issue.jobsite_name}</td>
                            <td>
                              {issue.description}
                              <small>{line?.cost_code || ""}</small>
                            </td>
                            <td>
                              {number(issue.quantity, 3)} {issue.unit}
                            </td>
                            <td>
                              <strong>{price(issue.amount)}</strong>
                              <small>{price(issue.unit_price)} per unit</small>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        ) : tab === "invoices" ? (
          <>
            <SectionHead
              title="Supplier invoices & payments"
              description="Match invoices to received quantities at the approved order price, then record full or partial payments."
              action={
                canInvoice && (
                  <button
                    type="button"
                    className="erp-button primary"
                    disabled={!invoiceable.length}
                    onClick={() => openDialog("invoice")}
                  >
                    Record invoice
                  </button>
                )
              }
            />
            <div className="erp-card">
              <p>
                Invoice quantities cannot exceed delivered quantities that have
                not already been invoiced. Prices match the purchase order.
                Payables and payments are separate from material expenses posted
                when stock is issued.
              </p>
            </div>
            <div className="erp-card">
              {!invoices.length ? (
                <Empty>
                  No supplier invoices for these projects. Receive material
                  before entering its invoice.
                </Empty>
              ) : (
                <div className="erp-table-wrap">
                  <table className="erp-table">
                    <thead>
                      <tr>
                        <th>Invoice / supplier</th>
                        <th>Project / order</th>
                        <th>Invoice value</th>
                        <th>Paid</th>
                        <th>Open payable</th>
                        <th>Status / action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoices.map((invoice) => (
                        <tr key={invoice.id}>
                          <td>
                            <strong>{invoice.reference}</strong>
                            <small>
                              {invoice.vendor_name} · {invoice.date}
                            </small>
                          </td>
                          <td>
                            {invoice.jobsite_name}
                            <small>{orderNumber(invoice.order_id)}</small>
                          </td>
                          <td>{price(invoice.amount)}</td>
                          <td>{price(invoice.paid_amount)}</td>
                          <td>
                            <strong>{price(invoice.open_amount)}</strong>
                          </td>
                          <td>
                            <div
                              className="erp-row"
                              style={{ flexWrap: "wrap" }}
                            >
                              <Badge
                                tone={
                                  !hasQty(invoice.open_amount)
                                    ? "success"
                                    : hasQty(invoice.paid_amount)
                                      ? "warning"
                                      : "neutral"
                                }
                              >
                                {!hasQty(invoice.open_amount)
                                  ? "Paid"
                                  : hasQty(invoice.paid_amount)
                                    ? "Partially paid"
                                    : "Unpaid"}
                              </Badge>
                              {canInvoice && hasQty(invoice.open_amount) && (
                                <button
                                  type="button"
                                  className="erp-button small"
                                  onClick={() =>
                                    openDialog("payment", invoice.id)
                                  }
                                >
                                  Record payment
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
            <div className="erp-card">
              <SectionHead
                title="Supplier payment history"
                description="Payment references and amounts recorded against each invoice."
              />
              {!payments.length ? (
                <Empty>No supplier payments for these projects.</Empty>
              ) : (
                <div className="erp-table-wrap">
                  <table className="erp-table">
                    <thead>
                      <tr>
                        <th>Date / payment reference</th>
                        <th>Supplier / invoice</th>
                        <th>Project</th>
                        <th>Paid amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payments.map((payment) => {
                        const invoice = data.invoices.find(
                          (record) => record.id === payment.invoice_id,
                        );
                        return (
                          <tr key={payment.id}>
                            <td>
                              <strong>{payment.reference}</strong>
                              <small>{payment.date}</small>
                            </td>
                            <td>
                              {invoice?.vendor_name}
                              <small>{invoice?.reference}</small>
                            </td>
                            <td>{invoice?.jobsite_name}</td>
                            <td>
                              <strong>{price(payment.amount)}</strong>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <SectionHead
              title="Signed changes & revised baselines"
              description="Turn customer-approved change requests into contract, budget and optional work-quantity revisions."
              action={
                canProcure && (
                  <button
                    type="button"
                    className="erp-button primary"
                    disabled={!pendingChanges.length}
                    onClick={() => openDialog("change")}
                  >
                    Approve signed change
                  </button>
                )
              }
            />
            <div className="erp-card">
              <p>
                A change request by itself does not increase the contract or
                budget. Approving a change requires a signed customer reference
                and records the before and after values. Positive adjustments
                add scope; negative adjustments remove scope.
              </p>
            </div>
            <div className="erp-card">
              <SectionHead
                title="Awaiting signed approval"
                description={`${number(pendingChanges.length)} unapproved change requests`}
              />
              {!pendingChanges.length ? (
                <Empty>
                  No changes awaiting signed approval. Add a change request in
                  Project controls when scope changes.
                </Empty>
              ) : (
                <div className="erp-table-wrap">
                  <table className="erp-table">
                    <thead>
                      <tr>
                        <th>Change request</th>
                        <th>Project</th>
                        <th>Requested value</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingChanges.map((control) => (
                        <tr key={control.id}>
                          <td>
                            <strong>{control.title}</strong>
                            <small>Request #{control.id}</small>
                          </td>
                          <td>
                            {erp.projects.find(
                              (job) => job.id === control.jobsite_id,
                            )?.name || "—"}
                          </td>
                          <td>{money(control.amount)}</td>
                          <td>
                            {canProcure ? (
                              <button
                                type="button"
                                className="erp-button small"
                                onClick={() => openDialog("change", control.id)}
                              >
                                Approve signed change
                              </button>
                            ) : (
                              <small>Awaiting approval</small>
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
                title="Approved change register"
                description="Customer reference, effective date and the resulting job baselines."
              />
              {!changes.length ? (
                <Empty>
                  No signed changes have been approved for these projects.
                </Empty>
              ) : (
                <div className="erp-table-wrap">
                  <table className="erp-table">
                    <thead>
                      <tr>
                        <th>Change / approval</th>
                        <th>Project</th>
                        <th>Contract adjustment</th>
                        <th>Budget adjustment</th>
                        <th>Work quantity</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changes.map((change) => {
                        const plan = erp.work_items.find(
                          (item) => item.id === change.plan_id,
                        );
                        return (
                          <tr key={change.id}>
                            <td>
                              <strong>{change.title}</strong>
                              <small>
                                {change.customer_reference} ·{" "}
                                {change.effective_date}
                              </small>
                            </td>
                            <td>{change.jobsite_name}</td>
                            <td>
                              <strong>{price(change.contract_delta)}</strong>
                              <small>
                                {money(change.before_contract)} →{" "}
                                {money(change.after_contract)}
                              </small>
                            </td>
                            <td>
                              <strong>{price(change.budget_delta)}</strong>
                              <small>
                                {money(change.before_budget)} →{" "}
                                {money(change.after_budget)}
                              </small>
                            </td>
                            <td>
                              {change.plan_id ? (
                                <>
                                  <strong>
                                    {number(change.quantity_delta, 3)}{" "}
                                    {plan?.unit || ""}
                                  </strong>
                                  <small>
                                    {plan?.activity ||
                                      `Work item #${change.plan_id}`}
                                  </small>
                                  <small>
                                    {number(change.before_quantity, 3)} →{" "}
                                    {number(change.after_quantity, 3)}{" "}
                                    {plan?.unit || ""}
                                  </small>
                                </>
                              ) : (
                                <small>No quantity revision</small>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {dialog && (
        <Modal title={titles[dialog]} onClose={close}>
          <form className="erp-stack" onSubmit={save}>
            {formError && (
              <div className="erp-alert" role="alert">
                {formError}
              </div>
            )}
            <fieldset className="erp-form-fields" disabled={saving}>
              {dialog === "vendor" ? (
                <div className="erp-form-grid">
                  <Field label="Supplier name" wide>
                    <input
                      required
                      maxLength={200}
                      value={form.name}
                      onChange={(event) => setValue("name", event.target.value)}
                    />
                  </Field>
                  <Field label="Email">
                    <input
                      type="email"
                      maxLength={200}
                      value={form.email}
                      onChange={(event) =>
                        setValue("email", event.target.value)
                      }
                    />
                  </Field>
                  <Field label="Phone">
                    <input
                      type="tel"
                      maxLength={80}
                      value={form.phone}
                      onChange={(event) =>
                        setValue("phone", event.target.value)
                      }
                    />
                  </Field>
                </div>
              ) : dialog === "item" ? (
                <div className="erp-form-grid">
                  <Field label="Material description" wide>
                    <input
                      required
                      maxLength={200}
                      placeholder="e.g. 18-inch reinforced concrete pipe"
                      value={form.description}
                      onChange={(event) =>
                        setValue("description", event.target.value)
                      }
                    />
                  </Field>
                  <Field label="Unit of measure">
                    <input
                      required
                      maxLength={20}
                      placeholder="e.g. LF, CY, ton, each"
                      value={form.unit}
                      onChange={(event) => setValue("unit", event.target.value)}
                    />
                  </Field>
                </div>
              ) : dialog === "order" ? (
                <>
                  <div className="erp-form-grid">
                    <Field label="Project">
                      <select
                        required
                        value={form.jobsite_id}
                        onChange={(event) =>
                          setValue("jobsite_id", event.target.value)
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
                    <Field label="Supplier">
                      <select
                        required
                        value={form.vendor_id}
                        onChange={(event) =>
                          setValue("vendor_id", event.target.value)
                        }
                      >
                        <option value="">Select a supplier</option>
                        {data.vendors.map((vendor) => (
                          <option key={vendor.id} value={vendor.id}>
                            {vendor.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Order date">
                      <input
                        required
                        type="date"
                        value={form.order_date}
                        onChange={(event) =>
                          setValue("order_date", event.target.value)
                        }
                      />
                    </Field>
                    <Field label="Expected delivery">
                      <input
                        type="date"
                        min={form.order_date}
                        value={form.expected_date}
                        onChange={(event) =>
                          setValue("expected_date", event.target.value)
                        }
                      />
                    </Field>
                    <Field label="Order description" wide>
                      <input
                        maxLength={2000}
                        placeholder="e.g. Phase 2 storm drainage materials"
                        value={form.description}
                        onChange={(event) =>
                          setValue("description", event.target.value)
                        }
                      />
                    </Field>
                  </div>
                  {draftLines.map((line, index) => (
                    <fieldset className="erp-production-line" key={line.key}>
                      <legend>Material line {index + 1}</legend>
                      <div className="erp-form-grid">
                        <Field label="Catalog material" wide>
                          <select
                            value={line.item_id}
                            onChange={(event) =>
                              selectItem(line.key, event.target.value)
                            }
                          >
                            <option value="">Enter a custom material</option>
                            {data.items.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.description} · {item.unit}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Description" wide>
                          <input
                            required
                            maxLength={200}
                            readOnly={Boolean(line.item_id)}
                            value={line.description}
                            onChange={(event) =>
                              updateLine(line.key, {
                                description: event.target.value,
                              })
                            }
                          />
                        </Field>
                        <Field label="Unit">
                          <input
                            required
                            maxLength={20}
                            readOnly={Boolean(line.item_id)}
                            value={line.unit}
                            placeholder="LF, CY, ton, each"
                            onChange={(event) =>
                              updateLine(line.key, { unit: event.target.value })
                            }
                          />
                        </Field>
                        <Field label="Cost code">
                          <input
                            required
                            maxLength={80}
                            placeholder="e.g. 4200-STORM"
                            value={line.cost_code}
                            onChange={(event) =>
                              updateLine(line.key, {
                                cost_code: event.target.value,
                              })
                            }
                          />
                        </Field>
                        <Field label="Ordered quantity">
                          <input
                            required
                            type="number"
                            min="0.000001"
                            step="0.000001"
                            value={line.quantity}
                            onChange={(event) =>
                              updateLine(line.key, {
                                quantity: event.target.value,
                              })
                            }
                          />
                        </Field>
                        <Field label="Unit price ($)">
                          <input
                            required
                            type="number"
                            min="0"
                            step="0.01"
                            value={line.unit_price}
                            onChange={(event) =>
                              updateLine(line.key, {
                                unit_price: event.target.value,
                              })
                            }
                          />
                        </Field>
                      </div>
                      <div
                        className="erp-row"
                        style={{
                          justifyContent: "space-between",
                          marginTop: 12,
                        }}
                      >
                        <span className="erp-muted">
                          Line value{" "}
                          {price(
                            extension(
                              Number(line.quantity) || 0,
                              Number(line.unit_price) || 0,
                            ),
                          )}
                        </span>
                        {draftLines.length > 1 && (
                          <button
                            type="button"
                            className="erp-button small"
                            onClick={() =>
                              setDraftLines((previous) =>
                                previous.filter(
                                  (item) => item.key !== line.key,
                                ),
                              )
                            }
                          >
                            Remove line {index + 1}
                          </button>
                        )}
                      </div>
                    </fieldset>
                  ))}
                  <div
                    className="erp-row"
                    style={{
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                    }}
                  >
                    <button
                      type="button"
                      className="erp-button"
                      onClick={() =>
                        setDraftLines((previous) => [
                          ...previous,
                          emptyLine(
                            Math.max(...previous.map((line) => line.key), 0) +
                              1,
                          ),
                        ])
                      }
                    >
                      Add material line
                    </button>
                    <strong>Total order {price(draftAmount)}</strong>
                  </div>
                  <p className="erp-muted">
                    Saved as a draft. Approval creates the commitment; delivery
                    and job consumption are recorded separately.
                  </p>
                </>
              ) : dialog === "receive" || dialog === "invoice" ? (
                <>
                  <div className="erp-form-grid">
                    <Field label="Approved item order" wide>
                      <select
                        required
                        value={form.order_id}
                        onChange={(event) => {
                          setValue("order_id", event.target.value);
                          setQuantities({});
                        }}
                      >
                        <option value="">Select an order</option>
                        {(dialog === "receive" ? receivable : invoiceable).map(
                          (order) => (
                            <option key={order.id} value={order.id}>
                              {orderNumber(order.id)} · {order.vendor} ·{" "}
                              {order.jobsite_name}
                            </option>
                          ),
                        )}
                      </select>
                    </Field>
                    <Field
                      label={
                        dialog === "receive" ? "Delivery date" : "Invoice date"
                      }
                    >
                      <input
                        required
                        type="date"
                        min={selectedOrder?.order_date}
                        value={form.date}
                        onChange={(event) =>
                          setValue("date", event.target.value)
                        }
                      />
                    </Field>
                    <Field
                      label={
                        dialog === "receive"
                          ? "Delivery ticket / reference"
                          : "Supplier invoice number"
                      }
                    >
                      <input
                        required
                        maxLength={200}
                        value={form.reference}
                        onChange={(event) =>
                          setValue("reference", event.target.value)
                        }
                      />
                    </Field>
                  </div>
                  {selectedOrder && (
                    <div className="erp-stack" style={{ marginTop: 16 }}>
                      {selectedOrder.lines
                        .filter((line) =>
                          hasQty(
                            dialog === "receive"
                              ? line.quantity - line.received_qty
                              : line.received_qty - line.invoiced_qty,
                          ),
                        )
                        .map((line) => {
                          const remaining =
                            dialog === "receive"
                              ? line.quantity - line.received_qty
                              : line.received_qty - line.invoiced_qty;
                          return (
                            <fieldset
                              className="erp-production-line"
                              key={line.id}
                            >
                              <legend>{line.description}</legend>
                              <div className="erp-form-grid">
                                <Field
                                  label={`${dialog === "receive" ? "Receive now" : "Invoice now"} (${line.unit})`}
                                >
                                  <input
                                    aria-label={`${dialog === "receive" ? "Receive" : "Invoice"} quantity for ${line.description}`}
                                    type="number"
                                    min="0"
                                    max={remaining}
                                    step="0.000001"
                                    placeholder="0"
                                    value={quantities[line.id] || ""}
                                    onChange={(event) =>
                                      setQuantities((previous) => ({
                                        ...previous,
                                        [line.id]: event.target.value,
                                      }))
                                    }
                                  />
                                </Field>
                                <div className="erp-muted">
                                  <strong>
                                    {number(remaining, 3)} {line.unit}{" "}
                                    {dialog === "receive"
                                      ? "still due"
                                      : "received and not yet invoiced"}
                                  </strong>
                                  <p>
                                    Ordered {number(line.quantity, 3)} ·
                                    received {number(line.received_qty, 3)}
                                    {dialog === "invoice"
                                      ? ` · invoiced ${number(line.invoiced_qty, 3)}`
                                      : ""}
                                  </p>
                                  <span>
                                    {price(line.unit_price)} / {line.unit} ·{" "}
                                    {line.cost_code}
                                  </span>
                                </div>
                              </div>
                            </fieldset>
                          );
                        })}
                    </div>
                  )}
                  <p className="erp-muted">
                    {dialog === "receive"
                      ? "Enter only quantities delivered on this ticket. Leave other lines blank. Stock is reserved to this project and receiving posts no job expense."
                      : "Enter only quantities on this invoice. Prices match the approved order, and previously invoiced quantities cannot be invoiced again."}
                  </p>
                  {dialog === "invoice" && (
                    <strong>Invoice value {price(invoiceAmount)}</strong>
                  )}
                </>
              ) : dialog === "issue" ? (
                <>
                  <div className="erp-form-grid">
                    <Field label="Available project stock" wide>
                      <select
                        required
                        value={form.line_id}
                        onChange={(event) => {
                          const owner = stock.find(
                            ({ line }) =>
                              line.id === Number(event.target.value),
                          );
                          setForm((previous) => ({
                            ...previous,
                            line_id: event.target.value,
                            jobsite_id: String(owner?.order.jobsite_id ?? ""),
                            quantity: "",
                          }));
                        }}
                      >
                        <option value="">Select material</option>
                        {stock.map(({ order, line }) => (
                          <option key={line.id} value={line.id}>
                            {line.description} · {order.jobsite_name} ·{" "}
                            {number(line.available_qty, 3)} {line.unit}{" "}
                            available
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Project">
                      <input
                        readOnly
                        value={selectedStock?.order.jobsite_name || ""}
                      />
                    </Field>
                    <Field label="Issue date">
                      <input
                        required
                        type="date"
                        value={form.date}
                        onChange={(event) =>
                          setValue("date", event.target.value)
                        }
                      />
                    </Field>
                    <Field
                      label={`Quantity consumed (${selectedStock?.line.unit || "units"})`}
                    >
                      <input
                        required
                        type="number"
                        min="0.000001"
                        max={selectedStock?.line.available_qty || undefined}
                        step="0.000001"
                        value={form.quantity}
                        onChange={(event) =>
                          setValue("quantity", event.target.value)
                        }
                      />
                    </Field>
                    <Field label="Issue ticket / reference">
                      <input
                        required
                        maxLength={200}
                        placeholder="e.g. Foreman ticket 107"
                        value={form.reference}
                        onChange={(event) =>
                          setValue("reference", event.target.value)
                        }
                      />
                    </Field>
                  </div>
                  {selectedStock && (
                    <p className="erp-muted">
                      {number(selectedStock.line.available_qty, 3)}{" "}
                      {selectedStock.line.unit} available on{" "}
                      {orderNumber(selectedStock.order.id)}. This issue posts{" "}
                      {price(
                        incrementalValue(
                          selectedStock.line,
                          Number(form.quantity) || 0,
                          "issue",
                        ),
                      )}{" "}
                      to {selectedStock.line.cost_code} on{" "}
                      {selectedStock.order.jobsite_name}. Record only material
                      actually consumed.
                    </p>
                  )}
                </>
              ) : dialog === "payment" ? (
                <>
                  <div className="erp-form-grid">
                    <Field label="Supplier invoice" wide>
                      <input
                        readOnly
                        value={
                          selectedInvoice
                            ? `${selectedInvoice.reference} · ${selectedInvoice.vendor_name}`
                            : ""
                        }
                      />
                    </Field>
                    <Field label="Payment amount ($)">
                      <input
                        required
                        type="number"
                        min="0.01"
                        max={selectedInvoice?.open_amount || undefined}
                        step="0.01"
                        value={form.amount}
                        onChange={(event) =>
                          setValue("amount", event.target.value)
                        }
                      />
                    </Field>
                    <Field label="Payment date">
                      <input
                        required
                        type="date"
                        min={selectedInvoice?.date}
                        value={form.date}
                        onChange={(event) =>
                          setValue("date", event.target.value)
                        }
                      />
                    </Field>
                    <Field label="Check / transfer reference" wide>
                      <input
                        required
                        maxLength={200}
                        value={form.reference}
                        onChange={(event) =>
                          setValue("reference", event.target.value)
                        }
                      />
                    </Field>
                  </div>
                  <p className="erp-muted">
                    {price(selectedInvoice?.open_amount || 0)} remains payable.
                    A partial payment reduces the balance and keeps the
                    remaining amount open.
                  </p>
                </>
              ) : (
                <>
                  <div className="erp-form-grid">
                    <Field label="Unapproved change request" wide>
                      <select
                        required
                        value={form.control_id}
                        onChange={(event) => {
                          const control = pendingChanges.find(
                            (item) => item.id === Number(event.target.value),
                          );
                          setForm((previous) => ({
                            ...previous,
                            control_id: event.target.value,
                            jobsite_id: String(control?.jobsite_id ?? ""),
                            contract_delta: String(control?.amount ?? 0),
                            budget_delta: "0",
                            plan_id: "",
                            quantity_delta: "",
                          }));
                        }}
                      >
                        <option value="">Select a change request</option>
                        {pendingChanges.map((control) => (
                          <option key={control.id} value={control.id}>
                            {control.title} ·{" "}
                            {
                              erp.projects.find(
                                (job) => job.id === control.jobsite_id,
                              )?.name
                            }
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Signed customer approval reference" wide>
                      <input
                        required
                        maxLength={200}
                        placeholder="e.g. Executed CO-004 / customer approval 2026-10-02"
                        value={form.customer_reference}
                        onChange={(event) =>
                          setValue("customer_reference", event.target.value)
                        }
                      />
                    </Field>
                    <Field label="Effective date">
                      <input
                        required
                        type="date"
                        value={form.effective_date}
                        onChange={(event) =>
                          setValue("effective_date", event.target.value)
                        }
                      />
                    </Field>
                    <Field label="Contract adjustment ($)">
                      <input
                        required
                        type="number"
                        step="0.01"
                        value={form.contract_delta}
                        onChange={(event) =>
                          setValue("contract_delta", event.target.value)
                        }
                      />
                    </Field>
                    <Field label="Job budget adjustment ($)">
                      <input
                        required
                        type="number"
                        step="0.01"
                        value={form.budget_delta}
                        onChange={(event) =>
                          setValue("budget_delta", event.target.value)
                        }
                      />
                    </Field>
                    <Field label="Affected work item (optional)">
                      <select
                        value={form.plan_id}
                        onChange={(event) =>
                          setForm((previous) => ({
                            ...previous,
                            plan_id: event.target.value,
                            quantity_delta: "",
                          }))
                        }
                      >
                        <option value="">No work-item revision</option>
                        {changePlans.map((plan) => (
                          <option key={plan.id} value={plan.id}>
                            {plan.activity} · {plan.cost_code} · {plan.unit}
                          </option>
                        ))}
                      </select>
                    </Field>
                    {form.plan_id && (
                      <Field
                        label={`Quantity adjustment (${selectedPlan?.unit || "units"})`}
                      >
                        <input
                          required
                          type="number"
                          min={
                            selectedPlan
                              ? selectedPlan.actual_qty -
                                selectedPlan.planned_qty
                              : undefined
                          }
                          step="0.000001"
                          value={form.quantity_delta}
                          onChange={(event) =>
                            setValue("quantity_delta", event.target.value)
                          }
                        />
                      </Field>
                    )}
                  </div>
                  <p className="erp-muted">
                    Use positive values for added scope and negative values for
                    reductions. Enter the customer reference from the signed
                    approval before applying the revised baseline. Selecting a
                    work item also applies the budget adjustment to that item.
                  </p>
                  {selectedProject && (
                    <div className="erp-card-note">
                      <strong>{selectedProject.name}</strong>
                      <p>
                        Contract {money(selectedProject.contract_value)} →{" "}
                        {money(
                          selectedProject.contract_value +
                            (Number(form.contract_delta) || 0),
                        )}
                        <br />
                        Job budget {money(selectedProject.budget)} →{" "}
                        {money(
                          selectedProject.budget +
                            (Number(form.budget_delta) || 0),
                        )}
                        {selectedPlan && (
                          <>
                            <br />
                            {selectedPlan.activity}:{" "}
                            {number(selectedPlan.planned_qty, 3)} →{" "}
                            {number(
                              selectedPlan.planned_qty +
                                (Number(form.quantity_delta) || 0),
                              3,
                            )}{" "}
                            {selectedPlan.unit}
                            <br />
                            Work-item budget {money(selectedPlan.budget)} →{" "}
                            {money(
                              selectedPlan.budget +
                                (Number(form.budget_delta) || 0),
                            )}
                          </>
                        )}
                      </p>
                    </div>
                  )}
                </>
              )}
            </fieldset>
            <div className="erp-form-actions">
              <button
                type="button"
                className="erp-button"
                disabled={saving}
                onClick={close}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="erp-button primary"
                disabled={saving}
              >
                {saving
                  ? "Saving…"
                  : dialog === "order"
                    ? "Create draft order"
                    : dialog === "receive"
                      ? "Record delivery"
                      : dialog === "issue"
                        ? "Issue & post job cost"
                        : dialog === "change"
                          ? "Approve & revise baseline"
                          : dialog === "payment"
                            ? "Record payment"
                            : dialog === "invoice"
                              ? "Record invoice"
                              : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
