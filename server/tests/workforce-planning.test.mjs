import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
const fixtureDir = mkdtempSync(path.join(tmpdir(), "dirtworks-workforce-"));
process.env.DB_PATH = path.join(fixtureDir, "workforce.db");
const { seedIfNeeded } = await import("../dist/db/seed/seed.js");
const { registerAllConnectors } = await import(
  "../dist/telematics/connectors/index.js"
);
const { initializeErp } = await import("../dist/erp/seed.js");
const { initializeWorkforcePlanning, backfillWorkforceSnapshots } =
  await import("../dist/erp/workforce-planning.js");
const { businessDate } = await import("../dist/erp/calendar.js");
const { all, get, getDb, run } = await import("../dist/db/database.js");
const { erpRouter } = await import("../dist/api/routes/erp.js");
const { workforcePlanningRouter } = await import(
  "../dist/api/routes/workforce-planning.js"
);
const { workforceRouter } = await import("../dist/api/routes/workforce.js");
const { tenantMiddleware } = await import("../dist/api/tenancy.js");

test("workforce shifts, qualification gates, historical rosters, and report corrections", async (t) => {
  registerAllConnectors();
  seedIfNeeded();
  initializeErp();
  initializeWorkforcePlanning();
  backfillWorkforceSnapshots();
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    tenantMiddleware,
    (req, _res, next) => {
      const role = req.header("x-test-role");
      if (role)
        req.authUser = {
          id: 100,
          tenant_id: req.tenant.id,
          name: "Authenticated reviewer",
          email: "reviewer@example.test",
          role,
        };
      next();
    },
    erpRouter,
    workforcePlanningRouter,
    workforceRouter,
  );
  app.use((error, _req, res, _next) =>
    res.status(500).json({ error: error.message }),
  );
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  async function request(
    endpoint,
    method = "GET",
    body,
    expected = 200,
    tenant,
    role,
  ) {
    const response = await fetch(url + endpoint, {
      method,
      headers: {
        "content-type": "application/json",
        ...(tenant ? { "x-tenant-id": String(tenant) } : {}),
        ...(role ? { "x-test-role": role } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result =
      response.status === 204
        ? null
        : response.headers.get("content-type")?.includes("text/csv")
          ? await response.text()
          : await response.json();
    assert.equal(
      response.status,
      expected,
      `${method} ${endpoint}: ${JSON.stringify(result)}`,
    );
    return result;
  }
  let tenant,
    foreignTenant,
    job,
    worker,
    lead,
    crew,
    earth,
    pipe,
    first,
    second,
    report;
  try {
    await t.test(
      "migration preserves old report lines and is idempotent",
      async () => {
        const before = all(
          "SELECT id,report_id,qty FROM daily_report_lines ORDER BY id",
        );
        const count = get("SELECT COUNT(*) n FROM crew_membership_history").n;
        initializeErp();
        initializeWorkforcePlanning();
        backfillWorkforceSnapshots();
        assert.deepEqual(
          all("SELECT id,report_id,qty FROM daily_report_lines ORDER BY id"),
          before,
        );
        assert.equal(
          get("SELECT COUNT(*) n FROM crew_membership_history").n,
          count,
        );
        assert.deepEqual(all("PRAGMA foreign_key_check"), []);
        const data = await request("/erp/overview");
        tenant = get("SELECT id FROM tenants LIMIT 1").id;
        foreignTenant = Number(
          run(
            "INSERT INTO tenants(slug,name) VALUES('workforce-foreign','Foreign workforce')",
          ).lastInsertRowid,
        );
        job = await request(
          "/erp/projects",
          "POST",
          { name: "Workforce integration job", code: "WF-INT", budget: 1000 },
          201,
        );
        worker = await request(
          "/erp/people",
          "POST",
          { name: "Time worker", role: "operator" },
          201,
        );
        lead = await request(
          "/erp/people",
          "POST",
          { name: "Time lead", role: "foreman" },
          201,
        );
        crew = await request(
          "/erp/crews",
          "POST",
          {
            name: "Time crew",
            trade: "Civil",
            foreman_id: lead.id,
            members: [worker.id],
          },
          201,
        );
        earth = await request(
          "/erp/work-items",
          "POST",
          {
            jobsite_id: job.id,
            phase: "Earthwork",
            activity: "Cut",
            unit: "CY",
            planned_qty: 100,
            planned_hours: 10,
            budget: 500,
            cost_code: "100",
          },
          201,
        );
        pipe = await request(
          "/erp/work-items",
          "POST",
          {
            jobsite_id: job.id,
            phase: "Utilities",
            activity: "Pipe",
            unit: "LF",
            planned_qty: 100,
            planned_hours: 10,
            budget: 500,
            cost_code: "200",
          },
          201,
        );
        assert.ok(data.projects.length > 0);
      },
    );
    await t.test(
      "split intervals derive paid hours and monetary snapshots; invalid dates and breaks are rejected",
      async () => {
        const base = {
          employee_id: worker.id,
          jobsite_id: job.id,
          date: "2036-01-10",
          cost_code: "100",
          start_time: "07:00",
          end_time: "11:00",
          break_minutes: 0,
          hourly_rate: 30,
          burden_pct: 25,
        };
        await request(
          "/erp/time-entries",
          "POST",
          { ...base, date: "2036-02-30" },
          400,
        );
        await request(
          "/erp/time-entries",
          "POST",
          { ...base, start_time: "22:00", end_time: "06:00" },
          400,
        );
        await request(
          "/erp/time-entries",
          "POST",
          { ...base, break_minutes: 240 },
          400,
        );
        await request(
          "/erp/time-entries",
          "POST",
          { ...base, break_minutes: 1.5 },
          400,
        );
        await request(
          "/erp/time-entries",
          "POST",
          { ...base, status: "approved" },
          400,
        );
        first = await request("/erp/time-entries", "POST", base, 201);
        assert.equal(first.hours, 4);
        assert.equal(first.base_cost, 120);
        assert.equal(first.burden_cost, 30);
        await request(
          "/erp/time-entries",
          "POST",
          { ...base, start_time: "10:00", end_time: "12:00", cost_code: "200" },
          409,
        );
        second = await request(
          "/erp/time-entries",
          "POST",
          {
            ...base,
            cost_code: "200",
            start_time: "11:00",
            end_time: "15:00",
            break_minutes: 30,
            hourly_rate: 40,
            burden_pct: 20,
          },
          201,
        );
        assert.equal(second.hours, 3.5);
        assert.equal(second.base_cost, 140);
        assert.equal(second.burden_cost, 28);
        const midnight = await request(
          "/erp/time-entries",
          "POST",
          {
            ...base,
            date: "2036-01-11",
            start_time: "23:00",
            end_time: "24:00",
          },
          201,
        );
        assert.equal(midnight.hours, 1);
      },
    );
    await t.test(
      "only approved shifts post once, immutable rates survive review, and overlaps include approved time",
      async () => {
        assert.equal(
          (await request("/erp/overview")).projects.find((j) => j.id === job.id)
            .actual_cost,
          0,
        );
        await request(`/erp/time-entries/${first.id}/approve`, "POST", {}, 409);
        await request(`/erp/time-entries/${first.id}/submit`, "POST", {});
        await request(
          `/erp/time-entries/${first.id}`,
          "PATCH",
          { hourly_rate: 99 },
          409,
        );
        await request(`/erp/time-entries/${first.id}/approve`, "POST", {
          approved_by: "PM test",
        });
        await request(`/erp/time-entries/${first.id}/approve`, "POST", {}, 409);
        await request(
          `/erp/time-entries/${first.id}`,
          "PATCH",
          { hourly_rate: 100 },
          409,
        );
        await request(`/erp/time-entries/${second.id}/submit`, "POST", {});
        await request(`/erp/time-entries/${second.id}/approve`, "POST", {});
        assert.equal(get("SELECT COUNT(*) n FROM time_entry_postings").n, 2);
        const data = await request("/erp/overview");
        assert.equal(
          data.projects.find((j) => j.id === job.id).actual_cost,
          318,
        );
        await request(
          "/erp/time-entries",
          "POST",
          {
            employee_id: worker.id,
            jobsite_id: job.id,
            date: "2036-01-10",
            cost_code: "100",
            start_time: "07:30",
            end_time: "08:00",
            hourly_rate: 10,
          },
          409,
        );
        assert.equal(
          get("SELECT hourly_rate FROM time_entries WHERE id=?", first.id)
            .hourly_rate,
          30,
        );
      },
    );
    await t.test(
      "legacy HH:MM and timestamp timecards block overlap, ambiguous intervals block new splits, totals cannot exceed one day",
      async () => {
        const base = {
          employee_id: worker.id,
          jobsite_id: job.id,
          cost_code: "100",
          hourly_rate: 30,
        };
        run(
          "INSERT INTO timecards(tenant_id,employee_id,jobsite_id,date,start_time,end_time,hours,status) VALUES(?,?,?,?,?,?,?,'approved')",
          tenant,
          worker.id,
          job.id,
          "2037-01-01",
          "2037-01-01T08:00:00Z",
          "2037-01-01T12:00:00Z",
          4,
        );
        await request(
          "/erp/time-entries",
          "POST",
          {
            ...base,
            date: "2037-01-01",
            start_time: "09:00",
            end_time: "11:00",
          },
          409,
        );
        await request(
          "/erp/time-entries",
          "POST",
          {
            ...base,
            date: "2037-01-01",
            start_time: "12:00",
            end_time: "14:00",
          },
          201,
        );
        run(
          "INSERT INTO timecards(tenant_id,employee_id,date,hours,status) VALUES(?,?,?,8,'approved')",
          tenant,
          worker.id,
          "2037-01-02",
        );
        await request(
          "/erp/time-entries",
          "POST",
          {
            ...base,
            date: "2037-01-02",
            start_time: "12:00",
            end_time: "14:00",
          },
          409,
        );
        run(
          "INSERT INTO timecards(tenant_id,employee_id,date,start_time,end_time,hours,status) VALUES(?,?,?,'08:00','09:00',23,'approved')",
          tenant,
          worker.id,
          "2037-01-03",
        );
        await request(
          "/erp/time-entries",
          "POST",
          {
            ...base,
            date: "2037-01-03",
            start_time: "10:00",
            end_time: "12:00",
          },
          409,
        );
      },
    );
    await t.test(
      "aggregate report labor cannot double cost approved person time",
      async () => {
        const aggregate = await request(
          "/erp/daily-reports",
          "POST",
          {
            jobsite_id: job.id,
            crew_id: crew.id,
            date: "2036-01-10",
            created_by: "Time lead",
            status: "submitted",
            lines: [{ plan_id: earth.id, qty: 5, labor_cost: 100 }],
          },
          201,
        );
        await request(
          `/erp/daily-reports/${aggregate.id}/approve`,
          "POST",
          {},
          409,
        );
        await request(`/erp/daily-reports/${aggregate.id}/reject`, "POST", {
          reason: "Individual shifts already provide labor cost",
        });
        await request(`/erp/daily-reports/${aggregate.id}`, "PATCH", {
          lines: [{ plan_id: earth.id, qty: 5, labor_hours: 4, labor_cost: 0 }],
        });
        await request(`/erp/daily-reports/${aggregate.id}/submit`, "POST", {});
        await request(`/erp/daily-reports/${aggregate.id}/approve`, "POST", {});
        assert.equal(
          (await request("/erp/overview")).projects.find((j) => j.id === job.id)
            .actual_cost,
          318,
        );
      },
    );
    await t.test(
      "voiding retains immutable postings but removes cost and export eligibility",
      async () => {
        await request(
          `/erp/time-entries/${first.id}/void`,
          "POST",
          { reason: "" },
          400,
        );
        const original = get("SELECT * FROM time_entries WHERE id=?", first.id);
        await request(`/erp/time-entries/${first.id}/void`, "POST", {
          reason: "Wrong allocation",
        });
        assert.deepEqual(
          get("SELECT * FROM time_entries WHERE id=?", first.id),
          original,
        );
        assert.equal(get("SELECT COUNT(*) n FROM time_entry_postings").n, 2);
        assert.equal(
          (await request("/erp/overview")).projects.find((j) => j.id === job.id)
            .actual_cost,
          168,
        );
        await request(
          `/erp/time-entries/${first.id}/void`,
          "POST",
          { reason: "Again" },
          409,
        );
        const csv = await request(
          "/erp/payroll-export?start_date=2036-01-10&end_date=2036-01-10",
        );
        assert.ok(csv.includes(`"${second.id}",`));
        assert.ok(!csv.includes(`"${first.id}",`));
        assert.equal(csv.split("\r\n").length, 2);
      },
    );
    await t.test(
      "legacy mutations cannot bypass approved split-shift overlap checks",
      async () => {
        const legacy = {
          employee_id: worker.id,
          jobsite_id: job.id,
          date: "2036-01-10",
          hours: 1,
          start_time: "11:30",
          end_time: "12:30",
          cost_code: "100",
        };
        await request("/timecards", "POST", legacy, 409);
        const safe = await request(
          "/timecards",
          "POST",
          { ...legacy, hours: 2, start_time: "08:00", end_time: "10:00" },
          201,
        );
        await request(
          `/timecards/${safe.id}`,
          "PATCH",
          { start_time: "11:00", end_time: "12:00", hours: 1 },
          409,
        );
        assert.equal(
          get("SELECT start_time FROM timecards WHERE id=?", safe.id)
            .start_time,
          "08:00",
        );
        const dirty = Number(
          run(
            "INSERT INTO timecards(tenant_id,employee_id,date,start_time,end_time,hours,source,status) VALUES(?,?,?,'11:00','12:00',1,'ai_auto','draft')",
            tenant,
            worker.id,
            "2036-01-10",
          ).lastInsertRowid,
        );
        await request(`/timecards/${dirty}/approve`, "POST", {}, 409);
        assert.equal(
          get("SELECT status FROM timecards WHERE id=?", dirty).status,
          "draft",
        );
      },
    );
    await t.test(
      "date-qualified dispatch rejects expired or not-yet-issued credentials atomically",
      async () => {
        for (const employee of [lead, worker])
          await request(
            "/erp/certifications",
            "POST",
            {
              employee_id: employee.id,
              cert_name: "Specialty qualification",
              issued_date: "2035-01-01",
              expires_date: "2036-12-31",
            },
            201,
          );
        await request(
          "/erp/assignments",
          "POST",
          {
            crew_id: crew.id,
            jobsite_id: job.id,
            date: "2037-01-05",
            task: "Pipe",
            cost_code: "200",
            required_certifications: ["Specialty qualification"],
          },
          409,
        );
        assert.equal(
          get(
            "SELECT COUNT(*) n FROM crew_assignments WHERE tenant_id=? AND crew_id=? AND date=?",
            tenant,
            crew.id,
            "2037-01-05",
          ).n,
          0,
        );
        await request(
          "/erp/assignments",
          "POST",
          {
            crew_id: crew.id,
            jobsite_id: job.id,
            date: "2034-01-05",
            task: "Pipe",
            cost_code: "200",
            required_certifications: ["Specialty qualification"],
          },
          409,
        );
        const assignment = await request(
          "/erp/assignments",
          "POST",
          {
            crew_id: crew.id,
            jobsite_id: job.id,
            date: "2036-02-01",
            task: "Pipe",
            cost_code: "200",
            required_certifications: ["Specialty qualification"],
          },
          201,
        );
        assert.equal(
          all(
            "SELECT * FROM crew_assignment_members WHERE assignment_id=?",
            assignment.id,
          ).length,
          2,
        );
        await request(
          "/erp/certifications",
          "POST",
          {
            employee_id: worker.id,
            cert_name: "Old certificate",
            issued_date: "2020-01-01",
            expires_date: "2021-01-01",
          },
          201,
        );
        const today = businessDate();
        await request(
          "/erp/certifications",
          "POST",
          {
            employee_id: worker.id,
            cert_name: "Today certificate",
            issued_date: today,
            expires_date: today,
          },
          201,
        );
        const certs = await request("/erp/certifications");
        assert.equal(
          certs.find((c) => c.cert_name === "Old certificate").validity,
          "expired",
        );
        assert.equal(
          certs.find((c) => c.cert_name === "Today certificate").validity,
          "expires_today",
        );
      },
    );
    await t.test(
      "roster snapshots preserve dispatched workers after membership changes",
      async () => {
        const assignment = get(
          "SELECT id FROM crew_assignments WHERE tenant_id=? AND crew_id=? AND date=?",
          tenant,
          crew.id,
          "2036-02-01",
        );
        const before = all(
          "SELECT * FROM crew_assignment_members WHERE assignment_id=? ORDER BY employee_id",
          assignment.id,
        );
        const replacement = await request(
          "/erp/people",
          "POST",
          { name: "Replacement worker", role: "laborer" },
          201,
        );
        await request(`/erp/crews/${crew.id}`, "PATCH", {
          members: [replacement.id],
        });
        assert.deepEqual(
          all(
            "SELECT * FROM crew_assignment_members WHERE assignment_id=? ORDER BY employee_id",
            assignment.id,
          ),
          before,
        );
        const history = (
          await request("/erp/workforce-planning")
        ).membership_history.filter((h) => h.crew_id === crew.id);
        assert.ok(history.some((h) => h.members.includes(worker.id)));
        assert.ok(history.some((h) => h.members.includes(replacement.id)));
        const otherLead = await request(
          "/erp/people",
          "POST",
          { name: "Other dispatch lead", role: "foreman" },
          201,
        );
        const otherCrew = await request(
          "/erp/crews",
          "POST",
          {
            name: "Other dispatch crew",
            trade: "Civil",
            foreman_id: otherLead.id,
            members: [worker.id],
          },
          201,
        );
        await request(
          "/erp/assignments",
          "POST",
          {
            crew_id: otherCrew.id,
            jobsite_id: job.id,
            date: "2036-02-01",
            task: "Attempt duplicate worker allocation",
            cost_code: "100",
          },
          409,
        );
        assert.equal(
          get(
            "SELECT COUNT(*) n FROM crew_assignments WHERE crew_id=? AND date=?",
            otherCrew.id,
            "2036-02-01",
          ).n,
          0,
        );
      },
    );
    await t.test(
      "submission rejection preserves reason; approved reversal preserves facts and a same-day correction restores revised totals",
      async () => {
        report = await request(
          "/erp/daily-reports",
          "POST",
          {
            jobsite_id: job.id,
            crew_id: crew.id,
            date: "2036-02-02",
            created_by: "Time lead",
            status: "submitted",
            lines: [
              { plan_id: pipe.id, qty: 20, labor_hours: 2, labor_cost: 80 },
            ],
          },
          201,
        );
        await request(
          `/erp/daily-reports/${report.id}/reject`,
          "POST",
          { reason: "" },
          400,
        );
        const rejected = await request(
          `/erp/daily-reports/${report.id}/reject`,
          "POST",
          { reason: "Installed quantity should be 10" },
        );
        assert.equal(rejected.status, "draft");
        assert.equal(
          rejected.rejection_reason,
          "Installed quantity should be 10",
        );
        await request(`/erp/daily-reports/${report.id}/submit`, "POST", {});
        await request(`/erp/daily-reports/${report.id}/approve`, "POST", {});
        const approvedCost = (await request("/erp/overview")).projects.find(
          (j) => j.id === job.id,
        ).actual_cost;
        const lines = all(
          "SELECT * FROM daily_report_lines WHERE report_id=? ORDER BY id",
          report.id,
        );
        await request(`/erp/daily-reports/${report.id}/reverse`, "POST", {
          reason: "Approved incorrect quantity",
        });
        assert.deepEqual(
          all(
            "SELECT * FROM daily_report_lines WHERE report_id=? ORDER BY id",
            report.id,
          ),
          lines,
        );
        assert.equal(
          (await request("/erp/overview")).projects.find((j) => j.id === job.id)
            .actual_cost,
          approvedCost - 80,
        );
        await request(
          `/erp/daily-reports/${report.id}`,
          "PATCH",
          { notes: "Attempt edit approved facts" },
          409,
        );
        await request(
          `/erp/daily-reports/${report.id}/reverse`,
          "POST",
          { reason: "Again" },
          409,
        );
        const corrected = await request(
          `/erp/daily-reports/${report.id}/correction`,
          "POST",
          {},
          201,
        );
        assert.equal(corrected.date, report.date);
        assert.equal(corrected.crew_id, crew.id);
        assert.equal(corrected.status, "draft");
        assert.equal(corrected.corrected_from_report_id, report.id);
        assert.equal(corrected.revision, 1);
        const repeated = await request(
          `/erp/daily-reports/${report.id}/correction`,
          "POST",
          {},
        );
        assert.equal(repeated.id, corrected.id);
        await request(`/erp/daily-reports/${corrected.id}`, "PATCH", {
          lines: [
            { plan_id: pipe.id, qty: 10, labor_hours: 1, labor_cost: 40 },
          ],
        });
        await request(`/erp/daily-reports/${corrected.id}/submit`, "POST", {});
        await request(`/erp/daily-reports/${corrected.id}/approve`, "POST", {});
        const data = await request("/erp/overview");
        assert.equal(
          data.work_items.find((w) => w.id === pipe.id).actual_qty,
          10,
        );
        assert.equal(
          data.projects.find((j) => j.id === job.id).actual_cost,
          approvedCost - 40,
        );
        const split = await request(
          "/erp/time-entries",
          "POST",
          {
            employee_id: worker.id,
            jobsite_id: job.id,
            date: report.date,
            cost_code: "200",
            start_time: "07:00",
            end_time: "08:00",
            hourly_rate: 40,
            status: "submitted",
          },
          201,
        );
        await request(`/erp/time-entries/${split.id}/approve`, "POST", {}, 409);
      },
    );
    await t.test(
      "offline draft retries return the original report and conflicting payloads never overwrite it",
      async () => {
        const base = {
          jobsite_id: job.id,
          crew_id: crew.id,
          date: "2036-02-03",
          created_by: "Time lead",
          notes: "Draft from offline device",
          status: "draft",
          lines: [],
          client_request_id: "device-retry-001",
        };
        const first = await request("/erp/daily-reports", "POST", base, 201),
          repeated = await request("/erp/daily-reports", "POST", base);
        assert.equal(first.id, repeated.id);
        await request(
          "/erp/daily-reports",
          "POST",
          { ...base, notes: "Different payload" },
          409,
        );
        assert.equal(
          get(
            "SELECT COUNT(*) n FROM daily_report_request_keys WHERE tenant_id=? AND client_request_id=?",
            tenant,
            base.client_request_id,
          ).n,
          1,
        );
      },
    );
    await t.test(
      "field clocks conceal private rates and require authorized pay confirmation before approval",
      async () => {
        const clock = {
          employee_id: worker.id,
          jobsite_id: job.id,
          date: "2038-01-01",
          cost_code: "100",
          start_time: "07:00",
          end_time: "09:00",
          status: "draft",
        };
        await request(
          "/erp/time-entries",
          "POST",
          { ...clock, hourly_rate: 50 },
          403,
          tenant,
          "foreman",
        );
        const field = await request(
          "/erp/time-entries",
          "POST",
          clock,
          201,
          tenant,
          "foreman",
        );
        assert.equal(field.rates_pending, 1);
        assert.ok(!("hourly_rate" in field));
        assert.ok(!("base_cost" in field));
        await request(
          `/erp/time-entries/${field.id}/submit`,
          "POST",
          {},
          200,
          tenant,
          "foreman",
        );
        await request(
          `/erp/time-entries/${field.id}/approve`,
          "POST",
          {},
          400,
          tenant,
          "pm",
        );
        const approved = await request(
          `/erp/time-entries/${field.id}/approve`,
          "POST",
          { hourly_rate: 49, burden_pct: 10, approved_by: "Spoofed name" },
          200,
          tenant,
          "pm",
        );
        assert.equal(approved.base_cost, 98);
        assert.equal(approved.burden_cost, 9.8);
        assert.equal(approved.approved_by, "Authenticated reviewer");
        assert.equal(approved.rates_pending, 0);
        const view = await request(
          "/erp/workforce-planning",
          "GET",
          undefined,
          200,
          tenant,
          "foreman",
        );
        assert.equal(view.can_view_rates, false);
        for (const shift of view.time_entries)
          for (const privateField of [
            "hourly_rate",
            "burden_pct",
            "base_cost",
            "burden_cost",
          ])
            assert.ok(!(privateField in shift));
        await request(
          "/erp/payroll-export",
          "GET",
          undefined,
          403,
          tenant,
          "foreman",
        );
        const publicOverview = await request(
          "/erp/overview",
          "GET",
          undefined,
          200,
          tenant,
          "foreman",
        );
        assert.ok(
          !publicOverview.cost_entries.some((e) =>
            e.description.includes(`Approved shift #${field.id}:`),
          ),
        );
        const fullOverview = await request(
          "/erp/overview",
          "GET",
          undefined,
          200,
          tenant,
          "pm",
        );
        assert.equal(
          publicOverview.projects.find((j) => j.id === job.id).actual_cost,
          fullOverview.projects.find((j) => j.id === job.id).actual_cost,
        );
      },
    );
    await t.test(
      "workforce references, reviews, corrections and exports remain tenant isolated",
      async () => {
        await request(
          "/erp/time-entries",
          "POST",
          {
            employee_id: worker.id,
            jobsite_id: job.id,
            date: "2036-03-01",
            cost_code: "100",
            start_time: "07:00",
            end_time: "08:00",
            hourly_rate: 30,
          },
          404,
          foreignTenant,
        );
        await request(
          `/erp/time-entries/${second.id}/void`,
          "POST",
          { reason: "Foreign write" },
          404,
          foreignTenant,
        );
        await request(
          "/erp/certifications",
          "POST",
          {
            employee_id: worker.id,
            cert_name: "Foreign cert",
            issued_date: "2036-01-01",
            expires_date: "2036-12-31",
          },
          404,
          foreignTenant,
        );
        await request(
          `/erp/daily-reports/${report.id}/correction`,
          "POST",
          {},
          404,
          foreignTenant,
        );
        const foreign = await request(
          "/erp/workforce-planning",
          "GET",
          undefined,
          200,
          foreignTenant,
        );
        assert.equal(foreign.time_entries.length, 0);
        assert.equal(foreign.certifications.length, 0);
        assert.equal(foreign.membership_history.length, 0);
        const csv = await request(
          "/erp/payroll-export",
          "GET",
          undefined,
          200,
          foreignTenant,
        );
        assert.equal(csv.split("\r\n").length, 1);
        assert.deepEqual(all("PRAGMA foreign_key_check"), []);
      },
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    getDb().close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
