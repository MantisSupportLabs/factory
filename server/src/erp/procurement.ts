import { get, getDb } from '../db/database.js';
import { ErpError } from './validation.js';

/** Item-level purchasing ledger. Receipt holds stock; only material usage posts job expense. */
export function initializeProcurement(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS material_vendors (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
      UNIQUE(tenant_id, name)
    );
    CREATE TABLE IF NOT EXISTS material_items (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      description TEXT NOT NULL, unit TEXT NOT NULL,
      UNIQUE(tenant_id, description, unit)
    );
    CREATE TABLE IF NOT EXISTS procurement_orders (
      order_id INTEGER PRIMARY KEY REFERENCES purchase_orders(id),
      tenant_id INTEGER NOT NULL REFERENCES tenants(id), vendor_id INTEGER NOT NULL REFERENCES material_vendors(id)
    );
    CREATE TABLE IF NOT EXISTS po_lines (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      order_id INTEGER NOT NULL REFERENCES procurement_orders(order_id), item_id INTEGER REFERENCES material_items(id),
      description TEXT NOT NULL, unit TEXT NOT NULL, cost_code TEXT NOT NULL,
      quantity REAL NOT NULL CHECK(quantity > 0), unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents >= 0),
      line_amount_cents INTEGER NOT NULL CHECK(line_amount_cents >= 0)
    );
    CREATE INDEX IF NOT EXISTS ix_po_lines_order ON po_lines(tenant_id, order_id);
    CREATE TABLE IF NOT EXISTS material_receipts (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      order_id INTEGER NOT NULL REFERENCES procurement_orders(order_id), date TEXT NOT NULL, reference TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(tenant_id, order_id, reference)
    );
    CREATE TABLE IF NOT EXISTS material_receipt_lines (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      receipt_id INTEGER NOT NULL REFERENCES material_receipts(id), line_id INTEGER NOT NULL REFERENCES po_lines(id),
      quantity REAL NOT NULL CHECK(quantity > 0), UNIQUE(receipt_id, line_id)
    );
    CREATE TABLE IF NOT EXISTS material_issues (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      jobsite_id INTEGER NOT NULL REFERENCES jobsites(id), line_id INTEGER NOT NULL REFERENCES po_lines(id),
      date TEXT NOT NULL, reference TEXT NOT NULL, quantity REAL NOT NULL CHECK(quantity > 0),
      unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents >= 0), amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
      cost_entry_id INTEGER NOT NULL UNIQUE REFERENCES job_cost_entries(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(tenant_id, reference)
    );
    CREATE TABLE IF NOT EXISTS material_issue_lots (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      issue_id INTEGER NOT NULL REFERENCES material_issues(id), receipt_line_id INTEGER NOT NULL REFERENCES material_receipt_lines(id),
      quantity REAL NOT NULL CHECK(quantity > 0), UNIQUE(issue_id, receipt_line_id)
    );
    CREATE TABLE IF NOT EXISTS supplier_invoices (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      order_id INTEGER NOT NULL REFERENCES procurement_orders(order_id), vendor_id INTEGER NOT NULL REFERENCES material_vendors(id),
      date TEXT NOT NULL, reference TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(tenant_id, vendor_id, reference)
    );
    CREATE TABLE IF NOT EXISTS supplier_invoice_lines (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id), line_id INTEGER NOT NULL REFERENCES po_lines(id),
      quantity REAL NOT NULL CHECK(quantity > 0), unit_price_cents INTEGER NOT NULL CHECK(unit_price_cents >= 0),
      amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0), UNIQUE(invoice_id, line_id)
    );
    CREATE TABLE IF NOT EXISTS supplier_payments (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id), date TEXT NOT NULL, reference TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(tenant_id, reference)
    );
    CREATE TABLE IF NOT EXISTS approved_project_changes (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      control_id INTEGER NOT NULL UNIQUE REFERENCES project_controls(id), jobsite_id INTEGER NOT NULL REFERENCES jobsites(id),
      customer_reference TEXT NOT NULL, effective_date TEXT NOT NULL,
      contract_delta_cents INTEGER NOT NULL, budget_delta_cents INTEGER NOT NULL,
      before_contract_cents INTEGER NOT NULL, after_contract_cents INTEGER NOT NULL CHECK(after_contract_cents >= 0),
      before_budget_cents INTEGER NOT NULL, after_budget_cents INTEGER NOT NULL CHECK(after_budget_cents >= 0),
      plan_id INTEGER REFERENCES production_plans(id), quantity_delta REAL,
      before_quantity REAL, after_quantity REAL, before_work_budget_cents INTEGER, after_work_budget_cents INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK((plan_id IS NULL AND quantity_delta IS NULL AND before_quantity IS NULL AND after_quantity IS NULL)
        OR (plan_id IS NOT NULL AND quantity_delta IS NOT NULL AND before_quantity IS NOT NULL AND after_quantity >= 0))
    );
    CREATE INDEX IF NOT EXISTS ix_issues_tenant_line ON material_issues(tenant_id, line_id);
    CREATE INDEX IF NOT EXISTS ix_receipts_tenant_order ON material_receipts(tenant_id, order_id);
    CREATE INDEX IF NOT EXISTS ix_invoices_tenant_order ON supplier_invoices(tenant_id, order_id);
  `);
  // Ledger records stay immutable. Corrections need an explicit future reversal workflow.
  for (const table of ['po_lines', 'material_receipts', 'material_receipt_lines', 'material_issues', 'material_issue_lots',
    'supplier_invoices', 'supplier_invoice_lines', 'supplier_payments', 'approved_project_changes']) {
    getDb().exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'Procurement ledger is append only'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT, 'Procurement ledger is append only'); END;`);
  }
}

