/** Purchase commitments and project controls. Receiving a PO does not post job costs. */
import { Router, type Request, type Response } from 'express';
import { all, get, run } from '../../db/database.js';

export const commercialRouter = Router();

type PurchaseOrderStatus = 'draft' | 'approved' | 'received';
type ControlKind = 'rfi' | 'change_order' | 'issue';
type ControlStatus = 'open' | 'closed';

export interface PurchaseOrderRow {
  id: number;
  tenant_id: number;
  jobsite_id: number;
  vendor: string;
  description: string;
  cost_code: string;
  amount: number;
  status: PurchaseOrderStatus;
  order_date: string;
  expected_date: string | null;
  created_at: string;
  jobsite_name: string;
  jobsite_code: string;
}

export interface ProjectControlRow {
  id: number;
  tenant_id: number;
  jobsite_id: number;
  kind: ControlKind;
  title: string;
  description: string;
  owner_id: number | null;
  due_date: string | null;
  status: ControlStatus;
  amount: number | null;
  created_at: string;
  jobsite_name: string;
  jobsite_code: string;
  owner_name: string | null;
}

class RequestError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}

function handle(fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: (error?: unknown) => void) => {
    try { fn(req, res); }
    catch (error) {
      if (error instanceof RequestError) res.status(error.status).json({ error: error.message });
      else next(error);
    }
  };
}

function body(value: unknown, allowed: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, 'request body must be a JSON object');
  }
  const result = value as Record<string, unknown>;
  const unsupported = Object.keys(result).filter((key) => !allowed.includes(key));
  if (unsupported.length) throw new RequestError(400, `unsupported fields: ${unsupported.join(', ')}`);
  return result;
}

function id(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RequestError(400, `${field} must be a positive integer`);
  }
  return value;
}

function pathId(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new RequestError(400, 'id must be a positive integer');
  }
  return id(Number(value), 'id');
}

function string(value: unknown, field: string, maxLength: number, allowBlank = false): string {
  if (typeof value !== 'string') throw new RequestError(400, `${field} must be a string`);
  const result = value.trim();
  if ((!allowBlank && result.length === 0) || result.length > maxLength) {
    throw new RequestError(400, `${field} must contain ${allowBlank ? '0' : '1'} to ${maxLength} characters`);
  }
  return result;
}

function date(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RequestError(400, `${field} must be a valid YYYY-MM-DD date`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RequestError(400, `${field} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function amount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RequestError(400, 'amount must be a finite nonnegative number');
  }
  return value;
}

function jobsite(tenantId: number, jobsiteId: number): void {
  if (!get('SELECT id FROM jobsites WHERE tenant_id = ? AND id = ?', tenantId, jobsiteId)) {
    throw new RequestError(404, 'jobsite not found');
  }
}

const purchaseOrderSelect = `SELECT po.*, j.name AS jobsite_name, j.code AS jobsite_code
  FROM purchase_orders po
  JOIN jobsites j ON j.id = po.jobsite_id AND j.tenant_id = po.tenant_id`;
const controlSelect = `SELECT pc.*, j.name AS jobsite_name, j.code AS jobsite_code,
  e.name AS owner_name
  FROM project_controls pc
  JOIN jobsites j ON j.id = pc.jobsite_id AND j.tenant_id = pc.tenant_id
  LEFT JOIN employees e ON e.id = pc.owner_id AND e.tenant_id = pc.tenant_id`;

commercialRouter.get('/erp/commercial', handle((req, res) => {
  const tenantId = req.tenant.id;
  res.json({
    purchase_orders: all<PurchaseOrderRow>(`${purchaseOrderSelect}
      WHERE po.tenant_id = ? ORDER BY po.order_date DESC, po.id DESC`, tenantId),
    controls: all<ProjectControlRow>(`${controlSelect}
      WHERE pc.tenant_id = ? ORDER BY pc.created_at DESC, pc.id DESC`, tenantId),
  });
}));

commercialRouter.post('/erp/purchase-orders', handle((req, res) => {
  const tenantId = req.tenant.id;
  const b = body(req.body, ['jobsite_id', 'vendor', 'description', 'cost_code', 'amount', 'order_date', 'expected_date']);
  const jobsiteId = id(b.jobsite_id, 'jobsite_id');
  const vendor = string(b.vendor, 'vendor', 200);
  const description = string(b.description ?? '', 'description', 4000, true);
  const costCode = string(b.cost_code ?? '', 'cost_code', 80, true);
  const value = amount(b.amount);
  const orderDate = date(b.order_date, 'order_date');
  const expectedDate = b.expected_date == null ? null : date(b.expected_date, 'expected_date');
  jobsite(tenantId, jobsiteId);
  const result = run(`INSERT INTO purchase_orders
    (tenant_id, jobsite_id, vendor, description, cost_code, amount, status, order_date, expected_date)
    VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    tenantId, jobsiteId, vendor, description, costCode, value, orderDate, expectedDate);
  res.status(201).json(get<PurchaseOrderRow>(`${purchaseOrderSelect}
    WHERE po.tenant_id = ? AND po.id = ?`, tenantId, Number(result.lastInsertRowid)));
}));

