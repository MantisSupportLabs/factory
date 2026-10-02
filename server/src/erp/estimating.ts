import { createHash } from "node:crypto";
import { all, get, getDb, nowIso, run, transaction } from "../db/database.js";
import { businessDate } from "./calendar.js";
import {
  activeEmployee,
  body,
  date,
  dateRange,
  ErpError,
  hasEdits,
  id,
  nullableText,
  number,
  option,
  text,
  type Body,
} from "./validation.js";

export function initializeEstimatingSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS estimate_families (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      bid_code TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(tenant_id,bid_code)
    );
    CREATE TABLE IF NOT EXISTS estimates (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      family_id INTEGER NOT NULL REFERENCES estimate_families(id), revision INTEGER NOT NULL,
      edit_version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL CHECK(status IN ('draft','approved')),
      client TEXT NOT NULL, title TEXT NOT NULL, due_date TEXT, valid_until TEXT NOT NULL,
      assumptions TEXT NOT NULL, exclusions TEXT NOT NULL, currency TEXT NOT NULL CHECK(currency='USD'),
      overhead_pct REAL NOT NULL, contingency_pct REAL NOT NULL, markup_pct REAL NOT NULL,
      lines TEXT NOT NULL, totals TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL, approved_at TEXT, approved_by TEXT, approval_date TEXT,
      UNIQUE(tenant_id,family_id,revision)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS estimate_one_draft_per_family ON estimates(tenant_id,family_id) WHERE status='draft';
    CREATE INDEX IF NOT EXISTS estimates_tenant_family ON estimates(tenant_id,family_id,revision);
    CREATE TRIGGER IF NOT EXISTS estimate_approved_freeze BEFORE UPDATE ON estimates WHEN OLD.status='approved'
      BEGIN SELECT RAISE(ABORT,'Approved estimates are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS estimate_delete_guard BEFORE DELETE ON estimates
      BEGIN SELECT RAISE(ABORT,'Estimate history cannot be deleted'); END;
    CREATE TABLE IF NOT EXISTS estimate_handovers (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      family_id INTEGER NOT NULL REFERENCES estimate_families(id), estimate_id INTEGER NOT NULL REFERENCES estimates(id),
      jobsite_id INTEGER NOT NULL REFERENCES jobsites(id), baseline_id INTEGER NOT NULL REFERENCES project_baselines(id),
      award_reference TEXT NOT NULL, award_date TEXT NOT NULL, request_hash TEXT NOT NULL,
      line_mappings TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL,
      UNIQUE(tenant_id,family_id), UNIQUE(jobsite_id), UNIQUE(tenant_id,award_reference)
    );
  `);
  for (const table of ["estimate_families", "estimate_handovers"]) {
    getDb().exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_update_guard BEFORE UPDATE ON ${table}
        BEGIN SELECT RAISE(ABORT,'Estimate history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_delete_guard BEFORE DELETE ON ${table}
        BEGIN SELECT RAISE(ABORT,'Estimate history cannot be deleted'); END;
    `);
  }
}

