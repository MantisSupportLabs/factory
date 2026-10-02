import { all, get, getDb, nowIso, run } from "../db/database.js";
import { businessDate } from "./calendar.js";
import { ErpError } from "./validation.js";

let initialized = false;
/** Additive workforce migrations preserve approved facts and their correction trail. */
export function initializeWorkforcePlanning(): void {
  if (initialized) return;
  migrateDailyReportRevisions();
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS time_entries (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      employee_id INTEGER NOT NULL REFERENCES employees(id), jobsite_id INTEGER NOT NULL REFERENCES jobsites(id),
      date TEXT NOT NULL, cost_code TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
      break_minutes INTEGER NOT NULL CHECK(break_minutes>=0), hours REAL NOT NULL CHECK(hours>0 AND hours<=24),
      hourly_rate REAL NOT NULL CHECK(hourly_rate>=0), burden_pct REAL NOT NULL CHECK(burden_pct>=0 AND burden_pct<=1000),
      base_cost REAL NOT NULL CHECK(base_cost>=0), burden_cost REAL NOT NULL CHECK(burden_cost>=0),
      rates_pending INTEGER NOT NULL DEFAULT 0 CHECK(rates_pending IN (0,1)),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved')),
      notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, submitted_at TEXT, approved_at TEXT, approved_by TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_time_entries_employee_date ON time_entries(tenant_id,employee_id,date);
    CREATE TABLE IF NOT EXISTS time_entry_postings (
      time_entry_id INTEGER PRIMARY KEY REFERENCES time_entries(id), tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      job_cost_entry_id INTEGER NOT NULL UNIQUE REFERENCES job_cost_entries(id)
    );
    CREATE TABLE IF NOT EXISTS time_entry_voids (
      time_entry_id INTEGER PRIMARY KEY REFERENCES time_entries(id), tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      reason TEXT NOT NULL, voided_at TEXT NOT NULL, voided_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS certifications (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), employee_id INTEGER NOT NULL REFERENCES employees(id),
      cert_name TEXT NOT NULL COLLATE NOCASE, issued_date TEXT NOT NULL, expires_date TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, UNIQUE(tenant_id,employee_id,cert_name,issued_date)
    );
    CREATE INDEX IF NOT EXISTS ix_certifications_employee ON certifications(tenant_id,employee_id,expires_date);
    CREATE TABLE IF NOT EXISTS crew_membership_history (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), crew_id INTEGER NOT NULL REFERENCES crews(id),
      crew_name TEXT NOT NULL, foreman_id INTEGER NOT NULL REFERENCES employees(id), members TEXT NOT NULL, member_names TEXT NOT NULL,
      effective_date TEXT NOT NULL, snapshot_at TEXT NOT NULL, source TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crew_assignment_members (
      assignment_id INTEGER NOT NULL REFERENCES crew_assignments(id) ON DELETE CASCADE,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id), employee_id INTEGER NOT NULL REFERENCES employees(id),
      employee_name TEXT NOT NULL, snapshot_source TEXT NOT NULL, PRIMARY KEY(assignment_id,employee_id)
    );
    CREATE TABLE IF NOT EXISTS crew_assignment_requirements (
      assignment_id INTEGER NOT NULL REFERENCES crew_assignments(id) ON DELETE CASCADE,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id), cert_name TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY(assignment_id,cert_name)
    );
    CREATE TABLE IF NOT EXISTS daily_report_replacements (
      original_report_id INTEGER PRIMARY KEY REFERENCES daily_reports(id), replacement_report_id INTEGER NOT NULL UNIQUE REFERENCES daily_reports(id),
      tenant_id INTEGER NOT NULL REFERENCES tenants(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_report_request_keys (
      tenant_id INTEGER NOT NULL REFERENCES tenants(id), client_request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
      report_id INTEGER NOT NULL REFERENCES daily_reports(id), PRIMARY KEY(tenant_id,client_request_id)
    );
    CREATE TABLE IF NOT EXISTS daily_report_rejections (
      id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id), report_id INTEGER NOT NULL REFERENCES daily_reports(id),
      reason TEXT NOT NULL, rejected_at TEXT NOT NULL, rejected_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS daily_report_reversals (
      report_id INTEGER PRIMARY KEY REFERENCES daily_reports(id), tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      reason TEXT NOT NULL, reversed_at TEXT NOT NULL, reversed_by TEXT NOT NULL
    );
  `);
  if (
    !all<{ name: string }>("PRAGMA table_info(time_entries)").some(
      (c) => c.name === "rates_pending",
    )
  )
    getDb().exec(
      "ALTER TABLE time_entries ADD COLUMN rates_pending INTEGER NOT NULL DEFAULT 0",
    );
  initialized = true;
  backfillWorkforceSnapshots();
}

export function backfillWorkforceSnapshots(): void {
  initializeWorkforcePlanning();
  // Older dispatch records have no recoverable roster history; label that limitation.
  for (const crew of all<{ id: number; tenant_id: number }>(
    "SELECT id,tenant_id FROM crews",
  )) {
    if (
      !get(
        "SELECT id FROM crew_membership_history WHERE tenant_id=? AND crew_id=?",
        crew.tenant_id,
        crew.id,
      )
    ) {
      captureMembership(crew.tenant_id, crew.id, "migration_current_roster");
    }
  }
  for (const assignment of all<{
    id: number;
    tenant_id: number;
    crew_id: number;
    date: string;
  }>(`SELECT a.* FROM crew_assignments a
    WHERE NOT EXISTS (SELECT 1 FROM crew_assignment_members m WHERE m.tenant_id=a.tenant_id AND m.assignment_id=a.id)`)) {
    snapshotAssignment(
      assignment.tenant_id,
      assignment.id,
      assignment.crew_id,
      assignment.date,
      [],
      "migration_current_roster",
    );
  }
}

/** SQLite cannot drop an inline UNIQUE index; atomically upgrade the report header without touching facts. */
function migrateDailyReportRevisions(): void {
  const columns = all<{ name: string }>("PRAGMA table_info(daily_reports)");
  if (columns.some((c) => c.name === "revision")) return;
  const table = get<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='daily_reports'",
  );
  if (!table)
    throw new Error("Initialize the ERP schema before workforce planning");
  const sql = table.sql
    .replace(
      /CREATE TABLE(?: IF NOT EXISTS)?\s+["`]?daily_reports["`]?/i,
      "CREATE TABLE daily_reports_revised",
    )
    .replace(
      /UNIQUE\s*\(\s*tenant_id\s*,\s*jobsite_id\s*,\s*crew_id\s*,\s*date\s*\)/i,
      "revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), UNIQUE(tenant_id,jobsite_id,crew_id,date,revision)",
    );
  const preserved = all<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE tbl_name='daily_reports' AND type IN ('index','trigger') AND sql IS NOT NULL",
  );
  const db = getDb(),
    foreignKeys = get<{ foreign_keys: number }>(
      "PRAGMA foreign_keys",
    )!.foreign_keys;
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(sql);
    const fields = columns
      .map((c) => `"${c.name.replaceAll('"', '""')}"`)
      .join(",");
    db.exec(
      `INSERT INTO daily_reports_revised(${fields}) SELECT ${fields} FROM daily_reports`,
    );
    db.exec("DROP TABLE daily_reports");
    db.exec("ALTER TABLE daily_reports_revised RENAME TO daily_reports");
    for (const item of preserved) db.exec(item.sql);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec(`PRAGMA foreign_keys=${foreignKeys ? "ON" : "OFF"}`);
  }
}

