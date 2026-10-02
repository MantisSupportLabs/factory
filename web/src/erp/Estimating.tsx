import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { api } from "../api/client";
import { type ERPData, number, today } from "./types";
import { Badge, Empty, Field, Modal, SectionHead } from "./ui";
import { useCanEdit } from "./permissions";
import "./Estimating.css";

type Category = "labor" | "equipment" | "material" | "subcontract" | "other";
type TakeoffMethod = "manual" | "length" | "area" | "volume" | "count";
interface Takeoff {
  method: TakeoffMethod;
  source_reference: string;
  length_ft?: number;
  width_ft?: number;
  depth_ft?: number;
  count?: number;
}
interface Resource {
  category: Category;
  description: string;
  resource_unit: string;
  usage_per_unit: number;
  unit_rate: number;
  waste_pct: number;
  quote_reference: string;
  quote_vendor: string;
  quote_valid_until: string | null;
  cost_cents?: number;
}
interface ScopeLine {
  cost_code: string;
  phase: string;
  description: string;
  unit: string;
  quantity: number;
  takeoff: Takeoff;
  components: Resource[];
  direct_cost_cents?: number;
  overhead_cents?: number;
  contingency_cents?: number;
  budget_cents?: number;
  markup_cents?: number;
  sell_cents?: number;
  labor_hours?: number;
  equipment_hours?: number;
}
interface Totals {
  direct_cost_cents: number;
  overhead_cents: number;
  contingency_cents: number;
  cost_total_cents: number;
  markup_cents: number;
  bid_total_cents: number;
  labor_hours: number;
  equipment_hours: number;
}
interface Estimate {
  id: number;
  family_id: number;
  revision: number;
  edit_version: number;
  bid_code: string;
  client: string;
  title: string;
  due_date: string | null;
  valid_until: string;
  assumptions: string;
  exclusions: string;
  currency: "USD";
  overhead_pct: number;
  contingency_pct: number;
  markup_pct: number;
  lines: ScopeLine[];
  status: "draft" | "approved";
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  approved_by: string | null;
  approval_date: string | null;
  totals: Totals;
}
interface Handover {
  id: number;
  family_id: number;
  estimate_id: number;
  jobsite_id: number;
  baseline_id: number;
  award_reference: string;
  award_date: string;
  project_code: string;
  project_name: string;
}
interface EstimatingData {
  estimates: Estimate[];
  handovers: Handover[];
}
const categories: Category[] = [
  "labor",
  "equipment",
  "material",
  "subcontract",
  "other",
];
const units = ["LF", "SF", "SY", "CY", "EA", "TON", "LS"];
const cash = (amount: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
const rateMoney = (amount: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(amount);
const cents = (amount: number | undefined) =>
  amount == null ? "—" : cash(amount / 100);
const failureMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Unable to save this estimate";
const str = (form: FormData, field: string) =>
  String(form.get(field) ?? "").trim();
const numeric = (form: FormData, field: string) => Number(str(form, field));
const cleanResource = (resource: Resource): Resource => ({
  category: resource.category,
  description: resource.description,
  resource_unit: resource.resource_unit,
  usage_per_unit: resource.usage_per_unit,
  unit_rate: resource.unit_rate,
  waste_pct: resource.waste_pct,
  quote_reference: resource.quote_reference,
  quote_vendor: resource.quote_vendor,
  quote_valid_until: resource.quote_valid_until,
});
const cleanLine = (line: ScopeLine): ScopeLine => ({
  cost_code: line.cost_code,
  phase: line.phase,
  description: line.description,
  unit: line.unit,
  quantity: line.quantity,
  takeoff: { ...line.takeoff },
  components: line.components.map(cleanResource),
});
function freshResource(category: Category = "labor"): Resource {
  return {
    category,
    description: "",
    resource_unit:
      category === "labor" || category === "equipment" ? "HRS" : "EA",
    usage_per_unit: 1,
    unit_rate: 0,
    waste_pct: 0,
    quote_reference: "",
    quote_vendor: "",
    quote_valid_until: null,
  };
}
function takeoffQuantity(line: ScopeLine): number {
  const t = line.takeoff,
    count = t.count ?? 1;
  if (t.method === "manual") return line.quantity;
  if (t.method === "count") return count;
  if (t.method === "length") return (t.length_ft ?? 0) * count;
  const area = (t.length_ft ?? 0) * (t.width_ft ?? 0) * count;
  if (t.method === "area") return area / (line.unit === "SY" ? 9 : 1);
  return (area * (t.depth_ft ?? 0)) / 27;
}
function quoteExpired(resource: Resource): boolean {
  return (
    !!resource.quote_reference &&
    !!resource.quote_valid_until &&
    resource.quote_valid_until < today()
  );
}
function takeoffSummary(line: ScopeLine): string {
  const t = line.takeoff,
    count = t.count ?? 1;
  if (t.method === "manual")
    return `Entered quantity${t.source_reference ? ` · ${t.source_reference}` : ""}`;
  if (t.method === "count")
    return `${number(count)} counted items · ${t.source_reference}`;
  const dimensions = [
    t.length_ft,
    ...(t.method === "length" ? [] : [t.width_ft]),
    ...(t.method === "volume" ? [t.depth_ft] : []),
  ]
    .map((v) => `${number(v, 3)} ft`)
    .join(" × ");
  return `${dimensions} × ${number(count)}${t.method === "volume" ? " ÷ 27" : line.unit === "SY" ? " ÷ 9" : ""} · ${t.source_reference}`;
}
function exportEstimate(estimate: Estimate): void {
  const rows: Array<Array<string | number>> = [
    [
      "Estimate",
      estimate.bid_code,
      "Revision",
      estimate.revision,
      "Status",
      estimate.status,
    ],
    ["Client", estimate.client, "Title", estimate.title],
    ["Valid through", estimate.valid_until, "Bid due", estimate.due_date ?? ""],
    [
      "Direct cost",
      estimate.totals.direct_cost_cents / 100,
      "Overhead % of direct cost",
      estimate.overhead_pct,
    ],
    [
      "Overhead",
      estimate.totals.overhead_cents / 100,
      "Contingency % of direct cost + overhead",
      estimate.contingency_pct,
    ],
    [
      "Contingency",
      estimate.totals.contingency_cents / 100,
      "Markup % of cost budget",
      estimate.markup_pct,
    ],
    [
      "Total cost budget",
      estimate.totals.cost_total_cents / 100,
      "Markup",
      estimate.totals.markup_cents / 100,
    ],
    [
      "Bid total",
      estimate.totals.bid_total_cents / 100,
      "Labor hours",
      estimate.totals.labor_hours,
      "Equipment hours",
      estimate.totals.equipment_hours,
    ],
    ["Assumptions", estimate.assumptions],
    ["Exclusions", estimate.exclusions],
    [],
    [
      "Code",
      "Phase",
      "Scope",
      "Installed unit",
      "Installed quantity",
      "Takeoff basis",
      "Direct cost",
      "Cost budget",
      "Sell value",
      "Labor hours",
      "Equipment hours",
    ],
    ...estimate.lines.map((line) => [
      line.cost_code,
      line.phase,
      line.description,
      line.unit,
      line.quantity,
      takeoffSummary(line),
      (line.direct_cost_cents ?? 0) / 100,
      (line.budget_cents ?? 0) / 100,
      (line.sell_cents ?? 0) / 100,
      line.labor_hours ?? 0,
      line.equipment_hours ?? 0,
    ]),
    [],
    [
      "Code",
      "Resource category",
      "Resource",
      "Resource unit",
      "Usage per installed unit",
      "Unit rate",
      "Waste %",
      "Cost",
      "Quote reference",
      "Vendor",
      "Quote valid through",
    ],
    ...estimate.lines.flatMap((line) =>
      line.components.map((resource) => [
        line.cost_code,
        resource.category,
        resource.description,
        resource.resource_unit,
        resource.usage_per_unit,
        resource.unit_rate,
        resource.waste_pct,
        (resource.cost_cents ?? 0) / 100,
        resource.quote_reference,
        resource.quote_vendor,
        resource.quote_valid_until ?? "",
      ]),
    ),
  ];
  const quote = (value: string | number) => {
    let text = String(value);
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(text))
      text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const url = URL.createObjectURL(
    new Blob(
      ["\uFEFF", rows.map((row) => row.map(quote).join(",")).join("\r\n")],
      { type: "text/csv;charset=utf-8" },
    ),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${estimate.bid_code.replace(/[^a-zA-Z0-9_-]/g, "_")}-rev-${estimate.revision}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Editor({
  title,
  onClose,
  save,
  children,
  submit = "Save draft",
}: {
  title: string;
  onClose: () => void;
  save: (form: FormData) => Promise<void>;
  children: ReactNode;
  submit?: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await save(new FormData(event.currentTarget));
      onClose();
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form onSubmit={send}>
        <fieldset className="erp-form-fields" disabled={busy}>
          {children}
        </fieldset>
        {error && (
          <div className="erp-alert error" role="alert">
            {error}
          </div>
        )}
        <div className="erp-form-actions">
          <button
            type="button"
            className="erp-button"
            disabled={busy}
            onClick={onClose}
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
function Input({
  label,
  name,
  value = "",
  type = "text",
  required = true,
  min,
  max,
  step = "any",
  disabled = false,
}: {
  label: string;
  name: string;
  value?: string | number;
  type?: string;
  required?: boolean;
  min?: number | string;
  max?: number | string;
  step?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label}>
      <input
        name={name}
        defaultValue={value}
        type={type}
        required={required}
        min={min}
        max={max}
        step={type === "number" ? step : undefined}
        disabled={disabled}
      />
    </Field>
  );
}
function HeaderEditor({
  estimate,
  save,
  onClose,
}: {
  estimate: Estimate | null;
  save: (body: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <Editor
      title={
        estimate
          ? `Edit ${estimate.bid_code} · revision ${estimate.revision}`
          : "Create bid estimate"
      }
      onClose={onClose}
      save={async (form) => {
        const body: Record<string, unknown> = {
          title: str(form, "title"),
          client: str(form, "client"),
          due_date: str(form, "due_date") || null,
          valid_until: str(form, "valid_until"),
          assumptions: str(form, "assumptions"),
          exclusions: str(form, "exclusions"),
          overhead_pct: numeric(form, "overhead_pct"),
          contingency_pct: numeric(form, "contingency_pct"),
          markup_pct: numeric(form, "markup_pct"),
        };
        if (!estimate)
          Object.assign(body, {
            bid_code: str(form, "bid_code"),
            currency: "USD",
            lines: [],
          });
        await save(body);
      }}
    >
      <div className="erp-form-grid">
        <Input
          label="Bid code"
          name="bid_code"
          value={estimate?.bid_code}
          disabled={!!estimate}
        />
        <Input label="Client / owner" name="client" value={estimate?.client} />
        <Field label="Estimate title" wide>
          <input name="title" defaultValue={estimate?.title} required />
        </Field>
        <Input
          label="Bid due date"
          name="due_date"
          value={estimate?.due_date ?? ""}
          type="date"
          required={false}
        />
        <Input
          label="Estimate valid through"
          name="valid_until"
          value={estimate?.valid_until ?? ""}
          type="date"
          min={today()}
        />
        <Input
          label="Overhead (% of direct cost)"
          name="overhead_pct"
          type="number"
          value={estimate?.overhead_pct ?? 0}
          min={0}
          max={100}
        />
        <Input
          label="Contingency (% of direct cost + overhead)"
          name="contingency_pct"
          type="number"
          value={estimate?.contingency_pct ?? 0}
          min={0}
          max={100}
        />
        <Input
          label="Markup (% of cost budget)"
          name="markup_pct"
          type="number"
          value={estimate?.markup_pct ?? 0}
          min={0}
          max={500}
        />
        <Field label="Currency">
          <input value="USD" readOnly aria-label="Currency" />
        </Field>
        <Field label="Scope assumptions" wide>
          <textarea
            name="assumptions"
            defaultValue={estimate?.assumptions}
            rows={3}
            placeholder="Access, sequencing, soil conditions, haul distance, expected production…"
          />
        </Field>
        <Field label="Scope exclusions" wide>
          <textarea
            name="exclusions"
            defaultValue={estimate?.exclusions}
            rows={3}
            placeholder="Owner-supplied materials, permits, unsuitable material, utility relocations…"
          />
        </Field>
      </div>
      <p className="erp-muted">
        Build each cost code from installed quantities and resource assumptions.
        Overhead and contingency form the cost budget; markup determines the bid
        price.
      </p>
    </Editor>
  );
}
function LineEditor({
  line: original,
  save,
  onClose,
}: {
  line: ScopeLine | null;
  save: (line: ScopeLine) => Promise<void>;
  onClose: () => void;
}) {
  const [line, setLine] = useState<ScopeLine>(() =>
    original
      ? cleanLine(original)
      : {
          cost_code: "",
          phase: "",
          description: "",
          unit: "CY",
          quantity: 1,
          takeoff: { method: "manual", source_reference: "", count: 1 },
          components: [freshResource()],
        },
  );
  const [resourceKeys, setResourceKeys] = useState(() =>
    line.components.map(() => crypto.randomUUID()),
  );
  const update = (changes: Partial<ScopeLine>) =>
    setLine((current) => ({ ...current, ...changes }));
  const updateTakeoff = (changes: Partial<Takeoff>) =>
    setLine((current) => ({
      ...current,
      takeoff: { ...current.takeoff, ...changes },
    }));
  const updateResource = (index: number, changes: Partial<Resource>) =>
    setLine((current) => ({
      ...current,
      components: current.components.map((resource, i) =>
        i === index ? { ...resource, ...changes } : resource,
      ),
    }));
  const method = line.takeoff.method,
    qty = takeoffQuantity(line);
  const geometry = method !== "manual";
  const preview = line.components.reduce(
    (sum, resource) =>
      sum +
      qty *
        resource.usage_per_unit *
        (1 + resource.waste_pct / 100) *
        resource.unit_rate,
    0,
  );
  const assembly = (kind: "earthwork" | "utilities" | "road") => {
    const preset =
      kind === "earthwork"
        ? {
            phase: "Earthwork",
            description: "Excavate and haul",
            unit: "CY",
            method: "volume" as const,
          }
        : kind === "utilities"
          ? {
              phase: "Utilities",
              description: "Install utility pipe",
              unit: "LF",
              method: "length" as const,
            }
          : {
              phase: "Roads",
              description: "Place road base",
              unit: "SY",
              method: "area" as const,
            };
    const resources = [
      freshResource("labor"),
      freshResource("equipment"),
      ...(kind === "earthwork" ? [] : [freshResource("material")]),
    ];
    update({
      phase: preset.phase,
      description: preset.description,
      unit: preset.unit,
      takeoff: { method: preset.method, source_reference: "", count: 1 },
      components: resources,
    });
    setResourceKeys(resources.map(() => crypto.randomUUID()));
  };
  const setMethod = (value: TakeoffMethod) => {
    const unit =
      value === "length"
        ? "LF"
        : value === "volume"
          ? "CY"
          : value === "count"
            ? "EA"
            : value === "area" && !["SF", "SY"].includes(line.unit)
              ? "SY"
              : line.unit;
    update({ unit, takeoff: { ...line.takeoff, method: value } });
  };
  return (
    <Editor
      title={
        original ? `Edit scope · ${original.cost_code}` : "Add estimate scope"
      }
      onClose={onClose}
      save={async () => {
        if (!(qty > 0) || !Number.isFinite(qty))
          throw new Error(
            "Enter a positive installed quantity or complete the takeoff dimensions.",
          );
        if (!line.components.length)
          throw new Error("Add at least one resource assumption.");
        await save({ ...cleanLine(line), quantity: qty });
      }}
      submit="Save scope line"
    >
      {!original && (
        <>
          <p className="erp-muted">
            Start with a civil scope structure, then enter your dimensions,
            usage and rates.
          </p>
          <div className="erp-estimate-assembly">
            <button
              type="button"
              className="erp-button small"
              onClick={() => assembly("earthwork")}
            >
              Earthwork structure
            </button>
            <button
              type="button"
              className="erp-button small"
              onClick={() => assembly("utilities")}
            >
              Utility structure
            </button>
            <button
              type="button"
              className="erp-button small"
              onClick={() => assembly("road")}
            >
              Road base structure
            </button>
          </div>
        </>
      )}
      <div className="erp-form-grid">
        <Field label="Unique cost code">
          <input
            required
            value={line.cost_code}
            onChange={(e) => update({ cost_code: e.target.value })}
            placeholder="UTIL-01"
          />
        </Field>
        <Field label="Phase / trade">
          <input
            required
            value={line.phase}
            onChange={(e) => update({ phase: e.target.value })}
            placeholder="Utilities"
          />
        </Field>
        <Field label="Scope description" wide>
          <input
            required
            value={line.description}
            onChange={(e) => update({ description: e.target.value })}
          />
        </Field>
        <Field label="Quantity basis">
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as TakeoffMethod)}
          >
            <option value="manual">Entered quantity</option>
            <option value="length">Measured length</option>
            <option value="area">Measured area</option>
            <option value="volume">Measured volume</option>
            <option value="count">Item count</option>
          </select>
        </Field>
        <Field label="Installed unit">
          <select
            value={line.unit}
            onChange={(e) => update({ unit: e.target.value })}
          >
            {units
              .filter(
                (unit) =>
                  method === "manual" ||
                  (method === "length" && unit === "LF") ||
                  (method === "area" && ["SF", "SY"].includes(unit)) ||
                  (method === "volume" && unit === "CY") ||
                  (method === "count" && unit === "EA"),
              )
              .map((unit) => (
                <option key={unit}>{unit}</option>
              ))}
          </select>
        </Field>
        {method === "manual" && (
          <Field label={`Installed quantity (${line.unit})`}>
            <input
              type="number"
              step="any"
              required
              min="0.000001"
              value={line.quantity || ""}
              onChange={(e) => update({ quantity: Number(e.target.value) })}
            />
          </Field>
        )}
        {geometry && method !== "count" && (
          <Field label="Length (feet)">
            <input
              type="number"
              step="any"
              required
              min="0.000001"
              value={line.takeoff.length_ft ?? ""}
              onChange={(e) =>
                updateTakeoff({ length_ft: Number(e.target.value) })
              }
            />
          </Field>
        )}
        {["area", "volume"].includes(method) && (
          <Field label="Width (feet)">
            <input
              type="number"
              step="any"
              required
              min="0.000001"
              value={line.takeoff.width_ft ?? ""}
              onChange={(e) =>
                updateTakeoff({ width_ft: Number(e.target.value) })
              }
            />
          </Field>
        )}
        {method === "volume" && (
          <Field label="Depth (feet)">
            <input
              type="number"
              step="any"
              required
              min="0.000001"
              value={line.takeoff.depth_ft ?? ""}
              onChange={(e) =>
                updateTakeoff({ depth_ft: Number(e.target.value) })
              }
            />
          </Field>
        )}
        {geometry && (
          <Field label={method === "count" ? "Item count" : "Repeat count"}>
            <input
              type="number"
              step="1"
              min="1"
              max="1000000"
              required
              value={line.takeoff.count ?? 1}
              onChange={(e) => updateTakeoff({ count: Number(e.target.value) })}
            />
          </Field>
        )}
        <Field
          label={
            geometry
              ? "Drawing / takeoff reference"
              : "Quantity reference (required for approval)"
          }
          wide
        >
          <input
            value={line.takeoff.source_reference}
            required={geometry}
            onChange={(e) =>
              updateTakeoff({ source_reference: e.target.value })
            }
            placeholder="Drawing C-4, revision A, chainage 10+00 to 12+00"
          />
        </Field>
      </div>
      <div className="erp-estimate-takeoff">
        <strong>
          {number(qty, 6)} {line.unit}
        </strong>{" "}
        installed quantity
        {geometry && (
          <div>
            {method === "volume"
              ? "Feet × feet × feet ÷ 27 = cubic yards."
              : method === "area" && line.unit === "SY"
                ? "Feet × feet ÷ 9 = square yards."
                : method === "length"
                  ? "Length in feet × repeat count."
                  : method === "count"
                    ? "Count of discrete installed items."
                    : "Feet × feet = square feet."}
          </div>
        )}
      </div>
      <h3>Resource assumptions</h3>
      <p className="erp-muted">
        Usage is per one installed {line.unit}. Labor uses worker-hours and
        equipment uses machine-hours; materials retain their own units. Rates
        start at $0.00 and require your estimate.
      </p>
      <div className="erp-estimate-resources">
        {line.components.map((resource, index) => {
          const resourceQty =
            qty * resource.usage_per_unit * (1 + resource.waste_pct / 100);
          return (
            <div className="erp-estimate-resource" key={resourceKeys[index]}>
              <div className="erp-estimate-resource-head">
                <strong>Resource {index + 1}</strong>
                <button
                  type="button"
                  className="erp-text-button"
                  onClick={() => {
                    update({
                      components: line.components.filter((_, i) => i !== index),
                    });
                    setResourceKeys((current) =>
                      current.filter((_, i) => i !== index),
                    );
                  }}
                  aria-label={`Remove resource ${index + 1}`}
                >
                  Remove
                </button>
              </div>
              <div className="erp-form-grid">
                <Field label="Resource category">
                  <select
                    value={resource.category}
                    onChange={(e) => {
                      const category = e.target.value as Category;
                      updateResource(index, {
                        category,
                        resource_unit:
                          category === "labor" || category === "equipment"
                            ? "HRS"
                            : resource.resource_unit === "HRS"
                              ? "EA"
                              : resource.resource_unit,
                      });
                    }}
                  >
                    {categories.map((category) => (
                      <option key={category} value={category}>
                        {category[0].toUpperCase() + category.slice(1)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Resource description">
                  <input
                    required
                    value={resource.description}
                    onChange={(e) =>
                      updateResource(index, { description: e.target.value })
                    }
                    placeholder="Pipe crew / excavator / bedding stone"
                  />
                </Field>
                <Field
                  label={`${resource.category === "labor" ? "Worker-hours" : resource.category === "equipment" ? "Machine-hours" : "Usage"} per installed ${line.unit}`}
                >
                  <input
                    type="number"
                    min="0"
                    step="any"
                    required
                    value={resource.usage_per_unit}
                    onChange={(e) =>
                      updateResource(index, {
                        usage_per_unit: Number(e.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="Resource unit">
                  <input
                    required
                    value={resource.resource_unit}
                    readOnly={
                      resource.category === "labor" ||
                      resource.category === "equipment"
                    }
                    onChange={(e) =>
                      updateResource(index, { resource_unit: e.target.value })
                    }
                    placeholder="TON, EA, LF…"
                  />
                </Field>
                <Field
                  label={
                    resource.category === "labor"
                      ? "Rate ($ / worker-hour)"
                      : resource.category === "equipment"
                        ? "Rate ($ / machine-hour)"
                        : "Unit rate ($ / resource unit)"
                  }
                >
                  <input
                    type="number"
                    min="0"
                    step="0.000001"
                    required
                    value={resource.unit_rate}
                    onChange={(e) =>
                      updateResource(index, {
                        unit_rate: Number(e.target.value),
                      })
                    }
                  />
                </Field>
                <Field label="Waste / allowance (%)">
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="any"
                    required
                    value={resource.waste_pct}
                    onChange={(e) =>
                      updateResource(index, {
                        waste_pct: Number(e.target.value),
                      })
                    }
                  />
                </Field>
              </div>
              <div className="erp-estimate-quote">
                <Field label="Supplier quote reference (optional)">
                  <input
                    value={resource.quote_reference}
                    onChange={(e) =>
                      updateResource(index, { quote_reference: e.target.value })
                    }
                    placeholder="Quote 4182 rev 2"
                  />
                </Field>
                {resource.quote_reference.trim() && (
                  <div className="erp-form-grid" style={{ marginTop: 12 }}>
                    <Field label="Quoted vendor">
                      <input
                        required
                        value={resource.quote_vendor}
                        onChange={(e) =>
                          updateResource(index, {
                            quote_vendor: e.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field label="Quote valid through">
                      <input
                        required
                        type="date"
                        value={resource.quote_valid_until ?? ""}
                        onChange={(e) =>
                          updateResource(index, {
                            quote_valid_until: e.target.value || null,
                          })
                        }
                      />
                    </Field>
                  </div>
                )}
              </div>
              <p className="erp-muted">
                {number(resourceQty, 3)} {resource.resource_unit} ×{" "}
                {rateMoney(resource.unit_rate)} ={" "}
                <strong>{cash(resourceQty * resource.unit_rate)}</strong>
                {quoteExpired(resource)
                  ? " · Quote expired; update before approval."
                  : ""}
              </p>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="erp-button"
        onClick={() => {
          update({
            components: [...line.components, freshResource("material")],
          });
          setResourceKeys((current) => [...current, crypto.randomUUID()]);
        }}
      >
        + Add resource
      </button>
      <div className="erp-estimate-takeoff">
        Direct cost preview: <strong>{cash(preview)}</strong>
        <div>
          Saved totals include server rounding and allocation of estimate
          allowances.
        </div>
      </div>
    </Editor>
  );
}
function HandoverEditor({
  estimate,
  data,
  onClose,
  save,
}: {
  estimate: Estimate;
  data: ERPData;
  onClose: () => void;
  save: (body: Record<string, unknown>) => Promise<void>;
}) {
  const managers = data.people.filter(
    (person) => person.active && ["pm", "super"].includes(person.role),
  );
  return (
    <Editor
      title={`Award and hand over ${estimate.bid_code}`}
      onClose={onClose}
      submit="Create awarded project"
      save={async (form) => {
        if (str(form, "scope_confirmed") !== "yes")
          throw new Error(
            "Confirm that the signed award matches this estimate scope and price.",
          );
        await save({
          expected_edit_version: estimate.edit_version,
          award_reference: str(form, "award_reference"),
          award_date: str(form, "award_date"),
          name: str(form, "name"),
          code: str(form, "code"),
          pm_id: numeric(form, "pm_id"),
          start_date: str(form, "start_date"),
          end_date: str(form, "end_date"),
          address: str(form, "address"),
          lat: numeric(form, "lat"),
          lng: numeric(form, "lng"),
          superintendent: str(form, "superintendent"),
        });
      }}
    >
      <div className="erp-estimate-takeoff">
        Award contract:{" "}
        <strong>{cents(estimate.totals.bid_total_cents)}</strong>
        <br />
        Job cost budget:{" "}
        <strong>{cents(estimate.totals.cost_total_cents)}</strong>
      </div>
      <div className="erp-form-grid">
        <Input
          label="Signed award / contract reference"
          name="award_reference"
        />
        <Input
          label="Award date"
          name="award_date"
          type="date"
          value={today()}
          min={estimate.approval_date ?? undefined}
          max={estimate.valid_until < today() ? estimate.valid_until : today()}
        />
        <Input label="New project name" name="name" value={estimate.title} />
        <Input
          label="New project code"
          name="code"
          value={estimate.bid_code.replace(/^BID/i, "JOB")}
        />
        <Field label="Project manager">
          <select name="pm_id" required defaultValue="">
            <option value="" disabled>
              Select active PM / superintendent
            </option>
            {managers.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </Field>
        <Input
          label="Superintendent (optional)"
          name="superintendent"
          required={false}
        />
        <Input label="Planned start date" name="start_date" type="date" />
        <Input label="Planned finish date" name="end_date" type="date" />
        <Field label="Site address" wide>
          <input
            name="address"
            required
            placeholder="Site address or location description"
          />
        </Field>
        <Input
          label="Site latitude"
          name="lat"
          type="number"
          min={-90}
          max={90}
        />
        <Input
          label="Site longitude"
          name="lng"
          type="number"
          min={-180}
          max={180}
        />
      </div>
      {!managers.length && (
        <div className="erp-alert warning">
          Add an active project manager or superintendent in Workforce before
          handover.
        </div>
      )}
      <label className="erp-estimate-confirm">
        <input type="checkbox" name="scope_confirmed" value="yes" required />
        <span>
          I have checked the signed award against revision {estimate.revision},
          including scope, quantities, rates, exclusions and bid value.
        </span>
      </label>
      <p className="erp-muted">
        Creates a new planned project, work items, billing pay items and a draft
        baseline for review in Forecasts. The award creates planned quantities
        and budgets. Production, purchasing and job costs start through their
        own workflows.
      </p>
    </Editor>
  );
}
export function Estimating({
  data,
  refresh,
}: {
  data: ERPData;
  refresh: () => Promise<void>;
}) {
  const canPrepare = useCanEdit("pm", "accountant"),
    canApprove = useCanEdit("accountant"),
    canHandover = useCanEdit("pm");
  const [records, setRecords] = useState<EstimatingData>({
    estimates: [],
    handovers: [],
  });
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all");
  const [headerEditor, setHeaderEditor] = useState<{
    estimate: Estimate | null;
  } | null>(null);
  const [lineEditor, setLineEditor] = useState<{
    estimate: Estimate;
    index: number | null;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<{
    estimate: Estimate;
    action: "approve" | "revise" | "remove";
    index?: number;
  } | null>(null);
  const [handoverEditor, setHandoverEditor] = useState<Estimate | null>(null);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<EstimatingData>("/erp/estimating");
      setRecords(result);
      setError("");
      setSelectedId((current) =>
        current != null &&
        result.estimates.some((estimate) => estimate.id === current)
          ? current
          : (result.estimates[0]?.id ?? null),
      );
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const saved = async (result: Estimate | Handover, message: string) => {
    if ("bid_code" in result) setSelectedId(result.id);
    setSuccess(message);
    await reload();
    try {
      await refresh();
    } catch (failure) {
      setError(
        `Saved successfully, but the portfolio could not refresh: ${failureMessage(failure)}`,
      );
    }
  };
  const mutate = async <T extends Estimate | Handover>(
    action: () => Promise<T>,
    message: (result: T) => string,
  ) => {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await action();
      await saved(result, message(result));
    } finally {
      setBusy(false);
    }
  };
  const edit = async (
    estimate: Estimate,
    body: Record<string, unknown>,
    message: string,
  ) =>
    mutate(
      () =>
        api.patch<Estimate>(`/erp/estimates/${estimate.id}`, {
          expected_edit_version: estimate.edit_version,
          ...body,
        }),
      () => message,
    );
  const selected =
    records.estimates.find((estimate) => estimate.id === selectedId) ?? null;
  const latestByFamily = useMemo(() => {
    const result = new Map<number, Estimate>();
    for (const estimate of records.estimates) {
      if (estimate.revision > (result.get(estimate.family_id)?.revision ?? 0))
        result.set(estimate.family_id, estimate);
    }
    return result;
  }, [records.estimates]);
  const handoverByFamily = useMemo(
    () =>
      new Map(
        records.handovers.map((handover) => [handover.family_id, handover]),
      ),
    [records.handovers],
  );
  const latest = Array.from(latestByFamily.values());
  const awarded = (estimate: Estimate) =>
    handoverByFamily.get(estimate.family_id);
  const isLatest = (estimate: Estimate) =>
    latestByFamily.get(estimate.family_id)?.id === estimate.id;
  const currentBids = latest.filter((estimate) => !awarded(estimate));
  const filtered = records.estimates
    .filter((estimate) => {
      const matches =
        `${estimate.bid_code} ${estimate.title} ${estimate.client}`
          .toLowerCase()
          .includes(search.toLowerCase());
      const matchesStatus =
        filter === "all" ||
        (filter === "handed_over"
          ? !!awarded(estimate)
          : estimate.status === filter && !awarded(estimate));
      return matches && matchesStatus;
    })
    .sort((a, b) => b.id - a.id);
  const handover = selected ? awarded(selected) : undefined;
  const expiredQuotes =
    selected?.lines.flatMap((line) => line.components).filter(quoteExpired)
      .length ?? 0;
  const margin =
    selected && selected.totals.bid_total_cents > 0
      ? ((selected.totals.bid_total_cents - selected.totals.cost_total_cents) /
          selected.totals.bid_total_cents) *
        100
      : null;
  return (
    <div className="erp-estimating">
      <SectionHead
        title="Estimating & award handover"
        description="Build the civil scope, review resource assumptions, and carry an approved estimate into a new job."
        action={
          <div className="erp-inline-actions">
            <button
              type="button"
              className="erp-button"
              disabled={loading || busy}
              onClick={() => void reload()}
            >
              Refresh
            </button>
            {canPrepare && (
              <button
                type="button"
                className="erp-button primary"
                onClick={() => setHeaderEditor({ estimate: null })}
              >
                + New estimate
              </button>
            )}
          </div>
        }
      />
      {error && (
        <div className="erp-alert error" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="erp-alert success" role="status">
          {success}
        </div>
      )}
      <div className="erp-estimate-stats">
        <div className="erp-card erp-estimate-stat">
          <span>Draft bids</span>
          <strong>
            {
              currentBids.filter((estimate) => estimate.status === "draft")
                .length
            }
          </strong>
        </div>
        <div className="erp-card erp-estimate-stat">
          <span>Approved, ready for award</span>
          <strong>
            {
              currentBids.filter((estimate) => estimate.status === "approved")
                .length
            }
          </strong>
        </div>
        <div className="erp-card erp-estimate-stat">
          <span>Current bid pipeline</span>
          <strong>
            {cents(
              currentBids.reduce(
                (sum, estimate) => sum + estimate.totals.bid_total_cents,
                0,
              ),
            )}
          </strong>
        </div>
        <div className="erp-card erp-estimate-stat">
          <span>Awarded projects</span>
          <strong>{records.handovers.length}</strong>
        </div>
      </div>
      {!records.estimates.length ? (
        <div className="erp-card">
          <Empty>
            {loading
              ? "Loading estimating workspace…"
              : "Create your first estimate, add measured scope and resource rates, then approve a bid revision for award."}
          </Empty>
        </div>
      ) : (
        <div className="erp-estimate-layout">
          <div className="erp-card">
            <SectionHead
              title="Bid register"
              description="Current bids and retained revisions"
            />
            <div className="erp-estimate-filter">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search code, scope or client…"
                aria-label="Search estimates"
              />
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label="Estimate status"
              >
                <option value="all">All revisions</option>
                <option value="draft">Draft bids</option>
                <option value="approved">Approved bids</option>
                <option value="handed_over">Awarded bids</option>
              </select>
            </div>
            <div className="erp-estimate-picker">
              {filtered.map((estimate) => (
                <button
                  type="button"
                  className={`erp-estimate-choice${selectedId === estimate.id ? " active" : ""}`}
                  key={estimate.id}
                  onClick={() => setSelectedId(estimate.id)}
                  aria-pressed={selectedId === estimate.id}
                >
                  <strong>
                    {estimate.bid_code} · rev {estimate.revision}
                  </strong>
                  <small>
                    {estimate.title}
                    <br />
                    {estimate.client}
                  </small>
                  <div className="erp-estimate-choice-footer">
                    <Badge
                      tone={
                        awarded(estimate)
                          ? "success"
                          : estimate.status === "approved"
                            ? "info"
                            : "warning"
                      }
                    >
                      {awarded(estimate)?.estimate_id === estimate.id
                        ? "Awarded"
                        : estimate.status === "approved"
                          ? "Approved"
                          : "Draft"}
                    </Badge>
                    <span>{cents(estimate.totals.bid_total_cents)}</span>
                  </div>
                </button>
              ))}
              {!filtered.length && (
                <Empty>No estimates match this search.</Empty>
              )}
            </div>
          </div>
          {selected && (
            <div className="erp-estimate-detail">
              <div className="erp-card">
                <div className="erp-estimate-title">
                  <div className="erp-estimate-meta">
                    <Badge
                      tone={
                        handover
                          ? "success"
                          : selected.status === "approved"
                            ? "info"
                            : "warning"
                      }
                    >
                      {handover?.estimate_id === selected.id
                        ? "Awarded"
                        : selected.status === "approved"
                          ? "Approved"
                          : "Draft"}
                    </Badge>
                    <span className="erp-muted">
                      {selected.bid_code} · revision {selected.revision} · edit{" "}
                      {selected.edit_version}
                    </span>
                    {!isLatest(selected) && <Badge>Earlier revision</Badge>}
                  </div>
                  <h2>{selected.title}</h2>
                  <p>
                    {selected.client} ·{" "}
                    {selected.due_date ? `Bid due ${selected.due_date} · ` : ""}
                    Valid through {selected.valid_until}
                  </p>
                  <div className="erp-estimate-actions">
                    <button
                      type="button"
                      className="erp-button"
                      onClick={() => exportEstimate(selected)}
                    >
                      Export estimate CSV
                    </button>
                    {canPrepare && selected.status === "draft" && (
                      <button
                        type="button"
                        className="erp-button"
                        disabled={busy}
                        onClick={() => setHeaderEditor({ estimate: selected })}
                      >
                        Edit bid assumptions
                      </button>
                    )}
                    {canApprove &&
                      selected.status === "draft" &&
                      isLatest(selected) && (
                        <button
                          type="button"
                          className="erp-button primary"
                          disabled={busy || !selected.lines.length}
                          onClick={() =>
                            setConfirmation({
                              estimate: selected,
                              action: "approve",
                            })
                          }
                        >
                          Approve revision
                        </button>
                      )}
                    {canPrepare &&
                      selected.status === "approved" &&
                      isLatest(selected) &&
                      !handover && (
                        <button
                          type="button"
                          className="erp-button"
                          disabled={busy}
                          onClick={() =>
                            setConfirmation({
                              estimate: selected,
                              action: "revise",
                            })
                          }
                        >
                          Create new revision
                        </button>
                      )}
                    {canHandover &&
                      selected.status === "approved" &&
                      isLatest(selected) &&
                      !handover && (
                        <button
                          type="button"
                          className="erp-button primary"
                          disabled={busy}
                          onClick={() => setHandoverEditor(selected)}
                        >
                          Award & hand over
                        </button>
                      )}
                  </div>
                </div>
                {handover && (
                  <div className="erp-estimate-review">
                    <p>
                      <strong>
                        Project {handover.project_code} ·{" "}
                        {handover.project_name}
                      </strong>
                    </p>
                    <p>
                      Award {handover.award_reference} dated{" "}
                      {handover.award_date}
                      {handover.estimate_id !== selected.id
                        ? ` · awarded from revision ${records.estimates.find((estimate) => estimate.id === handover.estimate_id)?.revision ?? "—"}`
                        : ""}
                      . Open this project in Projects; review draft baseline #
                      {handover.baseline_id} in Forecasts and its pay items in
                      Billing.
                    </p>
                  </div>
                )}
                {selected.status === "approved" && (
                  <div className="erp-estimate-review">
                    <p>
                      Revision approved{" "}
                      {selected.approval_date ??
                        selected.approved_at?.slice(0, 10)}
                      {selected.approved_by
                        ? ` by ${selected.approved_by}`
                        : ""}
                      . Approved scope and rates are retained in this revision.
                    </p>
                  </div>
                )}
                {(selected.assumptions || selected.exclusions) && (
                  <div className="erp-estimate-notes">
                    {selected.assumptions && (
                      <>
                        <strong>Assumptions</strong>
                        <p>{selected.assumptions}</p>
                      </>
                    )}
                    {selected.exclusions && (
                      <>
                        <strong>Exclusions</strong>
                        <p>{selected.exclusions}</p>
                      </>
                    )}
                  </div>
                )}
              </div>
              {selected.valid_until < today() && !handover && (
                <div className="erp-alert warning">
                  This bid validity has expired. A new revision can update
                  validity. An approved bid can be handed over for a signed
                  award dated within its validity.
                </div>
              )}
              {expiredQuotes > 0 && !handover && (
                <div className="erp-alert warning">
                  {expiredQuotes} resource quote
                  {expiredQuotes === 1 ? " has" : "s have"} expired. Review
                  quote validity before approval or award.
                </div>
              )}
              <div className="erp-card">
                <SectionHead
                  title="Scope & takeoff"
                  description={`${selected.lines.length} cost codes · ${number(selected.totals.labor_hours, 2)} labor hours · ${number(selected.totals.equipment_hours, 2)} equipment hours`}
                  action={
                    canPrepare && selected.status === "draft" ? (
                      <button
                        type="button"
                        className="erp-button primary"
                        disabled={busy}
                        onClick={() =>
                          setLineEditor({ estimate: selected, index: null })
                        }
                      >
                        + Add scope
                      </button>
                    ) : undefined
                  }
                />
                {!selected.lines.length ? (
                  <Empty>
                    Add an earthwork, utility, road or custom scope line. Each
                    line holds its own installed unit and resource assumptions.
                  </Empty>
                ) : (
                  <div className="erp-table-wrap">
                    <table className="erp-table">
                      <thead>
                        <tr>
                          <th>Cost code / scope</th>
                          <th>Installed quantity</th>
                          <th>Direct cost</th>
                          <th>Cost budget</th>
                          <th>Sell value</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.lines.map((line, index) => (
                          <tr key={`${line.cost_code}-${index}`}>
                            <td>
                              <strong>
                                {line.cost_code} · {line.description}
                              </strong>
                              <small>{line.phase}</small>
                              <small>
                                {line.components.length} resources ·{" "}
                                {number(line.labor_hours, 2)} labor hours
                              </small>
                            </td>
                            <td>
                              <strong>
                                {number(line.quantity, 6)} {line.unit}
                              </strong>
                              <small>{takeoffSummary(line)}</small>
                            </td>
                            <td>{cents(line.direct_cost_cents)}</td>
                            <td>{cents(line.budget_cents)}</td>
                            <td>{cents(line.sell_cents)}</td>
                            <td>
                              {canPrepare && selected.status === "draft" ? (
                                <div className="erp-inline-actions">
                                  <button
                                    type="button"
                                    className="erp-button small"
                                    disabled={busy}
                                    onClick={() =>
                                      setLineEditor({
                                        estimate: selected,
                                        index,
                                      })
                                    }
                                    aria-label={`Edit ${line.cost_code}`}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="erp-text-button"
                                    disabled={busy}
                                    onClick={() =>
                                      setConfirmation({
                                        estimate: selected,
                                        action: "remove",
                                        index,
                                      })
                                    }
                                    aria-label={`Remove ${line.cost_code}`}
                                  >
                                    Remove
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  className="erp-text-button"
                                  onClick={() =>
                                    setLineEditor({ estimate: selected, index })
                                  }
                                >
                                  View resources
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
                  title="Bid build-up"
                  description="Overhead applies to direct cost; contingency applies to direct cost plus overhead. Markup applies to the resulting cost budget."
                />
                <div className="erp-estimate-costs">
                  <dl>
                    <div>
                      <dt>Direct resource cost</dt>
                      <dd>{cents(selected.totals.direct_cost_cents)}</dd>
                    </div>
                    <div>
                      <dt>
                        Overhead · {number(selected.overhead_pct, 3)}% of direct
                        cost
                      </dt>
                      <dd>{cents(selected.totals.overhead_cents)}</dd>
                    </div>
                    <div>
                      <dt>
                        Contingency · {number(selected.contingency_pct, 3)}% of
                        direct cost + overhead
                      </dt>
                      <dd>{cents(selected.totals.contingency_cents)}</dd>
                    </div>
                    <div>
                      <dt>Total cost budget</dt>
                      <dd>
                        <strong>
                          {cents(selected.totals.cost_total_cents)}
                        </strong>
                      </dd>
                    </div>
                    <div>
                      <dt>
                        Markup · {number(selected.markup_pct, 3)}% of cost
                        budget
                      </dt>
                      <dd>{cents(selected.totals.markup_cents)}</dd>
                    </div>
                    <div className="total">
                      <dt>Bid total</dt>
                      <dd>{cents(selected.totals.bid_total_cents)}</dd>
                    </div>
                    <div>
                      <dt>Estimated margin on bid revenue</dt>
                      <dd>{margin == null ? "—" : `${number(margin, 2)}%`}</dd>
                    </div>
                  </dl>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {headerEditor && (
        <HeaderEditor
          estimate={headerEditor.estimate}
          onClose={() => setHeaderEditor(null)}
          save={async (body) => {
            if (headerEditor.estimate)
              await edit(headerEditor.estimate, body, "Bid assumptions saved.");
            else
              await mutate(
                () => api.post<Estimate>("/erp/estimates", body),
                (estimate) =>
                  `${estimate.bid_code} created. Add the scope and resource rates.`,
              );
          }}
        />
      )}
      {lineEditor &&
        (lineEditor.estimate.status === "draft" && canPrepare ? (
          <LineEditor
            line={
              lineEditor.index == null
                ? null
                : lineEditor.estimate.lines[lineEditor.index]
            }
            onClose={() => setLineEditor(null)}
            save={async (line) => {
              const lines = lineEditor.estimate.lines.map(cleanLine);
              if (lineEditor.index == null) lines.push(line);
              else lines[lineEditor.index] = line;
              await edit(
                lineEditor.estimate,
                { lines },
                "Scope and resource assumptions saved.",
              );
            }}
          />
        ) : (
          <ResourceDetail
            line={lineEditor.estimate.lines[lineEditor.index ?? 0]}
            onClose={() => setLineEditor(null)}
          />
        ))}
      {handoverEditor && (
        <HandoverEditor
          estimate={handoverEditor}
          data={data}
          onClose={() => setHandoverEditor(null)}
          save={async (body) => {
            await mutate(
              () =>
                api.post<Handover>(
                  `/erp/estimates/${handoverEditor.id}/handover`,
                  body,
                ),
              (result) =>
                `Awarded project ${result.project_code} created with a draft baseline and billing pay items.`,
            );
          }}
        />
      )}
      {confirmation && (
        <Editor
          title={
            confirmation.action === "approve"
              ? "Review and approve bid revision"
              : confirmation.action === "revise"
                ? "Create next bid revision"
                : "Remove draft scope"
          }
          onClose={() => setConfirmation(null)}
          submit={
            confirmation.action === "approve"
              ? "Approve this revision"
              : confirmation.action === "revise"
                ? "Create draft revision"
                : "Remove scope line"
          }
          save={async () => {
            if (confirmation.action === "remove")
              await edit(
                confirmation.estimate,
                {
                  lines: confirmation.estimate.lines
                    .filter((_, i) => i !== confirmation.index)
                    .map(cleanLine),
                },
                "Draft scope line removed.",
              );
            else
              await mutate(
                () =>
                  api.post<Estimate>(
                    `/erp/estimates/${confirmation.estimate.id}/${confirmation.action}`,
                    {
                      expected_edit_version: confirmation.estimate.edit_version,
                    },
                  ),
                (result) =>
                  confirmation.action === "approve"
                    ? `${result.bid_code} revision ${result.revision} approved.`
                    : `${result.bid_code} revision ${result.revision} created as a draft.`,
              );
          }}
        >
          {confirmation.action === "approve" ? (
            <>
              <div className="erp-estimate-takeoff">
                <strong>
                  {confirmation.estimate.bid_code} · revision{" "}
                  {confirmation.estimate.revision}
                </strong>
                <br />
                {confirmation.estimate.lines.length} cost codes · bid total{" "}
                {cents(confirmation.estimate.totals.bid_total_cents)}
                <br />
                Cost budget{" "}
                {cents(confirmation.estimate.totals.cost_total_cents)}
              </div>
              <p className="erp-muted">
                Approval freezes the scope, rate assumptions, supplier quotes,
                exclusions and pricing in this bid revision. Changes require a
                new draft revision.
              </p>
              <label className="erp-estimate-confirm">
                <input type="checkbox" required />
                <span>
                  I have reviewed quantities, usage per unit, rates, allowances,
                  scope exclusions and quote validity for this revision.
                </span>
              </label>
            </>
          ) : confirmation.action === "revise" ? (
            <p>
              Create revision {confirmation.estimate.revision + 1} from this
              approved bid. The approved predecessor stays available in the bid
              register. Update the new draft and approve it before award.
            </p>
          ) : (
            <p>
              Remove{" "}
              <strong>
                {
                  confirmation.estimate.lines[confirmation.index ?? 0]
                    ?.cost_code
                }{" "}
                ·{" "}
                {
                  confirmation.estimate.lines[confirmation.index ?? 0]
                    ?.description
                }
              </strong>{" "}
              from this draft and recalculate its bid totals.
            </p>
          )}
        </Editor>
      )}
    </div>
  );
}
function ResourceDetail({
  line,
  onClose,
}: {
  line: ScopeLine;
  onClose: () => void;
}) {
  return (
    <Modal title={`${line.cost_code} · resource assumptions`} onClose={onClose}>
      <div className="erp-card-body">
        <p>
          <strong>{line.description}</strong> · {number(line.quantity, 6)}{" "}
          {line.unit}
        </p>
        <p className="erp-muted">{takeoffSummary(line)}</p>
        <div className="erp-estimate-resources">
          {line.components.map((resource, index) => (
            <div className="erp-estimate-resource" key={index}>
              <strong>{resource.description}</strong>
              <p>
                {resource.category} · {number(resource.usage_per_unit, 6)}{" "}
                {resource.resource_unit} per {line.unit} ·{" "}
                {number(resource.waste_pct, 3)}% allowance
              </p>
              <p>
                {rateMoney(resource.unit_rate)} per {resource.resource_unit} ·
                Cost <strong>{cents(resource.cost_cents)}</strong>
              </p>
              {resource.quote_reference && (
                <p className="erp-muted">
                  Quote {resource.quote_reference} · {resource.quote_vendor} ·
                  valid through {resource.quote_valid_until}
                  {quoteExpired(resource) ? " · Expired" : ""}
                </p>
              )}
            </div>
          ))}
        </div>
        <div className="erp-form-actions">
          <button type="button" className="erp-button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