const categories = [
  "labor",
  "equipment",
  "material",
  "subcontract",
  "other",
] as const;
const units = ["LF", "SF", "SY", "CY", "TON", "EA", "LS"] as const;
const methods = ["manual", "length", "area", "volume", "count"] as const;
export interface Takeoff {
  method: (typeof methods)[number];
  source_reference: string;
  length_ft?: number;
  width_ft?: number;
  depth_ft?: number;
  count?: number;
}
export interface EstimateComponent {
  category: (typeof categories)[number];
  description: string;
  resource_unit: string;
  usage_per_unit: number;
  unit_rate: number;
  waste_pct: number;
  quote_reference: string;
  quote_vendor: string;
  quote_valid_until: string | null;
  cost_cents: number;
}
export interface EstimateLine {
  cost_code: string;
  phase: string;
  description: string;
  unit: (typeof units)[number];
  quantity: number;
  takeoff: Takeoff;
  components: EstimateComponent[];
  direct_cost_cents: number;
  overhead_cents: number;
  contingency_cents: number;
  budget_cents: number;
  markup_cents: number;
  sell_cents: number;
  labor_hours: number;
  equipment_hours: number;
}
export interface EstimateTotals {
  direct_cost_cents: number;
  overhead_cents: number;
  contingency_cents: number;
  cost_total_cents: number;
  markup_cents: number;
  bid_total_cents: number;
  labor_hours: number;
  equipment_hours: number;
}
export interface EstimatePayload {
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
  lines: EstimateLine[];
  totals: EstimateTotals;
}
export interface Estimate extends EstimatePayload {
  id: number;
  tenant_id: number;
  family_id: number;
  bid_code: string;
  revision: number;
  edit_version: number;
  status: "draft" | "approved";
  created_at: string;
  created_by: string;
  updated_at: string;
  approved_at: string | null;
  approved_by: string | null;
  approval_date: string | null;
}
interface EstimateRow extends Omit<Estimate, "lines" | "totals"> {
  lines: string;
  totals: string;
}
export interface Handover {
  id: number;
  tenant_id: number;
  family_id: number;
  estimate_id: number;
  jobsite_id: number;
  baseline_id: number;
  award_reference: string;
  award_date: string;
  line_mappings: { cost_code: string; plan_id: number; pay_item_id: number }[];
  created_at: string;
  created_by: string;
  project_code: string;
  project_name: string;
}
interface HandoverRow extends Omit<Handover, "line_mappings"> {
  line_mappings: string;
  request_hash: string;
}