export function captureMembership(
  tenantId: number,
  crewId: number,
  source = "crew_edit",
): void {
  initializeWorkforcePlanning();
  const crew = get<{ name: string; foreman_id: number }>(
    "SELECT name,foreman_id FROM crews WHERE tenant_id=? AND id=?",
    tenantId,
    crewId,
  );
  if (!crew) throw new ErpError(404, "crew not found");
  const members = all<{ id: number; name: string }>(
    `SELECT e.id,e.name FROM crew_members m JOIN employees e ON e.id=m.employee_id AND e.tenant_id=m.tenant_id
    WHERE m.tenant_id=? AND m.crew_id=? ORDER BY e.id`,
    tenantId,
    crewId,
  );
  const ids = JSON.stringify(members.map((m) => m.id));
  const previous = get<{
    members: string;
    foreman_id: number;
    crew_name: string;
  }>(
    `SELECT members,foreman_id,crew_name FROM crew_membership_history
    WHERE tenant_id=? AND crew_id=? ORDER BY id DESC LIMIT 1`,
    tenantId,
    crewId,
  );
  if (
    previous?.members === ids &&
    previous.foreman_id === crew.foreman_id &&
    previous.crew_name === crew.name
  )
    return;
  run(
    `INSERT INTO crew_membership_history(tenant_id,crew_id,crew_name,foreman_id,members,member_names,effective_date,snapshot_at,source)
    VALUES(?,?,?,?,?,?,?,?,?)`,
    tenantId,
    crewId,
    crew.name,
    crew.foreman_id,
    ids,
    JSON.stringify(members.map((m) => m.name)),
    businessDate(),
    nowIso(),
    source,
  );
}