commercialRouter.patch('/erp/purchase-orders/:id', handle((req, res) => {
  const tenantId = req.tenant.id;
  const purchaseOrderId = pathId(req.params.id);
  const b = body(req.body, ['status']);
  if (b.status !== 'draft' && b.status !== 'approved' && b.status !== 'received') {
    throw new RequestError(400, 'status must be draft, approved or received');
  }
  const existing = get<{ status: PurchaseOrderStatus }>(
    'SELECT status FROM purchase_orders WHERE tenant_id = ? AND id = ?', tenantId, purchaseOrderId);
  if (!existing) throw new RequestError(404, 'purchase order not found');
  if (get("SELECT name FROM sqlite_master WHERE type='table' AND name='procurement_orders'") &&
      get('SELECT order_id FROM procurement_orders WHERE tenant_id=? AND order_id=?',tenantId,purchaseOrderId)) {
    throw new RequestError(409,'Use item order approval and partial receiving for this purchase order');
  }
  const nextStatus: Partial<Record<PurchaseOrderStatus, PurchaseOrderStatus>> = {
    draft: 'approved', approved: 'received',
  };
  if (existing.status !== b.status && nextStatus[existing.status] !== b.status) {
    throw new RequestError(409, `cannot change purchase order from ${existing.status} to ${b.status}`);
  }
  run('UPDATE purchase_orders SET status = ? WHERE tenant_id = ? AND id = ?',
    b.status, tenantId, purchaseOrderId);
  res.json(get<PurchaseOrderRow>(`${purchaseOrderSelect}
    WHERE po.tenant_id = ? AND po.id = ?`, tenantId, purchaseOrderId));
}));

commercialRouter.post('/erp/controls', handle((req, res) => {
  const tenantId = req.tenant.id;
  const b = body(req.body, ['jobsite_id', 'kind', 'title', 'description', 'owner_id', 'due_date', 'amount']);
  const jobsiteId = id(b.jobsite_id, 'jobsite_id');
  if (b.kind !== 'rfi' && b.kind !== 'change_order' && b.kind !== 'issue') {
    throw new RequestError(400, 'kind must be rfi, change_order or issue');
  }
  const title = string(b.title, 'title', 240);
  const description = string(b.description ?? '', 'description', 4000, true);
  const ownerId = b.owner_id == null ? null : id(b.owner_id, 'owner_id');
  const dueDate = b.due_date == null ? null : date(b.due_date, 'due_date');
  const value = b.kind === 'change_order' ? amount(b.amount) : null;
  if (b.kind !== 'change_order' && b.amount != null) {
    throw new RequestError(400, 'amount is only supported for change orders');
  }
  jobsite(tenantId, jobsiteId);
  if (ownerId !== null && !get('SELECT id FROM employees WHERE tenant_id = ? AND id = ?', tenantId, ownerId)) {
    throw new RequestError(404, 'owner not found');
  }
  const result = run(`INSERT INTO project_controls
    (tenant_id, jobsite_id, kind, title, description, owner_id, due_date, status, amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    tenantId, jobsiteId, b.kind, title, description, ownerId, dueDate, value);
  res.status(201).json(get<ProjectControlRow>(`${controlSelect}
    WHERE pc.tenant_id = ? AND pc.id = ?`, tenantId, Number(result.lastInsertRowid)));
}));

commercialRouter.patch('/erp/controls/:id', handle((req, res) => {
  const tenantId = req.tenant.id;
  const controlId = pathId(req.params.id);
  const b = body(req.body, ['status']);
  if (b.status !== 'open' && b.status !== 'closed') {
    throw new RequestError(400, 'status must be open or closed');
  }
  const existing = get('SELECT id FROM project_controls WHERE tenant_id = ? AND id = ?', tenantId, controlId);
  if (!existing) throw new RequestError(404, 'project control not found');
  run('UPDATE project_controls SET status = ? WHERE tenant_id = ? AND id = ?', b.status, tenantId, controlId);
  res.json(get<ProjectControlRow>(`${controlSelect}
    WHERE pc.tenant_id = ? AND pc.id = ?`, tenantId, controlId));
}));
