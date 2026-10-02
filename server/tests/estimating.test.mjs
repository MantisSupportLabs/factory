import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const fixture = mkdtempSync(path.join(tmpdir(), "dirtworks-estimating-test-"));
process.env.DB_PATH = path.join(fixture, "estimating.db");
process.env.NODE_ENV = "test";
const { getDb, get, all, run, nowIso } = await import("../dist/db/database.js");
const { initializeErpSchema } = await import("../dist/erp/schema.js");
const { initializeWorkforcePlanning } =
  await import("../dist/erp/workforce-planning.js");
const { initCommercial } = await import("../dist/erp/commercial.js");
const { initializeProcurement } = await import("../dist/erp/procurement.js");
const { initializeProjectFinance } =
  await import("../dist/erp/project-finance.js");
const { getErpOverview } = await import("../dist/erp/overview.js");
const { businessDate } = await import("../dist/erp/calendar.js");
const { tenantMiddleware } = await import("../dist/api/tenancy.js");
const {
  initializeAccess,
  accessMiddleware,
  authorizationMiddleware,
  canAccess,
  hashPassword,
} = await import("../dist/erp/access.js");
const { accessRouter } = await import("../dist/api/routes/access.js");
const { initializeEstimatingSchema } =
  await import("../dist/erp/estimating.js");
const { estimatingRouter } = await import("../dist/api/routes/estimating.js");

const component = (category = "labor", overrides = {}) => ({
  category,
  description: "Crew or resource assumption",
  resource_unit:
    category === "labor" || category === "equipment" ? "HRS" : "EA",
  usage_per_unit: 0.25,
  unit_rate: 40,
  waste_pct: 0,
  ...overrides,
});
const line = (overrides = {}) => ({
  cost_code: "UTIL-01",
  phase: "Utilities",
  description: "Install drainage pipe",
  unit: "LF",
  quantity: 100,
  takeoff: { method: "manual", source_reference: "C4 revision A" },
  components: [component()],
  ...overrides,
});
let sequence = 0;
const draft = (overrides = {}) => ({
  bid_code: `EST-TEST-${++sequence}`,
  title: "Civil bid for drainage and road improvements",
  client: "Test municipal owner",
  due_date: businessDate(10),
  valid_until: businessDate(30),
  assumptions: "Normal working hours and suitable excavated soil",
  exclusions: "Rock excavation and contaminated soil",
  currency: "USD",
  overhead_pct: 5,
  contingency_pct: 3,
  markup_pct: 10,
  lines: [line()],
  ...overrides,
});