export function snapshotAssignment(
  tenantId: number,
  assignmentId: number,
  crewId: number,
  workDate: string,
  requirements: string[],
  source = "dated_membership",
): void {
  initializeWorkforcePlanning();
  const history = get<{
    members: string;
    member_names: string;
    source: string;
  }>(
    `SELECT members,member_names,source FROM crew_membership_history
    WHERE tenant_id=? AND crew_id=? AND effective_date<=? ORDER BY effective_date DESC,id DESC LIMIT 1`,
    tenantId,
    crewId,
    workDate,
  );
  let members: { id: number; name: string }[];
  if (history) {
    const ids = JSON.parse(history.members) as number[],
      names = JSON.parse(history.member_names) as string[];
    members = ids.map((id, index) => ({
      id,
      name: names[index] ?? `Employee ${id}`,
    }));
    if (history.source === "migration_current_roster")
      source = "migration_current_roster";
  } else {
    members = all<{ id: number; name: string }>(
      `SELECT e.id,e.name FROM crew_members m JOIN employees e ON e.id=m.employee_id AND e.tenant_id=m.tenant_id
      WHERE m.tenant_id=? AND m.crew_id=? ORDER BY e.id`,
      tenantId,
      crewId,
    );
    source = "current_roster_no_dated_history";
  }
  if (!members.length)
    throw new ErpError(
      400,
      "A crew assignment requires at least one crew member",
    );
  for (const member of members) {
    if (
      source !== "migration_current_roster" &&
      !get(
        "SELECT id FROM employees WHERE tenant_id=? AND id=? AND active=1",
        tenantId,
        member.id,
      )
    )
      throw new ErpError(400, "All scheduled crew members must be active");
    if (
      source !== "migration_current_roster" &&
      get(
        `SELECT m.assignment_id FROM crew_assignment_members m
      JOIN crew_assignments a ON a.id=m.assignment_id AND a.tenant_id=m.tenant_id
      WHERE m.tenant_id=? AND m.employee_id=? AND a.date=? AND a.id<>?`,
        tenantId,
        member.id,
        workDate,
        assignmentId,
      )
    ) {
      throw new ErpError(
        409,
        `${member.name} is already included in another crew assignment on ${workDate}; reconcile that dispatch before scheduling them again`,
      );
    }
    for (const cert of requirements) {
      if (
        !get(
          `SELECT id FROM certifications WHERE tenant_id=? AND employee_id=? AND cert_name=? COLLATE NOCASE
        AND issued_date<=? AND expires_date>=?`,
          tenantId,
          member.id,
          cert,
          workDate,
          workDate,
        )
      ) {
        throw new ErpError(
          409,
          `${member.name} needs a valid ${cert} certification on ${workDate}`,
        );
      }
    }
    run(
      `INSERT OR IGNORE INTO crew_assignment_members(assignment_id,tenant_id,employee_id,employee_name,snapshot_source)
      VALUES(?,?,?,?,?)`,
      assignmentId,
      tenantId,
      member.id,
      member.name,
      source,
    );
  }
  for (const cert of requirements)
    run(
      "INSERT INTO crew_assignment_requirements(assignment_id,tenant_id,cert_name) VALUES(?,?,?)",
      assignmentId,
      tenantId,
      cert,
    );
}

