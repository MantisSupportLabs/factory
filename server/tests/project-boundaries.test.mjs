import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
const directory = mkdtempSync(
  path.join(tmpdir(), "dirtworks-project-boundaries-"),
);
process.env.DB_PATH = path.join(directory, "test.db");
const { registerAllConnectors } =
  await import("../dist/telematics/connectors/index.js");
const { seedIfNeeded } = await import("../dist/db/seed/seed.js");
const { initializeErp } = await import("../dist/erp/seed.js");
const { initCommercial } = await import("../dist/erp/commercial.js");
const { initializeProjectFinance } =
  await import("../dist/erp/project-finance.js");
const { erpRouter } = await import("../dist/api/routes/erp.js");
const { jobsitesRouter } = await import("../dist/api/routes/jobsites.js");
const { projectFinanceRouter } =
  await import("../dist/api/routes/project-finance.js");
const { tenantMiddleware } = await import("../dist/api/tenancy.js");
const { get, getDb, run } = await import("../dist/db/database.js");
test("approved project controls cannot be bypassed through setup or legacy endpoints", async (t) => {
  registerAllConnectors();
  seedIfNeeded();
  initializeErp();
  initCommercial();
  initializeProjectFinance();
  const tenant = get("SELECT id FROM tenants ORDER BY id LIMIT 1").id;
  const project = get(
    "SELECT * FROM project_profiles WHERE tenant_id=? ORDER BY jobsite_id LIMIT 1",
    tenant,
  );
  const job = project.jobsite_id,
    crew = get(
      "SELECT id FROM crews WHERE tenant_id=? ORDER BY id LIMIT 1",
      tenant,
    ).id;
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    tenantMiddleware,
    erpRouter,
    jobsitesRouter,
    projectFinanceRouter,
  );
  app.use((e, _req, res, _next) => res.status(500).json({ error: e.message }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (endpoint, method = "GET", body, status = 200) => {
    const response = await fetch(url + endpoint, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  try {
    await t.test(
      "financial setup edits become signed changes after baseline certification",
      async () => {
        await request(`/erp/projects/${job}`, "PATCH", {
          budget: project.budget + 100,
        });
        const baseline = await request(
          "/erp/project-baselines",
          "POST",
          {
            jobsite_id: job,
            title: "Agreed job baseline",
            explanation: "Certified scope and budget",
          },
          201,
        );
        await request(
          `/erp/project-baselines/${baseline.id}/approve`,
          "POST",
          {},
        );
        await request(
          `/erp/projects/${job}`,
          "PATCH",
          { budget: project.budget + 200 },
          409,
        );
        await request(
          `/erp/projects/${job}`,
          "PATCH",
          { contract_value: project.contract_value + 100 },
          409,
        );
        const updated = await request(`/erp/projects/${job}`, "PATCH", {
          name: "Renamed controlled project",
        });
        assert.equal(updated.budget, project.budget + 100);
      },
    );
    await t.test(
      "certified forecasts reach the portfolio without replacing PM or measured progress",
      async () => {
        const before = await request("/erp/overview");
        const original = before.projects.find((project) => project.id === job);
        const items = before.work_items.filter(
          (item) => item.jobsite_id === job,
        );
        const draft = await request(
          "/erp/cost-forecasts",
          "POST",
          {
            jobsite_id: job,
            as_of: "2035-01-01",
            forecast_finish: "2035-02-01",
            explanation: "Includes complete remaining scope and commitments",
            complete_scope_confirmed: true,
            lines: items.map((item) => ({
              cost_code: item.cost_code,
              labor: 10,
              equipment: 10,
              material: 10,
              subcontract: 0,
              other: 0,
              notes: "Remaining resource allowance",
            })),
          },
          201,
        );
        assert.equal(
          (await request("/erp/overview")).projects.find(
            (project) => project.id === job,
          ).approved_forecast_cost,
          null,
        );
        await request(`/erp/cost-forecasts/${draft.id}/approve`, "POST", {});
        const reviewed = (await request("/erp/overview")).projects.find(
          (project) => project.id === job,
        );
        assert.equal(
          reviewed.approved_forecast_cost,
          original.actual_cost + items.length * 30,
        );
        assert.equal(reviewed.approved_forecast_as_of, "2035-01-01");
        assert.equal(reviewed.approved_forecast_finish, "2035-02-01");
        assert.equal(reviewed.latest_rough_pct, original.latest_rough_pct);
        assert.equal(reviewed.progress_pct, original.progress_pct);
        assert.equal(reviewed.forecast_cost, original.forecast_cost);
      },
    );
    await t.test(
      "generic status edits cannot bypass final acceptance checks",
      async () => {
        await request(
          `/erp/projects/${job}`,
          "PATCH",
          { status: "complete" },
          409,
        );
        await request(`/jobsites/${job}`, "PATCH", { status: "complete" }, 409);
        assert.equal(
          get("SELECT status FROM jobsites WHERE id=?", job).status,
          "active",
        );
      },
    );
    await t.test(
      "accepted project state stays closed and does not accept new measured work",
      async () => {
        // Represent a previously accepted job; actual checklist/quantity closeout is tested in finance.
        run(
          "INSERT INTO project_closeouts(jobsite_id,tenant_id,acceptance_reference,closed_at,closed_by) VALUES(?,?,?, ?,?)",
          job,
          tenant,
          "Prior signed acceptance",
          "2035-01-01T00:00:00Z",
          "Customer",
        );
        run("UPDATE jobsites SET status='complete' WHERE id=?", job);
        await request(
          `/erp/projects/${job}`,
          "PATCH",
          { status: "active" },
          409,
        );
        await request(`/jobsites/${job}`, "PATCH", { status: "active" }, 409);
        await request(
          "/erp/work-items",
          "POST",
          {
            jobsite_id: job,
            phase: "New",
            activity: "Late work",
            unit: "CY",
            cost_code: "LATE",
            planned_qty: 100,
            planned_hours: 10,
            budget: 10,
          },
          409,
        );
        await request(
          "/erp/assignments",
          "POST",
          {
            jobsite_id: job,
            crew_id: crew,
            date: "2035-01-05",
            task: "Late work",
            cost_code: "LATE",
          },
          409,
        );
        await request(
          "/erp/daily-reports",
          "POST",
          {
            jobsite_id: job,
            crew_id: crew,
            date: "2035-01-05",
            status: "draft",
            created_by: "Foreman",
            lines: [],
            notes: "Late work",
          },
          409,
        );
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    getDb().close();
    rmSync(directory, { recursive: true, force: true });
  }
});
