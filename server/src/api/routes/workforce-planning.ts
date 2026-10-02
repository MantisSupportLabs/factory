import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { all, get, nowIso, run, transaction } from "../../db/database.js";
import {
  activeEmployee,
  body,
  date,
  dateRange,
  ErpError,
  hasEdits,
  id,
  number,
  option,
  related,
  text,
  type Body,
} from "../../erp/validation.js";
import {
  assertNoReportLabor,
  getWorkforcePlanning,
  initializeWorkforcePlanning,
} from "../../erp/workforce-planning.js";

export const workforcePlanningRouter = Router();
function route(handler: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      initializeWorkforcePlanning();
      handler(req, res);
    } catch (error) {
      if (error instanceof ErpError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      if (
        error instanceof Error &&
        /UNIQUE constraint failed/.test(error.message)
      ) {
        res
          .status(409)
          .json({ error: "This workforce record or posting already exists" });
        return;
      }
      next(error);
    }
  };
}
interface Shift extends Body {
  id: number;
  employee_id: number;
  jobsite_id: number;
  date: string;
  cost_code: string;
  start_time: string;
  end_time: string;
  hours: number;
  break_minutes: number;
  hourly_rate: number;
  burden_pct: number;
  base_cost: number;
  burden_cost: number;
  rates_pending: number;
  status: string;
  voided_at?: string | null;
}
function clock(
  value: unknown,
  field: string,
  end = false,
): { time: string; minutes: number } {
  const time = text(value, field, true, 5);
  if (end && time === "24:00") return { time, minutes: 1440 };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new ErpError(
      400,
      `${field} must be HH:MM${end ? " (24:00 is permitted for the day boundary)" : ""}`,
    );
  return {
    time,
    minutes: Number(time.slice(0, 2)) * 60 + Number(time.slice(3)),
  };
}
function legacyMinutes(value: string | null, workDate: string): number | null {
  if (!value) return null;
  let match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) {
    if (!value.startsWith(`${workDate}T`) && !value.startsWith(`${workDate} `))
      return null;
    match = /[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value);
  }
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return Number(match[1]) * 60 + Number(match[2]) + Number(match[3] ?? 0) / 60;
}
function shiftPayload(tenantId: number, b: Body) {
  const employeeId = activeEmployee(tenantId, b.employee_id, "employee_id");
  const jobsiteId = related(tenantId, "jobsites", b.jobsite_id, "jobsite_id"),
    workDate = date(b.date, "date")!;
  const start = clock(b.start_time, "start_time"),
    end = clock(b.end_time, "end_time", true);
  if (end.minutes <= start.minutes)
    throw new ErpError(
      400,
      "End must follow start on the same work date; split overnight work at midnight",
    );
  const breakMinutes = number(
    b.break_minutes ?? 0,
    "break_minutes",
    0,
    end.minutes - start.minutes,
  );
  if (!Number.isInteger(breakMinutes))
    throw new ErpError(400, "break_minutes must be whole minutes");
  const hours = (end.minutes - start.minutes - breakMinutes) / 60;
  if (hours <= 0)
    throw new ErpError(
      400,
      "A shift must have positive paid time after breaks",
    );
  const hourlyRate = number(b.hourly_rate ?? 0, "hourly_rate"),
    burdenPct = number(b.burden_pct ?? 0, "burden_pct", 0, 1000);
  const baseCost = Math.round(hours * hourlyRate * 100) / 100,
    burdenCost = Math.round(baseCost * burdenPct) / 100;
  if (
    !Number.isSafeInteger(Math.round(baseCost * 100)) ||
    !Number.isSafeInteger(Math.round(burdenCost * 100))
  )
    throw new ErpError(400, "Calculated labor cost is too large");
  return {
    employee_id: employeeId,
    jobsite_id: jobsiteId,
    date: workDate,
    cost_code: text(b.cost_code, "cost_code", true, 100),
    start_time: start.time,
    end_time: end.time,
    break_minutes: breakMinutes,
    hours,
    hourly_rate: hourlyRate,
    burden_pct: burdenPct,
    base_cost: baseCost,
    burden_cost: burdenCost,
    rates_pending: Number(b.rates_pending ?? 0),
    status: option(b.status ?? "draft", "status", [
      "draft",
      "submitted",
    ] as const),
    notes: text(b.notes, "notes", false, 4000),
  };
}
function checkOverlap(
  tenantId: number,
  shift: ReturnType<typeof shiftPayload> | Shift,
  skipId = 0,
): void {
  const start = clock(shift.start_time, "start_time").minutes,
    end = clock(shift.end_time, "end_time", true).minutes;
  const entries = all<Shift>(
    `SELECT e.* FROM time_entries e WHERE e.tenant_id=? AND e.employee_id=? AND e.date=? AND e.id<>?
    AND NOT EXISTS(SELECT 1 FROM time_entry_voids v WHERE v.tenant_id=e.tenant_id AND v.time_entry_id=e.id)`,
    tenantId,
    shift.employee_id,
    shift.date,
    skipId,
  );
  for (const existing of entries)
    if (
      start < clock(existing.end_time, "end_time", true).minutes &&
      end > clock(existing.start_time, "start_time").minutes
    ) {
      throw new ErpError(
        409,
        "This employee already has an overlapping shift on this date",
      );
    }
  const legacy = all<{
    start_time: string | null;
    end_time: string | null;
    hours: number;
  }>(
    `SELECT start_time,end_time,hours FROM timecards
    WHERE tenant_id=? AND employee_id=? AND date=? AND hours>0`,
    tenantId,
    shift.employee_id,
    shift.date,
  );
  for (const existing of legacy) {
    const oldStart = legacyMinutes(existing.start_time, shift.date),
      oldEnd = legacyMinutes(existing.end_time, shift.date);
    if (oldStart === null || oldEnd === null || oldEnd <= oldStart)
      throw new ErpError(
        409,
        "A legacy timecard exists without a usable shift interval; reconcile it before entering split time",
      );
    if (start < oldEnd && end > oldStart)
      throw new ErpError(
        409,
        "This shift overlaps a legacy timecard; reconcile the original timecard first",
      );
  }
  if (
    entries.reduce((sum, e) => sum + e.hours, shift.hours) +
      legacy.reduce((sum, e) => sum + e.hours, 0) >
    24 + 1e-8
  )
    throw new ErpError(
      409,
      "Combined paid time exceeds 24 hours for this employee and date",
    );
}
function shift(tenantId: number, value: unknown): Shift {
  const shiftId = id(value),
    entry = get<Shift>(
      `SELECT e.*,v.voided_at FROM time_entries e LEFT JOIN time_entry_voids v
    ON v.time_entry_id=e.id AND v.tenant_id=e.tenant_id WHERE e.tenant_id=? AND e.id=?`,
      tenantId,
      shiftId,
    );
  if (!entry) throw new ErpError(404, "Time entry not found");
  return entry;
}
function canViewRates(req: Request): boolean {
  return (
    !req.authUser ||
    ["owner", "admin", "pm", "accountant"].includes(req.authUser.role)
  );
}
function privateBody(req: Request, value: Body, existing?: Shift): Body {
  if (canViewRates(req))
    return {
      ...value,
      rates_pending:
        value.hourly_rate !== undefined ? 0 : (existing?.rates_pending ?? 0),
    };
  if (value.hourly_rate !== undefined || value.burden_pct !== undefined)
    throw new ErpError(
      403,
      "Only project managers and accounting may set private pay rates",
    );
  return {
    ...value,
    hourly_rate: existing?.hourly_rate ?? 0,
    burden_pct: existing?.burden_pct ?? 0,
    rates_pending: existing?.rates_pending ?? 1,
  };
}
function safeEntry(req: Request, entry: Record<string, unknown> | undefined) {
  if (!entry || canViewRates(req)) return entry;
  const {
    hourly_rate: _rate,
    burden_pct: _burden,
    base_cost: _base,
    burden_cost: _cost,
    ...publicEntry
  } = entry;
  return publicEntry;
}
function responseEntry(req: Request, entryId: number) {
  return safeEntry(
    req,
    getWorkforcePlanning(req.tenant.id).time_entries.find(
      (e) => e.id === entryId,
    ),
  );
}

