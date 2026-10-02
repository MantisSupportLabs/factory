import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

// Set the database path before importing config/database: never touch the demo runtime file.
const fixtureDir = mkdtempSync(path.join(tmpdir(), 'dirtworks-erp-test-'));
process.env.DB_PATH = path.join(fixtureDir, 'erp.db');
const { seedIfNeeded } = await import('../dist/db/seed/seed.js');
const { registerAllConnectors } = await import('../dist/telematics/connectors/index.js');
const { initializeErp } = await import('../dist/erp/seed.js');
const { getErpOverview } = await import('../dist/erp/overview.js');
const { all, get, getDb, run } = await import('../dist/db/database.js');
const { erpRouter } = await import('../dist/api/routes/erp.js');
const { tenantMiddleware } = await import('../dist/api/tenancy.js');

test('civil ERP API and recorded-actuals regression checks', async t => {
  registerAllConnectors();
  seedIfNeeded();
  initializeErp();
  const app = express();
  app.use(express.json());
  app.use('/api', tenantMiddleware, erpRouter);
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
    const result = response.status === 204 ? null : await response.json();
    assert.equal(response.status, expectedStatus, `${method} ${endpoint}: ${JSON.stringify(result)}`);
    return result;
  };
  let overview, tenantId, manualPlan, foreignTenant, foreignPerson, pm, project, earthwork, utilities, foreman, crew, report;
  try {
    await t.test('upgrades an existing database once without duplicating the demo', async () => {
      const counts = () => ['project_profiles', 'crews', 'crew_members', 'daily_reports', 'weekly_updates', 'job_cost_entries']
        .map(table => get(`SELECT COUNT(*) n FROM ${table}`).n);
      const before = counts();
      initializeErp();
      assert.deepEqual(counts(), before);
      overview = await request('/erp/overview');
      assert.equal(overview.projects.length, 3);
      assert.equal(overview.crews.length, 3);
      assert.equal(overview.weekly_updates.length, 3);
      tenantId = get('SELECT id FROM tenants LIMIT 1').id;
      pm = overview.people.find(person => person.role === 'pm');
      manualPlan = getErpOverview(tenantId).work_items.find(item => item.actual_qty > 0);
    });
    await t.test('telemetry-derived estimates never change measured quantities or labor', async () => {
      const original = getErpOverview(tenantId).work_items.find(item => item.id === manualPlan.id);
      run("INSERT INTO production_entries (tenant_id,plan_id,date,qty,hours,source) VALUES (?,?,?,?,?,'ai_auto')",
        tenantId, manualPlan.id, '2035-01-01', 999999, 999999);
      const current = getErpOverview(tenantId).work_items.find(item => item.id === manualPlan.id);
      assert.equal(current.actual_qty, original.actual_qty);
      assert.equal(current.actual_hours, original.actual_hours);
    });
    await t.test('project validation rejects invalid dates and foreign related IDs', async () => {
      foreignTenant = Number(run("INSERT INTO tenants(slug,name) VALUES ('erp-foreign-check','Other tenant')").lastInsertRowid);
      foreignPerson = Number(run("INSERT INTO employees(tenant_id,name,role) VALUES (?, 'Foreign PM', 'pm')", foreignTenant).lastInsertRowid);
      await request('/erp/projects', 'POST', { name: 'bad scope', code: 'BAD', pm_id: foreignPerson }, 404);
      await request('/erp/projects', 'POST', { name: 'bad date', code: 'BAD', start_date: '2026-02-30' }, 400);
      await request('/erp/projects', 'POST', { name: 'bad location', code: 'BAD', lat: 91, lng: -98 }, 400);
      project = await request('/erp/projects', 'POST', {
        name: 'Integration project', code: 'ERP-INT-1', client: 'Integration client', pm_id: pm.id,
        budget: 1000, contract_value: 1500, start_date: '2035-01-01', end_date: '2035-12-31',
        lat: 35.5, lng: -98.1, address: 'Integration test job address',
      }, 201);
      assert.equal(project.lat, 35.5);
      assert.equal(project.lng, -98.1);
      assert.equal(project.address, 'Integration test job address');
      await request(`/erp/projects/${project.id}`, 'PATCH', { pm_id: foreignPerson }, 404);
    });
    await t.test('work items require finite positive baselines and distinct cost codes', async () => {
      earthwork = await request('/erp/work-items', 'POST', {
        jobsite_id: project.id, phase: 'Earthwork', activity: 'Cut', unit: 'CY',
        planned_qty: 100, planned_hours: 10, cost_code: '100', budget: 900,
      }, 201);
      utilities = await request('/erp/work-items', 'POST', {
        jobsite_id: project.id, phase: 'Utilities', activity: 'Pipe', unit: 'LF',
        planned_qty: 1000, planned_hours: 20, cost_code: '200', budget: 100,
      }, 201);
      await request('/erp/work-items', 'POST', {
        jobsite_id: project.id, phase: 'Invalid', activity: 'Invalid', unit: 'EA',
        planned_qty: 0, planned_hours: 1, cost_code: '300', budget: 1,
      }, 400);
      await request('/erp/work-items', 'POST', {
        jobsite_id: project.id, phase: 'Invalid', activity: 'Invalid', unit: 'EA',
        planned_qty: 1, planned_hours: 1, cost_code: '100', budget: 1,
      }, 409);
      assert.equal(all('SELECT id FROM production_plans WHERE jobsite_id=?', project.id).length, 2);
    });
    await t.test('crew membership and dispatch prevent inactive people and duplicate allocations', async () => {
      foreman = await request('/erp/people', 'POST', { name: 'Integration lead', role: 'foreman', certs: ['OSHA 30'] }, 201);
      const inactive = await request('/erp/people', 'POST', { name: 'Inactive worker', role: 'operator', active: 0 }, 201);
      await request('/erp/crews', 'POST', { name: 'Invalid crew', trade: 'Civil', foreman_id: foreman.id, members: [inactive.id] }, 400);
      crew = await request('/erp/crews', 'POST', { name: 'Integration crew', trade: 'Civil', foreman_id: foreman.id, members: [] }, 201);
      assert.deepEqual(crew.members, [foreman.id]);
      await request('/erp/crews', 'POST', { name: 'Conflict crew', trade: 'Civil', foreman_id: foreman.id, members: [] }, 409);
      await request(`/erp/people/${foreman.id}`, 'PATCH', { active: 0 }, 409);
      const allocation = await request('/erp/assignments', 'POST', {
        crew_id: crew.id, jobsite_id: project.id, date: '2035-01-10', task: 'Cut', cost_code: '100',
      }, 201);
      await request('/erp/assignments', 'POST', {
        crew_id: crew.id, jobsite_id: project.id, date: '2035-01-10', task: 'Other', cost_code: '100',
      }, 409);
      await request(`/erp/assignments/${allocation.id}`, 'DELETE', undefined, 204);
      await request(`/erp/assignments/${allocation.id}`, 'DELETE', undefined, 404);
    });
    await t.test('only approved reports contribute production, hours, and explicit costs', async () => {
      const base = {
        jobsite_id: project.id, crew_id: crew.id, date: '2035-01-10', created_by: 'Integration lead',
        weather: 'Clear', rough_pct: 90, notes: 'Status distinct from installed quantities', status: 'draft',
      };
      const before = get('SELECT COUNT(*) n FROM daily_reports').n;
      await request('/erp/daily-reports', 'POST', { ...base, lines: [{ plan_id: earthwork.id, qty: -1 }] }, 400);
      await request('/erp/daily-reports', 'POST', { ...base, lines: [{ plan_id: manualPlan.id, qty: 1 }] }, 400);
      assert.equal(get('SELECT COUNT(*) n FROM daily_reports').n, before, 'invalid multirow writes leave no orphan report');
      report = await request('/erp/daily-reports', 'POST', {
        ...base,
        lines: [
          { plan_id: earthwork.id, qty: 50, labor_hours: 5, labor_cost: 250, equipment_cost: 100, material_cost: 50 },
          { plan_id: utilities.id, qty: 100, labor_hours: 2, labor_cost: 25 },
        ],
      }, 201);
      let current = await request('/erp/overview');
      assert.equal(current.projects.find(item => item.id === project.id).progress_pct, 0, 'draft excluded');
      await request(`/erp/daily-reports/${report.id}/approve`, 'POST', {}, 409);
      await request(`/erp/daily-reports/${report.id}/submit`, 'POST', {});
      current = await request('/erp/overview');
      assert.equal(current.projects.find(item => item.id === project.id).actual_cost, 0, 'submitted excluded');
      await request(`/erp/daily-reports/${report.id}`, 'PATCH', { notes: 'Edit' }, 409);
      await request(`/erp/daily-reports/${report.id}/approve`, 'POST', { approved_by: 'Integration PM' });
      current = await request('/erp/overview');
      const measured = current.projects.find(item => item.id === project.id);
      assert.equal(measured.progress_pct, 46, '900×50% + 100×10%, divided by 1000; CY and LF never added');
      assert.equal(measured.actual_cost, 425);
      assert.equal(current.work_items.find(item => item.id === earthwork.id).rate, 10);
      assert.ok(Math.abs(measured.forecast_cost - 425 / 0.46) < 1e-9);
      await request(`/erp/daily-reports/${report.id}/approve`, 'POST', {}, 409);
    });
    await t.test('all-zero reports require explanatory notes and preserve the workflow', async () => {
      const base = {
        jobsite_id: project.id, crew_id: crew.id, date: '2035-01-11', created_by: 'Integration lead',
        notes: '', lines: [{ plan_id: earthwork.id, qty: 0, labor_hours: 0 }],
      };
      await request('/erp/daily-reports', 'POST', { ...base, status: 'submitted' }, 400);
      const empty = await request('/erp/daily-reports', 'POST', { ...base, status: 'draft' }, 201);
      await request(`/erp/daily-reports/${empty.id}/submit`, 'POST', {}, 400);
      await request(`/erp/daily-reports/${empty.id}`, 'PATCH', { notes: 'Rain shutdown, no work performed' });
      await request(`/erp/daily-reports/${empty.id}/submit`, 'POST', {});
      await request(`/erp/daily-reports/${empty.id}/approve`, 'POST', {});
      assert.equal(getErpOverview(tenantId).projects.find(item => item.id === project.id).progress_pct, 46);
    });
    await t.test('legacy manual overlap prevents duplicate production while allowing cost-only reports', async () => {
      const baselineDate = get("SELECT date FROM production_entries WHERE tenant_id=? AND plan_id=? AND source='manual' ORDER BY date LIMIT 1", tenantId, manualPlan.id).date;
      const base = { jobsite_id: manualPlan.jobsite_id, date: baselineDate, created_by: 'Integration lead', status: 'submitted', notes: 'Reconciliation check' };
      const costOnly = await request('/erp/daily-reports', 'POST', {
        ...base, crew_id: crew.id, lines: [{ plan_id: manualPlan.id, labor_cost: 123, qty: 0, labor_hours: 0 }],
      }, 201);
      const quantityBefore = getErpOverview(tenantId).work_items.find(item => item.id === manualPlan.id).actual_qty;
      await request(`/erp/daily-reports/${costOnly.id}/approve`, 'POST', {});
      assert.equal(getErpOverview(tenantId).work_items.find(item => item.id === manualPlan.id).actual_qty, quantityBefore);
      const duplicate = await request('/erp/daily-reports', 'POST', {
        ...base, crew_id: overview.crews[0].id, lines: [{ plan_id: manualPlan.id, qty: 100, labor_hours: 1 }],
      }, 201);
      await request(`/erp/daily-reports/${duplicate.id}/approve`, 'POST', {}, 409);
    });
    await t.test('PM rough percentage and final forecasts stay independent of measured actuals', async () => {
      const base = { jobsite_id: project.id, week_ending: '2035-01-12', health: 'at_risk', forecast_finish: '2035-11-01', forecast_cost: 1234 };
      await request('/erp/weekly-updates', 'POST', { ...base, pm_id: foreman.id, rough_pct: 95 }, 400);
      await request('/erp/weekly-updates', 'POST', { ...base, pm_id: pm.id, rough_pct: 101 }, 400);
      const weekly = await request('/erp/weekly-updates', 'POST', { ...base, pm_id: pm.id, rough_pct: 95 }, 201);
      let current = getErpOverview(tenantId).projects.find(item => item.id === project.id);
      assert.equal(current.progress_pct, 46);
      assert.equal(current.latest_rough_pct, 95);
      assert.equal(current.latest_forecast_cost, 1234);
      await request('/erp/weekly-updates', 'POST', { ...base, pm_id: pm.id, rough_pct: 96 }, 409);
      await request(`/erp/weekly-updates/${weekly.id}`, 'PATCH', { rough_pct: 97 });
      current = getErpOverview(tenantId).projects.find(item => item.id === project.id);
      assert.equal(current.latest_rough_pct, 97);
      assert.equal(current.progress_pct, 46);
    });
    await t.test('unallocated scope and recorded but uncosted labor suppress calculated forecasts', async () => {
      await request(`/erp/projects/${project.id}`, 'PATCH', { budget: 2000 });
      let current = getErpOverview(tenantId).projects.find(item => item.id === project.id);
      assert.equal(current.lat, 35.5, 'an unrelated edit preserves location');
      assert.equal(current.lng, -98.1);
      assert.equal(current.address, 'Integration test job address');
      assert.equal(current.budget_coverage_pct, 50);
      assert.equal(current.forecast_cost, null);
      await request(`/erp/projects/${project.id}`, 'PATCH', { budget: 1100 });
      const hoursOnly = await request('/erp/work-items', 'POST', {
        jobsite_id: project.id, phase: 'Earthwork', activity: 'Unproductive shift', unit: 'CY',
        planned_qty: 100, planned_hours: 10, cost_code: '300', budget: 100,
      }, 201);
      run("INSERT INTO production_entries (tenant_id,plan_id,date,qty,hours,source) VALUES (?,?,?,?,?,'manual')", tenantId, hoursOnly.id, '2035-01-13', 0, 8);
      current = getErpOverview(tenantId).projects.find(item => item.id === project.id);
      assert.equal(current.budget_coverage_pct, 100);
      assert.equal(current.forecast_cost, null, 'no quantity does not make missing labor costs safe to omit');
      await request('/erp/cost-entries', 'POST', {
        jobsite_id: project.id, date: '2035-01-13', cost_code: '300', category: 'labor', amount: 100, description: 'Recorded shift labor',
      }, 201);
      assert.ok(getErpOverview(tenantId).projects.find(item => item.id === project.id).forecast_cost > 0);
      await request('/erp/cost-entries', 'POST', {
        jobsite_id: project.id, date: '2035-01-13', cost_code: '300', category: 'labor', amount: -1, description: 'Invalid',
      }, 400);
    });
    await t.test('every overview and mutation remains in its resolved tenant', async () => {
      await request(`/erp/projects/${project.id}`, 'PATCH', { budget: 999 }, 404, foreignTenant);
      await request(`/erp/daily-reports/${report.id}/approve`, 'POST', {}, 404, foreignTenant);
      await request('/erp/assignments', 'POST', {
        crew_id: crew.id, jobsite_id: project.id, date: '2035-01-15', task: 'Foreign allocation', cost_code: '100',
      }, 404, foreignTenant);
      const foreignOverview = await request('/erp/overview', 'GET', undefined, 200, foreignTenant);
      assert.equal(foreignOverview.projects.length, 0);
      assert.equal(foreignOverview.crews.length, 0);
      assert.equal(foreignOverview.daily_reports.length, 0);
      assert.equal(foreignOverview.people.length, 1);
    });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    getDb().close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