test("estimating preserves bid evidence and hands approved scope to one new project", async (t) => {
  getDb();
  initializeErpSchema();
  initializeWorkforcePlanning();
  initCommercial();
  initializeProcurement();
  initializeProjectFinance();
  initializeAccess();
  initializeEstimatingSchema();
  const tenant = Number(
    run(
      "INSERT INTO tenants(slug,name) VALUES('summit-dirtworks','Estimating test company')",
    ).lastInsertRowid,
  );
  const foreignTenant = Number(
    run(
      "INSERT INTO tenants(slug,name) VALUES('estimating-other','Other estimating company')",
    ).lastInsertRowid,
  );
  const pmId = Number(
    run(
      "INSERT INTO employees(tenant_id,name,role) VALUES(?,'Estimating PM','pm')",
      tenant,
    ).lastInsertRowid,
  );
  const foremanId = Number(
    run(
      "INSERT INTO employees(tenant_id,name,role) VALUES(?,'Estimating foreman','foreman')",
      tenant,
    ).lastInsertRowid,
  );
  const inactivePmId = Number(
    run(
      "INSERT INTO employees(tenant_id,name,role,active) VALUES(?,'Inactive PM','pm',0)",
      tenant,
    ).lastInsertRowid,
  );
  const foreignPmId = Number(
    run(
      "INSERT INTO employees(tenant_id,name,role) VALUES(?,'Foreign PM','pm')",
      foreignTenant,
    ).lastInsertRowid,
  );
  const existingJob = Number(
    run(
      "INSERT INTO jobsites(tenant_id,name,code,status,lat,lng,start_date,end_date) VALUES(?,'Existing live project','EXISTING','active',35,-98,'2030-01-01','2030-12-31')",
      tenant,
    ).lastInsertRowid,
  );
  run(
    "INSERT INTO project_profiles(tenant_id,jobsite_id,contract_value,budget) VALUES(?,?,98765.43,87654.32)",
    tenant,
    existingJob,
  );
  const existingPlan = Number(
    run(
      "INSERT INTO production_plans(tenant_id,jobsite_id,phase,activity,unit,planned_qty,planned_hours) VALUES(?,?,'Roads','Existing paving','SY',500,80)",
      tenant,
      existingJob,
    ).lastInsertRowid,
  );
  run(
    "INSERT INTO work_item_profiles(tenant_id,plan_id,cost_code,budget) VALUES(?,?,'EXIST',87654.32)",
    tenant,
    existingPlan,
  );
  run(
    "INSERT INTO production_entries(tenant_id,plan_id,date,qty,hours,source) VALUES(?,?,?,25,4,'manual')",
    tenant,
    existingPlan,
    businessDate(),
  );
  run(
    "INSERT INTO job_cost_entries(tenant_id,jobsite_id,date,cost_code,category,amount,description) VALUES(?,?,?,'EXIST','labor',100,'Existing project cost')",
    tenant,
    existingJob,
    businessDate(),
  );
  const password = "Estimating test password 123!";
  const encoded = hashPassword(password);
  for (const role of ["owner", "pm", "accountant", "foreman"])
    run(
      "INSERT INTO auth_users(tenant_id,name,email,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
      tenant,
      `Authenticated ${role}`,
      `${role}@estimating.test`,
      role,
      encoded,
      nowIso(),
    );
  run(
    "INSERT INTO auth_users(tenant_id,name,email,role,password_hash,created_at) VALUES(?,'Foreign owner','foreign@estimating.test','owner',?,?)",
    foreignTenant,
    encoded,
    nowIso(),
  );
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    accessMiddleware,
    tenantMiddleware,
    authorizationMiddleware,
    accessRouter,
    estimatingRouter,
  );
  app.use((error, _req, res, _next) =>
    res.status(500).json({ error: error.message }),
  );
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sessions = {};
  const request = async (
    endpoint,
    method = "GET",
    data,
    expected = 200,
    identity = "owner",
    tenantHeader,
  ) => {
    const session = sessions[identity];
    const response = await fetch(origin + "/api" + endpoint, {
      method,
      headers: {
        "content-type": "application/json",
        origin,
        ...(session
          ? { cookie: session.cookie, "x-csrf-token": session.csrf }
          : {}),
        ...(tenantHeader === undefined
          ? {}
          : { "x-tenant-id": String(tenantHeader) }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    const result = response.status === 204 ? null : await response.json();
    assert.equal(
      response.status,
      expected,
      `${identity} ${method} ${endpoint}: ${JSON.stringify(result)}`,
    );
    return result;
  };
  const login = async (identity) => {
    const response = await fetch(origin + "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: `${identity}@estimating.test`, password }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    sessions[identity] = {
      cookie: response.headers.get("set-cookie").split(";")[0],
      csrf: result.csrf_token,
    };
  };
  const create = (payload = draft(), identity = "owner") =>
    request("/erp/estimates", "POST", payload, 201, identity);
  const approve = (estimate, identity = "owner") =>
    request(
      `/erp/estimates/${estimate.id}/approve`,
      "POST",
      {
        expected_edit_version: estimate.edit_version,
        reviewer: "Spoofed reviewer",
      },
      200,
      identity,
    );
  const award = (estimate, overrides = {}) => ({
    expected_edit_version: estimate.edit_version,
    award_reference: `SIGNED-${estimate.id}`,
    award_date: businessDate(),
    name: "New awarded civil job",
    code: `AWARD-${estimate.id}`,
    pm_id: pmId,
    start_date: businessDate(5),
    end_date: businessDate(90),
    address: "100 Construction Way",
    lat: 35.2,
    lng: -97.5,
    superintendent: "Civil superintendent",
    ...overrides,
  });
  let bid, approved, handover;
  const priorDateNow = Date.now;
  try {
    for (const identity of ["owner", "pm", "accountant", "foreman", "foreign"])
      await login(identity);
    await t.test(
      "civil takeoff converts feet, square yards and cubic yards without mixing material waste into installed scope",
      async () => {
        const measured = await create(
          draft({
            lines: [
              line({
                cost_code: "LEN",
                unit: "LF",
                quantity: 999,
                takeoff: {
                  method: "length",
                  length_ft: 123.4567894,
                  count: 2,
                  source_reference: "C1 scale checked",
                },
              }),
              line({
                cost_code: "SF",
                unit: "SF",
                takeoff: {
                  method: "area",
                  length_ft: 30,
                  width_ft: 18,
                  count: 2,
                  source_reference: "C2 area",
                },
              }),
              line({
                cost_code: "SY",
                unit: "SY",
                takeoff: {
                  method: "area",
                  length_ft: 30,
                  width_ft: 18,
                  source_reference: "C2 area",
                },
              }),
              line({
                cost_code: "CY",
                unit: "CY",
                takeoff: {
                  method: "volume",
                  length_ft: 30,
                  width_ft: 18,
                  depth_ft: 3,
                  source_reference: "C3 excavation",
                },
                components: [
                  component("material", {
                    usage_per_unit: 1,
                    unit_rate: 10,
                    waste_pct: 5,
                  }),
                ],
              }),
              line({
                cost_code: "EA",
                unit: "EA",
                takeoff: {
                  method: "count",
                  count: 7,
                  source_reference: "C4 structures",
                },
              }),
              line({ cost_code: "TON", unit: "TON", quantity: 12.5 }),
            ],
          }),
        );
        assert.deepEqual(
          measured.lines.map((item) => item.quantity),
          [246.913579, 1080, 60, 60, 7, 12.5],
        );
        assert.equal(measured.lines[3].components[0].cost_cents, 63000);
        assert.equal(
          measured.lines[3].quantity,
          60,
          "5% material waste adds resource cost but does not inflate planned installed quantity",
        );
      },
    );
    await t.test(
      "bad geometry, incompatible units, impossible dates and invalid resource assumptions are rejected before saving",
      async () => {
        const invalidLines = [
          line({
            unit: "TON",
            takeoff: {
              method: "volume",
              length_ft: 1,
              width_ft: 1,
              depth_ft: 1,
              source_reference: "C1",
            },
          }),
          line({
            unit: "CY",
            takeoff: {
              method: "length",
              length_ft: 10,
              source_reference: "C1",
            },
          }),
          line({
            takeoff: {
              method: "length",
              length_ft: -1,
              source_reference: "C1",
            },
          }),
          line({
            takeoff: {
              method: "length",
              length_ft: 10,
              count: 1.5,
              source_reference: "C1",
            },
          }),
          line({
            takeoff: { method: "length", length_ft: 10, source_reference: "" },
          }),
          line({ quantity: 0 }),
          line({ components: [component("labor", { resource_unit: "LF" })] }),
          line({
            components: [component("material", { unit_rate: "Infinity" })],
          }),
          line({ components: [component("material", { waste_pct: -1 })] }),
          line({ components: [component("labor", { usage_per_unit: -0.1 })] }),
          line({
            components: [
              component("material", {
                quote_reference: "Q-1",
                quote_vendor: "",
                quote_valid_until: businessDate(20),
              }),
            ],
          }),
        ];
        const countBefore = (await request("/erp/estimating")).estimates.length;
        for (const badLine of invalidLines)
          await request(
            "/erp/estimates",
            "POST",
            draft({ lines: [badLine] }),
            400,
          );
        for (const header of [
          { currency: "CAD" },
          { valid_until: "2030-02-30" },
          { overhead_pct: -1 },
          { due_date: businessDate(40), valid_until: businessDate(30) },
        ])
          await request("/erp/estimates", "POST", draft(header), 400);
        assert.equal(
          (await request("/erp/estimating")).estimates.length,
          countBefore,
        );
      },
    );
    await t.test(
      "drafts may be incomplete while approval requires priced scope and live estimate and quote evidence",
      async () => {
        const empty = await create(draft({ lines: [] }));
        await request(
          `/erp/estimates/${empty.id}/approve`,
          "POST",
          { expected_edit_version: empty.edit_version },
          400,
        );
        const zero = await create(
          draft({
            lines: [
              line({ components: [component("other", { unit_rate: 0 })] }),
            ],
          }),
        );
        await request(
          `/erp/estimates/${zero.id}/approve`,
          "POST",
          { expected_edit_version: zero.edit_version },
          400,
        );
        const unsourced = await create(
          draft({
            lines: [
              line({ takeoff: { method: "manual", source_reference: "" } }),
            ],
          }),
        );
        await request(
          `/erp/estimates/${unsourced.id}/approve`,
          "POST",
          { expected_edit_version: unsourced.edit_version },
          400,
        );
        const expired = await create(
          draft({ due_date: businessDate(-3), valid_until: businessDate(-1) }),
        );
        await request(
          `/erp/estimates/${expired.id}/approve`,
          "POST",
          { expected_edit_version: expired.edit_version },
          400,
        );
        const expiredQuote = await create(
          draft({
            lines: [
              line({
                components: [
                  component("material", {
                    quote_reference: "Q-EXPIRED",
                    quote_vendor: "Pipe supplier",
                    quote_valid_until: businessDate(-1),
                  }),
                ],
              }),
            ],
          }),
        );
        await request(
          `/erp/estimates/${expiredQuote.id}/approve`,
          "POST",
          { expected_edit_version: expiredQuote.edit_version },
          400,
        );
      },
    );
    await t.test(
      "fractional resource prices and allowances reconcile to cents across every work item",
      async () => {
        bid = await create(
          draft({
            overhead_pct: 4.25,
            contingency_pct: 3.15,
            markup_pct: 9.75,
            totals: { bid_total_cents: 1, cost_total_cents: 1 },
            lines: [
              line({
                cost_code: "A",
                unit: "EA",
                quantity: 3,
                components: [
                  component("labor", {
                    usage_per_unit: 0.125,
                    unit_rate: 31.17,
                  }),
                  component("material", {
                    usage_per_unit: 1.111,
                    unit_rate: 2.35,
                    waste_pct: 7,
                    quote_reference: "SUP-Q-123",
                    quote_vendor: "Civil pipe supplier",
                    quote_valid_until: businessDate(20),
                  }),
                  component("equipment", {
                    usage_per_unit: 0.3,
                    unit_rate: 5.89,
                  }),
                ],
              }),
              line({
                cost_code: "B",
                unit: "LS",
                quantity: 1,
                components: [
                  component("other", { usage_per_unit: 0.01, unit_rate: 0.5 }),
                ],
              }),
              line({
                cost_code: "C",
                unit: "TON",
                quantity: 2.75,
                components: [
                  component("material", {
                    usage_per_unit: 0.5,
                    unit_rate: 9.99,
                  }),
                ],
              }),
            ],
          }),
          "pm",
        );
        assert.deepEqual(
          bid.lines[0].components.map((item) => item.cost_cents),
          [1169, 838, 530],
        );
        assert.equal(bid.lines[1].direct_cost_cents, 1);
        assert.deepEqual(bid.totals, {
          direct_cost_cents: 3912,
          overhead_cents: 166,
          contingency_cents: 128,
          cost_total_cents: 4206,
          markup_cents: 410,
          bid_total_cents: 4616,
          labor_hours: 0.375,
          equipment_hours: 0.9,
        });
        for (const [lineField, totalField] of [
          ["direct_cost_cents", "direct_cost_cents"],
          ["overhead_cents", "overhead_cents"],
          ["contingency_cents", "contingency_cents"],
          ["budget_cents", "cost_total_cents"],
          ["markup_cents", "markup_cents"],
          ["sell_cents", "bid_total_cents"],
        ])
          assert.equal(
            bid.lines.reduce((sum, item) => sum + item[lineField], 0),
            bid.totals[totalField],
            lineField,
          );
        assert.equal(bid.created_by, "Authenticated pm");
      },
    );
    await t.test(
      "edit versions prevent a stale PM form from erasing another estimator's assumptions",
      async () => {
        const staleVersion = bid.edit_version;
        bid = await request(
          `/erp/estimates/${bid.id}`,
          "PATCH",
          {
            expected_edit_version: staleVersion,
            assumptions: "Reviewed soil and dewatering assumptions",
          },
          200,
          "pm",
        );
        assert.equal(bid.edit_version, staleVersion + 1);
        await request(
          `/erp/estimates/${bid.id}`,
          "PATCH",
          {
            expected_edit_version: staleVersion,
            assumptions: "Old browser tab overwrites this",
          },
          409,
          "pm",
        );
        await request(
          `/erp/estimates/${bid.id}`,
          "PATCH",
          { assumptions: "Missing optimistic version" },
          400,
          "pm",
        );
        const current = (await request("/erp/estimating")).estimates.find(
          (item) => item.id === bid.id,
        );
        assert.equal(
          current.assumptions,
          "Reviewed soil and dewatering assumptions",
        );
        assert.equal(current.edit_version, bid.edit_version);
      },
    );
    await t.test(
      "authorization distinguishes bid preparation, independent approval and project handover",
      async () => {
        for (const role of ["foreman", "dispatcher", "mechanic"])
          assert.equal(canAccess(role, "GET", "/erp/estimating"), false);
        assert.equal(
          canAccess("pm", "POST", `/erp/estimates/${bid.id}/approve`),
          false,
        );
        assert.equal(
          canAccess("accountant", "POST", `/erp/estimates/${bid.id}/handover`),
          false,
        );
        await request("/erp/estimating", "GET", undefined, 403, "foreman");
        await request("/erp/estimates", "POST", draft(), 403, "foreman");
        await request(
          `/erp/estimates/${bid.id}/approve`,
          "POST",
          { expected_edit_version: bid.edit_version },
          403,
          "pm",
        );
        approved = await approve(bid, "accountant");
        assert.equal(approved.status, "approved");
        assert.equal(
          approved.approved_by,
          "Authenticated accountant",
          "the supplied reviewer cannot replace the signed-in approver",
        );
        await request(
          `/erp/estimates/${approved.id}/handover`,
          "POST",
          award(approved),
          403,
          "accountant",
        );
      },
    );
    await t.test(
      "approved revisions remain fixed and a newer draft blocks award of the superseded bid",
      async () => {
        await request(
          `/erp/estimates/${approved.id}`,
          "PATCH",
          { expected_edit_version: approved.edit_version, markup_pct: 99 },
          409,
        );
        await request(
          `/erp/estimates/${approved.id}/approve`,
          "POST",
          { expected_edit_version: approved.edit_version },
          409,
        );
        const revised = await request(
          `/erp/estimates/${approved.id}/revise`,
          "POST",
          { expected_edit_version: approved.edit_version },
          201,
          "pm",
        );
        assert.notEqual(revised.id, approved.id);
        assert.equal(revised.family_id, approved.family_id);
        assert.equal(revised.revision, approved.revision + 1);
        assert.equal(revised.edit_version, 1);
        assert.equal(revised.status, "draft");
        assert.deepEqual(revised.lines, approved.lines);
        assert.deepEqual(revised.totals, approved.totals);
        await request(
          `/erp/estimates/${approved.id}/revise`,
          "POST",
          { expected_edit_version: approved.edit_version },
          409,
        );
        await request(
          `/erp/estimates/${approved.id}/handover`,
          "POST",
          award(approved),
          409,
          "pm",
        );
        approved = await approve(revised, "accountant");
      },
    );
    await t.test(
      "award validations reject foreign or inactive PMs, bad dates and existing job codes without creating partial work",
      async () => {
        const projectCount = get("SELECT COUNT(*) n FROM jobsites").n;
        for (const [overrides, expected] of [
          [{ pm_id: foreignPmId }, 404],
          [{ pm_id: inactivePmId }, 400],
          [{ pm_id: foremanId }, 400],
          [{ start_date: businessDate(8), end_date: businessDate(3) }, 400],
          [{ end_date: "2030-02-30" }, 400],
          [{ award_date: businessDate(1) }, 400],
          [{ award_date: businessDate(-1) }, 400],
          [{ lat: 100 }, 400],
          [{ lat: null }, 400],
          [{ lng: null }, 400],
          [{ code: "EXISTING" }, 409],
        ])
          await request(
            `/erp/estimates/${approved.id}/handover`,
            "POST",
            award(approved, overrides),
            expected,
            "pm",
          );
        assert.equal(get("SELECT COUNT(*) n FROM jobsites").n, projectCount);
        assert.equal((await request("/erp/estimating")).handovers.length, 0);
      },
    );
    await t.test(
      "a failure while inserting the final pay item rolls back the project, plans, SOV and baseline together",
      async () => {
        const tables = [
          "jobsites",
          "project_profiles",
          "production_plans",
          "work_item_profiles",
          "billing_pay_items",
          "project_baselines",
          "estimate_handovers",
        ];
        const counts = Object.fromEntries(
          tables.map((table) => [
            table,
            get(`SELECT COUNT(*) n FROM ${table}`).n,
          ]),
        );
        getDb().exec(
          "CREATE TRIGGER estimating_test_pay_item_failure BEFORE INSERT ON billing_pay_items WHEN NEW.code='C' BEGIN SELECT RAISE(ABORT,'Injected handover write failure'); END",
        );
        try {
          const failure = await request(
            `/erp/estimates/${approved.id}/handover`,
            "POST",
            award(approved),
            500,
            "pm",
          );
          assert.match(failure.error, /Injected handover write failure/);
        } finally {
          getDb().exec("DROP TRIGGER estimating_test_pay_item_failure");
        }
        for (const table of tables)
          assert.equal(
            get(`SELECT COUNT(*) n FROM ${table}`).n,
            counts[table],
            `${table} must not retain partial handover records`,
          );
        assert.equal(
          (await request(`/erp/estimates/${approved.id}`)).status,
          "approved",
        );
      },
    );
    await t.test(
      "handover creates a planned project with the exact bid budget, quantities and SOV, while measured actuals stay unchanged",
      async () => {
        const previousProject = get(
          "SELECT * FROM jobsites WHERE id=?",
          existingJob,
        );
        const previousProfile = get(
          "SELECT * FROM project_profiles WHERE jobsite_id=?",
          existingJob,
        );
        const previousOverview = getErpOverview(tenant).projects.find(
          (item) => item.id === existingJob,
        );
        handover = await request(
          `/erp/estimates/${approved.id}/handover`,
          "POST",
          award(approved),
          201,
          "pm",
        );
        assert.equal(handover.created_by, "Authenticated pm");
        const job = get(
          "SELECT * FROM jobsites WHERE id=?",
          handover.jobsite_id,
        );
        const profile = get(
          "SELECT * FROM project_profiles WHERE jobsite_id=?",
          handover.jobsite_id,
        );
        assert.equal(job.status, "planned");
        assert.equal(profile.pm_id, pmId);
        assert.equal(profile.budget, 42.06);
        assert.equal(profile.contract_value, 46.16);
        const plans = all(
          "SELECT p.*,w.cost_code,w.budget FROM production_plans p JOIN work_item_profiles w ON w.plan_id=p.id WHERE p.jobsite_id=? ORDER BY p.id",
          handover.jobsite_id,
        );
        const payItems = all(
          "SELECT * FROM billing_pay_items WHERE jobsite_id=? ORDER BY id",
          handover.jobsite_id,
        );
        assert.equal(plans.length, 3);
        assert.equal(payItems.length, 3);
        assert.deepEqual(
          plans.map((item) => item.planned_qty),
          [3, 1, 2.75],
        );
        assert.deepEqual(
          plans.map((item) => item.planned_hours),
          [0.375, 0, 0],
        );
        assert.equal(
          Math.round(plans.reduce((sum, item) => sum + item.budget, 0) * 100),
          4206,
        );
        assert.equal(
          payItems.reduce((sum, item) => sum + item.scheduled_value_cents, 0),
          4616,
        );
        assert.deepEqual(
          payItems.map((item) => item.total_qty),
          plans.map((item) => item.planned_qty),
        );
        assert.deepEqual(
          payItems.map((item) => item.plan_id),
          plans.map((item) => item.id),
        );
        const baseline = get(
          "SELECT * FROM project_baselines WHERE id=?",
          handover.baseline_id,
        );
        assert.equal(
          baseline.status,
          "draft",
          "handover must not approve the owner's project control baseline",
        );
        const snapshot = JSON.parse(baseline.snapshot);
        assert.equal(snapshot.work_items.length, 3);
        assert.equal(
          Math.round(
            snapshot.work_items.reduce((sum, item) => sum + item.budget, 0) *
              100,
          ),
          4206,
        );
        assert.equal(
          get(
            "SELECT COUNT(*) n FROM production_entries p JOIN production_plans w ON w.id=p.plan_id WHERE w.jobsite_id=?",
            job.id,
          ).n,
          0,
        );
        assert.equal(
          get(
            "SELECT COUNT(*) n FROM job_cost_entries WHERE jobsite_id=?",
            job.id,
          ).n,
          0,
        );
        assert.equal(
          get(
            "SELECT COUNT(*) n FROM material_issues WHERE jobsite_id=?",
            job.id,
          ).n,
          0,
        );
        const portfolioJob = getErpOverview(tenant).projects.find(
          (item) => item.id === job.id,
        );
        assert.equal(portfolioJob.actual_cost, 0);
        assert.equal(portfolioJob.progress_pct, 0);
        assert.deepEqual(
          get("SELECT * FROM jobsites WHERE id=?", existingJob),
          previousProject,
        );
        assert.deepEqual(
          get("SELECT * FROM project_profiles WHERE jobsite_id=?", existingJob),
          previousProfile,
        );
        assert.deepEqual(
          getErpOverview(tenant).projects.find(
            (item) => item.id === existingJob,
          ),
          previousOverview,
        );
      },
    );
    await t.test(
      "identical award retries return one project and conflicting retries or a second family award are rejected",
      async () => {
        const countBefore = get("SELECT COUNT(*) n FROM jobsites").n;
        // An award recorded successfully remains retryable after that PM becomes inactive.
        run("UPDATE employees SET active=0 WHERE id=?", pmId);
        let repeated;
        try {
          repeated = await request(
            `/erp/estimates/${approved.id}/handover`,
            "POST",
            award(approved),
            200,
            "pm",
          );
        } finally {
          run("UPDATE employees SET active=1 WHERE id=?", pmId);
        }
        assert.deepEqual(repeated, handover);
        assert.deepEqual(
          await request(
            `/erp/estimates/${approved.id}/handover`,
            "POST",
            award(approved, { expected_edit_version: 9999 }),
            200,
            "pm",
          ),
          handover,
        );
        await request(
          `/erp/estimates/${approved.id}/handover`,
          "POST",
          award(approved, { name: "A conflicting second project" }),
          409,
          "pm",
        );
        await request(
          `/erp/estimates/${bid.id}/handover`,
          "POST",
          award(bid),
          409,
          "pm",
        );
        await request(
          `/erp/estimates/${approved.id}/revise`,
          "POST",
          { expected_edit_version: approved.edit_version },
          409,
          "pm",
        );
        assert.equal(get("SELECT COUNT(*) n FROM jobsites").n, countBefore);
        assert.equal((await request("/erp/estimating")).handovers.length, 1);
      },
    );
    await t.test(
      "company boundaries hide estimate details and reject foreign estimate and project manager IDs",
      async () => {
        const other = await request(
          "/erp/estimating",
          "GET",
          undefined,
          200,
          "foreign",
        );
        assert.deepEqual(other.estimates, []);
        assert.deepEqual(other.handovers, []);
        await request(
          `/erp/estimates/${approved.id}`,
          "GET",
          undefined,
          404,
          "foreign",
        );
        await request(
          `/erp/estimates/${approved.id}`,
          "PATCH",
          {
            expected_edit_version: approved.edit_version,
            title: "Foreign edit",
          },
          404,
          "foreign",
        );
        await request(
          `/erp/estimates/${approved.id}/approve`,
          "POST",
          { expected_edit_version: approved.edit_version },
          404,
          "foreign",
        );
        await request(
          `/erp/estimates/${approved.id}/handover`,
          "POST",
          award(approved),
          404,
          "foreign",
        );
        await request(
          "/erp/estimating",
          "GET",
          undefined,
          403,
          "pm",
          foreignTenant,
        );
        const foreignBid = await create(draft(), "foreign");
        await request(
          `/erp/estimates/${foreignBid.id}/approve`,
          "POST",
          { expected_edit_version: foreignBid.edit_version },
          404,
        );
      },
    );
    await t.test(
      "a signed award within validity can be entered after expiry while awards outside quote validity cannot",
      async () => {
        const today = businessDate();
        const historical = await approve(
          await create(
            draft({
              due_date: today,
              valid_until: businessDate(1),
              lines: [
                line({
                  components: [
                    component("material", {
                      quote_reference: "RETRO-QUOTE",
                      quote_vendor: "Quoted supplier",
                      quote_valid_until: businessDate(1),
                    }),
                  ],
                }),
              ],
            }),
          ),
        );
        const expiredQuote = await approve(
          await create(
            draft({
              due_date: today,
              valid_until: businessDate(30),
              lines: [
                line({
                  components: [
                    component("material", {
                      quote_reference: "SHORT-QUOTE",
                      quote_vendor: "Quoted supplier",
                      quote_valid_until: today,
                    }),
                  ],
                }),
              ],
            }),
          ),
        );
        const originalNow = Date.now();
        try {
          Date.now = () => originalNow + 2 * 86400000;
          // Log in after moving the business date so the authentication session is current.
          await login("owner");
          const entered = await request(
            `/erp/estimates/${historical.id}/handover`,
            "POST",
            award(historical, { award_date: today }),
            201,
          );
          assert.ok(entered.jobsite_id);
          await request(
            `/erp/estimates/${expiredQuote.id}/handover`,
            "POST",
            award(expiredQuote, { award_date: businessDate(-1) }),
            400,
          );
        } finally {
          Date.now = priorDateNow;
          await login("owner");
        }
      },
    );
    await t.test(
      "approved quote and takeoff evidence, award provenance and estimate history remain immutable across repeated initialization",
      async () => {
        const saved = await request(`/erp/estimates/${approved.id}`);
        assert.equal(saved.lines[0].components[1].quote_reference, "SUP-Q-123");
        assert.equal(
          saved.lines[0].components[1].quote_vendor,
          "Civil pipe supplier",
        );
        assert.equal(saved.lines[0].components[1].unit_rate, 2.35);
        assert.equal(saved.lines[0].takeoff.source_reference, "C4 revision A");
        assert.throws(
          () => run("UPDATE estimates SET lines='[]' WHERE id=?", approved.id),
          /immutable/,
        );
        assert.throws(
          () => run("UPDATE estimates SET totals='{}' WHERE id=?", approved.id),
          /immutable/,
        );
        assert.throws(
          () =>
            run("UPDATE estimates SET status='draft' WHERE id=?", approved.id),
          /immutable/,
        );
        assert.throws(
          () => run("DELETE FROM estimates WHERE id=?", approved.id),
          /cannot be deleted/,
        );
        assert.throws(
          () =>
            run(
              "UPDATE estimate_handovers SET line_mappings='[]' WHERE id=?",
              handover.id,
            ),
          /immutable/,
        );
        assert.throws(
          () => run("DELETE FROM estimate_handovers WHERE id=?", handover.id),
          /cannot be deleted/,
        );
        assert.throws(
          () =>
            run(
              "UPDATE estimate_families SET bid_code='REWRITTEN-BID' WHERE id=?",
              approved.family_id,
            ),
          /immutable/,
        );
        const tables = [
          "estimate_families",
          "estimates",
          "estimate_handovers",
          "project_baselines",
          "billing_pay_items",
        ];
        const counts = tables.map(
          (table) => get(`SELECT COUNT(*) n FROM ${table}`).n,
        );
        initializeEstimatingSchema();
        initializeEstimatingSchema();
        assert.deepEqual(
          tables.map((table) => get(`SELECT COUNT(*) n FROM ${table}`).n),
          counts,
        );
        assert.deepEqual(await request(`/erp/estimates/${approved.id}`), saved);
        assert.deepEqual(getDb().prepare("PRAGMA foreign_key_check").all(), []);
      },
    );
  } finally {
    Date.now = priorDateNow;
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    getDb().close();
    rmSync(fixture, { recursive: true, force: true });
  }
});
