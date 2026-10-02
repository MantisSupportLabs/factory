import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { get, getDb, nowIso, run, transaction } from '../db/database.js';

export const ACCESS_ROLES = ['owner', 'admin', 'pm', 'foreman', 'dispatcher', 'mechanic', 'accountant'] as const;
export type AccessRole = typeof ACCESS_ROLES[number];
export interface AccessUser { id: number; tenant_id: number; name: string; email: string; role: AccessRole; }
export interface UserRow extends AccessUser { password_hash: string; active: number; created_at: string; }
export interface AccessSession { token_hash: string; csrf_token: string; expires_at: string; user_id: number; }

declare module 'express-serve-static-core' {
  interface Request { authUser?: AccessUser; authTenantId?: number; authSession?: AccessSession; }
}

const SESSION_COOKIE = 'dirtworks_session';
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PUBLIC_PATHS = new Set(['/health', '/auth/session', '/auth/login', '/auth/setup']);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function initializeAccess(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      role TEXT NOT NULL CHECK(role IN ('owner','admin','pm','foreman','dispatcher','mechanic','accountant')),
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_auth_users_tenant ON auth_users(tenant_id);
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES auth_users(id),
      csrf_token TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_auth_sessions_user ON auth_sessions(user_id);
    CREATE TABLE IF NOT EXISTS auth_throttle (
      key TEXT PRIMARY KEY,
      failures INTEGER NOT NULL,
      window_started INTEGER NOT NULL,
      blocked_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS erp_audit (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      actor_id INTEGER,
      actor_name TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      record_id TEXT,
      status INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_erp_audit_tenant ON erp_audit(tenant_id,id);
    CREATE TRIGGER IF NOT EXISTS erp_audit_no_update BEFORE UPDATE ON erp_audit
      BEGIN SELECT RAISE(ABORT, 'Audit records are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS erp_audit_no_delete BEFORE DELETE ON erp_audit
      BEGIN SELECT RAISE(ABORT, 'Audit records are append-only'); END;
  `);
}

export function isSecureMode(): boolean {
  return process.env.NODE_ENV === 'production' || Boolean(get('SELECT id FROM auth_users LIMIT 1'));
}
export function publicUser(user: AccessUser): AccessUser {
  return { id: user.id, tenant_id: user.tenant_id, name: user.name, email: user.email, role: user.role };
}
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
export function hashPassword(password: string): string {
  const salt = randomBytes(32).toString('hex');
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$16384$8$1$${salt}$${key}`;
}
const dummyHash = hashPassword('DirtWorks inaccessible placeholder password');
export function verifyPassword(password: string, encoded?: string): boolean {
  const [algorithm, n, r, p, salt, expected] = (encoded ?? dummyHash).split('$');
  if (algorithm !== 'scrypt' || n !== '16384' || r !== '8' || p !== '1' || !/^[a-f0-9]{64}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(expected ?? '')) return false;
  const actual = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, Buffer.from(expected, 'hex')) && encoded !== undefined;
}
export function sessionCookieToken(req: Request): string | null {
  const raw = req.header('cookie') ?? '';
  if (raw.length > 8192) return null;
  const candidate = raw.split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  return candidate && /^[a-f0-9]{64}$/.test(candidate) ? candidate : null;
}
function secureCookie(req: Request): boolean { return req.secure || process.env.NODE_ENV === 'production'; }
export function revokeSession(req: Request): void {
  const token = sessionCookieToken(req);
  if (token) run('DELETE FROM auth_sessions WHERE token_hash=?', digest(token));
}
export function clearSessionCookie(req: Request, res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure: secureCookie(req), path: '/api' });
}
export function startSession(req: Request, res: Response, user: AccessUser): AccessSession {
  revokeSession(req);
  const token = randomBytes(32).toString('hex');
  const session: AccessSession = { token_hash: digest(token), csrf_token: randomBytes(32).toString('hex'), user_id: user.id, expires_at: new Date(Date.now() + SESSION_LIFETIME_MS).toISOString() };
  run('INSERT INTO auth_sessions(token_hash,user_id,csrf_token,created_at,expires_at) VALUES (?,?,?,?,?)', session.token_hash, user.id, session.csrf_token, nowIso(), session.expires_at);
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookie(req), path: '/api', maxAge: SESSION_LIFETIME_MS });
  req.authUser = publicUser(user); req.authTenantId = user.tenant_id; req.authSession = session;
  return session;
}
export function sameOrigin(req: Request): boolean {
  const origin = req.header('origin');
  if (!origin || origin === 'null') return false;
  try {
    const expected = process.env.DIRTWORKS_PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
    const actual = new URL(origin), target = new URL(expected);
    return actual.origin === origin && actual.origin === target.origin && ['http:', 'https:'].includes(actual.protocol);
  } catch { return false; }
}

