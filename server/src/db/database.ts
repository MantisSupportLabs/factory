/**
 * Thin wrapper over node:sqlite. Kept deliberately small: the query surface
 * used here (prepare/all/get/run, transactions) maps directly onto
 * pg/postgres.js for the SaaS deployment — swap this file, keep the schema.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

export type Row = Record<string, unknown>;
export type SqlParam = string | number | bigint | null;

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    db = new DatabaseSync(config.dbPath);
    const here = path.dirname(fileURLToPath(import.meta.url));
    // schema.sql lives next to the source; copied to dist by the build script.
    const schemaPath = fs.existsSync(path.join(here, 'schema.sql'))
      ? path.join(here, 'schema.sql')
      : path.resolve(here, '../../src/db/schema.sql');
    db.exec(fs.readFileSync(schemaPath, 'utf8'));
    migrate(db);
  }
  return db;
}

/**
 * Additive column migrations for databases created before a schema change.
 * schema.sql only CREATEs missing tables; new columns on existing tables
 * are applied here.
 */
function migrate(d: DatabaseSync): void {
  const ensureColumn = (table: string, column: string, ddl: string) => {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };
  ensureColumn('employees', 'crew_id', 'crew_id INTEGER REFERENCES crews(id)');
  ensureColumn('jobsites', 'pm_id', 'pm_id INTEGER REFERENCES employees(id)');
  ensureColumn('jobsites', 'pe_id', 'pe_id INTEGER REFERENCES employees(id)');
}

export function all<T = Row>(sql: string, ...params: SqlParam[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function get<T = Row>(sql: string, ...params: SqlParam[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, ...params: SqlParam[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
  return getDb().prepare(sql).run(...params);
}

export function transaction<T>(fn: () => T): T {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