function array(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new ErpError(
      400,
      `${field} must be an array of at most ${max} records`,
    );
  return value;
}
function whole(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  const result = number(value, field, min, max);
  if (!Number.isSafeInteger(result))
    throw new ErpError(400, `${field} must be a whole number`);
  return result;
}
function safeCents(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ErpError(400, `${field} exceeds the supported cent precision`);
  return value;
}
function money(value: number, field: string): number {
  if (!Number.isFinite(value))
    throw new ErpError(400, `${field} must be finite`);
  return safeCents(Math.round(value * 100 + 1e-8), field);
}
function sumCents(values: number[], field: string): number {
  return safeCents(
    values.reduce((sum, value) => sum + value, 0),
    field,
  );
}
function roundQuantity(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Exact integer allocation; equal fractional remainders retain original line order. */
function allocateCents(amount: number, weights: number[]): number[] {
  const total = weights.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total === 0n) return weights.map(() => 0);
  const shares = weights.map((weight, index) => {
    const numerator = BigInt(amount) * BigInt(weight);
    return {
      index,
      share: Number(numerator / total),
      remainder: numerator % total,
    };
  });
  let remaining = amount - shares.reduce((sum, share) => sum + share.share, 0);
  const ordered = [...shares].sort((a, b) =>
    a.remainder === b.remainder
      ? a.index - b.index
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  for (const share of ordered) {
    if (remaining <= 0) break;
    share.share++;
    remaining--;
  }
  return shares.map((share) => share.share);
}

function normalizeLine(value: unknown, lineIndex: number): EstimateLine {
  const b = body(value),
    label = `Line ${lineIndex + 1}`;
  const unit = option(b.unit, `${label} unit`, units);
  const input =
    b.takeoff === undefined ? { method: "manual" } : body(b.takeoff);
  const method = option(
    input.method ?? "manual",
    `${label} takeoff method`,
    methods,
  );
  const takeoff: Takeoff = {
    method,
    source_reference: text(
      input.source_reference,
      `${label} source_reference`,
      method !== "manual",
      500,
    ),
  };
  let quantity: number;
  if (method === "manual") {
    quantity = number(b.quantity, `${label} quantity`, Number.MIN_VALUE, 1e9);
  } else {
    takeoff.count = whole(input.count ?? 1, `${label} count`, 1, 1e6);
    if (
      (method === "length" && unit !== "LF") ||
      (method === "area" && !["SF", "SY"].includes(unit)) ||
      (method === "volume" && unit !== "CY") ||
      (method === "count" && unit !== "EA")
    ) {
      throw new ErpError(
        400,
        `${label} takeoff geometry does not match its unit`,
      );
    }
    if (method === "count") quantity = takeoff.count;
    else {
      takeoff.length_ft = number(
        input.length_ft,
        `${label} length_ft`,
        Number.MIN_VALUE,
        1e7,
      );
      quantity = takeoff.length_ft * takeoff.count;
      if (method === "area" || method === "volume") {
        takeoff.width_ft = number(
          input.width_ft,
          `${label} width_ft`,
          Number.MIN_VALUE,
          1e7,
        );
        quantity *= takeoff.width_ft;
      }
      if (method === "volume") {
        takeoff.depth_ft = number(
          input.depth_ft,
          `${label} depth_ft`,
          Number.MIN_VALUE,
          1e7,
        );
        quantity = (quantity * takeoff.depth_ft) / 27;
      } else if (method === "area" && unit === "SY") quantity /= 9;
    }
  }
  quantity = roundQuantity(quantity);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1e9)
    throw new ErpError(
      400,
      `${label} quantity must be positive and at most 1 billion units`,
    );
  const components = array(b.components ?? [], `${label} components`, 100).map(
    (value, index): EstimateComponent => {
      const c = body(value),
        prefix = `${label} component ${index + 1}`;
      const category = option(c.category, `${prefix} category`, categories);
      const resourceUnit = text(
        c.resource_unit,
        `${prefix} resource_unit`,
        true,
        30,
      ).toUpperCase();
      if (["labor", "equipment"].includes(category) && resourceUnit !== "HRS")
        throw new ErpError(
          400,
          `${prefix} labor and equipment resources must use HRS`,
        );
      const usage = number(
        c.usage_per_unit,
        `${prefix} usage_per_unit`,
        0,
        1e6,
      );
      const rate = number(c.unit_rate, `${prefix} unit_rate`, 0, 1e6);
      const waste = number(c.waste_pct ?? 0, `${prefix} waste_pct`, 0, 100);
      const quoteReference = text(
        c.quote_reference,
        `${prefix} quote_reference`,
        false,
        300,
      );
      const quoteVendor = text(
        c.quote_vendor,
        `${prefix} quote_vendor`,
        Boolean(quoteReference),
        200,
      );
      const quoteExpiry = date(
        c.quote_valid_until,
        `${prefix} quote_valid_until`,
        !quoteReference,
      );
      if (!quoteReference && (quoteVendor || quoteExpiry))
        throw new ErpError(
          400,
          `${prefix} quote_reference is required when quote details are supplied`,
        );
      return {
        category,
        description: text(c.description, `${prefix} description`, true, 300),
        resource_unit: resourceUnit,
        usage_per_unit: usage,
        unit_rate: rate,
        waste_pct: waste,
        quote_reference: quoteReference,
        quote_vendor: quoteVendor,
        quote_valid_until: quoteExpiry,
        cost_cents: money(
          quantity * usage * (1 + waste / 100) * rate,
          `${prefix} cost`,
        ),
      };
    },
  );
  const hours = (category: string) =>
    roundQuantity(
      components
        .filter((c) => c.category === category && c.resource_unit === "HRS")
        .reduce(
          (sum, c) =>
            sum + quantity * c.usage_per_unit * (1 + c.waste_pct / 100),
          0,
        ),
    );
  const laborHours = hours("labor"),
    equipmentHours = hours("equipment");
  if (
    ![laborHours, equipmentHours].every(
      (value) => Number.isFinite(value) && value <= 1e12,
    )
  )
    throw new ErpError(
      400,
      `${label} resource hours exceed the supported range`,
    );
  const direct = sumCents(
    components.map((c) => c.cost_cents),
    `${label} direct cost`,
  );
  return {
    cost_code: text(b.cost_code, `${label} cost_code`, true, 100),
    phase: text(b.phase, `${label} phase`, true, 100),
    description: text(b.description, `${label} description`, true, 300),
    unit,
    quantity,
    takeoff,
    components,
    direct_cost_cents: direct,
    overhead_cents: 0,
    contingency_cents: 0,
    budget_cents: direct,
    markup_cents: 0,
    sell_cents: direct,
    labor_hours: laborHours,
    equipment_hours: equipmentHours,
  };
}

