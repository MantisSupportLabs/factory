import { all, get, getDb, run, transaction } from '../db/database.js';

/** Additive commercial records. Receipt and requested changes never post costs or revise contracts. */
export function initCommercial(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      jobsite_id INTEGER NOT NULL REFERENCES jobsites(id),
      vendor TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      cost_code TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL CHECK(amount >= 0),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','received')),
      order_date TEXT NOT NULL,
      expected_date TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS ix_purchase_orders_tenant_job_status
      ON purchase_orders(tenant_id, jobsite_id, status);
    CREATE TABLE IF NOT EXISTS project_controls (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      jobsite_id INTEGER NOT NULL REFERENCES jobsites(id),
      kind TEXT NOT NULL CHECK(kind IN ('rfi','change_order','issue')),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      owner_id INTEGER REFERENCES employees(id),
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
      amount REAL CHECK(amount >= 0),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      CHECK((kind = 'change_order' AND amount IS NOT NULL) OR (kind != 'change_order' AND amount IS NULL))
    );
    CREATE INDEX IF NOT EXISTS ix_project_controls_tenant_job_status
      ON project_controls(tenant_id, jobsite_id, status);
    CREATE TABLE IF NOT EXISTS commercial_seed_versions (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      version INTEGER NOT NULL,
      PRIMARY KEY(tenant_id, version)
    );
  `);

  const tenant = get<{ id: number }>(
    `SELECT id FROM tenants WHERE slug = 'summit-dirtworks' AND name = 'Summit DirtWorks & Paving'`,
  );
  if (!tenant || get(`SELECT tenant_id FROM commercial_seed_versions WHERE tenant_id = ? AND version = 1`, tenant.id)) return;
  const jobs = all<{ id: number; code: string }>(
    `SELECT id, code FROM jobsites WHERE tenant_id = ? AND code IN ('J-2401','J-2407','J-2410')`, tenant.id,
  );
  if (jobs.length !== 3) return;
  const jobIds = new Map(jobs.map(job => [job.code, job.id]));
  const employees = all<{ id: number; name: string }>(`SELECT id, name FROM employees WHERE tenant_id = ?`, tenant.id);
  const ownerId = (name: string) => employees.find(employee => employee.name === name)?.id ?? null;
  const localDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const offsetDate = (days: number) => {
    const date = new Date(`${localDate}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };

  transaction(() => {
    const purchase = (code: string, vendor: string, description: string, costCode: string, amount: number, status: string, ordered: number, expected: number) => {
      run(`INSERT INTO purchase_orders (tenant_id, jobsite_id, vendor, description, cost_code, amount, status, order_date, expected_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, tenant.id, jobIds.get(code)!, vendor, description, costCode, amount, status, offsetDate(ordered), offsetDate(expected));
    };
    purchase('J-2401', 'North Texas Aggregates', 'Flex base for northbound subgrade, scheduled truck deliveries', '3100-BASE', 68400, 'approved', -8, 3);
    purchase('J-2401', 'TrafficWorks Supply', 'Barrier rental for phase 2 traffic switch', '1100-MOB', 12900, 'draft', -1, 7);
    purchase('J-2407', 'Metro Pipe & Precast', 'Storm pipe and precast junction boxes for blocks 4–6', '4200-STORM', 92400, 'approved', -12, 2);
    purchase('J-2407', 'Lone Star Geotextiles', 'Detention basin filter fabric, delivered in full', '4300-DET', 18600, 'received', -20, -5);
    purchase('J-2410', 'Utility Supply Co.', 'Water main fittings and isolation valves', '4100-WATER', 34600, 'approved', -6, 5);
    purchase('J-2410', 'Rock Ridge Hauling', 'Quoted export hauling for rock excavation', '2200-ROCK', 27500, 'draft', 0, 10);

    const control = (code: string, kind: string, title: string, description: string, owner: string, due: number, status: string, amount: number | null) => {
      run(`INSERT INTO project_controls (tenant_id, jobsite_id, kind, title, description, owner_id, due_date, status, amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, tenant.id, jobIds.get(code)!, kind, title, description, ownerId(owner), offsetDate(due), status, amount);
    };
    control('J-2401', 'rfi', 'Confirm culvert invert at station 118+40', 'Design invert conflicts with the surveyed tie-in. Request engineer direction before installation.', 'Rafael Delgado', 2, 'open', null);
    control('J-2407', 'issue', 'Storm structures awaiting delivery', 'Confirm vendor shipping slot and revise crew lookahead if delivery moves.', 'Marcus Okafor', -1, 'open', null);
    control('J-2410', 'change_order', 'Unforeseen rock at northeast utility crossing', 'Requested price for additional excavation. Awaiting customer review; contract value remains unchanged.', 'Tracy Nguyen', 5, 'open', 48200);
    control('J-2407', 'rfi', 'Detention outlet elevation confirmed', 'Engineer response received and incorporated into the field layout.', 'Marcus Okafor', -4, 'closed', null);
    run(`INSERT INTO commercial_seed_versions (tenant_id, version) VALUES (?, 1)`, tenant.id);
  });
}
