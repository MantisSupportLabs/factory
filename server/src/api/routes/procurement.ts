import { Router, type Request, type Response } from 'express';
import { all, get, run, transaction } from '../../db/database.js';
import { assertNoReportMaterialCost, assertProjectAcceptsProcurement } from '../../erp/procurement.js';
import { ErpError } from '../../erp/validation.js';

export const procurementRouter = Router();

class ProcurementError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}
function handle(fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: (error?: unknown) => void) => {
    try { fn(req, res); }
    catch (error) {
      if (error instanceof ProcurementError || error instanceof ErpError) res.status(error.status).json({ error: error.message });
      else next(error);
    }
  };
}
function body(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProcurementError(400, 'Expected a JSON object');
  const b = value as Record<string, unknown>;
  const unsupported = Object.keys(b).filter(key => !allowed.includes(key));
  if (unsupported.length) throw new ProcurementError(400, `Unsupported fields: ${unsupported.join(', ')}`);
  return b;
}
function id(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new ProcurementError(400, `${label} must be a positive integer`);
  return value;
}
function pathId(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new ProcurementError(400, 'Invalid record ID');
  return id(Number(value), 'id');
}
function text(value: unknown, label: string, max = 240, blank = false): string {
  if (typeof value !== 'string' || value.trim().length > max || (!blank && !value.trim())) throw new ProcurementError(400, `${label} must contain ${blank ? '0' : '1'} to ${max} characters`);
  return value.trim();
}
function date(value: unknown, label = 'date'): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ProcurementError(400, `${label} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new ProcurementError(400, `${label} is not a calendar date`);
  return value;
}
function quantity(value: unknown, label = 'quantity', signed = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e9 || (!signed && value <= 0)
    || Math.abs(value * 1e6 - Math.round(value * 1e6)) > 0.000001) throw new ProcurementError(400, `${label} must be ${signed ? 'a finite' : 'a positive'} number with at most 6 decimal places`);
  const normalized = Math.round(value * 1e6) / 1e6;
  if (!signed && normalized <= 0) throw new ProcurementError(400, `${label} must be at least 0.000001`);
  return normalized;
}
function cents(value: unknown, label: string, signed = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e9 || (!signed && value < 0)) throw new ProcurementError(400, `${label} must be ${signed ? 'a finite' : 'a nonnegative'} monetary amount`);
  const result = Math.round(value * 100);
  if (Math.abs(value * 100 - result) > 0.00001) throw new ProcurementError(400, `${label} must have at most 2 decimal places`);
  return result;
}
function multiply(qty: number, unitCents: number): number {
  const result = Math.round(qty * unitCents);
  if (!Number.isSafeInteger(result) || result > 1e13) throw new ProcurementError(400, 'Line amount is too large');
  return result;
}
function lines(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new ProcurementError(400, 'Provide 1 to 100 lines');
  return value as Record<string, unknown>[];
}
function unique(values: number[]): void {
  if (new Set(values).size !== values.length) throw new ProcurementError(400, 'A line can only appear once per record');
}
function requireJob(tenant: number, jobId: number): void {
  if (!get('SELECT id FROM jobsites WHERE tenant_id=? AND id=?', tenant, jobId)) throw new ProcurementError(404, 'Project not found');
}

interface Order { id: number; tenant_id: number; jobsite_id: number; status: string; vendor_id: number; order_date: string }
interface Line { id: number; order_id: number; description: string; unit: string; cost_code: string; quantity: number; unit_price_cents: number; line_amount_cents: number; received_qty: number; issued_qty: number; invoiced_qty: number; issued_amount_cents: number; invoiced_amount_cents: number }
const lineSelect = `SELECT l.*,
  COALESCE((SELECT SUM(r.quantity) FROM material_receipt_lines r WHERE r.tenant_id=l.tenant_id AND r.line_id=l.id),0) received_qty,
  COALESCE((SELECT SUM(i.quantity) FROM material_issues i WHERE i.tenant_id=l.tenant_id AND i.line_id=l.id),0) issued_qty,
  COALESCE((SELECT SUM(i.amount_cents) FROM material_issues i WHERE i.tenant_id=l.tenant_id AND i.line_id=l.id),0) issued_amount_cents,
  COALESCE((SELECT SUM(i.quantity) FROM supplier_invoice_lines i WHERE i.tenant_id=l.tenant_id AND i.line_id=l.id),0) invoiced_qty,
  COALESCE((SELECT SUM(i.amount_cents) FROM supplier_invoice_lines i WHERE i.tenant_id=l.tenant_id AND i.line_id=l.id),0) invoiced_amount_cents
  FROM po_lines l`;
function order(tenant: number, orderId: number): Order {
  const found = get<Order>(`SELECT p.*, o.vendor_id FROM procurement_orders o
    JOIN purchase_orders p ON p.id=o.order_id AND p.tenant_id=o.tenant_id WHERE o.tenant_id=? AND o.order_id=?`, tenant, orderId);
  if (!found) throw new ProcurementError(404, 'Item purchase order not found');
  return found;
}
function orderLine(tenant: number, orderId: number, lineId: number): Line {
  const found = get<Line>(`${lineSelect} WHERE l.tenant_id=? AND l.order_id=? AND l.id=?`, tenant, orderId, lineId);
  if (!found) throw new ProcurementError(404, 'Order line not found');
  return found;
}
function serialLine(line: Line) {
  return { ...line, unit_price: line.unit_price_cents / 100, line_amount: line.line_amount_cents / 100,
    available_qty: Math.max(0, Math.round((line.received_qty - line.issued_qty) * 1e6) / 1e6),
    unconsumed_amount: (line.line_amount_cents - line.issued_amount_cents) / 100 };
}
function readOrder(tenant: number, orderId: number) {
  const header = get(`SELECT p.*, j.name jobsite_name, j.code jobsite_code, o.vendor_id
    FROM purchase_orders p JOIN jobsites j ON j.id=p.jobsite_id AND j.tenant_id=p.tenant_id
    JOIN procurement_orders o ON o.order_id=p.id AND o.tenant_id=p.tenant_id WHERE p.tenant_id=? AND p.id=?`, tenant, orderId);
  const orderLines = all<Line>(`${lineSelect} WHERE l.tenant_id=? AND l.order_id=? ORDER BY l.id`, tenant, orderId).map(serialLine);
  return { ...header, item_tracking: true, lines: orderLines,
    outstanding_commitment: orderLines.reduce((sum, line) => sum + line.line_amount_cents - line.issued_amount_cents, 0) / 100 };
}

procurementRouter.get('/erp/procurement', handle((req, res) => {
  const t = req.tenant.id;
  const orders = all<{ id: number; vendor_id: number | null; amount: number; status: string }>(`SELECT p.*, j.name jobsite_name,
    j.code jobsite_code, o.vendor_id FROM purchase_orders p JOIN jobsites j ON j.id=p.jobsite_id AND j.tenant_id=p.tenant_id
    LEFT JOIN procurement_orders o ON o.order_id=p.id AND o.tenant_id=p.tenant_id WHERE p.tenant_id=? ORDER BY p.id DESC`, t);
  const receiptLines = all(`SELECT r.*, l.description, l.unit FROM material_receipt_lines r
    JOIN po_lines l ON l.id=r.line_id AND l.tenant_id=r.tenant_id WHERE r.tenant_id=? ORDER BY r.id`, t);
  const invoiceLines = all<{ invoice_id: number }>(`SELECT i.*, l.description, l.unit, i.unit_price_cents/100.0 unit_price,
    i.amount_cents/100.0 amount FROM supplier_invoice_lines i JOIN po_lines l ON l.id=i.line_id AND l.tenant_id=i.tenant_id
    WHERE i.tenant_id=? ORDER BY i.id`, t);
  res.json({
    vendors: all('SELECT * FROM material_vendors WHERE tenant_id=? ORDER BY name', t),
    items: all('SELECT * FROM material_items WHERE tenant_id=? ORDER BY description', t),
    orders: orders.map(po => po.vendor_id == null ? { ...po, item_tracking: false, lines: [],
      outstanding_commitment: po.status === 'draft' ? 0 : po.amount } : readOrder(t, po.id)),
    receipts: all<{ id: number }>(`SELECT r.*, j.name jobsite_name, p.vendor FROM material_receipts r
      JOIN purchase_orders p ON p.id=r.order_id AND p.tenant_id=r.tenant_id
      JOIN jobsites j ON j.id=p.jobsite_id AND j.tenant_id=p.tenant_id WHERE r.tenant_id=? ORDER BY r.id DESC`, t)
      .map(receipt => ({ ...receipt, lines: receiptLines.filter(line => line.receipt_id === receipt.id) })),
    issues: all(`SELECT i.*, l.description, l.unit, j.name jobsite_name, i.unit_price_cents/100.0 unit_price,
      i.amount_cents/100.0 amount FROM material_issues i JOIN po_lines l ON l.id=i.line_id AND l.tenant_id=i.tenant_id
      JOIN jobsites j ON j.id=i.jobsite_id AND j.tenant_id=i.tenant_id WHERE i.tenant_id=? ORDER BY i.id DESC`, t),
    invoices: all<{ id: number; amount_cents: number; paid_cents: number }>(`SELECT i.*, v.name vendor_name, j.name jobsite_name,
      COALESCE((SELECT SUM(p.amount_cents) FROM supplier_payments p WHERE p.tenant_id=i.tenant_id AND p.invoice_id=i.id),0) paid_cents
      FROM supplier_invoices i JOIN material_vendors v ON v.id=i.vendor_id AND v.tenant_id=i.tenant_id
      JOIN purchase_orders po ON po.id=i.order_id AND po.tenant_id=i.tenant_id
      JOIN jobsites j ON j.id=po.jobsite_id AND j.tenant_id=po.tenant_id WHERE i.tenant_id=? ORDER BY i.id DESC`, t)
      .map(invoice => ({ ...invoice, amount: invoice.amount_cents / 100, paid_amount: invoice.paid_cents / 100,
        open_amount: (invoice.amount_cents - invoice.paid_cents) / 100,
        lines: invoiceLines.filter(line => line.invoice_id === invoice.id) })),
    payments: all('SELECT *, amount_cents/100.0 amount FROM supplier_payments WHERE tenant_id=? ORDER BY id DESC', t),
    changes: all(`SELECT c.*, pc.title, j.name jobsite_name, c.contract_delta_cents/100.0 contract_delta,
      c.budget_delta_cents/100.0 budget_delta, c.before_contract_cents/100.0 before_contract, c.after_contract_cents/100.0 after_contract,
      c.before_budget_cents/100.0 before_budget, c.after_budget_cents/100.0 after_budget
      FROM approved_project_changes c JOIN project_controls pc ON pc.id=c.control_id AND pc.tenant_id=c.tenant_id
      JOIN jobsites j ON j.id=c.jobsite_id AND j.tenant_id=c.tenant_id WHERE c.tenant_id=? ORDER BY c.id DESC`, t),
    controls: all('SELECT * FROM project_controls WHERE tenant_id=? AND kind=\'change_order\' ORDER BY id DESC', t),
  });
}));

procurementRouter.post('/erp/vendors', handle((req, res) => {
  const t = req.tenant.id, b = body(req.body, ['name', 'email', 'phone']);
  const name = text(b.name, 'name', 200), email = text(b.email ?? '', 'email', 240, true), phone = text(b.phone ?? '', 'phone', 80, true);
  if (get('SELECT id FROM material_vendors WHERE tenant_id=? AND name=?', t, name)) throw new ProcurementError(409, 'Vendor already exists');
  const result = run('INSERT INTO material_vendors(tenant_id,name,email,phone) VALUES (?,?,?,?)', t, name, email, phone);
  res.status(201).json(get('SELECT * FROM material_vendors WHERE tenant_id=? AND id=?', t, Number(result.lastInsertRowid)));
}));
procurementRouter.post('/erp/material-items', handle((req, res) => {
  const t = req.tenant.id, b = body(req.body, ['description', 'unit']);
  const description = text(b.description, 'description'), unit = text(b.unit, 'unit', 20).toUpperCase();
  if (get('SELECT id FROM material_items WHERE tenant_id=? AND description=? AND unit=?', t, description, unit)) throw new ProcurementError(409, 'Material item already exists');
  const result = run('INSERT INTO material_items(tenant_id,description,unit) VALUES (?,?,?)', t, description, unit);
  res.status(201).json(get('SELECT * FROM material_items WHERE tenant_id=? AND id=?', t, Number(result.lastInsertRowid)));
}));

procurementRouter.post('/erp/line-orders', handle((req, res) => {
  const t = req.tenant.id, b = body(req.body, ['jobsite_id', 'vendor_id', 'order_date', 'expected_date', 'description', 'lines']);
  const job = id(b.jobsite_id, 'jobsite_id'), vendorId = id(b.vendor_id, 'vendor_id');
  requireJob(t, job);
  assertProjectAcceptsProcurement(t, job);
  const vendor = get<{ name: string }>('SELECT name FROM material_vendors WHERE tenant_id=? AND id=?', t, vendorId);
  if (!vendor) throw new ProcurementError(404, 'Vendor not found');
  const ordered = date(b.order_date, 'order_date'), expected = b.expected_date == null ? null : date(b.expected_date, 'expected_date');
  if (expected && expected < ordered) throw new ProcurementError(400, 'Expected date cannot precede order date');
  const description = text(b.description ?? '', 'description', 4000, true);
  const rows = lines(b.lines).map(raw => {
    const l = body(raw, ['item_id', 'description', 'unit', 'quantity', 'unit_price', 'cost_code']);
    const itemId = l.item_id == null ? null : id(l.item_id, 'item_id');
    const item = itemId == null ? undefined : get<{ description: string; unit: string }>('SELECT description,unit FROM material_items WHERE tenant_id=? AND id=?', t, itemId);
    if (itemId != null && !item) throw new ProcurementError(404, 'Material item not found');
    const desc = text(l.description ?? item?.description, 'description');
    const unit = text(l.unit ?? item?.unit, 'unit', 20).toUpperCase();
    if (item && unit !== item.unit) throw new ProcurementError(400, 'Item unit must match catalog unit');
    const qty = quantity(l.quantity), price = cents(l.unit_price, 'unit_price');
    return { itemId, desc, unit, qty, price, amount: multiply(qty, price), code: text(l.cost_code, 'cost_code', 80) };
  });
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  if (!Number.isSafeInteger(total) || total > 1e13) throw new ProcurementError(400, 'Order total is too large');
  const orderId = transaction(() => {
    const result = run(`INSERT INTO purchase_orders(tenant_id,jobsite_id,vendor,description,cost_code,amount,status,order_date,expected_date)
      VALUES (?,?,?,?,?,?,'draft',?,?)`, t, job, vendor.name, description, rows[0].code, total / 100, ordered, expected);
    const key = Number(result.lastInsertRowid);
    run('INSERT INTO procurement_orders(order_id,tenant_id,vendor_id) VALUES (?,?,?)', key, t, vendorId);
    for (const l of rows) run(`INSERT INTO po_lines(tenant_id,order_id,item_id,description,unit,cost_code,quantity,unit_price_cents,line_amount_cents)
      VALUES (?,?,?,?,?,?,?,?,?)`, t, key, l.itemId, l.desc, l.unit, l.code, l.qty, l.price, l.amount);
    return key;
  });
  res.status(201).json(readOrder(t, orderId));
}));

procurementRouter.post('/erp/line-orders/:id/approve', handle((req, res) => {
  body(req.body ?? {}, []);
  const t = req.tenant.id, key = pathId(req.params.id), po = order(t, key);
  assertProjectAcceptsProcurement(t, po.jobsite_id);
  if (po.status === 'received') throw new ProcurementError(409, 'Received orders cannot be reapproved');
  if (po.status === 'draft') run("UPDATE purchase_orders SET status='approved' WHERE tenant_id=? AND id=?", t, key);
  res.json(readOrder(t, key));
}));

procurementRouter.post('/erp/line-orders/:id/receive', handle((req, res) => {
  const t = req.tenant.id, key = pathId(req.params.id), b = body(req.body, ['date', 'reference', 'lines']);
  const received = date(b.date), reference = text(b.reference, 'Delivery ticket reference');
  const rows = lines(b.lines).map(raw => {
    const l = body(raw, ['line_id', 'quantity']);
    return { key: id(l.line_id, 'line_id'), qty: quantity(l.quantity) };
  });
  unique(rows.map(l => l.key));
  const receiptId = transaction(() => {
    const po = order(t, key);
    assertProjectAcceptsProcurement(t, po.jobsite_id);
    if (po.status !== 'approved') throw new ProcurementError(409, 'Only approved, incomplete orders can receive materials');
    if (received < po.order_date) throw new ProcurementError(400, 'Delivery date cannot precede order date');
    if (get('SELECT id FROM material_receipts WHERE tenant_id=? AND order_id=? AND reference=?', t, key, reference)) throw new ProcurementError(409, 'Delivery ticket already recorded');
    for (const row of rows) {
      const line = orderLine(t, key, row.key);
      if (row.qty > Math.round((line.quantity - line.received_qty) * 1e6) / 1e6) throw new ProcurementError(409, 'Receipt exceeds unreceived order quantity');
    }
    const result = run('INSERT INTO material_receipts(tenant_id,order_id,date,reference) VALUES (?,?,?,?)', t, key, received, reference);
    const receipt = Number(result.lastInsertRowid);
    for (const l of rows) run('INSERT INTO material_receipt_lines(tenant_id,receipt_id,line_id,quantity) VALUES (?,?,?,?)', t, receipt, l.key, l.qty);
    const incomplete = all<Line>(`${lineSelect} WHERE l.tenant_id=? AND l.order_id=?`, t, key).some(l => Math.round((l.quantity - l.received_qty) * 1e6) > 0);
    if (!incomplete) run("UPDATE purchase_orders SET status='received' WHERE tenant_id=? AND id=?", t, key);
    return receipt;
  });
  res.status(201).json({ id: receiptId, order: readOrder(t, key) });
}));

procurementRouter.post('/erp/material-issues', handle((req, res) => {
  const t = req.tenant.id, b = body(req.body, ['jobsite_id', 'line_id', 'quantity', 'date', 'reference']);
  const job = id(b.jobsite_id, 'jobsite_id'), lineKey = id(b.line_id, 'line_id'), qty = quantity(b.quantity);
  const used = date(b.date), reference = text(b.reference, 'Material usage reference');
  const issueId = transaction(() => {
    requireJob(t, job);
    const found = get<{ order_id: number }>('SELECT order_id FROM po_lines WHERE tenant_id=? AND id=?', t, lineKey);
    if (!found) throw new ProcurementError(404, 'Order line not found');
    const po = order(t, found.order_id), l = orderLine(t, found.order_id, lineKey);
    assertProjectAcceptsProcurement(t, po.jobsite_id);
    if (po.jobsite_id !== job) throw new ProcurementError(409, 'Stock is reserved to its purchase order project; a transfer is required for another job');
    if (po.status === 'draft') throw new ProcurementError(409, 'Draft order material cannot be issued');
    if (get('SELECT id FROM material_issues WHERE tenant_id=? AND reference=?', t, reference)) throw new ProcurementError(409, 'Material usage reference already posted');
    const lots = all<{ id: number; available: number }>(`SELECT r.id, r.quantity-COALESCE((SELECT SUM(x.quantity)
      FROM material_issue_lots x WHERE x.tenant_id=r.tenant_id AND x.receipt_line_id=r.id),0) available
      FROM material_receipt_lines r JOIN material_receipts receipt ON receipt.id=r.receipt_id AND receipt.tenant_id=r.tenant_id
      WHERE r.tenant_id=? AND r.line_id=? AND receipt.date<=? ORDER BY receipt.date,r.id`, t, lineKey, used)
      .map(lot => ({ ...lot, available: Math.max(0, Math.round(lot.available * 1e6) / 1e6) }));
    if (qty > Math.round(lots.reduce((sum, lot) => sum + lot.available, 0) * 1e6) / 1e6) throw new ProcurementError(409, 'Usage exceeds received stock available on this date');
    // Allocate cumulative line cents to avoid penny drift when fractional quantities are split.
    const costCents = multiply(Math.round((l.issued_qty + qty) * 1e6) / 1e6, l.unit_price_cents) - l.issued_amount_cents;
    if (costCents > 0) assertNoReportMaterialCost(t, job, l.cost_code, used);
    const cost = run(`INSERT INTO job_cost_entries(tenant_id,jobsite_id,date,cost_code,category,amount,description)
      VALUES (?,?,?,?,'material',?,?)`, t, job, used, l.cost_code, costCents / 100, `Material usage ${reference}: ${qty} ${l.unit} ${l.description} (PO ${po.id})`);
    const result = run(`INSERT INTO material_issues(tenant_id,jobsite_id,line_id,date,reference,quantity,unit_price_cents,amount_cents,cost_entry_id)
      VALUES (?,?,?,?,?,?,?,?,?)`, t, job, lineKey, used, reference, qty, l.unit_price_cents, costCents, Number(cost.lastInsertRowid));
    const issue = Number(result.lastInsertRowid);
    let remaining = qty;
    for (const lot of lots) {
      const allocated = Math.min(remaining, lot.available);
      if (allocated > 0) run('INSERT INTO material_issue_lots(tenant_id,issue_id,receipt_line_id,quantity) VALUES (?,?,?,?)', t, issue, lot.id, allocated);
      remaining = Math.round((remaining - allocated) * 1e6) / 1e6;
      if (!remaining) break;
    }
    return issue;
  });
  res.status(201).json(get('SELECT *, amount_cents/100.0 amount,unit_price_cents/100.0 unit_price FROM material_issues WHERE tenant_id=? AND id=?', t, issueId));
}));

procurementRouter.post('/erp/supplier-invoices', handle((req, res) => {
  const t = req.tenant.id, b = body(req.body, ['order_id', 'reference', 'date', 'lines']);
  const orderId = id(b.order_id, 'order_id'), reference = text(b.reference, 'Supplier invoice reference'), invoiced = date(b.date);
  const parsed = lines(b.lines).map(raw => {
    const l = body(raw, ['line_id', 'quantity', 'unit_price']);
    return { key: id(l.line_id, 'line_id'), qty: quantity(l.quantity), price: cents(l.unit_price, 'unit_price') };
  });
  unique(parsed.map(l => l.key));
  const invoiceId = transaction(() => {
    const po = order(t, orderId);
    if (po.status === 'draft') throw new ProcurementError(409, 'Draft orders cannot be invoiced');
    if (invoiced < po.order_date) throw new ProcurementError(400, 'Invoice date cannot precede order date');
    if (get('SELECT id FROM supplier_invoices WHERE tenant_id=? AND vendor_id=? AND reference=?', t, po.vendor_id, reference)) throw new ProcurementError(409, 'Supplier invoice already recorded');
    const rows = parsed.map(row => {
      const l = orderLine(t, orderId, row.key);
      const eligible = get<{ qty: number }>(`SELECT COALESCE(SUM(r.quantity),0) qty FROM material_receipt_lines r
        JOIN material_receipts receipt ON receipt.id=r.receipt_id AND receipt.tenant_id=r.tenant_id
        WHERE r.tenant_id=? AND r.line_id=? AND receipt.date<=?`, t, row.key, invoiced)!.qty;
      if (row.qty > Math.round((eligible - l.invoiced_qty) * 1e6) / 1e6) throw new ProcurementError(409, 'Invoice quantity exceeds received, uninvoiced materials on this date');
      if (row.price !== l.unit_price_cents) throw new ProcurementError(409, 'Invoice price must match the approved purchase order; resolve the discrepancy before posting');
      return { ...row, amount: multiply(Math.round((l.invoiced_qty + row.qty) * 1e6) / 1e6, row.price) - l.invoiced_amount_cents };
    });
    const amount = rows.reduce((sum, l) => sum + l.amount, 0);
    const result = run('INSERT INTO supplier_invoices(tenant_id,order_id,vendor_id,date,reference,amount_cents) VALUES (?,?,?,?,?,?)', t, orderId, po.vendor_id, invoiced, reference, amount);
    const key = Number(result.lastInsertRowid);
    for (const l of rows) run('INSERT INTO supplier_invoice_lines(tenant_id,invoice_id,line_id,quantity,unit_price_cents,amount_cents) VALUES (?,?,?,?,?,?)', t, key, l.key, l.qty, l.price, l.amount);
    return key;
  });
  // AP is a separate liability ledger. Material costs were / will be recognized by stock usage.
  res.status(201).json(get('SELECT *, amount_cents/100.0 amount FROM supplier_invoices WHERE tenant_id=? AND id=?', t, invoiceId));
}));

procurementRouter.post('/erp/supplier-invoices/:id/pay', handle((req, res) => {
  const t = req.tenant.id, key = pathId(req.params.id), b = body(req.body, ['amount', 'date', 'reference']);
  const amount = cents(b.amount, 'amount'), paid = date(b.date), reference = text(b.reference, 'Payment reference');
  if (amount <= 0) throw new ProcurementError(400, 'Payment amount must be positive');
  const paymentId = transaction(() => {
    const invoice = get<{ date: string; amount_cents: number; paid_cents: number }>(`SELECT i.*,
      COALESCE((SELECT SUM(p.amount_cents) FROM supplier_payments p WHERE p.tenant_id=i.tenant_id AND p.invoice_id=i.id),0) paid_cents
      FROM supplier_invoices i WHERE i.tenant_id=? AND i.id=?`, t, key);
    if (!invoice) throw new ProcurementError(404, 'Supplier invoice not found');
    if (paid < invoice.date) throw new ProcurementError(400, 'Payment cannot precede invoice date');
    if (get('SELECT id FROM supplier_payments WHERE tenant_id=? AND reference=?', t, reference)) throw new ProcurementError(409, 'Payment reference already recorded');
    if (amount > invoice.amount_cents - invoice.paid_cents) throw new ProcurementError(409, 'Payment exceeds the open invoice balance');
    return Number(run('INSERT INTO supplier_payments(tenant_id,invoice_id,date,reference,amount_cents) VALUES (?,?,?,?,?)', t, key, paid, reference, amount).lastInsertRowid);
  });
  res.status(201).json(get('SELECT *, amount_cents/100.0 amount FROM supplier_payments WHERE tenant_id=? AND id=?', t, paymentId));
}));

procurementRouter.post('/erp/change-approvals', handle((req, res) => {
  const t = req.tenant.id, b = body(req.body, ['control_id', 'customer_reference', 'effective_date', 'contract_delta', 'budget_delta', 'plan_id', 'quantity_delta']);
  const controlId = id(b.control_id, 'control_id'), reference = text(b.customer_reference, 'Signed customer approval reference');
  const effective = date(b.effective_date, 'effective_date'), contractDelta = cents(b.contract_delta, 'contract_delta', true), budgetDelta = cents(b.budget_delta, 'budget_delta', true);
  const planId = b.plan_id == null ? null : id(b.plan_id, 'plan_id');
  if (planId == null && b.quantity_delta != null) throw new ProcurementError(400, 'A quantity adjustment requires a work item');
  const quantityDelta = planId == null ? null : quantity(b.quantity_delta ?? 0, 'quantity_delta', true);
  const approvalId = transaction(() => {
    const control = get<{ jobsite_id: number; kind: string }>('SELECT jobsite_id,kind FROM project_controls WHERE tenant_id=? AND id=?', t, controlId);
    if (!control) throw new ProcurementError(404, 'Change request not found');
    if (control.kind !== 'change_order') throw new ProcurementError(400, 'Only change requests can receive commercial approval');
    assertProjectAcceptsProcurement(t, control.jobsite_id);
    if (get('SELECT id FROM approved_project_changes WHERE tenant_id=? AND control_id=?', t, controlId)) throw new ProcurementError(409, 'This change was already approved; record a separate credit change for a reversal');
    const profile = get<{ contract_value: number; budget: number }>('SELECT contract_value,budget FROM project_profiles WHERE tenant_id=? AND jobsite_id=?', t, control.jobsite_id);
    if (!profile) throw new ProcurementError(409, 'Project must have a contract and budget profile before change approval');
    const beforeContract = Math.round(profile.contract_value * 100), beforeBudget = Math.round(profile.budget * 100);
    const afterContract = beforeContract + contractDelta, afterBudget = beforeBudget + budgetDelta;
    if (afterContract < 0 || afterBudget < 0) throw new ProcurementError(409, 'Change cannot make project contract or budget negative');
    if (afterContract > 1e13 || afterBudget > 1e13) throw new ProcurementError(400, 'Resulting project amount is too large');
    if (get("SELECT name FROM sqlite_master WHERE type='table' AND name='billing_pay_items'")) {
      const scheduled = get<{ amount: number }>('SELECT COALESCE(SUM(scheduled_value_cents),0) amount FROM billing_pay_items WHERE tenant_id=? AND jobsite_id=?', t, control.jobsite_id)!.amount;
      if (afterContract < scheduled) throw new ProcurementError(409, 'Revised contract cannot be less than the existing schedule of values; a signed billing schedule credit amendment is required first');
    }
    if (get("SELECT name FROM sqlite_master WHERE type='table' AND name='payment_applications'")) {
      const certified = get<{ amount: number }>("SELECT COALESCE(MAX(cumulative_earned_cents),0) amount FROM payment_applications WHERE tenant_id=? AND jobsite_id=? AND status='approved'", t, control.jobsite_id)!.amount;
      if (afterContract < certified) throw new ProcurementError(409, 'Revised contract cannot fall below certified billing; reconcile the approved billing before a credit change');
    }
    let beforeQty: number | null = null, afterQty: number | null = null, beforeWorkBudget: number | null = null, afterWorkBudget: number | null = null;
    if (planId != null) {
      const plan = get<{ planned_qty: number; budget: number }>(`SELECT p.planned_qty,w.budget FROM production_plans p
        JOIN work_item_profiles w ON w.plan_id=p.id AND w.tenant_id=p.tenant_id WHERE p.tenant_id=? AND p.jobsite_id=? AND p.id=?`, t, control.jobsite_id, planId);
      if (!plan) throw new ProcurementError(404, 'Budgeted work item not found on this project');
      beforeQty = plan.planned_qty;
      afterQty = Math.round((beforeQty + quantityDelta!) * 1e6) / 1e6;
      beforeWorkBudget = Math.round(plan.budget * 100);
      afterWorkBudget = beforeWorkBudget + budgetDelta;
      const reversalFilter = get("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_report_reversals'")
        ? ' AND NOT EXISTS(SELECT 1 FROM daily_report_reversals v WHERE v.tenant_id=r.tenant_id AND v.report_id=r.id)' : '';
      const installed = get<{ qty: number }>(`SELECT
        COALESCE((SELECT SUM(qty) FROM production_entries WHERE tenant_id=? AND plan_id=? AND source='manual'),0)+
        COALESCE((SELECT SUM(l.qty) FROM daily_report_lines l JOIN daily_reports r ON r.id=l.report_id AND r.tenant_id=l.tenant_id
          WHERE l.tenant_id=? AND l.plan_id=? AND r.status='approved'${reversalFilter}),0) qty`, t, planId, t, planId)!.qty;
      if (afterQty < 0 || afterQty < Math.round(installed * 1e6) / 1e6) throw new ProcurementError(409, 'Revised planned quantity cannot fall below installed quantity');
      if (afterWorkBudget < 0) throw new ProcurementError(409, 'Change cannot make the work item budget negative');
      run('UPDATE production_plans SET planned_qty=? WHERE tenant_id=? AND id=?', afterQty, t, planId);
      run('UPDATE work_item_profiles SET budget=? WHERE tenant_id=? AND plan_id=?', afterWorkBudget / 100, t, planId);
    }
    run('UPDATE project_profiles SET contract_value=?,budget=? WHERE tenant_id=? AND jobsite_id=?', afterContract / 100, afterBudget / 100, t, control.jobsite_id);
    const result = run(`INSERT INTO approved_project_changes(tenant_id,control_id,jobsite_id,customer_reference,effective_date,
      contract_delta_cents,budget_delta_cents,before_contract_cents,after_contract_cents,before_budget_cents,after_budget_cents,
      plan_id,quantity_delta,before_quantity,after_quantity,before_work_budget_cents,after_work_budget_cents)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, t, controlId, control.jobsite_id, reference, effective, contractDelta, budgetDelta,
      beforeContract, afterContract, beforeBudget, afterBudget, planId, quantityDelta, beforeQty, afterQty, beforeWorkBudget, afterWorkBudget);
    run("UPDATE project_controls SET status='closed' WHERE tenant_id=? AND id=?", t, controlId);
    return Number(result.lastInsertRowid);
  });
  res.status(201).json(get('SELECT * FROM approved_project_changes WHERE tenant_id=? AND id=?', t, approvalId));
}));
