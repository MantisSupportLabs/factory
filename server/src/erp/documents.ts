import { getDb } from "../db/database.js";
import path from "node:path";
import { config } from "../config.js";

export const documentDirectory = path.join(
  path.dirname(config.dbPath),
  "documents",
);
export const documentMimeTypes = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "text/csv",
] as const;
export const documentCategories = [
  "drawing",
  "photo",
  "delivery_ticket",
  "permit",
  "quality",
  "safety",
  "correspondence",
  "closeout",
  "other",
] as const;
export function initializeDocuments(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS project_documents (
    id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
    jobsite_id INTEGER NOT NULL REFERENCES jobsites(id), group_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0), supersedes_id INTEGER REFERENCES project_documents(id),
    category TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    file_key TEXT NOT NULL UNIQUE, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL, uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL,
    UNIQUE(tenant_id,group_id,revision));
    CREATE INDEX IF NOT EXISTS ix_documents_job ON project_documents(tenant_id,jobsite_id,uploaded_at);
    CREATE TRIGGER IF NOT EXISTS documents_immutable_update BEFORE UPDATE ON project_documents
      BEGIN SELECT RAISE(ABORT,'Document revisions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS documents_immutable_delete BEFORE DELETE ON project_documents
      BEGIN SELECT RAISE(ABORT,'Document revisions are immutable'); END;`);
}