/** Server totals are authoritative. A quote supplies one component rate, never an additional charge. */
export function calculateEstimate(value: unknown): EstimatePayload {
  const b = body(value);
  const due = date(b.due_date, "due_date", true),
    valid = date(b.valid_until, "valid_until")!;
  dateRange(due, valid);
  const overheadPct = number(b.overhead_pct ?? 0, "overhead_pct", 0, 100);
  const contingencyPct = number(
    b.contingency_pct ?? 0,
    "contingency_pct",
    0,
    100,
  );
  const markupPct = number(b.markup_pct ?? 0, "markup_pct", 0, 500);
  const lines = array(b.lines ?? [], "lines", 500).map(normalizeLine);
  const codes = lines.map((line) => line.cost_code.toLowerCase());
  if (new Set(codes).size !== codes.length)
    throw new ErpError(400, "Each estimate line must have a unique cost code");
  const direct = sumCents(
    lines.map((line) => line.direct_cost_cents),
    "Estimate direct cost",
  );
  const overhead = safeCents(
    Math.round((direct * overheadPct) / 100),
    "Overhead",
  );
  const directAndOverhead = sumCents(
    [direct, overhead],
    "Cost including overhead",
  );
  const contingency = safeCents(
    Math.round((directAndOverhead * contingencyPct) / 100),
    "Contingency",
  );
  const costTotal = sumCents(
    [directAndOverhead, contingency],
    "Total estimated cost",
  );
  const markup = safeCents(Math.round((costTotal * markupPct) / 100), "Markup");
  const bidTotal = sumCents([costTotal, markup], "Total bid");
  const overheadShares = allocateCents(
    overhead,
    lines.map((line) => line.direct_cost_cents),
  );
  const contingencyShares = allocateCents(
    contingency,
    lines.map((line, index) => line.direct_cost_cents + overheadShares[index]),
  );
  const markupShares = allocateCents(
    markup,
    lines.map(
      (line, index) =>
        line.direct_cost_cents +
        overheadShares[index] +
        contingencyShares[index],
    ),
  );
  lines.forEach((line, index) => {
    line.overhead_cents = overheadShares[index];
    line.contingency_cents = contingencyShares[index];
    line.budget_cents =
      line.direct_cost_cents + line.overhead_cents + line.contingency_cents;
    line.markup_cents = markupShares[index];
    line.sell_cents = line.budget_cents + line.markup_cents;
  });
  const laborHours = roundQuantity(
    lines.reduce((sum, line) => sum + line.labor_hours, 0),
  );
  const equipmentHours = roundQuantity(
    lines.reduce((sum, line) => sum + line.equipment_hours, 0),
  );
  if (
    ![laborHours, equipmentHours].every(
      (value) => Number.isFinite(value) && value <= 1e12,
    )
  )
    throw new ErpError(400, "Total resource hours exceed the supported range");
  return {
    client: text(b.client, "client", true, 150),
    title: text(b.title, "title", true, 200),
    due_date: due,
    valid_until: valid,
    assumptions: text(b.assumptions, "assumptions", false, 10000),
    exclusions: text(b.exclusions, "exclusions", false, 10000),
    currency: option(b.currency ?? "USD", "currency", ["USD"] as const),
    overhead_pct: overheadPct,
    contingency_pct: contingencyPct,
    markup_pct: markupPct,
    lines,
    totals: {
      direct_cost_cents: direct,
      overhead_cents: overhead,
      contingency_cents: contingency,
      cost_total_cents: costTotal,
      markup_cents: markup,
      bid_total_cents: bidTotal,
      labor_hours: laborHours,
      equipment_hours: equipmentHours,
    },
  };
}
export const normalizeEstimatePayload = calculateEstimate;