workforcePlanningRouter.get(
  "/erp/workforce-planning",
  route((req, res) => {
    const result = getWorkforcePlanning(req.tenant.id);
    res.json({
      ...result,
      time_entries: result.time_entries.map((e) => safeEntry(req, e)),
      can_view_rates: canViewRates(req),
      can_edit_time:
        !req.authUser ||
        ["owner", "admin", "pm", "accountant", "foreman"].includes(
          req.authUser.role,
        ),
      can_edit_certifications:
        !req.authUser || ["owner", "admin", "pm"].includes(req.authUser.role),
    });
  }),
);
workforcePlanningRouter.post(
  "/erp/time-entries",
  route((req, res) => {
    const t = req.tenant.id,
      p = shiftPayload(t, privateBody(req, body(req.body)));
    const entryId = transaction(() => {
      checkOverlap(t, p);
      const result = run(
        `INSERT INTO time_entries(tenant_id,employee_id,jobsite_id,date,cost_code,start_time,end_time,break_minutes,hours,hourly_rate,burden_pct,base_cost,burden_cost,rates_pending,status,notes,created_at,submitted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        t,
        p.employee_id,
        p.jobsite_id,
        p.date,
        p.cost_code,
        p.start_time,
        p.end_time,
        p.break_minutes,
        p.hours,
        p.hourly_rate,
        p.burden_pct,
        p.base_cost,
        p.burden_cost,
        p.rates_pending,
        p.status,
        p.notes,
        nowIso(),
        p.status === "submitted" ? nowIso() : null,
      );
      return Number(result.lastInsertRowid);
    });
    res.status(201).json(responseEntry(req, entryId));
  }),
);
workforcePlanningRouter.patch(
  "/erp/time-entries/:id",
  route((req, res) => {
    const t = req.tenant.id,
      e = shift(t, req.params.id),
      b = body(req.body);
    if (e.status !== "draft" || e.voided_at)
      throw new ErpError(
        409,
        "Only unvoided draft shifts can be edited; approved rate and cost snapshots are locked",
      );
    hasEdits(b, [
      "employee_id",
      "jobsite_id",
      "date",
      "cost_code",
      "start_time",
      "end_time",
      "break_minutes",
      "hourly_rate",
      "burden_pct",
      "notes",
      "status",
    ]);
    const p = shiftPayload(t, { ...e, ...privateBody(req, b, e) });
    transaction(() => {
      checkOverlap(t, p, e.id);
      run(
        `UPDATE time_entries SET employee_id=?,jobsite_id=?,date=?,cost_code=?,start_time=?,end_time=?,break_minutes=?,hours=?,hourly_rate=?,burden_pct=?,base_cost=?,burden_cost=?,rates_pending=?,status=?,notes=?,submitted_at=? WHERE tenant_id=? AND id=?`,
        p.employee_id,
        p.jobsite_id,
        p.date,
        p.cost_code,
        p.start_time,
        p.end_time,
        p.break_minutes,
        p.hours,
        p.hourly_rate,
        p.burden_pct,
        p.base_cost,
        p.burden_cost,
        p.rates_pending,
        p.status,
        p.notes,
        p.status === "submitted" ? nowIso() : null,
        t,
        e.id,
      );
    });
    res.json(responseEntry(req, e.id));
  }),
);
workforcePlanningRouter.post(
  "/erp/time-entries/:id/submit",
  route((req, res) => {
    const t = req.tenant.id,
      e = shift(t, req.params.id);
    if (e.status !== "draft" || e.voided_at)
      throw new ErpError(409, "Only unvoided draft shifts can be submitted");
    checkOverlap(t, e, e.id);
    run(
      "UPDATE time_entries SET status='submitted',submitted_at=? WHERE tenant_id=? AND id=?",
      nowIso(),
      t,
      e.id,
    );
    res.json(responseEntry(req, e.id));
  }),
);
workforcePlanningRouter.post(
  "/erp/time-entries/:id/approve",
  route((req, res) => {
    const t = req.tenant.id,
      e = shift(t, req.params.id),
      b = body(req.body ?? {}),
      reviewer = text(
        req.authUser?.name ?? b.approved_by ?? "PM review",
        "approved_by",
        true,
        150,
      );
    if (!canViewRates(req))
      throw new ErpError(
        403,
        "Only project managers and accounting may approve private labor postings",
      );
    if (e.status !== "submitted" || e.voided_at)
      throw new ErpError(409, "Only unvoided submitted shifts can be approved");
    if (e.rates_pending && b.hourly_rate === undefined)
      throw new ErpError(
        400,
        "Confirm the employee hourly rate before approving this field-entered shift",
      );
    if (b.hourly_rate !== undefined)
      e.hourly_rate = number(b.hourly_rate, "hourly_rate");
    if (b.burden_pct !== undefined)
      e.burden_pct = number(b.burden_pct, "burden_pct", 0, 1000);
    e.base_cost = Math.round(e.hours * e.hourly_rate * 100) / 100;
    e.burden_cost = Math.round(e.base_cost * e.burden_pct) / 100;
    if (
      !Number.isSafeInteger(Math.round(e.base_cost * 100)) ||
      !Number.isSafeInteger(Math.round(e.burden_cost * 100))
    )
      throw new ErpError(400, "Calculated labor cost is too large");
    transaction(() => {
      checkOverlap(t, e, e.id);
      if (e.base_cost + e.burden_cost > 0)
        assertNoReportLabor(t, e.jobsite_id, e.cost_code, e.date);
      const posting = run(
        `INSERT INTO job_cost_entries(tenant_id,jobsite_id,date,cost_code,category,amount,description) VALUES(?,?,?,?,'labor',?,?)`,
        t,
        e.jobsite_id,
        e.date,
        e.cost_code,
        Math.round((e.base_cost + e.burden_cost) * 100) / 100,
        `Approved shift #${e.id}: wage ${e.base_cost.toFixed(2)} + burden ${e.burden_cost.toFixed(2)}`,
      );
      run(
        "INSERT INTO time_entry_postings(time_entry_id,tenant_id,job_cost_entry_id) VALUES(?,?,?)",
        e.id,
        t,
        Number(posting.lastInsertRowid),
      );
      run(
        "UPDATE time_entries SET status='approved',approved_at=?,approved_by=?,hourly_rate=?,burden_pct=?,base_cost=?,burden_cost=?,rates_pending=0 WHERE tenant_id=? AND id=?",
        nowIso(),
        reviewer,
        e.hourly_rate,
        e.burden_pct,
        e.base_cost,
        e.burden_cost,
        t,
        e.id,
      );
    });
    res.json(responseEntry(req, e.id));
  }),
);
workforcePlanningRouter.post(
  "/erp/time-entries/:id/void",
  route((req, res) => {
    const t = req.tenant.id,
      e = shift(t, req.params.id),
      b = body(req.body ?? {});
    if (e.voided_at)
      throw new ErpError(409, "This shift has already been voided");
    const reason = text(b.reason, "reason", true, 2000),
      reviewer = text(
        req.authUser?.name ?? b.voided_by ?? "PM review",
        "voided_by",
        true,
        150,
      );
    run(
      "INSERT INTO time_entry_voids(time_entry_id,tenant_id,reason,voided_at,voided_by) VALUES(?,?,?,?,?)",
      e.id,
      t,
      reason,
      nowIso(),
      reviewer,
    );
    res.json(responseEntry(req, e.id));
  }),
);
workforcePlanningRouter.get(
  "/erp/certifications",
  route((req, res) =>
    res.json(getWorkforcePlanning(req.tenant.id).certifications),
  ),
);
workforcePlanningRouter.post(
  "/erp/certifications",
  route((req, res) => {
    const t = req.tenant.id,
      b = body(req.body),
      employeeId = related(t, "employees", b.employee_id, "employee_id");
    const issued = date(b.issued_date, "issued_date")!,
      expires = date(b.expires_date, "expires_date")!;
    dateRange(issued, expires);
    const result = run(
      `INSERT INTO certifications(tenant_id,employee_id,cert_name,issued_date,expires_date,notes,created_at) VALUES(?,?,?,?,?,?,?)`,
      t,
      employeeId,
      text(b.cert_name, "cert_name", true, 150),
      issued,
      expires,
      text(b.notes, "notes", false, 2000),
      nowIso(),
    );
    res
      .status(201)
      .json(
        getWorkforcePlanning(t).certifications.find(
          (c) => c.id === Number(result.lastInsertRowid),
        ),
      );
  }),
);
workforcePlanningRouter.get(
  "/erp/payroll-export",
  route((req, res) => {
    if (!canViewRates(req))
      throw new ErpError(
        403,
        "Payroll preparation is limited to project managers and accounting",
      );
    const start = date(req.query.start_date, "start_date", true),
      end = date(req.query.end_date, "end_date", true);
    dateRange(start, end);
    const entries = getWorkforcePlanning(req.tenant.id).time_entries.filter(
      (e) =>
        e.status === "approved" &&
        !e.voided_at &&
        (!start || String(e.date) >= start) &&
        (!end || String(e.date) <= end),
    );
    const columns = [
      "id",
      "employee_id",
      "employee_name",
      "date",
      "start_time",
      "end_time",
      "break_minutes",
      "hours",
      "jobsite_id",
      "jobsite_name",
      "cost_code",
      "hourly_rate",
      "base_cost",
      "burden_pct",
      "burden_cost",
      "approved_by",
    ];
    const csvValue = (value: unknown) => {
      const raw = String(value ?? "");
      const safe = /^[=+@-]/.test(raw) ? `'${raw}` : raw;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    res
      .type("text/csv")
      .setHeader(
        "Content-Disposition",
        'attachment; filename="payroll-preparation.csv"',
      );
    res.send(
      [
        columns.join(","),
        ...entries.map((e) => columns.map((c) => csvValue(e[c])).join(",")),
      ].join("\r\n"),
    );
  }),
);
