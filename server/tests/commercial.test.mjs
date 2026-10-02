import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

// Select an isolated database before any imports can initialize the shared configuration.
const fixtureDir = mkdtempSync(path.join(tmpdir(), 'dirtworks-commercial-test-'));
process.env.DB_PATH = path.join(fixtureDir, 'commercial.db');
const { seedIfNeeded } = await import('../dist/db/seed/seed.js');
const { registerAllConnectors } = await import('../dist/telematics/connectors/index.js');
const { initializeErp } = await import('../dist/erp/seed.js');
const { initCommercial } = await import('../dist/erp/commercial.js');
const { getErpOverview } = await import('../dist/erp/overview.js');
const { get, getDb, run } = await import('../dist/db/database.js');
const { commercialRouter } = await import('../dist/api/routes/commercial.js');
const { tenantMiddleware } = await import('../dist/api/tenancy.js');

test('commercial commitments and project controls preserve accounting boundaries', async t => {
  registerAllConnectors();
  seedIfNeeded();
  initializeErp();
  initCommercial();
  const tenantId = get("SELECT id FROM tenants WHERE slug='summit-dirtworks'").id;
  const projectId = get('SELECT id FROM jobsites WHERE tenant_id=? ORDER BY id LIMIT 1', tenantId).id;
  const ownerId = get('SELECT id FROM employees WHERE tenant_id=? ORDER BY id LIMIT 1', tenantId).id;
  const foreignTenant = Number(run("INSERT INTO tenants(slug,name) VALUES ('commercial-other','Other contractor')").lastInsertRowid);
  const foreignProject = Number(run("INSERT INTO jobsites(tenant_id,name,code,lat,lng) VALUES (?,'Other job','OTHER-1',32,-97)", foreignTenant).lastInsertRowid);
  const foreignOwner = Number(run("INSERT INTO employees(tenant_id,name,role) VALUES (?,'Other owner','pm')", foreignTenant).lastInsertRowid);
  const counts = () => ({
    orders: get('SELECT COUNT(*) n FROM purchase_orders').n,
    controls: get('SELECT COUNT(*) n FROM project_controls').n,
    markers: get('SELECT COUNT(*) n FROM commercial_seed_versions').n,
  });
  const accounting = () => ({
    entries: get('SELECT COUNT(*) n, COALESCE(SUM(amount),0) amount FROM job_cost_entries WHERE tenant_id=?', tenantId),
    contract: get('SELECT contract_value,budget FROM project_profiles WHERE tenant_id=? AND jobsite_id=?', tenantId, projectId),
    actualCost: getErpOverview(tenantId).projects.find(project => project.id === projectId).actual_cost,
  });
  const originalAccounting = accounting();
  const app = express();
  app.use(express.json());
  app.use('/api', tenantMiddleware, commercialRouter);
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (endpoint, method = 'GET', data, expectedStatus = 200, tenant) => {
    const response = await fetch(url + endpoint, {
      method,
      headers: { 'content-type': 'application/json', ...(tenant ? { 'x-tenant-id': String(tenant) } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const result = await response.json();
    assert.equal(response.status, expectedStatus, `${method} ${endpoint}: ${JSON.stringify(result)}`);
    return result;
  };
  const orderFields = {
    jobsite_id: projectId, vendor: 'Integration aggregate supplier', description: 'Job base material',
    cost_code: '3100-BASE', amount: 2500, order_date: '2035-01-10', expected_date: '2035-01-15',
  };
  const controlFields = {
    jobsite_id: projectId, kind: 'change_order', title: 'Requested additional excavation',
    description: 'Price requested for unforeseen rock; awaiting customer review.',
    owner_id: ownerId, due_date: '2035-01-20', amount: 4500,
  };
  let order, control;
  try {
    await t.test('demo commercial seed runs once and stays scoped to Summit', async () => {
      const before = counts();
      assert.deepEqual(before, { orders: 6, controls: 4, markers: 1 });
      initCommercial();
      assert.deepEqual(counts(), before);
      assert.equal(get('SELECT COUNT(*) n FROM commercial_seed_versions WHERE tenant_id=?', foreignTenant).n, 0);
      const other = await request('/erp/commercial', 'GET', undefined, 200, foreignTenant);
      assert.deepEqual(other, { purchase_orders: [], controls: [] });
    });
    await t.test('rejects foreign related IDs and invalid amounts or calendar dates without writes', async () => {
      const before = counts();
      await request('/erp/purchase-orders', 'POST', { ...orderFields, jobsite_id: foreignProject }, 404);
      await request('/erp/controls', 'POST', { ...controlFields, jobsite_id: foreignProject }, 404);
      await request('/erp/controls', 'POST', { ...controlFields, owner_id: foreignOwner }, 404);
      await request('/erp/purchase-orders', 'POST', { ...orderFields, amount: -1 }, 400);
      await request('/erp/purchase-orders', 'POST', { ...orderFields, order_date: '2035-02-30' }, 400);
      await request('/erp/purchase-orders', 'POST', { ...orderFields, status: 'approved' }, 400);
      await request('/erp/controls', 'POST', { ...controlFields, kind: 'rfi' }, 400);
      assert.deepEqual(counts(), before);
    });
    await t.test('orders progress draft to approved to received and reject skips or reversals', async () => {
      order = await request('/erp/purchase-orders', 'POST', orderFields, 201);
      assert.equal(order.status, 'draft');
      assert.equal(order.jobsite_id, projectId);
      assert.ok(order.jobsite_name);
      assert.deepEqual(accounting(), originalAccounting);
      await request(`/erp/purchase-orders/${order.id}`, 'PATCH', { status: 'received' }, 409);
      order = await request(`/erp/purchase-orders/${order.id}`, 'PATCH', { status: 'approved' });
      assert.equal(order.status, 'approved');
      await request(`/erp/purchase-orders/${order.id}`, 'PATCH', { status: 'draft' }, 409);
      order = await request(`/erp/purchase-orders/${order.id}`, 'PATCH', { status: 'received' });
      assert.equal(order.status, 'received');
      await request(`/erp/purchase-orders/${order.id}`, 'PATCH', { status: 'approved' }, 409);
      assert.deepEqual(accounting(), originalAccounting, 'whole-order receipt does not post actual cost');
    });
    await t.test('change requests close and reopen without approving contract changes', async () => {
      control = await request('/erp/controls', 'POST', controlFields, 201);
      assert.equal(control.status, 'open');
      assert.equal(control.amount, 4500);
      assert.ok(control.owner_name);
      control = await request(`/erp/controls/${control.id}`, 'PATCH', { status: 'closed' });
      assert.equal(control.status, 'closed');
      assert.equal(control.amount, 4500);
      assert.deepEqual(accounting(), originalAccounting, 'closing a requested change does not change contracts, budgets, or costs');
      control = await request(`/erp/controls/${control.id}`, 'PATCH', { status: 'open' });
      assert.equal(control.status, 'open');
      assert.deepEqual(accounting(), originalAccounting);
    });
    await t.test('foreign tenants cannot transition another tenant’s records', async () => {
      await request(`/erp/purchase-orders/${order.id}`, 'PATCH', { status: 'received' }, 404, foreignTenant);
      await request(`/erp/controls/${control.id}`, 'PATCH', { status: 'closed' }, 404, foreignTenant);
      const other = await request('/erp/commercial', 'GET', undefined, 200, foreignTenant);
      assert.deepEqual(other, { purchase_orders: [], controls: [] });
    });
    await t.test('reinitialization preserves user records and lifecycle states', async () => {
      const before = counts();
      initCommercial();
      assert.deepEqual(counts(), before);
      const records = await request('/erp/commercial');
      assert.equal(records.purchase_orders.find(record => record.id === order.id).status, 'received');
      assert.equal(records.controls.find(record => record.id === control.id).status, 'open');
      assert.deepEqual(accounting(), originalAccounting);
    });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    getDb().close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
