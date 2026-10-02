import { all, get, getDb, run, transaction } from "../db/database.js";

/** Equipment decisions use operational records; telemetry remains separate evidence. */
export function initializeEquipmentOperations(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS equipment_reservations (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      asset_id INTEGER NOT NULL REFERENCES assets(id), jobsite_id INTEGER NOT NULL REFERENCES jobsites(id),
      start_at TEXT NOT NULL, end_at TEXT NOT NULL, task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','cancelled')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), CHECK(end_at > start_at)
    );
    CREATE INDEX IF NOT EXISTS ix_equipment_reservations_overlap ON equipment_reservations(tenant_id,asset_id,status,start_at,end_at);
    CREATE TABLE IF NOT EXISTS asset_transfers (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), asset_id INTEGER NOT NULL REFERENCES assets(id),
      from_jobsite_id INTEGER REFERENCES jobsites(id), to_jobsite_id INTEGER NOT NULL REFERENCES jobsites(id),
      custodian_id INTEGER REFERENCES employees(id), requested_date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','cancelled')),
      source_operator TEXT, source_status TEXT NOT NULL, source_updated_at TEXT NOT NULL,
      previous_jobsite_id INTEGER REFERENCES jobsites(id), previous_operator TEXT,
      accepted_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_asset_pending_transfer ON asset_transfers(tenant_id,asset_id) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS equipment_work_orders (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), asset_id INTEGER NOT NULL REFERENCES assets(id),
      type TEXT NOT NULL CHECK(type IN ('preventive','repair','inspection')), title TEXT NOT NULL,
      assigned_to_id INTEGER REFERENCES employees(id), status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','completed')),
      scheduled_start TEXT, scheduled_end TEXT, parts_cost REAL NOT NULL DEFAULT 0 CHECK(parts_cost>=0),
      labor_cost REAL NOT NULL DEFAULT 0 CHECK(labor_cost>=0), notes TEXT NOT NULL DEFAULT '',
      jobsite_id INTEGER REFERENCES jobsites(id), cost_code TEXT, service_rule_id INTEGER REFERENCES equipment_service_rules(id), prior_status TEXT, completed_meter REAL CHECK(completed_meter>=0),
      started_at TEXT, completed_at TEXT, returned_to_service INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK((scheduled_start IS NULL AND scheduled_end IS NULL) OR (scheduled_start IS NOT NULL AND scheduled_end > scheduled_start)),
      CHECK((jobsite_id IS NULL AND cost_code IS NULL) OR (jobsite_id IS NOT NULL AND cost_code IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS ix_equipment_work_orders_asset ON equipment_work_orders(tenant_id,asset_id,status);
    CREATE TABLE IF NOT EXISTS equipment_cost_links (
      work_order_id INTEGER PRIMARY KEY REFERENCES equipment_work_orders(id), tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      cost_entry_id INTEGER NOT NULL UNIQUE REFERENCES job_cost_entries(id)
    );
    CREATE TABLE IF NOT EXISTS equipment_service_rules (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), asset_id INTEGER NOT NULL REFERENCES assets(id),
      name TEXT NOT NULL, interval_hours REAL CHECK(interval_hours>0), interval_days INTEGER CHECK(interval_days>0),
      last_completed_date TEXT, last_completed_meter REAL CHECK(last_completed_meter>=0),
      CHECK(interval_hours IS NOT NULL OR interval_days IS NOT NULL)
    );
    CREATE TABLE IF NOT EXISTS equipment_inspections (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), asset_id INTEGER NOT NULL REFERENCES assets(id),
      date TEXT NOT NULL, inspector_id INTEGER NOT NULL REFERENCES employees(id), passed INTEGER NOT NULL CHECK(passed IN (0,1)),
      findings TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS equipment_seed_versions (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id), version INTEGER NOT NULL, PRIMARY KEY(tenant_id,version)
    );
  `);
  // Add the service link safely for databases initialized during an earlier app version.
  if (
    !all<{ name: string }>("PRAGMA table_info(equipment_work_orders)").some(
      (column) => column.name === "service_rule_id",
    )
  )
    getDb().exec(
      "ALTER TABLE equipment_work_orders ADD COLUMN service_rule_id INTEGER REFERENCES equipment_service_rules(id)",
    );
  const tenant = get<{ id: number }>(
    `SELECT id FROM tenants WHERE slug='summit-dirtworks' AND name='Summit DirtWorks & Paving'`,
  );
  if (
    !tenant ||
    get(
      "SELECT tenant_id FROM equipment_seed_versions WHERE tenant_id=? AND version=1",
      tenant.id,
    )
  )
    return;
  const asset = get<{ id: number }>(
    `SELECT a.id FROM assets a JOIN jobsites j ON j.id=a.jobsite_id AND j.tenant_id=a.tenant_id
    WHERE a.tenant_id=? AND a.source='manual' AND a.kind IN ('machine','truck') AND a.serial_number IN ('1XKZDP9X5LJ290112','1XKZDP9X5LJ290114','1XPCDP9X3MD450115') AND j.code IN ('J-2401','J-2407','J-2410') ORDER BY a.id LIMIT 1`,
    tenant.id,
  );
  if (!asset) return;
  transaction(() => {
    // Illustrative planned shop work does not change availability, telemetry, or actual job costs.
    run(
      `INSERT INTO equipment_work_orders(tenant_id,asset_id,type,title,notes)
      VALUES (?,?,'preventive','Demo planning example: review preventive service','Illustrative open planning record. Schedule and validate service against the manufacturer before starting.')`,
      tenant.id,
      asset.id,
    );
    run(
      "INSERT INTO equipment_seed_versions(tenant_id,version) VALUES (?,1)",
      tenant.id,
    );
  });
}

export function equipmentServiceRules(tenantId: number) {
  const localToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return all<{
    interval_hours: number | null;
    interval_days: number | null;
    last_completed_date: string | null;
    last_completed_meter: number | null;
    engine_hours: number | null;
  }>(
    `SELECT r.*,a.name AS asset_name,s.engine_hours,s.ts AS meter_observed_at
     FROM equipment_service_rules r JOIN assets a ON a.id=r.asset_id AND a.tenant_id=r.tenant_id
     LEFT JOIN asset_state s ON s.asset_id=r.asset_id AND s.tenant_id=r.tenant_id WHERE r.tenant_id=? ORDER BY r.id DESC`,
    tenantId,
  ).map((rule) => {
    const next_due_meter =
      rule.interval_hours != null && rule.last_completed_meter != null
        ? rule.last_completed_meter + rule.interval_hours
        : null;
    let next_due_date: string | null = null;
    if (rule.interval_days != null && rule.last_completed_date) {
      const value = new Date(`${rule.last_completed_date}T12:00:00Z`);
      value.setUTCDate(value.getUTCDate() + rule.interval_days);
      next_due_date = value.toISOString().slice(0, 10);
    }
    return {
      ...rule,
      next_due_meter,
      next_due_date,
      next_due: next_due_date,
      due:
        (next_due_date !== null && next_due_date <= localToday) ||
        (next_due_meter !== null &&
          rule.engine_hours !== null &&
          rule.engine_hours >= next_due_meter),
      baseline_missing:
        (rule.interval_hours !== null && rule.last_completed_meter === null) ||
        (rule.interval_days !== null && rule.last_completed_date === null),
    };
  });
}
