import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { all, get, run, transaction } from "../../db/database.js";
import { equipmentServiceRules } from "../../erp/equipment-operations.js";

export const equipmentOperationsRouter = Router();
class EquipmentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const handle =
  (fn: (req: Request, res: Response) => void) =>
  (req: Request, res: Response, next: NextFunction) => {
    try {
      fn(req, res);
    } catch (error) {
      if (error instanceof EquipmentError)
        res.status(error.status).json({ error: error.message });
      else next(error);
    }
  };
function body(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new EquipmentError(400, "request body must be a JSON object");
  const result = value as Record<string, unknown>;
  const unsupported = Object.keys(result).filter(
    (key) => !allowed.includes(key),
  );
  if (unsupported.length)
    throw new EquipmentError(
      400,
      `unsupported fields: ${unsupported.join(", ")}`,
    );
  return result;
}
function id(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new EquipmentError(400, `${field} must be a positive integer`);
  return value;
}
function pathId(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value))
    throw new EquipmentError(400, "id must be a positive integer");
  return id(Number(value), "id");
}
function text(
  value: unknown,
  field: string,
  max = 4000,
  blank = false,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length > max ||
    (!blank && !value.trim())
  )
    throw new EquipmentError(
      400,
      `${field} must contain ${blank ? 0 : 1} to ${max} characters`,
    );
  return value.trim();
}
function amount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new EquipmentError(
      400,
      `${field} must be a finite nonnegative number`,
    );
  return value;
}
function date(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new EquipmentError(400, `${field} must be a YYYY-MM-DD date`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new EquipmentError(400, `${field} must be a valid calendar date`);
  return value;
}
function time(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    throw new EquipmentError(
      400,
      `${field} must include a date, time and timezone`,
    );
  date(value.slice(0, 10), field);
  if (
    Number(value.slice(11, 13)) > 23 ||
    Number(value.slice(14, 16)) > 59 ||
    (value[16] === ":" && Number(value.slice(17, 19)) > 59)
  )
    throw new EquipmentError(400, `${field} must be a valid time`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()))
    throw new EquipmentError(400, `${field} must be a valid timestamp`);
  return parsed.toISOString();
}
function window(start: unknown, end: unknown): [string, string] {
  const from = time(start, "start_at"),
    to = time(end, "end_at");
  if (to <= from) throw new EquipmentError(400, "end must be after start");
  return [from, to];
}
interface Asset {
  id: number;
  jobsite_id: number | null;
  name: string;
  status: string;
  operator: string | null;
  updated_at: string;
  meta: string | null;
}
function asset(tenantId: number, assetId: number): Asset {
  const record = get<Asset>(
    "SELECT * FROM assets WHERE tenant_id=? AND id=?",
    tenantId,
    assetId,
  );
  if (!record) throw new EquipmentError(404, "asset not found");
  return record;
}
function job(tenantId: number, jobId: number): void {
  if (
    !get("SELECT id FROM jobsites WHERE tenant_id=? AND id=?", tenantId, jobId)
  )
    throw new EquipmentError(404, "jobsite not found");
}
function person(tenantId: number, personId: number): { name: string } {
  const value = get<{ name: string; active: number }>(
    "SELECT name,active FROM employees WHERE tenant_id=? AND id=?",
    tenantId,
    personId,
  );
  if (!value) throw new EquipmentError(404, "person not found");
  if (!value.active) throw new EquipmentError(409, "person is inactive");
  return value;
}
function noReservationOverlap(
  tenantId: number,
  assetId: number,
  start: string,
  end: string,
): void {
  if (
    get(
      `SELECT id FROM equipment_reservations WHERE tenant_id=? AND asset_id=? AND status='reserved' AND start_at < ? AND end_at > ?`,
      tenantId,
      assetId,
      end,
      start,
    )
  ) {
    throw new EquipmentError(
      409,
      "asset has a conflicting reservation; cancel or reschedule it before maintenance",
    );
  }
}
const reservationSelect = `SELECT r.*,a.name AS asset_name,j.name AS jobsite_name,j.code AS jobsite_code FROM equipment_reservations r
  JOIN assets a ON a.id=r.asset_id AND a.tenant_id=r.tenant_id JOIN jobsites j ON j.id=r.jobsite_id AND j.tenant_id=r.tenant_id`;
