import { getDb } from '../db/database.js';

/** Additive ERP migration: runs on every boot, including databases seeded before ERP existed. */
export function initializeErpSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS project_profiles (
      jobsite_id INTEGER PRIMARY KEY REFERENCES jobsites(id),
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      client TEXT NOT NULL DEFAULT '',
      pm_id INTEGER REFERENCES employees(id),
      contract_value REAL NOT NULL DEFAULT 0 CHECK(contract_value >= 0),
      budget REAL NOT NULL DEFAULT 0 CHECK(budget >= 0)
    );
    CREATE INDEX IF NOT EXISTS ix_project_profiles_tenant ON project_profiles(tenant_id);
    CREATE TABLE IF NOT EXISTS crews (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      name TEXT NOT NULL,
      trade TEXT NOT NULL,
      foreman_id INTEGER NOT NULL REFERENCES employees(id),
      UNIQUE(tenant_id, name)
    );
    CREATE TABLE IF NOT EXISTS crew_members (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      crew_id INTEGER NOT NULL REFERENCES crews(id),
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      PRIMARY KEY(crew_id, employee_id),
      UNIQUE(tenant_id, employee_id)
    );
    CREATE TABLE IF NOT EXISTS crew_assignments (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      crew_id INTEGER NOT NULL REFERENCES crews(id),
      jobsite_id INTEGER NOT NULL REFERENCES jobsites(id),
      date TEXT NOT NULL,
      task TEXT NOT NULL,
      cost_code TEXT NOT NULL,
      UNIQUE(tenant_id, crew_id, date)
    );
    CREATE INDEX IF NOT EXISTS ix_crew_assignments_job_date ON crew_assignments(tenant_id, jobsite_id, date);
    CREATE TABLE IF NOT EXISTS work_item_profiles (
      plan_id INTEGER PRIMARY KEY REFERENCES production_plans(id),
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      cost_code TEXT NOT NULL,
      budget REAL NOT NULL DEFAULT 0 CHECK(budget >= 0)
    );
    CREATE INDEX IF NOT EXISTS ix_work_item_profiles_tenant ON work_item_profiles(tenant_id);
    CREATE TABLE IF NOT EXISTS daily_reports (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      jobsite_id INTEGER NOT NULL REFERENCES jobsites(id),
      crew_id INTEGER NOT NULL REFERENCES crews(id),
      date TEXT NOT NULL,
      weather TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      rough_pct REAL CHECK(rough_pct BETWEEN 0 AND 100),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'submitted', 'approved')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      submitted_at TEXT,
      approved_at TEXT,
      approved_by TEXT,
      UNIQUE(tenant_id, jobsite_id, crew_id, date)
    );
    CREATE TABLE IF NOT EXISTS daily_report_lines (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      report_id INTEGER NOT NULL REFERENCES daily_reports(id) ON DELETE CASCADE,
      plan_id INTEGER NOT NULL REFERENCES production_plans(id),
      qty REAL NOT NULL DEFAULT 0 CHECK(qty >= 0),
      labor_hours REAL NOT NULL DEFAULT 0 CHECK(labor_hours >= 0),
      equipment_hours REAL NOT NULL DEFAULT 0 CHECK(equipment_hours >= 0),
      labor_cost REAL NOT NULL DEFAULT 0 CHECK(labor_cost >= 0),
      equipment_cost REAL NOT NULL DEFAULT 0 CHECK(equipment_cost >= 0),
      material_cost REAL NOT NULL DEFAULT 0 CHECK(material_cost >= 0),
      UNIQUE(report_id, plan_id)
    );
    CREATE INDEX IF NOT EXISTS ix_report_lines_tenant_plan ON daily_report_lines(tenant_id, plan_id);
    CREATE TABLE IF NOT EXISTS job_cost_entries (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      jobsite_id INTEGER NOT NULL REFERENCES jobsites(id),
      date TEXT NOT NULL,
      cost_code TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('labor','equipment','material','subcontract','other')),
      amount REAL NOT NULL CHECK(amount >= 0),
      description TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS ix_job_cost_entries_job ON job_cost_entries(tenant_id, jobsite_id, cost_code);
    CREATE TABLE IF NOT EXISTS weekly_updates (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      jobsite_id INTEGER NOT NULL REFERENCES jobsites(id),
      pm_id INTEGER NOT NULL REFERENCES employees(id),
      week_ending TEXT NOT NULL,
      rough_pct REAL NOT NULL CHECK(rough_pct BETWEEN 0 AND 100),
      forecast_finish TEXT,
      forecast_cost REAL CHECK(forecast_cost >= 0),
      health TEXT NOT NULL CHECK(health IN ('on_track','at_risk','delayed')),
      blockers TEXT NOT NULL DEFAULT '',
      next_steps TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(tenant_id, jobsite_id, week_ending)
    );
    CREATE INDEX IF NOT EXISTS ix_weekly_updates_job_week ON weekly_updates(tenant_id, jobsite_id, week_ending);
    CREATE TABLE IF NOT EXISTS erp_seed_versions (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      version INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, version)
    );
  `);
}