export function accessMiddleware(req: Request, res: Response, next: NextFunction): void {
  const path = req.path;
  run('DELETE FROM auth_sessions WHERE expires_at<=?', nowIso());
  const token = sessionCookieToken(req);
  if (token) {
    const session = get<AccessSession>('SELECT token_hash,user_id,csrf_token,expires_at FROM auth_sessions WHERE token_hash=?', digest(token));
    if (session) {
      const user = get<UserRow>('SELECT * FROM auth_users WHERE id=? AND active=1', session.user_id);
      if (user) { req.authUser = publicUser(user); req.authTenantId = user.tenant_id; req.authSession = session; }
    }
  }
  const secure = isSecureMode();
  if (secure && !req.authUser && !PUBLIC_PATHS.has(path)) { res.status(401).json({ error: 'Sign in to access DirtWorks' }); return; }
  if (WRITE_METHODS.has(req.method) && (secure || path === '/auth/setup' || path === '/auth/login')) {
    if (!sameOrigin(req)) { res.status(403).json({ error: 'This request must originate from this DirtWorks app' }); return; }
    if (req.authSession && !['/auth/login', '/auth/setup'].includes(path)) {
      const supplied = req.header('x-csrf-token');
      if (!supplied || supplied.length > 256 || !safeEqual(supplied, req.authSession.csrf_token)) { res.status(403).json({ error: 'Security token expired. Refresh the page and try again' }); return; }
    }
  }
  next();
}

interface ThrottleRow { failures: number; window_started: number; blocked_until: number; }
function throttleKeys(req: Request, email: string): string[] {
  // Addresses and account names are hashed before storing; never persist passwords.
  return [`ip:${digest(req.ip ?? req.socket.remoteAddress ?? 'unknown')}`, `account:${digest(email)}`];
}
export function throttleWait(req: Request, email: string): number {
  const now = Date.now();
  return Math.max(0, ...throttleKeys(req, email).map(key => {
    const bucket = get<ThrottleRow>('SELECT * FROM auth_throttle WHERE key=?', key);
    return bucket ? Math.ceil((bucket.blocked_until - now) / 1000) : 0;
  }));
}
export function recordLoginFailure(req: Request, email: string): void {
  transaction(() => {
    const now = Date.now();
    for (const key of throttleKeys(req, email)) {
      const current = get<ThrottleRow>('SELECT * FROM auth_throttle WHERE key=?', key);
      const withinWindow = current && now - current.window_started < LOGIN_WINDOW_MS;
      const failures = withinWindow ? current.failures + 1 : 1;
      const started = withinWindow ? current.window_started : now;
      const blocked = failures >= MAX_FAILURES ? now + LOGIN_WINDOW_MS : 0;
      run(`INSERT INTO auth_throttle(key,failures,window_started,blocked_until) VALUES (?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,window_started=excluded.window_started,blocked_until=excluded.blocked_until`, key, failures, started, blocked);
    }
    run('DELETE FROM auth_throttle WHERE window_started<? AND blocked_until<?', now - 86400000, now);
  });
}
export function recordLoginSuccess(email: string): void { run('DELETE FROM auth_throttle WHERE key=?', `account:${digest(email)}`); }