const transferSelect = `SELECT t.*,a.name AS asset_name,f.name AS from_jobsite_name,d.name AS to_jobsite_name,e.name AS custodian_name
  FROM asset_transfers t JOIN assets a ON a.id=t.asset_id AND a.tenant_id=t.tenant_id
  LEFT JOIN jobsites f ON f.id=t.from_jobsite_id AND f.tenant_id=t.tenant_id JOIN jobsites d ON d.id=t.to_jobsite_id AND d.tenant_id=t.tenant_id
  LEFT JOIN employees e ON e.id=t.custodian_id AND e.tenant_id=t.tenant_id`;
const orderSelect = `SELECT w.*,a.name AS asset_name,e.name AS assigned_to_name,j.name AS jobsite_name,c.cost_entry_id
  FROM equipment_work_orders w JOIN assets a ON a.id=w.asset_id AND a.tenant_id=w.tenant_id
  LEFT JOIN employees e ON e.id=w.assigned_to_id AND e.tenant_id=w.tenant_id LEFT JOIN jobsites j ON j.id=w.jobsite_id AND j.tenant_id=w.tenant_id
  LEFT JOIN equipment_cost_links c ON c.work_order_id=w.id AND c.tenant_id=w.tenant_id`;
const inspectionSelect = `SELECT i.*,a.name AS asset_name,e.name AS inspector_name FROM equipment_inspections i
  JOIN assets a ON a.id=i.asset_id AND a.tenant_id=i.tenant_id JOIN employees e ON e.id=i.inspector_id AND e.tenant_id=i.tenant_id`;

equipmentOperationsRouter.get(
  "/erp/equipment-operations",
  handle((req, res) => {
    const tenant = req.tenant.id;
    res.json({
      reservations: all(
        `${reservationSelect} WHERE r.tenant_id=? ORDER BY r.start_at DESC,r.id DESC`,
        tenant,
      ),
      transfers: all(
        `${transferSelect} WHERE t.tenant_id=? ORDER BY t.id DESC`,
        tenant,
      ),
      work_orders: all(
        `${orderSelect} WHERE w.tenant_id=? ORDER BY w.id DESC`,
        tenant,
      ),
      service_rules: equipmentServiceRules(tenant),
      inspections: all(
        `${inspectionSelect} WHERE i.tenant_id=? ORDER BY i.date DESC,i.id DESC`,
        tenant,
      ),
    });
  }),
);

