import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
const fixture = mkdtempSync(path.join(tmpdir(), "dirtworks-finance-test-"));
process.env.DB_PATH = path.join(fixture, "finance.db");
const { getDb, get, run, nowIso } = await import("../dist/db/database.js");
const { getErpOverview } = await import("../dist/erp/overview.js");
const { initializeErpSchema } = await import("../dist/erp/schema.js");
const { initializeWorkforcePlanning } =
  await import("../dist/erp/workforce-planning.js");
const { initializeProcurement } = await import("../dist/erp/procurement.js");
const { initCommercial } = await import("../dist/erp/commercial.js");
const { initializeProjectFinance, workingDays, getProjectFinance } =
  await import("../dist/erp/project-finance.js");
const { projectFinanceRouter } =
  await import("../dist/api/routes/project-finance.js");
const { tenantMiddleware } = await import("../dist/api/tenancy.js");

test("planning snapshots, measured billing, receipts, and final retainage are traceable", async (t) => {
  getDb();
  initializeErpSchema();
  initializeWorkforcePlanning();
  initCommercial();
  initializeProcurement();
  initializeProjectFinance();
  const tenant = Number(
    run(
      "INSERT INTO tenants(slug,name) VALUES('summit-dirtworks','Finance test')",
    ).lastInsertRowid,
  );
  const foreignTenant = Number(
    run(
      "INSERT INTO tenants(slug,name) VALUES('finance-other','Other company')",
    ).lastInsertRowid,
  );
  const job = Number(
    run(
      "INSERT INTO jobsites(tenant_id,name,code,status,lat,lng,start_date,end_date) VALUES(?,'Finance test project','FIN-1','active',35,-98,'2035-01-01','2035-02-28')",
      tenant,
    ).lastInsertRowid,
  );
  const foreignJob = Number(
    run(
      "INSERT INTO jobsites(tenant_id,name,code,status,lat,lng) VALUES(?,'Foreign job','OTHER','active',35,-98)",
      foreignTenant,
    ).lastInsertRowid,
  );
  run(
    "INSERT INTO project_profiles(tenant_id,jobsite_id,contract_value,budget) VALUES(?,?,1500,1000)",
    tenant,
    job,
  );
  const first = Number(
    run(
      "INSERT INTO production_plans(tenant_id,jobsite_id,phase,activity,unit,planned_qty,planned_hours,planned_start,planned_end) VALUES(?,?,'Earthwork','Cut','CY',100,10,'2035-01-01','2035-01-20')",
      tenant,
      job,
    ).lastInsertRowid,
  );
  const second = Number(
    run(
      "INSERT INTO production_plans(tenant_id,jobsite_id,phase,activity,unit,planned_qty,planned_hours) VALUES(?,?,'Utilities','Pipe','LF',100,20)",
      tenant,
      job,
    ).lastInsertRowid,
  );
  run(
    "INSERT INTO work_item_profiles(tenant_id,plan_id,cost_code,budget) VALUES(?,?,'100',800)",
    tenant,
    first,
  );
  run(
    "INSERT INTO work_item_profiles(tenant_id,plan_id,cost_code,budget) VALUES(?,?,'200',200)",
    tenant,
    second,
  );
  const foreignPlan = Number(
    run(
      "INSERT INTO production_plans(tenant_id,jobsite_id,phase,activity,unit,planned_qty,planned_hours) VALUES(?,?,'Foreign','Foreign','CY',100,10)",
      foreignTenant,
      foreignJob,
    ).lastInsertRowid,
  );
  const employee = Number(
    run(
      "INSERT INTO employees(tenant_id,name,role) VALUES(?,'Finance test foreman','foreman')",
      tenant,
    ).lastInsertRowid,
  );
  const crew = Number(
    run(
      "INSERT INTO crews(tenant_id,name,trade,foreman_id) VALUES(?,'Finance test crew','Civil',?)",
      tenant,
      employee,
    ).lastInsertRowid,
  );
  run(
    "INSERT INTO production_entries(tenant_id,plan_id,date,qty,hours,source) VALUES(?,?,'2035-01-05',40,4,'manual')",
    tenant,
    first,
  );
  run(
    "INSERT INTO production_entries(tenant_id,plan_id,date,qty,hours,source) VALUES(?,?,'2035-01-31',10,1,'manual')",
    tenant,
    first,
  );
  run(
    "INSERT INTO production_entries(tenant_id,plan_id,date,qty,hours,source) VALUES(?,?,'2035-01-05',99999,99999,'ai_auto')",
    tenant,
    first,
  );
  run(
    "INSERT INTO job_cost_entries(tenant_id,jobsite_id,date,cost_code,category,amount,description) VALUES(?,?,'2035-01-05','100','labor',100,'Recorded labor')",
    tenant,
    job,
  );
  run(
    "INSERT INTO job_cost_entries(tenant_id,jobsite_id,date,cost_code,category,amount,description) VALUES(?,?,'2035-01-31','100','other',80,'Future-period cost')",
    tenant,
    job,
  );
  const voidCost = Number(
    run(
      "INSERT INTO job_cost_entries(tenant_id,jobsite_id,date,cost_code,category,amount,description) VALUES(?,?,'2035-01-04','100','labor',500,'Voided shift posting')",
      tenant,
      job,
    ).lastInsertRowid,
  );
  const shift = Number(
    run(
      "INSERT INTO time_entries(tenant_id,employee_id,jobsite_id,date,cost_code,start_time,end_time,break_minutes,hours,hourly_rate,burden_pct,base_cost,burden_cost,status,created_at) VALUES(?,?,?,'2035-01-04','100','07:00','08:00',0,1,500,0,500,0,'approved',?)",
      tenant,
      employee,
      job,
      nowIso(),
    ).lastInsertRowid,
  );
  run(
    "INSERT INTO time_entry_postings(time_entry_id,tenant_id,job_cost_entry_id) VALUES(?,?,?)",
    shift,
    tenant,
    voidCost,
  );
  run(
    "INSERT INTO time_entry_voids(time_entry_id,tenant_id,reason,voided_at,voided_by) VALUES(?,?,?,?,?)",
    shift,
    tenant,
    "Voided duplicate",
    nowIso(),
    "Test",
  );
  const report = Number(
    run(
      "INSERT INTO daily_reports(tenant_id,jobsite_id,crew_id,date,weather,notes,status,created_by,approved_at,approved_by) VALUES(?,?,?,'2035-01-06','','Measured daily production','approved','Test',?,'Test')",
      tenant,
      job,
      crew,
      nowIso(),
    ).lastInsertRowid,
  );
  run(
    "INSERT INTO daily_report_lines(tenant_id,report_id,plan_id,qty,labor_hours,equipment_hours,labor_cost,equipment_cost,material_cost) VALUES(?,?,?,10,1,0,20,0,0)",
    tenant,
    report,
    first,
  );
  const app = express();
  app.use(express.json());
  app.use("/api", tenantMiddleware, projectFinanceRouter);
  app.use((error, _req, res, _next) =>
    res.status(500).json({ error: error.message }),
  );
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (
    endpoint,
    method = "GET",
    data,
    status = 200,
    scope = tenant,
  ) => {
    const response = await fetch(url + endpoint, {
      method,
      headers: {
        "content-type": "application/json",
        "x-tenant-id": String(scope),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const result = response.status === 204 ? null : await response.json();
    assert.equal(
      response.status,
      status,
      `${method} ${endpoint}: ${JSON.stringify(result)}`,
    );
    return result;
  };
  let baseline,
    forecast,
    mapped,
    amountItem,
    bill1,
    bill2,
    bill3,
    requiredItem,
    release;
  try {
    await t.test(
      "calendar validates real dates and dependency links reject cross-job scopes and cycles",
      async () => {
        await request(
          `/erp/project-calendars/${foreignJob}`,
          "PUT",
          { weekdays: [1], holidays: [] },
          404,
        );
        await request(
          `/erp/project-calendars/${job}`,
          "PUT",
          { weekdays: [], holidays: [] },
          400,
        );
        await request(
          `/erp/project-calendars/${job}`,
          "PUT",
          { weekdays: [1, 2, 3, 4, 5], holidays: ["2035-02-30"] },
          400,
        );
        await request(`/erp/project-calendars/${job}`, "PUT", {
          weekdays: [1, 2, 3, 4, 5],
          holidays: ["2035-01-01"],
        });
        assert.equal(
          workingDays("2035-01-01", "2035-01-07", {
            weekdays: [1, 2, 3, 4, 5],
            holidays: ["2035-01-01"],
          }),
          4,
        );
        await request(
          "/erp/work-dependencies",
          "POST",
          { predecessor_id: first, successor_id: foreignPlan },
          404,
        );
        await request(
          "/erp/work-dependencies",
          "POST",
          { predecessor_id: first, successor_id: first },
          400,
        );
        await request(
          "/erp/work-dependencies",
          "POST",
          { predecessor_id: first, successor_id: second, lag_days: 2 },
          201,
        );
        await request(
          "/erp/work-dependencies",
          "POST",
          { predecessor_id: second, successor_id: first },
          409,
        );
      },
    );
    await t.test(
      "baseline snapshots preserve schedule, calendar, and immutable approved scope",
      async () => {
        baseline = await request(
          "/erp/project-baselines",
          "POST",
          {
            jobsite_id: job,
            title: "Original estimate",
            explanation: "Accepted contract scope",
          },
          201,
        );
        await request(`/erp/project-baselines/${baseline.id}/approve`, "POST");
        await request(
          `/erp/project-baselines/${baseline.id}/approve`,
          "POST",
          {},
          409,
        );
        assert.throws(
          () =>
            run(
              "UPDATE project_baselines SET title=? WHERE id=?",
              "Changed history",
              baseline.id,
            ),
          /immutable/,
        );
        assert.throws(
          () => run("DELETE FROM project_baselines WHERE id=?", baseline.id),
          /cannot be deleted/,
        );
        run(
          "UPDATE work_item_profiles SET budget=900 WHERE tenant_id=? AND plan_id=?",
          tenant,
          first,
        );
        const current = getProjectFinance(tenant).baselines[0];
        assert.equal(
          current.snapshot.work_items.find((i) => i.id === first).budget,
          800,
        );
        assert.equal(current.snapshot.calendar.holidays[0], "2035-01-01");
        assert.equal(current.snapshot.dependencies.length, 1);
      },
    );
    await t.test(
      "complete bottom-up forecasts avoid adding commitments twice and freeze costs at approval",
      async () => {
        const payload = {
          jobsite_id: job,
          as_of: "2035-01-10",
          forecast_finish: "2035-02-28",
          explanation:
            "Remaining labor, pipe and subcontract commitments included once",
          complete_scope_confirmed: true,
          lines: [
            {
              cost_code: "100",
              labor: 50,
              equipment: 25,
              material: 35,
              subcontract: 40,
              other: 10,
            },
            {
              cost_code: "200",
              labor: 0,
              equipment: 0,
              material: 0,
              subcontract: 0,
              other: 0,
            },
          ],
        };
        await request(
          "/erp/cost-forecasts",
          "POST",
          { ...payload, complete_scope_confirmed: false },
          400,
        );
        await request(
          "/erp/cost-forecasts",
          "POST",
          { ...payload, lines: [payload.lines[0]] },
          400,
        );
        await request(
          "/erp/cost-forecasts",
          "POST",
          {
            ...payload,
            lines: [{ ...payload.lines[0], labor: -1 }, payload.lines[1]],
          },
          400,
        );
        run(
          "INSERT INTO purchase_orders(tenant_id,jobsite_id,vendor,amount,status,order_date) VALUES(?,?,'Committed vendor',300,'approved','2035-01-01')",
          tenant,
          job,
        );
        forecast = await request("/erp/cost-forecasts", "POST", payload, 201);
        assert.equal(forecast.actual_cost_cents, 12000);
        assert.equal(forecast.remaining_cost_cents, 16000);
        assert.equal(forecast.estimate_at_completion_cents, 28000);
        assert.equal(forecast.committed_reference_cents, 30000);
        run(
          "INSERT INTO job_cost_entries(tenant_id,jobsite_id,date,cost_code,category,amount,description) VALUES(?,?,'2035-01-04','100','other',10,'Late posting')",
          tenant,
          job,
        );
        forecast = await request(
          `/erp/cost-forecasts/${forecast.id}/approve`,
          "POST",
        );
        assert.equal(forecast.actual_cost_cents, 13000);
        assert.equal(forecast.estimate_at_completion_cents, 29000);
        await request(
          `/erp/cost-forecasts/${forecast.id}/approve`,
          "POST",
          {},
          409,
        );
        assert.throws(
          () =>
            run(
              "UPDATE cost_forecasts SET remaining_cost_cents=0 WHERE id=?",
              forecast.id,
            ),
          /immutable/,
        );
      },
    );
    await t.test(
      "the schedule of values stays within the contract and preserves mapped units",
      async () => {
        await request(
          "/erp/pay-items",
          "POST",
          {
            jobsite_id: job,
            code: "BAD",
            description: "Wrong unit",
            unit: "LF",
            total_qty: 100,
            scheduled_value: 100,
            plan_id: first,
          },
          400,
        );
        await request(
          "/erp/pay-items",
          "POST",
          {
            jobsite_id: job,
            code: "FOREIGN",
            description: "Wrong scope",
            unit: "CY",
            total_qty: 100,
            scheduled_value: 100,
            plan_id: foreignPlan,
          },
          404,
        );
        mapped = await request(
          "/erp/pay-items",
          "POST",
          {
            jobsite_id: job,
            code: "CUT",
            description: "Measured excavation",
            unit: "CY",
            total_qty: 100,
            scheduled_value: 1000,
            plan_id: first,
          },
          201,
        );
        amountItem = await request(
          "/erp/pay-items",
          "POST",
          {
            jobsite_id: job,
            code: "MOB",
            description: "Verified mobilization and testing",
            unit: "LS",
            total_qty: 1,
            scheduled_value: 500,
          },
          201,
        );
        await request(
          "/erp/pay-items",
          "POST",
          {
            jobsite_id: job,
            code: "OVER",
            description: "Overscheduled",
            unit: "LS",
            total_qty: 1,
            scheduled_value: 0.01,
          },
          409,
        );
        assert.throws(
          () =>
            run(
              "UPDATE billing_pay_items SET scheduled_value_cents=1 WHERE id=?",
              mapped.id,
            ),
          /cannot be changed/,
        );
      },
    );
    await t.test(
      "billing uses cumulative accepted quantity through the period, never AI or future work",
      async () => {
        const payload = {
          jobsite_id: job,
          period_start: "2035-01-01",
          period_end: "2035-01-10",
          retainage_pct: 5,
          evidence_reference: "Signed measurement 001",
          lines: [
            { pay_item_id: mapped.id, cumulative_qty: 50 },
            { pay_item_id: amountItem.id, cumulative_amount: 100 },
          ],
        };
        await request(
          "/erp/payment-applications",
          "POST",
          {
            ...payload,
            lines: [{ pay_item_id: mapped.id, cumulative_qty: 51 }],
          },
          409,
        );
        await request(
          "/erp/payment-applications",
          "POST",
          {
            ...payload,
            lines: [{ pay_item_id: mapped.id, cumulative_amount: 500 }],
          },
          400,
        );
        bill1 = await request(
          "/erp/payment-applications",
          "POST",
          payload,
          201,
        );
        assert.equal(bill1.cumulative_earned_cents, 60000);
        assert.equal(bill1.retainage_cents, 3000);
        assert.equal(bill1.due_cents, 57000);
        await request("/erp/payment-applications", "POST", payload, 409);
        await request(
          `/erp/payment-applications/${bill1.id}/approve`,
          "POST",
          {},
          409,
        );
        await request(`/erp/payment-applications/${bill1.id}/submit`, "POST");
        await request(`/erp/payment-applications/${bill1.id}/approve`, "POST");
        await request(
          `/erp/payment-applications/${bill1.id}/approve`,
          "POST",
          {},
          409,
        );
        assert.throws(
          () =>
            run(
              "UPDATE payment_applications SET due_cents=0 WHERE id=?",
              bill1.id,
            ),
          /immutable/,
        );
      },
    );
    await t.test(
      "partial receipts cap unpaid certified due and duplicate references cannot post twice",
      async () => {
        await request(
          "/erp/customer-payments",
          "POST",
          {
            application_id: bill1.id,
            amount: 200,
            received_date: "2035-01-15",
            reference: "CHK-1",
          },
          201,
        );
        await request(
          "/erp/customer-payments",
          "POST",
          {
            application_id: bill1.id,
            amount: 200,
            received_date: "2035-01-15",
            reference: "CHK-1",
          },
          409,
        );
        await request(
          "/erp/customer-payments",
          "POST",
          {
            application_id: bill1.id,
            amount: 371,
            received_date: "2035-01-15",
            reference: "OVER-PAY",
          },
          409,
        );
        const [a, b] = await Promise.all([
          request(
            "/erp/customer-payments",
            "POST",
            {
              application_id: bill1.id,
              amount: 370,
              received_date: "2035-01-15",
              reference: "CHK-2",
            },
            201,
          ),
          request(
            "/erp/customer-payments",
            "POST",
            {
              application_id: bill1.id,
              amount: 1,
              received_date: "2035-01-15",
              reference: "CHK-3",
            },
            409,
          ),
        ]);
        assert.ok(a.id);
        assert.match(b.error, /unpaid/);
        const current = (
          await request("/erp/project-finance")
        ).applications.find((a) => a.id === bill1.id);
        assert.equal(current.paid, 570);
        assert.equal(current.unpaid, 0);
        assert.equal(
          getErpOverview(tenant).projects.find((p) => p.id === job).actual_cost,
          210,
          "billing does not post job costs and voided shift cost stays excluded",
        );
      },
    );
    await t.test(
      "later cumulative billing deducts previous certified values and retains pennies consistently",
      async () => {
        const payload = {
          jobsite_id: job,
          period_start: "2035-01-11",
          period_end: "2035-01-31",
          retainage_pct: 5,
          evidence_reference: "Signed measurement 002",
          lines: [
            { pay_item_id: mapped.id, cumulative_qty: 60 },
            { pay_item_id: amountItem.id, cumulative_amount: 150 },
          ],
        };
        await request(
          "/erp/payment-applications",
          "POST",
          { ...payload, period_start: "2035-01-10" },
          409,
        );
        await request(
          "/erp/payment-applications",
          "POST",
          { ...payload, retainage_pct: 10 },
          409,
        );
        bill2 = await request(
          "/erp/payment-applications",
          "POST",
          payload,
          201,
        );
        assert.equal(bill2.previous_earned_cents, 60000);
        assert.equal(bill2.current_earned_cents, 15000);
        assert.equal(bill2.retainage_cents, 750);
        assert.equal(bill2.due_cents, 14250);
        await request(`/erp/payment-applications/${bill2.id}/submit`, "POST");
        await request(`/erp/payment-applications/${bill2.id}/approve`, "POST");
        run(
          "INSERT INTO daily_report_reversals(report_id,tenant_id,reason,reversed_at,reversed_by) VALUES(?,?,?,?,?)",
          report,
          tenant,
          "Correction after certification",
          nowIso(),
          "Test",
        );
        const updated = (
          await request("/erp/project-finance")
        ).applications.find((a) => a.id === bill2.id);
        assert.match(updated.evidence_warning, /subsequently reversed/);
        run(
          "INSERT INTO production_entries(tenant_id,plan_id,date,qty,hours,source) VALUES(?,?,'2035-01-06',10,1,'manual')",
          tenant,
          first,
        );
      },
    );
    await t.test(
      "foreign companies cannot see or approve another company finance records",
      async () => {
        await request(
          `/erp/project-baselines/${baseline.id}/approve`,
          "POST",
          {},
          404,
          foreignTenant,
        );
        await request(
          `/erp/payment-applications/${bill2.id}/approve`,
          "POST",
          {},
          404,
          foreignTenant,
        );
        await request(
          "/erp/customer-payments",
          "POST",
          {
            application_id: bill1.id,
            amount: 1,
            received_date: "2035-02-01",
            reference: "FOREIGN",
          },
          404,
          foreignTenant,
        );
        const other = await request(
          "/erp/project-finance",
          "GET",
          undefined,
          200,
          foreignTenant,
        );
        for (const key of [
          "baselines",
          "forecasts",
          "pay_items",
          "applications",
          "payments",
          "retainage_releases",
        ])
          assert.equal(other[key].length, 0);
      },
    );
    await t.test(
      "required closeout, final measured production, and billing guard retainage release",
      async () => {
        await request(
          "/erp/retainage-releases",
          "POST",
          {
            jobsite_id: job,
            amount: 1,
            release_date: "2035-03-01",
            acceptance_reference: "Premature",
          },
          409,
        );
        requiredItem = await request(
          "/erp/closeout-items",
          "POST",
          {
            jobsite_id: job,
            title: "Signed as-builts and testing",
            required: true,
          },
          201,
        );
        await request(
          `/erp/project-closeout/${job}`,
          "POST",
          { acceptance_reference: "Premature" },
          409,
        );
        await request(
          `/erp/closeout-items/${requiredItem.id}`,
          "PATCH",
          { status: "complete", evidence_reference: "" },
          400,
        );
        await request(`/erp/closeout-items/${requiredItem.id}`, "PATCH", {
          status: "complete",
          evidence_reference: "ASBUILT-01",
        });
        await request(
          `/erp/project-closeout/${job}`,
          "POST",
          { acceptance_reference: "Incomplete work" },
          409,
        );
        run(
          "INSERT INTO production_entries(tenant_id,plan_id,date,qty,hours,source) VALUES(?,?,'2035-02-01',40,4,'manual')",
          tenant,
          first,
        );
        run(
          "INSERT INTO production_entries(tenant_id,plan_id,date,qty,hours,source) VALUES(?,?,'2035-02-01',100,20,'manual')",
          tenant,
          second,
        );
        const fields = {
          jobsite_id: job,
          period_start: "2035-02-01",
          period_end: "2035-02-28",
          retainage_pct: 5,
          evidence_reference: "Signed final measurement",
          lines: [
            { pay_item_id: mapped.id, cumulative_qty: 100 },
            { pay_item_id: amountItem.id, cumulative_amount: 500 },
          ],
        };
        const replace = await request(
          "/erp/payment-applications",
          "POST",
          fields,
          201,
        );
        await request(
          `/erp/payment-applications/${replace.id}/withdraw`,
          "POST",
          { reason: "Correct application reference" },
        );
        bill3 = await request("/erp/payment-applications", "POST", fields, 201);
        assert.equal(bill3.current_earned_cents, 75000);
        assert.equal(bill3.retainage_cents, 3750);
        await request(
          `/erp/project-closeout/${job}`,
          "POST",
          { acceptance_reference: "Unapproved billing" },
          409,
        );
        await request(`/erp/payment-applications/${bill3.id}/submit`, "POST");
        await request(`/erp/payment-applications/${bill3.id}/approve`, "POST");
        await request(
          `/erp/project-closeout/${job}`,
          "POST",
          { acceptance_reference: "Unreceived whole-order delivery" },
          409,
        );
        run(
          "UPDATE purchase_orders SET status='received' WHERE tenant_id=? AND jobsite_id=?",
          tenant,
          job,
        );
        const unresolved = Number(
          run(
            "INSERT INTO project_controls(tenant_id,jobsite_id,kind,title,amount) VALUES(?,?,'change_order','Unresolved change request',25)",
            tenant,
            job,
          ).lastInsertRowid,
        );
        await request(
          `/erp/project-closeout/${job}`,
          "POST",
          { acceptance_reference: "Open change" },
          409,
        );
        run(
          "UPDATE project_controls SET status='closed' WHERE tenant_id=? AND id=?",
          tenant,
          unresolved,
        );
        const pendingReport = Number(
          run(
            "INSERT INTO daily_reports(tenant_id,jobsite_id,crew_id,date,weather,notes,status,created_by) VALUES(?,?,?,'2035-02-03','','Final field record','submitted','Test')",
            tenant,
            job,
            crew,
          ).lastInsertRowid,
        );
        await request(
          `/erp/project-closeout/${job}`,
          "POST",
          { acceptance_reference: "Unapproved field record" },
          409,
        );
        run(
          "UPDATE daily_reports SET status='approved',approved_at=?,approved_by='Test' WHERE tenant_id=? AND id=?",
          nowIso(),
          tenant,
          pendingReport,
        );
        const vendor = Number(
          run(
            "INSERT INTO material_vendors(tenant_id,name) VALUES(?,'Closeout stock supplier')",
            tenant,
          ).lastInsertRowid,
        );
        const stockOrder = Number(
          run(
            "INSERT INTO purchase_orders(tenant_id,jobsite_id,vendor,amount,status,order_date) VALUES(?,?,'Closeout stock supplier',50,'approved','2035-02-01')",
            tenant,
            job,
          ).lastInsertRowid,
        );
        run(
          "INSERT INTO procurement_orders(order_id,tenant_id,vendor_id) VALUES(?,?,?)",
          stockOrder,
          tenant,
          vendor,
        );
        const stockLine = Number(
          run(
            "INSERT INTO po_lines(tenant_id,order_id,description,unit,cost_code,quantity,unit_price_cents,line_amount_cents) VALUES(?,?,'Final pipe material','LF','200',5,1000,5000)",
            tenant,
            stockOrder,
          ).lastInsertRowid,
        );
        await request(
          `/erp/project-closeout/${job}`,
          "POST",
          { acceptance_reference: "Unreceived line delivery" },
          409,
        );
        const receipt = Number(
          run(
            "INSERT INTO material_receipts(tenant_id,order_id,date,reference) VALUES(?,?,'2035-02-05','Final stock delivery')",
            tenant,
            stockOrder,
          ).lastInsertRowid,
        );
        run(
          "INSERT INTO material_receipt_lines(tenant_id,receipt_id,line_id,quantity) VALUES(?,?,?,5)",
          tenant,
          receipt,
          stockLine,
        );
        run(
          "UPDATE purchase_orders SET status='received' WHERE tenant_id=? AND id=?",
          tenant,
          stockOrder,
        );
        await request(
          `/erp/project-closeout/${job}`,
          "POST",
          { acceptance_reference: "Unconsumed received material" },
          409,
        );
        const usageCost = Number(
          run(
            "INSERT INTO job_cost_entries(tenant_id,jobsite_id,date,cost_code,category,amount,description) VALUES(?,?,'2035-02-05','200','material',50,'Final stock usage')",
            tenant,
            job,
          ).lastInsertRowid,
        );
        run(
          "INSERT INTO material_issues(tenant_id,jobsite_id,line_id,date,reference,quantity,unit_price_cents,amount_cents,cost_entry_id) VALUES(?,?,?,'2035-02-05','Final verified material usage',5,1000,5000,?)",
          tenant,
          job,
          stockLine,
          usageCost,
        );
        await request(`/erp/project-closeout/${job}`, "POST", {
          acceptance_reference: "OWNER-FINAL-2035",
        });
        assert.equal(
          get("SELECT status FROM jobsites WHERE id=?", job).status,
          "complete",
        );
        await request(
          `/erp/project-closeout/${job}`,
          "POST",
          { acceptance_reference: "Repeat" },
          409,
        );
        await request(
          "/erp/closeout-items",
          "POST",
          { jobsite_id: job, title: "Post acceptance change" },
          409,
        );
        release = await request(
          "/erp/retainage-releases",
          "POST",
          {
            jobsite_id: job,
            amount: 50,
            release_date: "2035-03-01",
            acceptance_reference: "RELEASE-1",
          },
          201,
        );
        await request(
          "/erp/retainage-releases",
          "POST",
          {
            jobsite_id: job,
            amount: 26,
            release_date: "2035-03-01",
            acceptance_reference: "OVER-RELEASE",
          },
          409,
        );
        await request(
          "/erp/retainage-releases",
          "POST",
          {
            jobsite_id: job,
            amount: 25,
            release_date: "2035-03-01",
            acceptance_reference: "RELEASE-2",
          },
          201,
        );
        await request(
          "/erp/retainage-releases",
          "POST",
          {
            jobsite_id: job,
            amount: 1,
            release_date: "2035-03-01",
            acceptance_reference: "EXTRA",
          },
          409,
        );
      },
    );
    await t.test(
      "released retainage remains receivable until separately recorded cash arrives",
      async () => {
        let released = (
          await request("/erp/project-finance")
        ).retainage_releases.find((r) => r.id === release.id);
        assert.equal(released.paid, 0);
        assert.equal(released.unpaid, 50);
        await request(
          "/erp/retainage-payments",
          "POST",
          {
            release_id: release.id,
            amount: 30,
            received_date: "2035-03-02",
            reference: "RET-CASH-1",
          },
          201,
        );
        await request(
          "/erp/retainage-payments",
          "POST",
          {
            release_id: release.id,
            amount: 21,
            received_date: "2035-03-02",
            reference: "RET-OVER",
          },
          409,
        );
        await request(
          "/erp/retainage-payments",
          "POST",
          {
            release_id: release.id,
            amount: 20,
            received_date: "2035-03-02",
            reference: "RET-CASH-2",
          },
          201,
        );
        released = (
          await request("/erp/project-finance")
        ).retainage_releases.find((r) => r.id === release.id);
        assert.equal(released.paid, 50);
        assert.equal(released.unpaid, 0);
        assert.throws(
          () =>
            run(
              "UPDATE retainage_releases SET amount_cents=0 WHERE id=?",
              release.id,
            ),
          /immutable/,
        );
        initializeProjectFinance();
        assert.equal(
          get(
            "SELECT COUNT(*) n FROM payment_applications WHERE tenant_id=?",
            tenant,
          ).n,
          4,
        );
        assert.equal(
          get(
            "SELECT COUNT(*) n FROM project_closeouts WHERE tenant_id=?",
            tenant,
          ).n,
          1,
        );
      },
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    getDb().close();
    rmSync(fixture, { recursive: true, force: true });
  }
});
