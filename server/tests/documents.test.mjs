import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

const directory = mkdtempSync(path.join(tmpdir(), "dirtworks-documents-"));
process.env.DB_PATH = path.join(directory, "test.db");
const { registerAllConnectors } =
  await import("../dist/telematics/connectors/index.js");
const { seedIfNeeded } = await import("../dist/db/seed/seed.js");
const { initializeErp } = await import("../dist/erp/seed.js");
const { initializeDocuments } = await import("../dist/erp/documents.js");
const { documentsRouter } = await import("../dist/api/routes/documents.js");
const { tenantMiddleware } = await import("../dist/api/tenancy.js");
const { get, getDb, run } = await import("../dist/db/database.js");

test("documents retain revisions and exports respect the company boundary", async (t) => {
  registerAllConnectors();
  seedIfNeeded();
  initializeErp();
  initializeDocuments();
  const tenant = get("SELECT id FROM tenants ORDER BY id LIMIT 1").id;
  const job = get(
    "SELECT id FROM jobsites WHERE tenant_id=? ORDER BY id LIMIT 1",
    tenant,
  ).id;
  const other = Number(
    run("INSERT INTO tenants(slug,name) VALUES('doc-other','Other')")
      .lastInsertRowid,
  );
  const otherJob = Number(
    run(
      "INSERT INTO jobsites(tenant_id,name,code,lat,lng) VALUES(?,'Other job','DOC-OTHER',1,1)",
      other,
    ).lastInsertRowid,
  );
  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use("/api", tenantMiddleware, documentsRouter);
  app.use((error, _req, res, _next) =>
    res.status(500).json({ error: error.message }),
  );
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (
    endpoint,
    method = "GET",
    payload,
    status = 200,
    company = tenant,
  ) => {
    const response = await fetch(url + endpoint, {
      method,
      headers: {
        "content-type": "application/json",
        "x-tenant-id": String(company),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  const fields = {
    jobsite_id: job,
    category: "drawing",
    name: "Plan A.txt",
    mime_type: "text/plain",
    description: "Issued plan",
    base64: Buffer.from("Revision A\n").toString("base64"),
  };
  let original, revised;
  try {
    await t.test(
      "reject foreign projects, active content, and malformed encodings",
      async () => {
        await request(
          "/erp/documents",
          "POST",
          { ...fields, jobsite_id: otherJob },
          404,
        );
        await request(
          "/erp/documents",
          "POST",
          { ...fields, mime_type: "text/html" },
          400,
        );
        await request(
          "/erp/documents",
          "POST",
          { ...fields, base64: "invalid?" },
          400,
        );
        assert.equal(get("SELECT COUNT(*) n FROM project_documents").n, 0);
      },
    );
    await t.test(
      "immutable revision history requires the latest version and same project",
      async () => {
        original = await request("/erp/documents", "POST", fields, 201);
        assert.equal(original.revision, 1);
        assert.equal(original.file_key, undefined);
        revised = await request(
          "/erp/documents",
          "POST",
          {
            ...fields,
            supersedes_id: original.id,
            base64: Buffer.from("Revision B\n").toString("base64"),
          },
          201,
        );
        assert.equal(revised.revision, 2);
        assert.equal(revised.supersedes_id, original.id);
        await request(
          "/erp/documents",
          "POST",
          { ...fields, supersedes_id: original.id },
          409,
        );
        assert.throws(
          () =>
            run(
              "UPDATE project_documents SET name=? WHERE id=?",
              "Changed",
              original.id,
            ),
          /immutable/,
        );
        assert.throws(
          () => run("DELETE FROM project_documents WHERE id=?", original.id),
          /immutable/,
        );
        initializeDocuments();
        assert.equal(get("SELECT COUNT(*) n FROM project_documents").n, 2);
      },
    );
    await t.test(
      "downloads verify original bytes and prevent cross-company access",
      async () => {
        const response = await fetch(
          url + `/erp/documents/${original.id}/download`,
          { headers: { "x-tenant-id": String(tenant) } },
        );
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "Revision A\n");
        assert.match(response.headers.get("content-disposition"), /attachment/);
        assert.equal(
          response.headers.get("cache-control"),
          "private, no-store",
        );
        await request(
          `/erp/documents/${original.id}/download`,
          "GET",
          undefined,
          404,
          other,
        );
        assert.deepEqual(
          (await request("/erp/documents", "GET", undefined, 200, other))
            .documents,
          [],
        );
      },
    );
    await t.test(
      "export includes company records and file references without credentials or file keys",
      async () => {
        const exported = await request("/erp/data-export");
        assert.equal(exported.tenant.id, tenant);
        assert.equal(exported.tables.project_documents.length, 2);
        assert.equal(exported.tables.provider_credentials, undefined);
        assert.equal(exported.tables.project_documents[0].file_key, undefined);
        assert.ok(
          exported.tables.jobsites.every((row) => row.tenant_id === tenant),
        );
        assert.match(exported.notice, /not a database restore/);
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    getDb().close();
    rmSync(directory, { recursive: true, force: true });
  }
});
