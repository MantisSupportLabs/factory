import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const directory = mkdtempSync(path.join(tmpdir(), "dirtworks-equipment-"));
process.env.DB_PATH = path.join(directory, "equipment.db");
const { get, getDb, run } = await import("../dist/db/database.js");
const { initializeErpSchema } = await import("../dist/erp/schema.js");
const { initializeEquipmentOperations } = await import(
  "../dist/erp/equipment-operations.js"
);
const { equipmentOperationsRouter } = await import(
  "../dist/api/routes/equipment-operations.js"
);

test("equipment operations preserve availability, movement and financial evidence", async (t) => {
  initializeErpSchema();
  initializeEquipmentOperations();
  const tenant = Number(
    run(
      "INSERT INTO tenants(slug,name) VALUES ('equipment-test','Equipment test')",
    ).lastInsertRowid,
  );
  const foreign = Number(
    run(
      "INSERT INTO tenants(slug,name) VALUES ('equipment-other','Other contractor')",
    ).lastInsertRowid,
  );
  const newJob = (tenant, code) =>
    Number(
      run(
        "INSERT INTO jobsites(tenant_id,name,code,lat,lng) VALUES (?,?,?,?,?)",
        tenant,
        code,
        code,
        32,
        -97,
      ).lastInsertRowid,
    );
  const jobA = newJob(tenant, "A"),
    jobB = newJob(tenant, "B"),
    foreignJob = newJob(foreign, "FOREIGN");
  const newPerson = (tenant, name) =>
    Number(
      run(
        "INSERT INTO employees(tenant_id,name,role) VALUES (?,?,'mechanic')",
        tenant,
        name,
      ).lastInsertRowid,
    );
  const mechanic = newPerson(tenant, "Test mechanic"),
    foreignPerson = newPerson(foreign, "Foreign mechanic");
  const newAsset = (tenant, job, name) =>
    Number(
      run(
        "INSERT INTO assets(tenant_id,jobsite_id,name,kind,operator,meta) VALUES (?,?,?,'machine','Original operator',?)",
        tenant,
        job,
        name,
        JSON.stringify({ starlinkKit: "preserve", custom: { serial: "123" } }),
      ).lastInsertRowid,
    );
  const machine = newAsset(tenant, jobA, "Excavator"),
    repairMachine = newAsset(tenant, jobA, "Dozer"),
    foreignAsset = newAsset(foreign, foreignJob, "Foreign iron");
  run(
    "INSERT INTO asset_state(asset_id,tenant_id,engine_hours,ts) VALUES (?,?,?,?)",
    machine,
    tenant,
    1200,
    "2035-01-01T00:00:00Z",
  );
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    (req, _res, next) => {
      req.tenant = { id: Number(req.headers["x-tenant-id"] ?? tenant) };
      next();
    },
    equipmentOperationsRouter,
  );
  app.use((error, _req, res, _next) =>
    res.status(500).json({ error: error.message }),
  );
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (
    endpoint,
    method = "GET",
    payload,
    status = 200,
    selectedTenant = tenant,
  ) => {
    const response = await fetch(base + endpoint, {
      method,
      headers: {
        "content-type": "application/json",
        "x-tenant-id": String(selectedTenant),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const result = await response.json();
    assert.equal(
      response.status,
      status,
      `${endpoint}: ${JSON.stringify(result)}`,
    );
    return result;
  };
  const reserve = {
    asset_id: machine,
    jobsite_id: jobA,
    start_at: "2035-01-10T08:00:00Z",
    end_at: "2035-01-10T16:00:00Z",
    task: "Storm trench",
  };
  const work = {
    asset_id: machine,
    type: "preventive",
    title: "250 hour inspection",
    parts_cost: 100,
    labor_cost: 200,
    assigned_to_id: mechanic,
  };
  let reservation, transfer, order;
  try {
    await t.test(
      "tenant boundaries and timestamp validation reject writes",
      async () => {
        await request(
          "/erp/equipment-reservations",
          "POST",
          { ...reserve, asset_id: foreignAsset },
          404,
        );
        await request(
          "/erp/equipment-reservations",
          "POST",
          { ...reserve, jobsite_id: foreignJob },
          404,
        );
        await request(
          "/erp/equipment-reservations",
          "POST",
          { ...reserve, start_at: "2035-02-30T08:00:00Z" },
          400,
        );
        await request(
          "/erp/equipment-reservations",
          "POST",
          { ...reserve, start_at: "2035-01-10T24:00:00Z" },
          400,
        );
        await request(
          "/erp/equipment-reservations",
          "POST",
          { ...reserve, start_at: "2035-01-10T08:00:00" },
          400,
        );
        await request(
          "/erp/equipment-work-orders",
          "POST",
          { ...work, assigned_to_id: foreignPerson },
          404,
        );
        await request(
          "/erp/equipment-work-orders",
          "POST",
          { ...work, jobsite_id: foreignJob, cost_code: "EQ" },
          404,
        );
        await request(
          "/erp/equipment-inspections",
          "POST",
          {
            asset_id: machine,
            date: "2035-01-01",
            inspector_id: foreignPerson,
            passed: true,
          },
          404,
        );
        assert.equal(get("SELECT COUNT(*) n FROM equipment_reservations").n, 0);
      },
    );
    await t.test(
      "concurrent overlapping bookings allow one and adjacent windows remain valid",
      async () => {
        const results = await Promise.all(
          [1, 2].map(async () => {
            const response = await fetch(base + "/erp/equipment-reservations", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(reserve),
            });
            return { status: response.status, value: await response.json() };
          }),
        );
        assert.deepEqual(
          results.map((result) => result.status).sort(),
          [201, 409],
        );
        reservation = results.find((result) => result.status === 201).value;
        await request(
          "/erp/equipment-reservations",
          "POST",
          {
            ...reserve,
            start_at: "2035-01-10T16:00:00Z",
            end_at: "2035-01-10T18:00:00Z",
          },
          201,
        );
        await request(
          "/erp/equipment-work-orders",
          "POST",
          {
            ...work,
            scheduled_start: "2035-01-10T15:00:00Z",
            scheduled_end: "2035-01-10T17:00:00Z",
          },
          409,
        );
        await request(
          `/erp/equipment-reservations/${reservation.id}/cancel`,
          "POST",
          {},
          404,
          foreign,
        );
        await request(
          `/erp/equipment-reservations/${reservation.id}/cancel`,
          "POST",
          {},
        );
        await request(
          "/erp/equipment-reservations",
          "POST",
          { ...reserve, jobsite_id: jobB },
          201,
        );
      },
    );
    await t.test(
      "planned maintenance and unavailable status block reservations",
      async () => {
        order = await request(
          "/erp/equipment-work-orders",
          "POST",
          {
            ...work,
            scheduled_start: "2035-01-11T08:00:00Z",
            scheduled_end: "2035-01-11T16:00:00Z",
          },
          201,
        );
        await request(
          "/erp/equipment-reservations",
          "POST",
          {
            ...reserve,
            start_at: "2035-01-11T12:00:00Z",
            end_at: "2035-01-11T18:00:00Z",
          },
          409,
        );
        for (const status of ["down", "maintenance", "retired"]) {
          run("UPDATE assets SET status=? WHERE id=?", status, repairMachine);
          await request(
            "/erp/equipment-reservations",
            "POST",
            { ...reserve, asset_id: repairMachine },
            409,
          );
        }
        run("UPDATE assets SET status='active' WHERE id=?", repairMachine);
      },
    );
    await t.test(
      "transfers preserve metadata and reject stale location/operator state",
      async () => {
        const fields = {
          asset_id: machine,
          from_jobsite_id: jobA,
          to_jobsite_id: jobB,
          custodian_id: mechanic,
          requested_date: "2035-01-02",
        };
        await request(
          "/erp/asset-transfers",
          "POST",
          { ...fields, custodian_id: foreignPerson },
          404,
        );
        await request(
          "/erp/asset-transfers",
          "POST",
          { ...fields, from_jobsite_id: jobB },
          409,
        );
        transfer = await request("/erp/asset-transfers", "POST", fields, 201);
        await request("/erp/asset-transfers", "POST", fields, 409);
        run(
          "UPDATE assets SET operator='Changed operator' WHERE id=?",
          machine,
        );
        await request(
          `/erp/asset-transfers/${transfer.id}/accept`,
          "POST",
          {},
          409,
        );
        await request(`/erp/asset-transfers/${transfer.id}/cancel`, "POST", {});
        transfer = await request("/erp/asset-transfers", "POST", fields, 201);
        await request(
          `/erp/asset-transfers/${transfer.id}/accept`,
          "POST",
          {},
          404,
          foreign,
        );
        transfer = await request(
          `/erp/asset-transfers/${transfer.id}/accept`,
          "POST",
          {},
        );
        assert.equal(transfer.previous_jobsite_id, jobA);
        assert.equal(transfer.previous_operator, "Changed operator");
        const moved = get(
          "SELECT jobsite_id,operator,meta FROM assets WHERE id=?",
          machine,
        );
        assert.equal(moved.jobsite_id, jobB);
        assert.equal(moved.operator, "Test mechanic");
        assert.deepEqual(JSON.parse(moved.meta), {
          starlinkKit: "preserve",
          custom: { serial: "123" },
          jobsiteLocked: true,
        });
        await request(`/erp/asset-transfers/${transfer.id}/accept`, "POST", {});
        await request(
          `/erp/asset-transfers/${transfer.id}/cancel`,
          "POST",
          {},
          409,
        );
        assert.equal(
          get("SELECT COUNT(*) n FROM asset_transfers WHERE status='accepted'")
            .n,
          1,
        );
      },
    );
    await t.test(
      "maintenance start cannot take an actively reserved resource",
      async () => {
        await request(
          `/erp/equipment-work-orders/${order.id}/start`,
          "POST",
          {},
          409,
        );
        assert.equal(
          get("SELECT status FROM assets WHERE id=?", machine).status,
          "active",
        );
      },
    );
    await t.test(
      "failed inspections require explicit repair return and cost posts exactly once",
      async () => {
        const inspect = {
          asset_id: repairMachine,
          date: "2035-01-01",
          inspector_id: mechanic,
          passed: false,
          findings: "Hydraulic leak",
        };
        await request(
          "/erp/equipment-inspections",
          "POST",
          { ...inspect, findings: "" },
          400,
        );
        await request("/erp/equipment-inspections", "POST", inspect, 201);
        assert.equal(
          get("SELECT status FROM assets WHERE id=?", repairMachine).status,
          "down",
        );
        await request(
          "/erp/equipment-inspections",
          "POST",
          { ...inspect, passed: true },
          201,
        );
        assert.equal(
          get("SELECT status FROM assets WHERE id=?", repairMachine).status,
          "down",
        );
        const repair = await request(
          "/erp/equipment-work-orders",
          "POST",
          {
            ...work,
            asset_id: repairMachine,
            type: "repair",
            jobsite_id: jobA,
            cost_code: "EQ-REPAIR",
          },
          201,
        );
        await request(
          `/erp/equipment-work-orders/${repair.id}/complete`,
          "POST",
          { return_to_service: true },
          409,
        );
        await request(
          `/erp/equipment-work-orders/${repair.id}/start`,
          "POST",
          {},
        );
        assert.equal(
          get("SELECT status FROM assets WHERE id=?", repairMachine).status,
          "maintenance",
        );
        await request(
          `/erp/equipment-work-orders/${repair.id}/complete`,
          "POST",
          {},
          400,
        );
        const completed = await request(
          `/erp/equipment-work-orders/${repair.id}/complete`,
          "POST",
          { return_to_service: true, completed_meter: 1220 },
        );
        assert.equal(
          get("SELECT status FROM assets WHERE id=?", repairMachine).status,
          "active",
        );
        assert.ok(completed.cost_entry_id);
        await request(
          `/erp/equipment-work-orders/${repair.id}/complete`,
          "POST",
          { return_to_service: true, completed_meter: 1220 },
        );
        const ledger = get(
          "SELECT COUNT(*) n,SUM(amount) amount FROM job_cost_entries WHERE tenant_id=?",
          tenant,
        );
        assert.deepEqual({ ...ledger }, { n: 1, amount: 300 });
        await request(
          `/erp/equipment-work-orders/${repair.id}/complete`,
          "POST",
          { return_to_service: false },
          409,
        );
      },
    );
    await t.test(
      "multiple shop work orders cannot release an asset until all active work is complete",
      async () => {
        const first = await request(
          "/erp/equipment-work-orders",
          "POST",
          { ...work, asset_id: repairMachine },
          201,
        );
        const second = await request(
          "/erp/equipment-work-orders",
          "POST",
          { ...work, asset_id: repairMachine, type: "repair" },
          201,
        );
        await request(
          `/erp/equipment-work-orders/${first.id}/start`,
          "POST",
          {},
        );
        await request(
          `/erp/equipment-work-orders/${second.id}/start`,
          "POST",
          {},
        );
        assert.equal(
          get(
            "SELECT prior_status FROM equipment_work_orders WHERE id=?",
            second.id,
          ).prior_status,
          "active",
        );
        await request(
          `/erp/equipment-work-orders/${first.id}/complete`,
          "POST",
          { return_to_service: true },
        );
        assert.equal(
          get("SELECT status FROM assets WHERE id=?", repairMachine).status,
          "maintenance",
        );
        await request(
          `/erp/equipment-work-orders/${second.id}/complete`,
          "POST",
          { return_to_service: false },
        );
        assert.equal(
          get("SELECT status FROM assets WHERE id=?", repairMachine).status,
          "down",
        );
        assert.equal(
          get("SELECT COUNT(*) n FROM equipment_cost_links").n,
          1,
          "shop maintenance never posts to a job",
        );
      },
    );
    await t.test(
      "service intervals compute from real meter/baseline without overwriting telemetry",
      async () => {
        const rule = await request(
          "/erp/equipment-service-rules",
          "POST",
          {
            asset_id: machine,
            name: "Oil service",
            interval_hours: 250,
            interval_days: 90,
            last_completed_meter: 900,
            last_completed_date: "2000-01-01",
          },
          201,
        );
        assert.equal(rule.engine_hours, 1200);
        assert.equal(rule.next_due_meter, 1150);
        assert.equal(rule.next_due_date, "2000-03-31");
        assert.equal(rule.due, true);
        const missing = await request(
          "/erp/equipment-service-rules",
          "POST",
          {
            asset_id: repairMachine,
            name: "Unknown service baseline",
            interval_hours: 250,
          },
          201,
        );
        assert.equal(missing.engine_hours, null);
        assert.equal(missing.next_due_meter, null);
        assert.equal(missing.baseline_missing, true);
        assert.equal(
          get("SELECT engine_hours FROM asset_state WHERE asset_id=?", machine)
            .engine_hours,
          1200,
        );
        const other = await request(
          "/erp/equipment-operations",
          "GET",
          undefined,
          200,
          foreign,
        );
        assert.deepEqual(other, {
          reservations: [],
          transfers: [],
          work_orders: [],
          service_rules: [],
          inspections: [],
        });
        const counts = get("SELECT COUNT(*) n FROM equipment_work_orders").n;
        initializeEquipmentOperations();
        assert.equal(
          get("SELECT COUNT(*) n FROM equipment_work_orders").n,
          counts,
        );
      },
    );
    await t.test(
      "service completion updates only its linked rule and leaves telemetry untouched",
      async () => {
        const oil = await request(
          "/erp/equipment-service-rules",
          "POST",
          {
            asset_id: repairMachine,
            name: "Oil and filter",
            interval_hours: 250,
            last_completed_meter: 50,
          },
          201,
        );
        const tracks = await request(
          "/erp/equipment-service-rules",
          "POST",
          {
            asset_id: repairMachine,
            name: "Track adjustment",
            interval_hours: 500,
            last_completed_meter: 20,
          },
          201,
        );
        await request(
          "/erp/equipment-work-orders",
          "POST",
          { ...work, asset_id: machine, service_rule_id: oil.id },
          404,
        );
        await request(
          "/erp/equipment-work-orders",
          "POST",
          {
            ...work,
            asset_id: repairMachine,
            type: "repair",
            service_rule_id: oil.id,
          },
          400,
        );
        const service = await request(
          "/erp/equipment-work-orders",
          "POST",
          { ...work, asset_id: repairMachine, service_rule_id: oil.id },
          201,
        );
        await request(
          `/erp/equipment-work-orders/${service.id}/start`,
          "POST",
          {},
        );
        await request(
          `/erp/equipment-work-orders/${service.id}/complete`,
          "POST",
          { return_to_service: true, completed_meter: 1300 },
        );
        const rules = (await request("/erp/equipment-operations"))
          .service_rules;
        assert.equal(
          rules.find((rule) => rule.id === oil.id).next_due_meter,
          1550,
        );
        assert.equal(
          rules.find((rule) => rule.id === tracks.id).last_completed_meter,
          20,
        );
        assert.equal(
          get(
            "SELECT engine_hours FROM asset_state WHERE asset_id=?",
            repairMachine,
          ),
          undefined,
          "service meter is evidence, not fabricated telemetry",
        );
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    getDb().close();
    rmSync(directory, { recursive: true, force: true });
  }
});
