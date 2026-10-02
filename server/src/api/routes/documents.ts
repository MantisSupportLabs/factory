import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { all, get, run, transaction, nowIso } from "../../db/database.js";
import {
  documentDirectory,
  documentMimeTypes,
  documentCategories,
  initializeDocuments,
} from "../../erp/documents.js";
import * as v from "../../erp/validation.js";

export const documentsRouter = Router();
type DocumentRow = {
  id: number;
  tenant_id: number;
  jobsite_id: number;
  group_id: string;
  revision: number;
  file_key: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
};
function handle(fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      fn(req, res);
    } catch (error) {
      if (error instanceof v.ErpError)
        res.status(error.status).json({ error: error.message });
      else next(error);
    }
  };
}
function listed(tenant: number) {
  return all(
    `SELECT d.id,d.jobsite_id,j.name jobsite_name,d.group_id,d.revision,d.supersedes_id,
  d.category,d.name,d.description,d.mime_type,d.size_bytes,d.sha256,d.uploaded_by,d.uploaded_at
  FROM project_documents d JOIN jobsites j ON j.id=d.jobsite_id AND j.tenant_id=d.tenant_id
  WHERE d.tenant_id=? ORDER BY d.uploaded_at DESC,d.id DESC`,
    tenant,
  );
}
documentsRouter.get(
  "/erp/documents",
  handle((req, res) => {
    initializeDocuments();
    res.json({ documents: listed(req.tenant.id) });
  }),
);
documentsRouter.post(
  "/erp/documents",
  handle((req, res) => {
    initializeDocuments();
    const b = v.body(req.body),
      tenant = req.tenant.id;
    const job = v.related(tenant, "jobsites", b.jobsite_id, "jobsite_id");
    const name = v
      .text(b.name, "name", true, 180)
      .replace(/[\r\n\\/\x00-\x1f]/g, "_");
    const mime = v.option(b.mime_type, "mime_type", documentMimeTypes),
      category = v.option(b.category, "category", documentCategories);
    const description = v.text(b.description, "description", false, 2000);
    const encoded = v.text(b.base64, "base64", true, 7_000_000);
    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
      throw new v.ErpError(400, "Invalid file encoding");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded)
      throw new v.ErpError(400, "Invalid file encoding");
    if (bytes.length < 1 || bytes.length > 5 * 1024 * 1024)
      throw new v.ErpError(400, "File must be between 1 byte and 5 MB");
    const digest = createHash("sha256").update(bytes).digest("hex"),
      key = randomUUID();
    const uploadedBy =
      req.authUser?.name ??
      v.text(b.uploaded_by ?? "Workspace user", "uploaded_by", true, 150);
    fs.mkdirSync(documentDirectory, { recursive: true, mode: 0o700 });
    const destination = path.join(documentDirectory, key);
    fs.writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
    try {
      const record = transaction(() => {
        let group: string = randomUUID(),
          revision = 1,
          previous: number | null = null;
        if (
          b.supersedes_id !== undefined &&
          b.supersedes_id !== null &&
          b.supersedes_id !== ""
        ) {
          previous = v.id(b.supersedes_id, "supersedes_id");
          const prior = get<DocumentRow>(
            "SELECT * FROM project_documents WHERE tenant_id=? AND id=?",
            tenant,
            previous,
          );
          if (!prior || prior.jobsite_id !== job)
            throw new v.ErpError(
              404,
              "Previous document not found in this project",
            );
          const latest = get<{ id: number; revision: number }>(
            "SELECT id,revision FROM project_documents WHERE tenant_id=? AND group_id=? ORDER BY revision DESC LIMIT 1",
            tenant,
            prior.group_id,
          )!;
          if (latest.id !== previous)
            throw new v.ErpError(
              409,
              "Upload the new revision against the latest document",
            );
          group = prior.group_id;
          revision = latest.revision + 1;
        }
        const id = Number(
          run(
            `INSERT INTO project_documents(tenant_id,jobsite_id,group_id,revision,supersedes_id,category,name,description,file_key,mime_type,size_bytes,sha256,uploaded_by,uploaded_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            tenant,
            job,
            group,
            revision,
            previous,
            category,
            name,
            description,
            key,
            mime,
            bytes.length,
            digest,
            uploadedBy,
            nowIso(),
          ).lastInsertRowid,
        );
        return listed(tenant).find((row) => row.id === id);
      });
      res.status(201).json(record);
    } catch (error) {
      fs.unlinkSync(destination);
      throw error;
    }
  }),
);
documentsRouter.get(
  "/erp/documents/:id/download",
  handle((req, res) => {
    const row = get<DocumentRow>(
      "SELECT * FROM project_documents WHERE tenant_id=? AND id=?",
      req.tenant.id,
      v.id(req.params.id),
    );
    if (!row) throw new v.ErpError(404, "Document not found");
    const destination = path.join(documentDirectory, row.file_key);
    if (!fs.existsSync(destination))
      throw new v.ErpError(
        410,
        "Document file is unavailable; restore it from backup",
      );
    const bytes = fs.readFileSync(destination);
    if (createHash("sha256").update(bytes).digest("hex") !== row.sha256)
      throw new v.ErpError(409, "Document integrity check failed");
    res
      .set("Cache-Control", "private, no-store")
      .set("X-Content-Type-Options", "nosniff");
    res.type(row.mime_type).attachment(row.name).send(bytes);
  }),
);
/** Tenant-scoped business data only. Host backups include files and credentials separately. */
documentsRouter.get(
  "/erp/data-export",
  handle((req, res) => {
    const excluded = new Set([
      "provider_credentials",
      "auth_users",
      "auth_sessions",
      "auth_settings",
      "auth_login_attempts",
    ]);
    const tables = all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const data: Record<string, unknown[]> = {};
    for (const { name } of tables) {
      if (
        !/^[a-z_]+$/.test(name) ||
        name.startsWith("auth_") ||
        excluded.has(name)
      )
        continue;
      const columns = all<{ name: string }>(`PRAGMA table_info("${name}")`);
      if (!columns.some((column) => column.name === "tenant_id")) continue;
      data[name] = all(
        `SELECT * FROM "${name}" WHERE tenant_id=?`,
        req.tenant.id,
      ).map((row) => {
        if (name === "project_documents") {
          const { file_key, ...rest } = row;
          return rest;
        }
        return row;
      });
    }
    res
      .set("Cache-Control", "no-store")
      .attachment(
        `dirtworks-data-${req.tenant.slug}-${nowIso().slice(0, 10)}.json`,
      )
      .json({
        format: "dirtworks-business-export",
        version: 1,
        tenant: req.tenant,
        exported_at: nowIso(),
        notice:
          "Business records only. Files, credentials, and sessions are excluded. This is not a database restore archive.",
        tables: data,
      });
  }),
);