const matches = (path: string, patterns: RegExp[]) => patterns.some(pattern => pattern.test(path));
export function canAccess(role: AccessRole, method: string, path: string, body: Record<string, unknown> = {}): boolean {
  if (role === 'owner' || role === 'admin') return true;
  if (path === '/auth/session' || path === '/auth/logout' || path === '/health') return true;
  if (matches(path, [/^\/auth\//, /^\/erp\/(audit|backups?|data-export)(\/|$)/, /^\/(credentials|connectors|ingestion)(\/|$)/, /^\/ai\/settings(\/|$)/])) return false;
  if (method === 'GET' || method === 'HEAD') {
    if (/^\/erp\/(estimating|estimates)(\/|$)/.test(path)) return role === 'pm' || role === 'accountant';
    if (matches(path, [/^\/erp\/(rates|costing|payroll|payroll-export|billing|invoices|financials|integrations)(\/|$)/])) return role === 'pm' || role === 'accountant';
    return matches(path, [/^\/erp\/(overview|commercial|procurement|workforce-planning|certifications|project-finance|equipment-operations|projects|people|crews|assignments|work-items|daily-reports|cost-entries|weekly-updates|purchase-orders|controls|labor|time|equipment|dispatch|documents|safety|operations|execution|financial)(\/|$)/,
      /^\/(employees|timecards|assets|faults|jobsites|tools|safety|reports|fleet|connectivity|cameras)(\/|$)/, /^\/ai\/(insights|projections)$/]);
  }
  if (!WRITE_METHODS.has(method)) return false;
  if (/^\/erp\/estimates(?:\/\d+)?$/.test(path)) return ['pm','accountant'].includes(role) && ['POST','PATCH'].includes(method);
  if (/^\/erp\/estimates\/\d+\/approve$/.test(path)) return role === 'accountant' && method === 'POST';
  if (/^\/erp\/estimates\/\d+\/revise$/.test(path)) return ['pm','accountant'].includes(role) && method === 'POST';
  if (/^\/erp\/estimates\/\d+\/handover$/.test(path)) return role === 'pm' && method === 'POST';
  // Legacy timecards can approve via PATCH status, so check the payload as well as action paths.
  if (matches(path, [/^\/timecards(?:\/\d+)?$/]) && ['POST','PATCH'].includes(method)) {
    if (role === 'foreman' && method === 'PATCH') {
      const cardId = Number(path.split('/').at(-1));
      if (get<{ status: string }>('SELECT status FROM timecards WHERE id=?', cardId)?.status === 'approved') return false;
    }
    if (body.status === 'approved') return role === 'pm' || role === 'accountant';
    return role === 'foreman' || role === 'pm' || role === 'accountant';
  }
  if (path.match(/^\/timecards\/\d+\/approve$/)) return method === 'POST' && ['pm','accountant'].includes(role);
  if (matches(path, [/^\/safety\/(jsas|incidents)(\/\d+)?$/, /^\/erp\/safety(\/\d+)?(?:\/(close|submit))?$/])) return ['pm','foreman'].includes(role) && ['POST','PATCH'].includes(method);
  if (matches(path, [/^\/erp\/daily-reports(?:\/\d+)?$/])) return ['pm','foreman'].includes(role) && ['POST','PATCH'].includes(method) && body.status !== 'approved';
  if (path.match(/^\/erp\/daily-reports\/\d+\/submit$/)) return ['pm','foreman'].includes(role) && method === 'POST';
  if (path.match(/^\/erp\/daily-reports\/\d+\/approve$/)) return role === 'pm' && method === 'POST';
  if (matches(path, [/^\/erp\/(projects|work-items|weekly-updates|controls)(\/\d+)?$/, /^\/jobsites(\/\d+)?$/])) return role === 'pm' && ['POST','PATCH'].includes(method);
  if (matches(path, [/^\/erp\/purchase-orders(?:\/\d+)?$/])) return ['pm','accountant'].includes(role) && ['POST','PATCH'].includes(method);
  if (path.match(/^\/erp\/cost-entries$/)) return ['pm','accountant'].includes(role) && method === 'POST';
  if (matches(path, [/^\/erp\/(crews|assignments)(\/\d+)?$/, /^\/tools\/\d+\/(checkout|checkin)$/, /^\/fleet\/hauls$/])) return ['pm','dispatcher'].includes(role) && ['POST','PATCH','DELETE'].includes(method);
  // New feature action routes are listed explicitly; arbitrary future writes remain denied.
  if (/^\/erp\/documents$/.test(path)) return method === 'POST' && ['pm','foreman','dispatcher','mechanic','accountant'].includes(role);
  if (/^\/erp\/(equipment-reservations|asset-transfers)(?:\/\d+(?:\/(cancel|accept))?)?$/.test(path)) return ['dispatcher','pm'].includes(role) && ['POST','PATCH'].includes(method);
  if (/^\/erp\/(equipment-work-orders|equipment-service-rules|equipment-inspections)(?:\/\d+(?:\/(start|complete))?)?$/.test(path)) return ['mechanic','pm'].includes(role) && ['POST','PATCH'].includes(method);
  if (path === '/erp/material-issues') return ['foreman','pm','accountant'].includes(role) && method === 'POST';
  if (/^\/erp\/line-orders\/\d+\/receive$/.test(path)) return ['foreman','pm','accountant'].includes(role) && method === 'POST';
  if (/^\/erp\/(vendors|material-items|line-orders|material-issues)(?:\/\d+(?:\/(approve|receive))?)?$/.test(path)) return ['pm','accountant'].includes(role) && ['POST','PATCH'].includes(method);
  if (/^\/erp\/supplier-invoices(?:\/\d+\/pay)?$/.test(path)) return role === 'accountant' && method === 'POST';
  if (/^\/erp\/change-approvals$/.test(path)) return ['pm','accountant'].includes(role) && method === 'POST';
  if (/^\/erp\/certifications(?:\/\d+)?$/.test(path)) return role === 'pm' && ['POST','PATCH'].includes(method);
  if (/^\/erp\/time-entries(?:\/\d+(?:\/(submit|approve|void))?)?$/.test(path)) {
    if (/\/(approve|void)$/.test(path) || body.status === 'approved') return ['pm','accountant'].includes(role) && method === 'POST';
    return ['foreman','pm','accountant'].includes(role) && ['POST','PATCH'].includes(method);
  }
  if (/^\/erp\/daily-reports\/\d+\/(reject|reverse|correction)$/.test(path)) return role === 'pm' && method === 'POST';
  if (/^\/erp\/project-calendars\/\d+$/.test(path)) return role === 'pm' && method === 'PUT';
  if (/^\/erp\/work-dependencies(?:\/\d+)?$/.test(path)) return role === 'pm' && ['POST','DELETE'].includes(method);
  if (/^\/erp\/(project-baselines|cost-forecasts)(?:\/\d+\/approve)?$/.test(path)) {
    return method === 'POST' && (/\/approve$/.test(path) ? role === 'accountant' : ['pm','accountant'].includes(role));
  }
  if (/^\/erp\/(pay-items|payment-applications)(?:\/\d+\/(submit|approve|withdraw))?$/.test(path)) {
    return method === 'POST' && (/\/approve$/.test(path) ? role === 'accountant' : ['pm','accountant'].includes(role));
  }
  if (/^\/erp\/(customer-payments|retainage-releases|retainage-payments)$/.test(path)) return role === 'accountant' && method === 'POST';
  if (/^\/erp\/closeout-items(?:\/\d+)?$/.test(path)) return role === 'pm' && ['POST','PATCH'].includes(method);
  if (/^\/erp\/project-closeout\/\d+$/.test(path)) return role === 'pm' && method === 'POST';
  if (matches(path, [/^\/erp\/equipment\/(work-orders|services|inspections|maintenance)(\/\d+)?(?:\/(complete|close|start|cancel))?$/])) return ['mechanic','pm'].includes(role) && ['POST','PATCH'].includes(method);
  if (matches(path, [/^\/erp\/dispatch\/(reservations|transfers)(\/\d+)?(?:\/(complete|cancel|release|dispatch|arrive))?$/])) return ['dispatcher','pm'].includes(role) && ['POST','PATCH','DELETE'].includes(method);
  if (matches(path, [/^\/erp\/(rates|costing|billing|invoices|financials|payroll)(\/\d+)?(?:\/(approve|submit|void|pay|post|export|finalize|reverse))?$/])) return role === 'accountant' && ['POST','PATCH'].includes(method);
  if (matches(path, [/^\/erp\/(labor|time)\/(entries|sheets|timecards)(\/\d+)?(?:\/(submit|approve|reject|void|post))?$/])) {
    if (path.match(/\/(approve|reject|void|post)$/) || body.status === 'approved') return ['pm','accountant'].includes(role);
    return ['foreman','pm','accountant'].includes(role) && ['POST','PATCH'].includes(method);
  }
  if (matches(path, [/^\/reports\/generate$/, /^\/ai\/(analyze|insights\/\d+\/(accept|dismiss))$/])) return role === 'pm' && method === 'POST';
  return false;
}
export function authorizationMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isSecureMode() || PUBLIC_PATHS.has(req.path)) { next(); return; }
  if (!req.authUser || !canAccess(req.authUser.role, req.method, req.path, req.body && typeof req.body === 'object' ? req.body : {})) {
    res.status(403).json({ error: 'Your role does not permit this action' }); return;
  }
  // Attribute text actor fields to the signed-in account even if a legacy form supplies another name.
  if (WRITE_METHODS.has(req.method) && req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    for (const field of ['created_by', 'approved_by', 'submitted_by', 'completed_by', 'posted_by']) {
      if (field in req.body || (field === 'approved_by' && /^\/erp\/daily-reports\/\d+\/approve$/.test(req.path)) || (field === 'created_by' && req.path === '/erp/daily-reports')) req.body[field] = req.authUser.name;
    }
  }
  next();
}
export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!WRITE_METHODS.has(req.method)) { next(); return; }
  const operationPath = req.path.slice(0,500), operationMethod = req.method;
  let recordId: string | null = null;
  const json = res.json.bind(res);
  res.json = ((value: unknown) => {
    if (value && typeof value === 'object' && 'id' in value) {
      const candidate = (value as {id?: unknown}).id;
      if (typeof candidate === 'number' || (typeof candidate === 'string' && candidate.length <= 100)) recordId = String(candidate);
    }
    return json(value);
  }) as typeof res.json;
  res.once('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    const tenantId = req.authTenantId ?? req.tenant?.id;
    if (!tenantId) return;
    const routeId = operationPath.split('/').filter(segment => /^\d+$/.test(segment)).at(-1);
    try {
      run('INSERT INTO erp_audit(tenant_id,actor_id,actor_name,method,path,record_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)',
        tenantId, req.authUser?.id ?? null, req.authUser?.name ?? 'Demo user', operationMethod, operationPath, recordId ?? routeId ?? null, res.statusCode, nowIso());
    } catch (error) { console.error('[audit] Failed to record operation', error); }
  });
  next();
}