/** Blocks costing the same job/code/day in both aggregate reports and individual shifts. */
export function assertNoReportLabor(
  tenantId: number,
  jobsiteId: number,
  costCode: string,
  workDate: string,
): void {
  initializeWorkforcePlanning();
  if (
    get(
      `SELECT l.id FROM daily_report_lines l JOIN daily_reports r ON r.id=l.report_id AND r.tenant_id=l.tenant_id
    JOIN work_item_profiles w ON w.plan_id=l.plan_id AND w.tenant_id=l.tenant_id
    WHERE r.tenant_id=? AND r.jobsite_id=? AND r.date=? AND w.cost_code=? AND r.status='approved' AND l.labor_cost>0
    AND NOT EXISTS(SELECT 1 FROM daily_report_reversals v WHERE v.tenant_id=r.tenant_id AND v.report_id=r.id)`,
      tenantId,
      jobsiteId,
      workDate,
      costCode,
    )
  ) {
    throw new ErpError(
      409,
      "Approved daily-report labor already costs this job, code, and date; reverse that report or remove labor from its replacement before posting individual shifts",
    );
  }
}
export function assertNoShiftLabor(tenantId: number, reportId: number): void {
  initializeWorkforcePlanning();
  if (
    get(
      `SELECT l.id FROM daily_report_lines l JOIN daily_reports r ON r.id=l.report_id AND r.tenant_id=l.tenant_id
    JOIN work_item_profiles w ON w.plan_id=l.plan_id AND w.tenant_id=l.tenant_id
    JOIN time_entries e ON e.tenant_id=r.tenant_id AND e.jobsite_id=r.jobsite_id AND e.date=r.date AND e.cost_code=w.cost_code
    WHERE r.tenant_id=? AND r.id=? AND l.labor_cost>0 AND e.status='approved' AND (e.base_cost+e.burden_cost)>0
    AND NOT EXISTS(SELECT 1 FROM time_entry_voids v WHERE v.tenant_id=e.tenant_id AND v.time_entry_id=e.id)`,
      tenantId,
      reportId,
    )
  ) {
    throw new ErpError(
      409,
      "Approved individual shifts already cost labor for a report job, code, and date; return this report for correction and set its aggregate labor cost to zero",
    );
  }
}