function parseEstimate(row: EstimateRow): Estimate {
  return {
    ...row,
    lines: JSON.parse(row.lines) as EstimateLine[],
    totals: JSON.parse(row.totals) as EstimateTotals,
  };
}
const estimateQuery =
  "SELECT e.*,f.bid_code FROM estimates e JOIN estimate_families f ON f.id=e.family_id AND f.tenant_id=e.tenant_id";
export function getEstimate(tenantId: number, estimateId: number): Estimate {
  const row = get<EstimateRow>(
    `${estimateQuery} WHERE e.tenant_id=? AND e.id=?`,
    tenantId,
    estimateId,
  );
  if (!row) throw new ErpError(404, "Estimate not found");
  return parseEstimate(row);
}
function parseHandover(row: HandoverRow): Handover {
  const { request_hash: _requestHash, ...safe } = row;
  return {
    ...safe,
    line_mappings: JSON.parse(row.line_mappings) as Handover["line_mappings"],
  };
}
const handoverQuery =
  "SELECT h.*,j.code project_code,j.name project_name FROM estimate_handovers h JOIN jobsites j ON j.id=h.jobsite_id AND j.tenant_id=h.tenant_id";
export function getEstimating(tenantId: number): {
  estimates: Estimate[];
  handovers: Handover[];
} {
  return {
    estimates: all<EstimateRow>(
      `${estimateQuery} WHERE e.tenant_id=? ORDER BY e.family_id DESC,e.revision DESC`,
      tenantId,
    ).map(parseEstimate),
    handovers: all<HandoverRow>(
      `${handoverQuery} WHERE h.tenant_id=? ORDER BY h.id DESC`,
      tenantId,
    ).map(parseHandover),
  };
}
function expectedVersion(estimate: Estimate, value: unknown): void {
  if (id(value, "expected_edit_version") !== estimate.edit_version)
    throw new ErpError(
      409,
      "The estimate has changed; reload it before continuing",
    );
}
function assertLatest(estimate: Estimate): void {
  const newest = get<{ id: number }>(
    "SELECT id FROM estimates WHERE tenant_id=? AND family_id=? ORDER BY revision DESC LIMIT 1",
    estimate.tenant_id,
    estimate.family_id,
  )!;
  if (newest.id !== estimate.id)
    throw new ErpError(409, "Use the latest estimate revision");
}
function assertNotHandedOver(estimate: Estimate): void {
  if (
    get(
      "SELECT id FROM estimate_handovers WHERE tenant_id=? AND family_id=?",
      estimate.tenant_id,
      estimate.family_id,
    )
  )
    throw new ErpError(
      409,
      "This bid family has already been handed over to a project",
    );
}
function validateQuotedRates(estimate: EstimatePayload, asOf: string): void {
  for (const line of estimate.lines)
    for (const component of line.components) {
      if (component.quote_reference && component.quote_valid_until! < asOf)
        throw new ErpError(
          400,
          `Quote ${component.quote_reference} on ${line.cost_code} expired before ${asOf}`,
        );
    }
}
function insertEstimate(
  tenantId: number,
  familyId: number,
  revision: number,
  p: EstimatePayload,
  actor: string,
): number {
  const now = nowIso();
  return Number(
    run(
      `INSERT INTO estimates(tenant_id,family_id,revision,edit_version,status,client,title,due_date,valid_until,assumptions,exclusions,currency,overhead_pct,contingency_pct,markup_pct,lines,totals,created_at,created_by,updated_at)
    VALUES(?,?,?,1,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      tenantId,
      familyId,
      revision,
      p.client,
      p.title,
      p.due_date,
      p.valid_until,
      p.assumptions,
      p.exclusions,
      p.currency,
      p.overhead_pct,
      p.contingency_pct,
      p.markup_pct,
      JSON.stringify(p.lines),
      JSON.stringify(p.totals),
      now,
      actor,
      now,
    ).lastInsertRowid,
  );
}
export function createEstimate(
  tenantId: number,
  value: unknown,
  actor = "Demo user",
): Estimate {
  const b = body(value),
    bidCode = text(b.bid_code, "bid_code", true, 100),
    p = calculateEstimate(b);
  return transaction(() => {
    const familyId = Number(
      run(
        "INSERT INTO estimate_families(tenant_id,bid_code,created_at) VALUES(?,?,?)",
        tenantId,
        bidCode,
        nowIso(),
      ).lastInsertRowid,
    );
    return getEstimate(
      tenantId,
      insertEstimate(tenantId, familyId, 1, p, text(actor, "actor", true, 150)),
    );
  });
}
const editable = [
  "client",
  "title",
  "due_date",
  "valid_until",
  "assumptions",
  "exclusions",
  "overhead_pct",
  "contingency_pct",
  "markup_pct",
  "lines",
];
export function editEstimate(
  tenantId: number,
  estimateId: number,
  value: unknown,
): Estimate {
  const b = body(value);
  return transaction(() => {
    const estimate = getEstimate(tenantId, estimateId);
    expectedVersion(estimate, b.expected_edit_version);
    if (estimate.status !== "draft")
      throw new ErpError(
        409,
        "Approved estimates cannot be edited; create a revision",
      );
    assertLatest(estimate);
    assertNotHandedOver(estimate);
    hasEdits(b, editable);
    if (b.bid_code !== undefined && b.bid_code !== estimate.bid_code)
      throw new ErpError(400, "bid_code is fixed for this estimate family");
    if (b.currency !== undefined && b.currency !== "USD")
      throw new ErpError(400, "Only USD is supported");
    const p = calculateEstimate({ ...estimate, ...b });
    run(
      `UPDATE estimates SET client=?,title=?,due_date=?,valid_until=?,assumptions=?,exclusions=?,overhead_pct=?,contingency_pct=?,markup_pct=?,lines=?,totals=?,edit_version=edit_version+1,updated_at=? WHERE tenant_id=? AND id=?`,
      p.client,
      p.title,
      p.due_date,
      p.valid_until,
      p.assumptions,
      p.exclusions,
      p.overhead_pct,
      p.contingency_pct,
      p.markup_pct,
      JSON.stringify(p.lines),
      JSON.stringify(p.totals),
      nowIso(),
      tenantId,
      estimateId,
    );
    return getEstimate(tenantId, estimateId);
  });
}
export function approveEstimate(
  tenantId: number,
  estimateId: number,
  value: unknown,
  actor = "Demo reviewer",
): Estimate {
  const b = body(value);
  return transaction(() => {
    const estimate = getEstimate(tenantId, estimateId);
    expectedVersion(estimate, b.expected_edit_version);
    if (estimate.status !== "draft")
      throw new ErpError(409, "Only draft estimates can be approved");
    assertLatest(estimate);
    assertNotHandedOver(estimate);
    const calculated = calculateEstimate(estimate);
    if (
      !calculated.lines.length ||
      calculated.lines.some(
        (line) => line.direct_cost_cents <= 0 || line.sell_cents <= 0,
      )
    )
      throw new ErpError(400, "Price every scope line before approval");
    if (calculated.lines.some((line) => !line.takeoff.source_reference))
      throw new ErpError(
        400,
        "Record a plan, takeoff memo, or other source reference for every scope line before approval",
      );
    const today = businessDate();
    if (estimate.valid_until < today)
      throw new ErpError(400, "Estimate validity has expired");
    validateQuotedRates(calculated, today);
    const reviewer = text(actor, "reviewer", true, 150),
      now = nowIso();
    run(
      `UPDATE estimates SET status='approved',lines=?,totals=?,approved_at=?,approved_by=?,approval_date=?,edit_version=edit_version+1,updated_at=? WHERE tenant_id=? AND id=?`,
      JSON.stringify(calculated.lines),
      JSON.stringify(calculated.totals),
      now,
      reviewer,
      today,
      now,
      tenantId,
      estimateId,
    );
    return getEstimate(tenantId, estimateId);
  });
}
export function reviseEstimate(
  tenantId: number,
  estimateId: number,
  value: unknown,
  actor = "Demo user",
): Estimate {
  const b = body(value);
  return transaction(() => {
    const estimate = getEstimate(tenantId, estimateId);
    expectedVersion(estimate, b.expected_edit_version);
    if (estimate.status !== "approved")
      throw new ErpError(
        409,
        "Only approved estimates can start a new revision",
      );
    assertLatest(estimate);
    assertNotHandedOver(estimate);
    return getEstimate(
      tenantId,
      insertEstimate(
        tenantId,
        estimate.family_id,
        estimate.revision + 1,
        calculateEstimate(estimate),
        text(actor, "actor", true, 150),
      ),
    );
  });
}

interface HandoverPayload {
  award_reference: string;
  award_date: string;
  name: string;
  code: string;
  pm_id: number;
  start_date: string;
  end_date: string;
  address: string | null;
  lat: number;
  lng: number;
  superintendent: string | null;
}
function handoverPayload(value: Body): HandoverPayload {
  const start = date(value.start_date, "start_date")!,
    end = date(value.end_date, "end_date")!;
  dateRange(start, end);
  return {
    award_reference: text(value.award_reference, "award_reference", true, 300),
    award_date: date(value.award_date, "award_date")!,
    name: text(value.name, "name", true, 150),
    code: text(value.code, "code", true, 50),
    pm_id: id(value.pm_id, "pm_id"),
    start_date: start,
    end_date: end,
    address: nullableText(value.address, "address", 300),
    lat: number(value.lat, "lat", -90, 90),
    lng: number(value.lng, "lng", -180, 180),
    superintendent: nullableText(value.superintendent, "superintendent", 150),
  };
}
export function handoverEstimate(
  tenantId: number,
  estimateId: number,
  value: unknown,
  actor = "Demo PM",
): { handover: Handover; created: boolean } {
  const b = body(value),
    p = handoverPayload(b);
  // Request hash deliberately omits edit_version so an unchanged award retries after a refresh.
  const hash = createHash("sha256")
    .update(JSON.stringify({ estimate_id: estimateId, ...p }))
    .digest("hex");
  return transaction(() => {
    const estimate = getEstimate(tenantId, estimateId);
    const previous = get<HandoverRow>(
      `${handoverQuery} WHERE h.tenant_id=? AND h.family_id=?`,
      tenantId,
      estimate.family_id,
    );
    if (previous) {
      if (previous.request_hash !== hash)
        throw new ErpError(
          409,
          "This bid family has already been handed over with different award details",
        );
      id(b.expected_edit_version, "expected_edit_version");
      return { handover: parseHandover(previous), created: false };
    }
    expectedVersion(estimate, b.expected_edit_version);
    if (estimate.status !== "approved")
      throw new ErpError(409, "Approve the estimate before handover");
    assertLatest(estimate);
    if (
      !estimate.approval_date ||
      p.award_date < estimate.approval_date ||
      p.award_date > estimate.valid_until ||
      p.award_date > businessDate()
    ) {
      throw new ErpError(
        400,
        "Award date must fall between estimate approval and validity, and cannot be in the future",
      );
    }
    validateQuotedRates(estimate, p.award_date);
    const pm = activeEmployee(tenantId, p.pm_id, "pm_id", ["pm", "super"]);
    const now = nowIso(),
      handoverActor = text(actor, "actor", true, 150);
    const projectId = Number(
      run(
        "INSERT INTO jobsites(tenant_id,name,code,status,lat,lng,address,superintendent,start_date,end_date) VALUES(?,?,?,'planned',?,?,?,?,?,?)",
        tenantId,
        p.name,
        p.code,
        p.lat,
        p.lng,
        p.address,
        p.superintendent,
        p.start_date,
        p.end_date,
      ).lastInsertRowid,
    );
    run(
      "INSERT INTO project_profiles(tenant_id,jobsite_id,client,pm_id,contract_value,budget) VALUES(?,?,?,?,?,?)",
      tenantId,
      projectId,
      estimate.client,
      pm,
      estimate.totals.bid_total_cents / 100,
      estimate.totals.cost_total_cents / 100,
    );
    const mappings: Handover["line_mappings"] = [];
    const workItems = estimate.lines.map((line) => {
      const planId = Number(
        run(
          "INSERT INTO production_plans(tenant_id,jobsite_id,phase,activity,unit,planned_qty,planned_hours,planned_start,planned_end) VALUES(?,?,?,?,?,?,?,?,?)",
          tenantId,
          projectId,
          line.phase,
          line.description,
          line.unit,
          line.quantity,
          line.labor_hours,
          p.start_date,
          p.end_date,
        ).lastInsertRowid,
      );
      run(
        "INSERT INTO work_item_profiles(tenant_id,plan_id,cost_code,budget) VALUES(?,?,?,?)",
        tenantId,
        planId,
        line.cost_code,
        line.budget_cents / 100,
      );
      const payItemId = Number(
        run(
          "INSERT INTO billing_pay_items(tenant_id,jobsite_id,code,description,unit,total_qty,scheduled_value_cents,plan_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          tenantId,
          projectId,
          line.cost_code,
          line.description,
          line.unit,
          line.quantity,
          line.sell_cents,
          planId,
          now,
        ).lastInsertRowid,
      );
      mappings.push({
        cost_code: line.cost_code,
        plan_id: planId,
        pay_item_id: payItemId,
      });
      return {
        id: planId,
        cost_code: line.cost_code,
        phase: line.phase,
        activity: line.description,
        unit: line.unit,
        planned_qty: line.quantity,
        planned_hours: line.labor_hours,
        budget: line.budget_cents / 100,
        planned_start: p.start_date,
        planned_end: p.end_date,
      };
    });
    const snapshot = {
      project: {
        name: p.name,
        contract_value: estimate.totals.bid_total_cents / 100,
        budget: estimate.totals.cost_total_cents / 100,
        start_date: p.start_date,
        end_date: p.end_date,
      },
      calendar: { weekdays: [1, 2, 3, 4, 5], holidays: [] },
      dependencies: [],
      work_items: workItems,
      estimate: {
        estimate_id: estimate.id,
        bid_code: estimate.bid_code,
        revision: estimate.revision,
        award_reference: p.award_reference,
      },
    };
    const baselineId = Number(
      run(
        "INSERT INTO project_baselines(tenant_id,jobsite_id,version,title,explanation,snapshot,status,created_at) VALUES(?,?,1,?,?,?,'draft',?)",
        tenantId,
        projectId,
        `${estimate.bid_code} revision ${estimate.revision} award handover`,
        "Scope, resource hours and cost allowances copied from the approved estimate. Review this baseline before approval.",
        JSON.stringify(snapshot),
        now,
      ).lastInsertRowid,
    );
    const handoverId = Number(
      run(
        "INSERT INTO estimate_handovers(tenant_id,family_id,estimate_id,jobsite_id,baseline_id,award_reference,award_date,request_hash,line_mappings,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        tenantId,
        estimate.family_id,
        estimate.id,
        projectId,
        baselineId,
        p.award_reference,
        p.award_date,
        hash,
        JSON.stringify(mappings),
        now,
        handoverActor,
      ).lastInsertRowid,
    );
    return {
      handover: parseHandover(
        get<HandoverRow>(
          `${handoverQuery} WHERE h.tenant_id=? AND h.id=?`,
          tenantId,
          handoverId,
        )!,
      ),
      created: true,
    };
  });
}
