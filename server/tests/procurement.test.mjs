import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const fixtureDir = mkdtempSync(path.join(tmpdir(), 'dirtworks-procurement-test-'));
process.env.DB_PATH = path.join(fixtureDir, 'procurement.db');
const { seedIfNeeded } = await import('../dist/db/seed/seed.js');
const { registerAllConnectors } = await import('../dist/telematics/connectors/index.js');
const { initializeErp } = await import('../dist/erp/seed.js');
const { initCommercial } = await import('../dist/erp/commercial.js');
const { initializeProcurement, assertNoIssuedMaterialCost } = await import('../dist/erp/procurement.js');
const { initializeProjectFinance } = await import('../dist/erp/project-finance.js');
const { get, run, getDb } = await import('../dist/db/database.js');
const { procurementRouter } = await import('../dist/api/routes/procurement.js');
const { tenantMiddleware } = await import('../dist/api/tenancy.js');

test('item procurement records partial deliveries, usage expense, matched AP and approved changes', async t => {
  registerAllConnectors(); seedIfNeeded(); initializeErp(); initCommercial(); initializeProcurement();
  const tenant = get("SELECT id FROM tenants WHERE slug='summit-dirtworks'").id;
  const job = get('SELECT jobsite_id FROM project_profiles WHERE tenant_id=? ORDER BY jobsite_id LIMIT 1', tenant).jobsite_id;
  const otherJob = get('SELECT jobsite_id FROM project_profiles WHERE tenant_id=? AND jobsite_id!=? ORDER BY jobsite_id LIMIT 1', tenant, job).jobsite_id;
  const foreignTenant = Number(run("INSERT INTO tenants(slug,name) VALUES ('procurement-other','Other company')").lastInsertRowid);
  const foreignJob = Number(run("INSERT INTO jobsites(tenant_id,name,code,lat,lng) VALUES (?,'Other job','OTHER',30,-90)", foreignTenant).lastInsertRowid);
  const costState = () => ({ ...get('SELECT COUNT(*) n,COALESCE(SUM(amount),0) amount FROM job_cost_entries WHERE tenant_id=?', tenant) });
  const originalCosts = costState();
  const app = express(); app.use(express.json()); app.use('/api', tenantMiddleware, procurementRouter);
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = app.listen(0); await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (endpoint, method = 'GET', data, expected = 200, selectedTenant = tenant) => {
    const response = await fetch(url + endpoint, { method, headers: { 'content-type': 'application/json', 'x-tenant-id': String(selectedTenant) },
      body: data === undefined ? undefined : JSON.stringify(data) });
    const result = await response.json();
    assert.equal(response.status, expected, `${method} ${endpoint}: ${JSON.stringify(result)}`);
    return result;
  };
  let vendor, item, order, invoice;
  const fields = () => ({ jobsite_id: job, vendor_id: vendor.id, order_date: '2035-01-10', expected_date: '2035-01-12',
    description: 'Storm pipe delivery', lines: [{ item_id: item.id, quantity: 10, unit_price: 125.55, cost_code: '4200-STORM' },
      { description: 'Joint lubricant', unit: 'EA', quantity: 3, unit_price: 8.99, cost_code: '4200-STORM' }] });
  const receive = (quantity, reference = 'TICKET-1', expected = 201, date = '2035-01-12') => request(`/erp/line-orders/${order.id}/receive`, 'POST',
    { date, reference, lines: [{ line_id: order.lines[0].id, quantity }] }, expected);
  const usage = (quantity, reference = 'USE-1', expected = 201, date = '2035-01-13', jobsite_id = job) => request('/erp/material-issues', 'POST',
    { jobsite_id, line_id: order.lines[0].id, quantity, date, reference }, expected);
  try {
    await t.test('legacy whole-order headers stay separate and migrations preserve data', async () => {
      let data = await request('/erp/procurement');
      assert.equal(data.orders.length, 6); assert.ok(data.orders.every(po => !po.item_tracking && !po.lines.length));
      initializeProcurement(); data = await request('/erp/procurement'); assert.equal(data.orders.length, 6);
      assert.deepEqual(costState(), originalCosts);
      assert.equal((await request('/erp/procurement', 'GET', undefined, 200, foreignTenant)).orders.length, 0);
    });
    await t.test('catalog and line totals are tenant scoped and rounded to cents', async () => {
      vendor = await request('/erp/vendors', 'POST', { name: 'Metro Pipe Test', email: 'ap@example.test', phone: '555-1000' }, 201);
      item = await request('/erp/material-items', 'POST', { description: '24 inch RCP', unit: 'lf' }, 201);
      assert.equal(item.unit, 'LF');
      await request('/erp/vendors', 'POST', { name: vendor.name }, 409);
      await request('/erp/material-items', 'POST', { description: item.description, unit: item.unit }, 409);
      await request('/erp/line-orders', 'POST', { ...fields(), jobsite_id: foreignJob }, 404);
      await request('/erp/line-orders', 'POST', fields(), 404, foreignTenant);
      await request('/erp/line-orders', 'POST', { ...fields(), lines: [{ ...fields().lines[0], unit: 'EA' }] }, 400);
      await request('/erp/line-orders', 'POST', { ...fields(), lines: [{ ...fields().lines[0], unit_price: 1.001 }] }, 400);
      await request('/erp/line-orders', 'POST', { ...fields(), lines: [{ ...fields().lines[0], quantity: 0.000000001 }] }, 400);
      await request('/erp/line-orders', 'POST', { ...fields(), order_date: '2035-02-30' }, 400);
      order = await request('/erp/line-orders', 'POST', fields(), 201);
      assert.equal(order.amount, 1282.47); assert.equal(order.status, 'draft'); assert.equal(order.lines[0].unit_price, 125.55);
      assert.equal(get('SELECT amount FROM purchase_orders WHERE id=?', order.id).amount, order.amount);
      assert.equal(order.item_tracking, true); assert.deepEqual(costState(), originalCosts);
    });
    await t.test('partial receipt cannot skip approval, oversupply, duplicate or predate', async () => {
      await receive(1, 'NO-APPROVAL', 409);
      order = await request(`/erp/line-orders/${order.id}/approve`, 'POST', {});
      await request(`/erp/line-orders/${order.id}/approve`, 'POST', {});
      await request(`/erp/line-orders/${order.id}/approve`, 'POST', {}, 404, foreignTenant);
      await receive(1, 'EARLY', 400, '2035-01-09');
      await receive(11, 'EXCESS', 409); await receive(4);
      await receive(4, 'TICKET-1', 409); await receive(7, 'EXCESS-2', 409);
      let data = await request('/erp/procurement');
      order = data.orders.find(po => po.id === order.id);
      assert.equal(order.status, 'approved'); assert.equal(order.lines[0].received_qty, 4); assert.equal(order.lines[0].available_qty, 4);
      assert.equal(data.receipts.length, 1); assert.deepEqual(costState(), originalCosts, 'receipt creates stock, not job expense');
      await request(`/erp/line-orders/${order.id}/receive`, 'POST', { date: '2035-01-12', reference: 'DUP-LINE',
        lines: [{ line_id: order.lines[0].id, quantity: 1 }, { line_id: order.lines[0].id, quantity: 1 }] }, 400);
    });
    await t.test('FIFO stock usage posts one sourced expense and retains remaining commitment', async () => {
      await usage(1, 'PREDELIVERY', 409, '2035-01-11'); await usage(5, 'OVERUSE', 409);
      await usage(1, 'WRONG-JOB', 409, '2035-01-13', otherJob);
      const issue = await usage(2.5);
      assert.equal(issue.amount, 313.88);
      assert.equal(get('SELECT amount FROM job_cost_entries WHERE id=?', issue.cost_entry_id).amount, 313.88);
      assert.deepEqual(costState(), { n: originalCosts.n + 1, amount: originalCosts.amount + 313.88 });
      await usage(1, 'USE-1', 409);
      const data = await request('/erp/procurement'); order = data.orders.find(po => po.id === order.id);
      assert.equal(order.lines[0].available_qty, 1.5); assert.equal(order.outstanding_commitment, 968.59);
      assert.equal(get('SELECT SUM(quantity) qty FROM material_issue_lots WHERE issue_id=?', issue.id).qty, 2.5);
      assert.throws(() => run('UPDATE material_issues SET quantity=1 WHERE id=?', issue.id), /append only/);
      assert.throws(() => run('DELETE FROM material_receipts WHERE id=?', data.receipts[0].id), /append only/);
    });
    await t.test('supplier invoices match received quantities and prices without duplicating job cost', async () => {
      const before = costState();
      const form = { order_id: order.id, reference: 'INV-1', date: '2035-01-14',
        lines: [{ line_id: order.lines[0].id, quantity: 4, unit_price: 125.55 }] };
      await request('/erp/supplier-invoices', 'POST', { ...form, lines: [{ ...form.lines[0], quantity: 5 }] }, 409);
      await request('/erp/supplier-invoices', 'POST', { ...form, lines: [{ ...form.lines[0], unit_price: 126 }] }, 409);
      await request('/erp/supplier-invoices', 'POST', { ...form, date: '2035-01-11' }, 409);
      invoice = await request('/erp/supplier-invoices', 'POST', form, 201); assert.equal(invoice.amount, 502.2);
      await request('/erp/supplier-invoices', 'POST', form, 409);
      await request('/erp/supplier-invoices', 'POST', { ...form, reference: 'INV-2', lines: [{ ...form.lines[0], quantity: 1 }] }, 409);
      assert.deepEqual(costState(), before, 'AP is not a second material expense');
      const data = await request('/erp/procurement'); assert.equal(data.invoices[0].open_amount, 502.2);
    });
    await t.test('payments are partial, append only and limited to the open invoice balance', async () => {
      const fields = { amount: 200, date: '2035-01-15', reference: 'CHECK-1' };
      await request(`/erp/supplier-invoices/${invoice.id}/pay`, 'POST', { ...fields, amount: 600 }, 409);
      await request(`/erp/supplier-invoices/${invoice.id}/pay`, 'POST', { ...fields, date: '2035-01-13' }, 400);
      await request(`/erp/supplier-invoices/${invoice.id}/pay`, 'POST', fields, 404, foreignTenant);
      await request(`/erp/supplier-invoices/${invoice.id}/pay`, 'POST', fields, 201);
      await request(`/erp/supplier-invoices/${invoice.id}/pay`, 'POST', fields, 409);
      await request(`/erp/supplier-invoices/${invoice.id}/pay`, 'POST', { ...fields, reference: 'CHECK-2', amount: 303 }, 409);
      let data = await request('/erp/procurement'); assert.equal(data.invoices[0].paid_amount, 200); assert.equal(data.invoices[0].open_amount, 302.2);
      await request(`/erp/supplier-invoices/${invoice.id}/pay`, 'POST', { ...fields, reference: 'CHECK-2', amount: 302.2 }, 201);
      data = await request('/erp/procurement'); assert.equal(data.invoices[0].open_amount, 0); assert.equal(data.payments.length, 2);
      assert.deepEqual(costState(), { n: originalCosts.n + 1, amount: originalCosts.amount + 313.88 });
    });
    await t.test('aggregate report material and inventory issues cannot post the same expense twice', async () => {
      const crewId = get('SELECT id FROM crews WHERE tenant_id=? LIMIT 1', tenant).id;
      const guardPlan = Number(run("INSERT INTO production_plans(tenant_id,jobsite_id,phase,activity,unit,planned_qty,planned_hours) VALUES (?,?,'Test','Report material guard','EA',100,10)", tenant, job).lastInsertRowid);
      run("INSERT INTO work_item_profiles(plan_id,tenant_id,cost_code,budget) VALUES (?,?,'4200-STORM',1000)", guardPlan, tenant);
      const report = Number(run("INSERT INTO daily_reports(tenant_id,jobsite_id,crew_id,date,status,created_by) VALUES (?,?,?,'2035-01-13','submitted','tester')", tenant, job, crewId).lastInsertRowid);
      run('INSERT INTO daily_report_lines(tenant_id,report_id,plan_id,material_cost) VALUES (?,?,?,100)', tenant, report, guardPlan);
      assert.throws(() => assertNoIssuedMaterialCost(tenant, report), /Inventory issues already post material/);
      const approved = Number(run("INSERT INTO daily_reports(tenant_id,jobsite_id,crew_id,date,status,created_by) VALUES (?,?,?,'2035-01-19','approved','tester')", tenant, job, crewId).lastInsertRowid);
      run('INSERT INTO daily_report_lines(tenant_id,report_id,plan_id,material_cost) VALUES (?,?,?,100)', tenant, approved, guardPlan);
      const before = costState();
      await usage(1, 'REPORT-DUPLICATE', 409, '2035-01-19');
      assert.deepEqual(costState(), before);
      run("INSERT INTO daily_report_reversals(report_id,tenant_id,reason,reversed_at,reversed_by) VALUES (?,?,'Correct material source','2035-01-19T12:00:00Z','tester')", approved, tenant);
      const issue = await usage(0.5, 'AFTER-REVERSAL', 201, '2035-01-19');
      assert.equal(issue.amount, 62.77);
    });
    await t.test('complete receipt closes header and fractional usage has no penny drift', async () => {
      await receive(6, 'TICKET-2');
      await request(`/erp/line-orders/${order.id}/receive`, 'POST', { date: '2035-01-12', reference: 'TICKET-3',
        lines: [{ line_id: order.lines[1].id, quantity: 3 }] }, 201);
      const data = await request('/erp/procurement'); order = data.orders.find(po => po.id === order.id);
      assert.equal(order.status, 'received');
      await receive(1, 'CLOSED-EXCESS', 409); await usage(7, 'USE-2');
      assert.equal(get('SELECT SUM(amount_cents) cents FROM material_issues WHERE tenant_id=? AND line_id=?', tenant, order.lines[0].id).cents, 125550);
      assert.equal(get('SELECT SUM(quantity) quantity FROM material_issues WHERE line_id=?', order.lines[0].id).quantity, 10);
    });
    await t.test('formal signed changes update project and work-item baselines exactly once', async () => {
      const before = get('SELECT contract_value,budget FROM project_profiles WHERE tenant_id=? AND jobsite_id=?', tenant, job);
      const plan = get('SELECT p.id,p.planned_qty,w.budget FROM production_plans p JOIN work_item_profiles w ON w.plan_id=p.id WHERE p.tenant_id=? AND p.jobsite_id=? ORDER BY p.id LIMIT 1', tenant, job);
      const control = Number(run("INSERT INTO project_controls(tenant_id,jobsite_id,kind,title,amount,status) VALUES (?,?,'change_order','Signed extra work',5000,'closed')", tenant, job).lastInsertRowid);
      const form = { control_id: control, customer_reference: 'Signed owner CO-17 / document register', effective_date: '2035-01-16',
        contract_delta: 5000, budget_delta: 3000, plan_id: plan.id, quantity_delta: 100 };
      await request('/erp/change-approvals', 'POST', { ...form, customer_reference: '' }, 400);
      await request('/erp/change-approvals', 'POST', form, 404, foreignTenant);
      const approval = await request('/erp/change-approvals', 'POST', form, 201);
      assert.equal(approval.before_contract_cents, Math.round(before.contract_value * 100));
      assert.deepEqual({ ...get('SELECT contract_value,budget FROM project_profiles WHERE tenant_id=? AND jobsite_id=?', tenant, job) },
        { contract_value: before.contract_value + 5000, budget: before.budget + 3000 });
      assert.equal(get('SELECT planned_qty FROM production_plans WHERE id=?', plan.id).planned_qty, plan.planned_qty + 100);
      assert.equal(get('SELECT budget FROM work_item_profiles WHERE plan_id=?', plan.id).budget, plan.budget + 3000);
      await request('/erp/change-approvals', 'POST', form, 409);
      assert.throws(() => run('DELETE FROM approved_project_changes WHERE id=?', approval.id), /append only/);
      const requestCredit = Number(run("INSERT INTO project_controls(tenant_id,jobsite_id,kind,title,amount) VALUES (?,?,'change_order','Signed credit',0)", tenant, job).lastInsertRowid);
      const credit = { ...form, control_id: requestCredit, contract_delta: -1000, budget_delta: -500, quantity_delta: 0, customer_reference: 'Owner credit CO-18' };
      await request('/erp/change-approvals', 'POST', { ...credit, contract_delta: -1e9 }, 409);
      await request('/erp/change-approvals', 'POST', { ...credit, quantity_delta: -1e9 }, 409);
      await request('/erp/change-approvals', 'POST', credit, 201);
      assert.equal(get('SELECT contract_value FROM project_profiles WHERE jobsite_id=?', job).contract_value, before.contract_value + 4000);
      const floorControl = Number(run("INSERT INTO project_controls(tenant_id,jobsite_id,kind,title,amount) VALUES (?,?,'change_order','Reduce uninstalled scope',0)", tenant, job).lastInsertRowid);
      run("INSERT INTO production_entries(tenant_id,plan_id,date,qty,hours,source) VALUES (?,?,'2035-01-17',5,1,'manual')", tenant, plan.id);
      await request('/erp/change-approvals', 'POST', { ...credit, control_id: floorControl, contract_delta: 0, budget_delta: 0,
        quantity_delta: -(plan.planned_qty + 100) + 1 }, 409);
      assert.equal(get('SELECT COUNT(*) n FROM approved_project_changes WHERE tenant_id=?', tenant).n, 2);
    });
    await t.test('tenant reads and writes cannot expose or mutate another company ledgers', async () => {
      const data = await request('/erp/procurement', 'GET', undefined, 200, foreignTenant);
      for (const key of ['vendors','items','orders','receipts','issues','invoices','payments','changes','controls']) assert.deepEqual(data[key], []);
      await request('/erp/material-issues', 'POST', { jobsite_id: foreignJob, line_id: order.lines[0].id, quantity: 1,
        date: '2035-01-18', reference: 'FOREIGN-USAGE' }, 404, foreignTenant);
      const before = get('SELECT COUNT(*) n FROM supplier_payments').n;
      initializeProcurement(); assert.equal(get('SELECT COUNT(*) n FROM supplier_payments').n, before);
    });
    await t.test('scope credits cannot invalidate the billing schedule or certified earned revenue', async () => {
      initializeProjectFinance();
      const current = get('SELECT contract_value FROM project_profiles WHERE tenant_id=? AND jobsite_id=?', tenant, job).contract_value;
      run("INSERT INTO billing_pay_items(tenant_id,jobsite_id,code,description,unit,total_qty,scheduled_value_cents,created_at) VALUES (?,?,'SOV-REVIEW','Signed schedule','LS',1,?,'2035-01-20T12:00:00Z')", tenant, job, Math.round(current * 100));
      const control = Number(run("INSERT INTO project_controls(tenant_id,jobsite_id,kind,title,amount) VALUES (?,?,'change_order','Credit requires schedule amendment',0)", tenant, job).lastInsertRowid);
      const fields = { control_id: control, customer_reference: 'Signed credit 19', effective_date: '2035-01-20', contract_delta: -0.01, budget_delta: 0 };
      await request('/erp/change-approvals', 'POST', fields, 409);
      assert.equal(get('SELECT contract_value FROM project_profiles WHERE tenant_id=? AND jobsite_id=?', tenant, job).contract_value, current);
      assert.equal(get('SELECT id FROM approved_project_changes WHERE control_id=?', control), undefined);
    });
    await t.test('final project acceptance freezes new commitments, stock movement and scope while AP can settle', async () => {
      initializeProjectFinance();
      const closedJob = Number(run("INSERT INTO jobsites(tenant_id,name,code,lat,lng) VALUES (?,'Accepted project','ACCEPTED-PROC',32,-97)", tenant).lastInsertRowid);
      run('INSERT INTO project_profiles(tenant_id,jobsite_id,contract_value,budget) VALUES (?,?,10000,8000)', tenant, closedJob);
      let receiving = await request('/erp/line-orders', 'POST', { ...fields(), jobsite_id: closedJob, lines: [{ item_id: item.id, quantity: 2, unit_price: 10, cost_code: '4200-STORM' }] }, 201);
      receiving = await request(`/erp/line-orders/${receiving.id}/approve`, 'POST', {});
      await request(`/erp/line-orders/${receiving.id}/receive`, 'POST', { date: '2035-01-12', reference: 'ACCEPTED-TICKET', lines: [{ line_id: receiving.lines[0].id, quantity: 1 }] }, 201);
      const draft = await request('/erp/line-orders', 'POST', { ...fields(), jobsite_id: closedJob }, 201);
      const control = Number(run("INSERT INTO project_controls(tenant_id,jobsite_id,kind,title,amount) VALUES (?,?,'change_order','Late scope',10)", tenant, closedJob).lastInsertRowid);
      run("INSERT INTO project_closeouts(jobsite_id,tenant_id,acceptance_reference,closed_at,closed_by) VALUES (?,?,'Acceptance record','2035-01-16T12:00:00Z','PM')", closedJob, tenant);
      await request('/erp/line-orders', 'POST', { ...fields(), jobsite_id: closedJob }, 409);
      await request(`/erp/line-orders/${draft.id}/approve`, 'POST', {}, 409);
      await request(`/erp/line-orders/${receiving.id}/receive`, 'POST', { date: '2035-01-17', reference: 'LATE-TICKET', lines: [{ line_id: receiving.lines[0].id, quantity: 1 }] }, 409);
      await request('/erp/material-issues', 'POST', { jobsite_id: closedJob, line_id: receiving.lines[0].id, quantity: 1, date: '2035-01-17', reference: 'LATE-USAGE' }, 409);
      await request('/erp/change-approvals', 'POST', { control_id: control, customer_reference: 'Late owner change', effective_date: '2035-01-17', contract_delta: 10, budget_delta: 5 }, 409);
      const lateInvoice = await request('/erp/supplier-invoices', 'POST', { order_id: receiving.id, reference: 'LATE-AP', date: '2035-01-17', lines: [{ line_id: receiving.lines[0].id, quantity: 1, unit_price: 10 }] }, 201);
      await request(`/erp/supplier-invoices/${lateInvoice.id}/pay`, 'POST', { amount: 10, date: '2035-01-18', reference: 'LATE-SETTLEMENT' }, 201);
      assert.equal(get('SELECT COUNT(*) n FROM material_issues WHERE jobsite_id=?', closedJob).n, 0);
    });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    getDb().close(); rmSync(fixtureDir, { recursive: true, force: true });
  }
});