export function getWorkforcePlanning(tenantId: number) {
  initializeWorkforcePlanning();
  const timeEntries = all(
    `SELECT e.*,p.name employee_name,j.name jobsite_name,v.reason void_reason,v.voided_at,v.voided_by
    FROM time_entries e JOIN employees p ON p.id=e.employee_id AND p.tenant_id=e.tenant_id
    JOIN jobsites j ON j.id=e.jobsite_id AND j.tenant_id=e.tenant_id
    LEFT JOIN time_entry_voids v ON v.time_entry_id=e.id AND v.tenant_id=e.tenant_id
    WHERE e.tenant_id=? ORDER BY e.date DESC,e.start_time DESC,e.id DESC`,
    tenantId,
  );
  const certifications = all<
    { id: number; expires_date: string; issued_date: string } & Record<
      string,
      unknown
    >
  >(
    `SELECT c.*,e.name employee_name FROM certifications c
    JOIN employees e ON e.id=c.employee_id AND e.tenant_id=c.tenant_id WHERE c.tenant_id=? ORDER BY c.expires_date,c.id`,
    tenantId,
  ).map((c) => ({
    ...c,
    validity:
      c.issued_date > businessDate()
        ? "not_yet_valid"
        : c.expires_date < businessDate()
          ? "expired"
          : c.expires_date === businessDate()
            ? "expires_today"
            : c.expires_date <= businessDate(30)
              ? "expiring_soon"
              : "valid",
  }));
  const membershipHistory = all<
    { members: string; member_names: string } & Record<string, unknown>
  >(
    `SELECT * FROM crew_membership_history WHERE tenant_id=? ORDER BY snapshot_at DESC,id DESC`,
    tenantId,
  ).map((h) => ({
    ...h,
    members: JSON.parse(h.members),
    member_names: JSON.parse(h.member_names),
  }));
  const assignmentMembers = all(
    `SELECT m.*,a.date,a.crew_id,c.name crew_name,j.name jobsite_name FROM crew_assignment_members m
    JOIN crew_assignments a ON a.id=m.assignment_id AND a.tenant_id=m.tenant_id
    JOIN crews c ON c.id=a.crew_id AND c.tenant_id=a.tenant_id JOIN jobsites j ON j.id=a.jobsite_id AND j.tenant_id=a.tenant_id
    WHERE m.tenant_id=? ORDER BY a.date DESC,m.assignment_id,m.employee_id`,
    tenantId,
  );
  return {
    time_entries: timeEntries,
    certifications,
    membership_history: membershipHistory,
    assignment_members: assignmentMembers,
    payroll_export: {
      label:
        "Payroll preparation — approved, unvoided shifts; no tax, overtime, withholding, or payroll engine",
      endpoint: "/erp/payroll-export",
    },
  };
}

/** Keep the legacy entry surface from bypassing the split-shift interval checks. */
export function assertLegacyTimecardDoesNotOverlap(
  tenantId: number,
  card: {
    id?: number;
    employee_id: number;
    date: string;
    start_time?: string | null;
    end_time?: string | null;
    hours: number;
  },
): void {
  if (
    !get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='time_entries'",
    )
  )
    return;
  const entries = all<{ start_time: string; end_time: string; hours: number }>(
    `SELECT e.start_time,e.end_time,e.hours FROM time_entries e
    WHERE e.tenant_id=? AND e.employee_id=? AND e.date=?
    AND NOT EXISTS(SELECT 1 FROM time_entry_voids v WHERE v.tenant_id=e.tenant_id AND v.time_entry_id=e.id)`,
    tenantId,
    card.employee_id,
    card.date,
  );
  if (!entries.length) return;
  const parse = (value: string | null | undefined): number | null => {
    if (!value) return null;
    if (value === "24:00") return 1440;
    const direct = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(value);
    const iso =
      value.startsWith(`${card.date}T`) || value.startsWith(`${card.date} `)
        ? /[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?/.exec(value)
        : null;
    const match = direct ?? iso;
    return match
      ? Number(match[1]) * 60 + Number(match[2]) + Number(match[3] ?? 0) / 60
      : null;
  };
  if (card.hours > 0) {
    const start = parse(card.start_time),
      end = parse(card.end_time);
    if (start === null || end === null || end <= start)
      throw new ErpError(
        409,
        "Split shifts already exist for this employee and date; a legacy timecard without a usable interval must be reconciled first",
      );
    for (const entry of entries)
      if (start < parse(entry.end_time)! && end > parse(entry.start_time)!)
        throw new ErpError(
          409,
          "This legacy timecard overlaps a split shift already recorded for this employee and date",
        );
  }
  const otherLegacy = get<{ hours: number }>(
    `SELECT COALESCE(SUM(hours),0) hours FROM timecards WHERE tenant_id=? AND employee_id=? AND date=? AND id<>?`,
    tenantId,
    card.employee_id,
    card.date,
    card.id ?? 0,
  )!.hours;
  if (
    entries.reduce((sum, e) => sum + e.hours, 0) + otherLegacy + card.hours >
    24 + 1e-8
  )
    throw new ErpError(
      409,
      "Combined paid time exceeds 24 hours for this employee and date",
    );
}