/** Aggregate field costs and inventory expense must not recognize the same job/code/day twice. */
export function assertNoReportMaterialCost(tenantId: number, jobsiteId: number, costCode: string, workDate: string): void {
  const reversalFilter = get("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_report_reversals'")
    ? ' AND NOT EXISTS(SELECT 1 FROM daily_report_reversals v WHERE v.tenant_id=r.tenant_id AND v.report_id=r.id)' : '';
  if (get(`SELECT l.id FROM daily_report_lines l JOIN daily_reports r ON r.id=l.report_id AND r.tenant_id=l.tenant_id
    JOIN work_item_profiles w ON w.plan_id=l.plan_id AND w.tenant_id=l.tenant_id
    WHERE r.tenant_id=? AND r.jobsite_id=? AND r.date=? AND w.cost_code=? AND r.status='approved' AND l.material_cost>0
    ${reversalFilter}`, tenantId, jobsiteId, workDate, costCode)) {
    throw new ErpError(409, 'Approved daily-report material already costs this job, code, and date; reverse and correct the report before issuing inventory material');
  }
}

export function assertNoIssuedMaterialCost(tenantId: number, reportId: number): void {
  initializeProcurement();
  if (get(`SELECT l.id FROM daily_report_lines l JOIN daily_reports r ON r.id=l.report_id AND r.tenant_id=l.tenant_id
    JOIN work_item_profiles w ON w.plan_id=l.plan_id AND w.tenant_id=l.tenant_id
    JOIN po_lines p ON p.tenant_id=r.tenant_id AND p.cost_code=w.cost_code
    JOIN material_issues i ON i.line_id=p.id AND i.tenant_id=r.tenant_id AND i.jobsite_id=r.jobsite_id AND i.date=r.date
    WHERE r.tenant_id=? AND r.id=? AND l.material_cost>0 AND i.amount_cents>0`, tenantId, reportId)) {
    throw new ErpError(409, 'Inventory issues already post material for this job, code, and date; set the daily report aggregate material cost to zero before approval');
  }
}

/** Final project acceptance freezes new scope and physical purchasing; AP settlement can continue. */
export function assertProjectAcceptsProcurement(tenantId: number, jobsiteId: number): void {
  if (get("SELECT name FROM sqlite_master WHERE type='table' AND name='project_closeouts'") &&
    get('SELECT jobsite_id FROM project_closeouts WHERE tenant_id=? AND jobsite_id=?', tenantId, jobsiteId)) {
    throw new ErpError(409, 'This project has final acceptance; new orders, deliveries, material issues, and scope changes are closed');
  }
}