equipmentOperationsRouter.post(
  "/erp/equipment-reservations",
  handle((req, res) => {
    const tenant = req.tenant.id,
      b = body(req.body, [
        "asset_id",
        "jobsite_id",
        "start_at",
        "end_at",
        "task",
      ]);
    const assetId = id(b.asset_id, "asset_id"),
      jobId = id(b.jobsite_id, "jobsite_id"),
      [start, end] = window(b.start_at, b.end_at),
      task = text(b.task, "task", 500);
    const reservationId = transaction(() => {
      const current = asset(tenant, assetId);
      job(tenant, jobId);
      if (current.status !== "active")
        throw new EquipmentError(
          409,
          `asset is ${current.status} and cannot be reserved`,
        );
      noReservationOverlap(tenant, assetId, start, end);
      if (
        get(
          `SELECT id FROM equipment_work_orders WHERE tenant_id=? AND asset_id=? AND status IN ('open','in_progress')
      AND scheduled_start IS NOT NULL AND scheduled_start < ? AND scheduled_end > ?`,
          tenant,
          assetId,
          end,
          start,
        )
      )
        throw new EquipmentError(
          409,
          "reservation overlaps a planned maintenance window",
        );
      return Number(
        run(
          `INSERT INTO equipment_reservations(tenant_id,asset_id,jobsite_id,start_at,end_at,task) VALUES (?,?,?,?,?,?)`,
          tenant,
          assetId,
          jobId,
          start,
          end,
          task,
        ).lastInsertRowid,
      );
    });
    res
      .status(201)
      .json(
        get(
          `${reservationSelect} WHERE r.tenant_id=? AND r.id=?`,
          tenant,
          reservationId,
        ),
      );
  }),
);
equipmentOperationsRouter.post(
  "/erp/equipment-reservations/:id/cancel",
  handle((req, res) => {
    const tenant = req.tenant.id,
      reservationId = pathId(req.params.id);
    body(req.body ?? {}, []);
    if (
      !get(
        "SELECT id FROM equipment_reservations WHERE tenant_id=? AND id=?",
        tenant,
        reservationId,
      )
    )
      throw new EquipmentError(404, "reservation not found");
    run(
      `UPDATE equipment_reservations SET status='cancelled' WHERE tenant_id=? AND id=?`,
      tenant,
      reservationId,
    );
    res.json(
      get(
        `${reservationSelect} WHERE r.tenant_id=? AND r.id=?`,
        tenant,
        reservationId,
      ),
    );
  }),
);

equipmentOperationsRouter.post(
  "/erp/asset-transfers",
  handle((req, res) => {
    const tenant = req.tenant.id,
      b = body(req.body, [
        "asset_id",
        "from_jobsite_id",
        "to_jobsite_id",
        "custodian_id",
        "requested_date",
        "notes",
      ]);
    const assetId = id(b.asset_id, "asset_id"),
      from =
        b.from_jobsite_id == null
          ? null
          : id(b.from_jobsite_id, "from_jobsite_id"),
      to = id(b.to_jobsite_id, "to_jobsite_id");
    const custodian =
        b.custodian_id == null ? null : id(b.custodian_id, "custodian_id"),
      requested = date(b.requested_date, "requested_date"),
      notes = text(b.notes ?? "", "notes", 4000, true);
    const transferId = transaction(() => {
      const current = asset(tenant, assetId);
      if (from !== null) job(tenant, from);
      job(tenant, to);
      if (custodian !== null) person(tenant, custodian);
      if (current.jobsite_id !== from)
        throw new EquipmentError(
          409,
          "source job does not match the current asset location",
        );
      if (from === to)
        throw new EquipmentError(400, "destination must differ from source");
      if (
        get(
          `SELECT id FROM asset_transfers WHERE tenant_id=? AND asset_id=? AND status='pending'`,
          tenant,
          assetId,
        )
      )
        throw new EquipmentError(409, "asset already has a pending transfer");
      return Number(
        run(
          `INSERT INTO asset_transfers(tenant_id,asset_id,from_jobsite_id,to_jobsite_id,custodian_id,requested_date,notes,source_operator,source_status,source_updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
          tenant,
          assetId,
          from,
          to,
          custodian,
          requested,
          notes,
          current.operator,
          current.status,
          current.updated_at,
        ).lastInsertRowid,
      );
    });
    res
      .status(201)
      .json(
        get(
          `${transferSelect} WHERE t.tenant_id=? AND t.id=?`,
          tenant,
          transferId,
        ),
      );
  }),
);
interface Transfer {
  id: number;
  asset_id: number;
  from_jobsite_id: number | null;
  to_jobsite_id: number;
  custodian_id: number | null;
  status: string;
  source_operator: string | null;
  source_status: string;
  source_updated_at: string;
}
equipmentOperationsRouter.post(
  "/erp/asset-transfers/:id/accept",
  handle((req, res) => {
    const tenant = req.tenant.id,
      transferId = pathId(req.params.id);
    body(req.body ?? {}, []);
    transaction(() => {
      const record = get<Transfer>(
        "SELECT * FROM asset_transfers WHERE tenant_id=? AND id=?",
        tenant,
        transferId,
      );
      if (!record) throw new EquipmentError(404, "transfer not found");
      if (record.status === "accepted") return;
      if (record.status !== "pending")
        throw new EquipmentError(
          409,
          "only a pending transfer can be accepted",
        );
      const current = asset(tenant, record.asset_id);
      job(tenant, record.to_jobsite_id);
      if (
        current.jobsite_id !== record.from_jobsite_id ||
        current.operator !== record.source_operator ||
        current.status !== record.source_status ||
        current.updated_at !== record.source_updated_at
      )
        throw new EquipmentError(
          409,
          "asset state changed since this transfer was requested; cancel and request a new transfer",
        );
      const operator =
        record.custodian_id !== null
          ? person(tenant, record.custodian_id).name
          : current.operator;
      let meta: Record<string, unknown> = {};
      if (current.meta) {
        try {
          const parsed: unknown = JSON.parse(current.meta);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            meta = parsed as Record<string, unknown>;
        } catch {
          throw new EquipmentError(
            409,
            "asset metadata must be repaired before accepting transfer",
          );
        }
      }
      const now = new Date().toISOString();
      run(
        `UPDATE asset_transfers SET status='accepted',previous_jobsite_id=?,previous_operator=?,accepted_at=? WHERE tenant_id=? AND id=?`,
        current.jobsite_id,
        current.operator,
        now,
        tenant,
        transferId,
      );
      run(
        "UPDATE assets SET jobsite_id=?,operator=?,meta=?,updated_at=? WHERE tenant_id=? AND id=?",
        record.to_jobsite_id,
        operator,
        JSON.stringify({ ...meta, jobsiteLocked: true }),
        now,
        tenant,
        record.asset_id,
      );
    });
    res.json(
      get(
        `${transferSelect} WHERE t.tenant_id=? AND t.id=?`,
        tenant,
        transferId,
      ),
    );
  }),
);
equipmentOperationsRouter.post(
  "/erp/asset-transfers/:id/cancel",
  handle((req, res) => {
    const tenant = req.tenant.id,
      transferId = pathId(req.params.id);
    body(req.body ?? {}, []);
    const record = get<{ status: string }>(
      "SELECT status FROM asset_transfers WHERE tenant_id=? AND id=?",
      tenant,
      transferId,
    );
    if (!record) throw new EquipmentError(404, "transfer not found");
    if (record.status === "accepted")
      throw new EquipmentError(
        409,
        "accepted transfers are historical records; request a new transfer",
      );
    run(
      `UPDATE asset_transfers SET status='cancelled' WHERE tenant_id=? AND id=?`,
      tenant,
      transferId,
    );
    res.json(
      get(
        `${transferSelect} WHERE t.tenant_id=? AND t.id=?`,
        tenant,
        transferId,
      ),
    );
  }),
);

equipmentOperationsRouter.post(
  "/erp/equipment-work-orders",
  handle((req, res) => {
    const tenant = req.tenant.id,
      b = body(req.body, [
        "asset_id",
        "type",
        "title",
        "assigned_to_id",
        "scheduled_start",
        "scheduled_end",
        "parts_cost",
        "labor_cost",
        "notes",
        "jobsite_id",
        "cost_code",
        "service_rule_id",
      ]);
    const assetId = id(b.asset_id, "asset_id"),
      title = text(b.title, "title", 240),
      assigned =
        b.assigned_to_id == null
          ? null
          : id(b.assigned_to_id, "assigned_to_id");
    if (!["preventive", "repair", "inspection"].includes(String(b.type)))
      throw new EquipmentError(
        400,
        "type must be preventive, repair or inspection",
      );
    let start: string | null = null,
      end: string | null = null;
    if (b.scheduled_start != null || b.scheduled_end != null)
      [start, end] = window(b.scheduled_start, b.scheduled_end);
    const serviceRuleId =
      b.service_rule_id == null
        ? null
        : id(b.service_rule_id, "service_rule_id");
    if (serviceRuleId !== null && b.type !== "preventive")
      throw new EquipmentError(
        400,
        "service_rule_id applies only to preventive work orders",
      );
    const parts = amount(b.parts_cost ?? 0, "parts_cost"),
      labor = amount(b.labor_cost ?? 0, "labor_cost"),
      notes = text(b.notes ?? "", "notes", 4000, true);
    const jobId = b.jobsite_id == null ? null : id(b.jobsite_id, "jobsite_id"),
      code = jobId === null ? null : text(b.cost_code, "cost_code", 80);
    if (jobId === null && b.cost_code != null && b.cost_code !== "")
      throw new EquipmentError(400, "cost_code requires a jobsite_id");
    const orderId = transaction(() => {
      const current = asset(tenant, assetId);
      if (current.status === "retired")
        throw new EquipmentError(
          409,
          "retired assets cannot have new work orders",
        );
      if (assigned !== null) person(tenant, assigned);
      if (jobId !== null) job(tenant, jobId);
      if (
        serviceRuleId !== null &&
        !get(
          "SELECT id FROM equipment_service_rules WHERE tenant_id=? AND asset_id=? AND id=?",
          tenant,
          assetId,
          serviceRuleId,
        )
      )
        throw new EquipmentError(404, "service rule for this asset not found");
      if (start && end) noReservationOverlap(tenant, assetId, start, end);
      return Number(
        run(
          `INSERT INTO equipment_work_orders(tenant_id,asset_id,type,title,assigned_to_id,scheduled_start,scheduled_end,parts_cost,labor_cost,notes,jobsite_id,cost_code,service_rule_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          tenant,
          assetId,
          String(b.type),
          title,
          assigned,
          start,
          end,
          parts,
          labor,
          notes,
          jobId,
          code,
          serviceRuleId,
        ).lastInsertRowid,
      );
    });
    res
      .status(201)
      .json(
        get(`${orderSelect} WHERE w.tenant_id=? AND w.id=?`, tenant, orderId),
      );
  }),
);
interface WorkOrder {
  service_rule_id: number | null;
  id: number;
  asset_id: number;
  type: string;
  status: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  prior_status: string | null;
  parts_cost: number;
  labor_cost: number;
  jobsite_id: number | null;
  cost_code: string | null;
  title: string;
  notes: string;
  completed_meter: number | null;
  returned_to_service: number;
}
equipmentOperationsRouter.post(
  "/erp/equipment-work-orders/:id/start",
  handle((req, res) => {
    const tenant = req.tenant.id,
      orderId = pathId(req.params.id);
    body(req.body ?? {}, []);
    transaction(() => {
      const order = get<WorkOrder>(
        "SELECT * FROM equipment_work_orders WHERE tenant_id=? AND id=?",
        tenant,
        orderId,
      );
      if (!order) throw new EquipmentError(404, "work order not found");
      if (order.status === "in_progress") return;
      if (order.status !== "open")
        throw new EquipmentError(409, "only an open work order can be started");
      const current = asset(tenant, order.asset_id);
      if (current.status === "retired")
        throw new EquipmentError(
          409,
          "retired assets cannot enter maintenance",
        );
      const now = new Date().toISOString(),
        start =
          order.scheduled_start && order.scheduled_start < now
            ? order.scheduled_start
            : now;
      const end =
        order.scheduled_end && order.scheduled_end > now
          ? order.scheduled_end
          : "9999-12-31T23:59:59.999Z";
      noReservationOverlap(tenant, order.asset_id, start, end);
      const baseline = get<{ prior_status: string | null }>(
        `SELECT prior_status FROM equipment_work_orders WHERE tenant_id=? AND asset_id=? AND status='in_progress' ORDER BY started_at,id LIMIT 1`,
        tenant,
        order.asset_id,
      );
      run(
        `UPDATE equipment_work_orders SET status='in_progress',prior_status=?,started_at=? WHERE tenant_id=? AND id=?`,
        baseline?.prior_status ?? current.status,
        now,
        tenant,
        orderId,
      );
      run(
        `UPDATE assets SET status='maintenance',updated_at=? WHERE tenant_id=? AND id=?`,
        now,
        tenant,
        order.asset_id,
      );
    });
    res.json(
      get(`${orderSelect} WHERE w.tenant_id=? AND w.id=?`, tenant, orderId),
    );
  }),
);
equipmentOperationsRouter.post(
  "/erp/equipment-work-orders/:id/complete",
  handle((req, res) => {
    const tenant = req.tenant.id,
      orderId = pathId(req.params.id),
      b = body(req.body, ["return_to_service", "completed_meter", "notes"]);
    if (typeof b.return_to_service !== "boolean")
      throw new EquipmentError(
        400,
        "return_to_service must be explicitly true or false",
      );
    const meter =
        b.completed_meter == null
          ? null
          : amount(b.completed_meter, "completed_meter"),
      notes =
        b.notes === undefined ? undefined : text(b.notes, "notes", 4000, true);
    transaction(() => {
      const order = get<WorkOrder>(
        "SELECT * FROM equipment_work_orders WHERE tenant_id=? AND id=?",
        tenant,
        orderId,
      );
      if (!order) throw new EquipmentError(404, "work order not found");
      if (order.status === "completed") {
        if (
          order.returned_to_service !== Number(b.return_to_service) ||
          (b.completed_meter !== undefined &&
            order.completed_meter !== meter) ||
          (notes !== undefined && order.notes !== notes)
        )
          throw new EquipmentError(409, "completed work orders are immutable");
        return;
      }
      if (order.status !== "in_progress")
        throw new EquipmentError(
          409,
          "start the work order before completing it",
        );
      const current = asset(tenant, order.asset_id),
        now = new Date().toISOString();
      if (current.status === "retired" && b.return_to_service)
        throw new EquipmentError(
          409,
          "retired assets cannot be returned to service",
        );
      run(
        `UPDATE equipment_work_orders SET status='completed',completed_at=?,completed_meter=?,returned_to_service=?,notes=? WHERE tenant_id=? AND id=?`,
        now,
        meter,
        Number(b.return_to_service),
        notes ?? order.notes,
        tenant,
        orderId,
      );
      const remaining = get(
        `SELECT id FROM equipment_work_orders WHERE tenant_id=? AND asset_id=? AND status='in_progress'`,
        tenant,
        order.asset_id,
      );
      if (!remaining && current.status !== "retired")
        run(
          "UPDATE assets SET status=?,updated_at=? WHERE tenant_id=? AND id=?",
          b.return_to_service ? "active" : "down",
          now,
          tenant,
          order.asset_id,
        );
      if (
        order.jobsite_id !== null &&
        order.parts_cost + order.labor_cost > 0 &&
        !get(
          "SELECT work_order_id FROM equipment_cost_links WHERE tenant_id=? AND work_order_id=?",
          tenant,
          orderId,
        )
      ) {
        job(tenant, order.jobsite_id);
        const localDate = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Chicago",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());
        const entry = run(
          `INSERT INTO job_cost_entries(tenant_id,jobsite_id,date,cost_code,category,amount,description) VALUES (?,?,?,?,'equipment',?,?)`,
          tenant,
          order.jobsite_id,
          localDate,
          order.cost_code,
          order.parts_cost + order.labor_cost,
          `Equipment work order #${orderId}: ${order.title}`,
        );
        run(
          "INSERT INTO equipment_cost_links(work_order_id,tenant_id,cost_entry_id) VALUES (?,?,?)",
          orderId,
          tenant,
          Number(entry.lastInsertRowid),
        );
      }
      if (order.type === "preventive" && order.service_rule_id !== null) {
        const localDate = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Chicago",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());
        run(
          `UPDATE equipment_service_rules SET last_completed_date=?,last_completed_meter=? WHERE tenant_id=? AND asset_id=? AND id=?`,
          localDate,
          meter,
          tenant,
          order.asset_id,
          order.service_rule_id,
        );
      }
    });
    res.json(
      get(`${orderSelect} WHERE w.tenant_id=? AND w.id=?`, tenant, orderId),
    );
  }),
);

equipmentOperationsRouter.post(
  "/erp/equipment-service-rules",
  handle((req, res) => {
    const tenant = req.tenant.id,
      b = body(req.body, [
        "asset_id",
        "name",
        "interval_hours",
        "interval_days",
        "last_completed_date",
        "last_completed_meter",
      ]);
    const assetId = id(b.asset_id, "asset_id"),
      name = text(b.name, "name", 200),
      hours =
        b.interval_hours == null
          ? null
          : amount(b.interval_hours, "interval_hours");
    const days =
      b.interval_days == null ? null : id(b.interval_days, "interval_days");
    if (hours === 0 || (hours === null && days === null))
      throw new EquipmentError(
        400,
        "at least one positive service interval is required",
      );
    const completed =
        b.last_completed_date == null
          ? null
          : date(b.last_completed_date, "last_completed_date"),
      meter =
        b.last_completed_meter == null
          ? null
          : amount(b.last_completed_meter, "last_completed_meter");
    asset(tenant, assetId);
    const ruleId = Number(
      run(
        `INSERT INTO equipment_service_rules(tenant_id,asset_id,name,interval_hours,interval_days,last_completed_date,last_completed_meter) VALUES (?,?,?,?,?,?,?)`,
        tenant,
        assetId,
        name,
        hours,
        days,
        completed,
        meter,
      ).lastInsertRowid,
    );
    res
      .status(201)
      .json(
        equipmentServiceRules(tenant).find(
          (rule) => (rule as unknown as { id: number }).id === ruleId,
        ),
      );
  }),
);
equipmentOperationsRouter.post(
  "/erp/equipment-inspections",
  handle((req, res) => {
    const tenant = req.tenant.id,
      b = body(req.body, [
        "asset_id",
        "date",
        "inspector_id",
        "passed",
        "findings",
      ]);
    const assetId = id(b.asset_id, "asset_id"),
      inspectorId = id(b.inspector_id, "inspector_id"),
      inspected = date(b.date, "date"),
      findings = text(b.findings ?? "", "findings", 4000, true);
    if (typeof b.passed !== "boolean")
      throw new EquipmentError(400, "passed must be a boolean");
    if (!b.passed && !findings)
      throw new EquipmentError(400, "failed inspections require findings");
    const inspectionId = transaction(() => {
      const current = asset(tenant, assetId);
      person(tenant, inspectorId);
      const result = run(
        "INSERT INTO equipment_inspections(tenant_id,asset_id,date,inspector_id,passed,findings) VALUES (?,?,?,?,?,?)",
        tenant,
        assetId,
        inspected,
        inspectorId,
        Number(b.passed),
        findings,
      );
      if (!b.passed && current.status !== "retired")
        run(
          `UPDATE assets SET status='down',updated_at=? WHERE tenant_id=? AND id=?`,
          new Date().toISOString(),
          tenant,
          assetId,
        );
      return Number(result.lastInsertRowid);
    });
    res
      .status(201)
      .json(
        get(
          `${inspectionSelect} WHERE i.tenant_id=? AND i.id=?`,
          tenant,
          inspectionId,
        ),
      );
  }),
);
