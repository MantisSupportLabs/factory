import { Router, type NextFunction, type Request, type Response } from 'express';
import { all, get, nowIso, run, transaction } from '../../db/database.js';
import { config } from '../../config.js';
import { ACCESS_ROLES, clearSessionCookie, hashPassword, isSecureMode, publicUser, recordLoginFailure, recordLoginSuccess, revokeSession, safeEqual, startSession, throttleWait, verifyPassword, type AccessRole, type UserRow } from '../../erp/access.js';

export const accessRouter = Router();
class AccessError extends Error { constructor(public status: number, message: string) { super(message); } }
function handle(handler: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try { handler(req, res); }
    catch (error) {
      if (error instanceof AccessError) { res.status(error.status).json({ error: error.message }); return; }
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) { res.status(409).json({ error: 'An account already uses this email address' }); return; }
      next(error);
    }
  };
}
function data(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new AccessError(400, 'A JSON object is required');
  return req.body;
}
function string(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AccessError(400, `${label} is required and must contain at most ${max} characters`);
  return value.trim();
}
function email(value: unknown): string {
  const result = string(value, 'Email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) throw new AccessError(400, 'Enter a valid email address');
  return result;
}
function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) throw new AccessError(400, 'Password must contain 12 to 128 characters');
  return value;
}
function role(value: unknown): AccessRole {
  if (typeof value !== 'string' || !ACCESS_ROLES.includes(value as AccessRole)) throw new AccessError(400, 'Choose a valid access role');
  return value as AccessRole;
}
function administrator(req: Request): number {
  if (!req.authUser || !['owner', 'admin'].includes(req.authUser.role)) throw new AccessError(403, 'Owner or administrator access is required');
  return req.authUser.tenant_id;
}
function rateLimit(req: Request, res: Response, account: string): boolean {
  const wait = throttleWait(req, account);
  if (!wait) return false;
  res.setHeader('Retry-After', wait);
  res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes' });
  return true;
}
function activeUsersExist(): boolean { return Boolean(get('SELECT id FROM auth_users LIMIT 1')); }

accessRouter.get('/auth/session', handle((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ mode: isSecureMode() ? 'secure' : 'demo', user: req.authUser ?? null,
    ...(req.authSession ? { csrf_token: req.authSession.csrf_token } : {}),
    setup_required: !activeUsersExist(), setup_requires_token: Boolean(process.env.DIRTWORKS_SETUP_TOKEN) || ![undefined, 'development', 'test'].includes(process.env.NODE_ENV) });
}));
accessRouter.post('/auth/setup', handle((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (activeUsersExist()) throw new AccessError(409, 'Secure access is already enabled');
  const b = data(req), account = typeof b.email === 'string' ? b.email.toLowerCase().slice(0,254) : 'setup';
  if (rateLimit(req, res, account)) return;
  const configured = process.env.DIRTWORKS_SETUP_TOKEN;
  const development = [undefined, 'development', 'test'].includes(process.env.NODE_ENV);
  if ((configured && (typeof b.setup_token !== 'string' || b.setup_token.length > 1024 || !safeEqual(configured, b.setup_token))) || (!configured && !development)) {
    recordLoginFailure(req, account);
    throw new AccessError(403, 'Secure setup requires the server setup token');
  }
  const name = string(b.name, 'Name', 150), address = email(b.email), encoded = hashPassword(password(b.password));
  const user = transaction(() => {
    if (activeUsersExist()) throw new AccessError(409, 'Secure access is already enabled');
    const tenant = get<{ id: number }>('SELECT id FROM tenants WHERE slug=?', config.defaultTenantSlug);
    if (!tenant) throw new AccessError(409, 'Create the company tenant before enabling secure access');
    const result = run("INSERT INTO auth_users(tenant_id,name,email,role,password_hash,active,created_at) VALUES (?,?,?,'owner',?,1,?)", tenant.id, name, address, encoded, nowIso());
    return get<UserRow>('SELECT * FROM auth_users WHERE id=?', Number(result.lastInsertRowid))!;
  });
  const session = startSession(req, res, user);
  recordLoginSuccess(address);
  res.status(201).json({ mode: 'secure', user: publicUser(user), csrf_token: session.csrf_token });
}));
accessRouter.post('/auth/login', handle((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const b = data(req), address = email(b.email);
  if (rateLimit(req, res, address)) return;
  if (typeof b.password !== 'string' || b.password.length > 128) throw new AccessError(400, 'Enter your password');
  const user = get<UserRow>('SELECT * FROM auth_users WHERE email=? COLLATE NOCASE', address);
  const valid = verifyPassword(b.password, user?.password_hash);
  if (!valid || !user?.active) {
    recordLoginFailure(req, address);
    throw new AccessError(401, 'Email or password is incorrect');
  }
  recordLoginSuccess(address);
  const session = startSession(req, res, user);
  res.json({ mode: 'secure', user: publicUser(user), csrf_token: session.csrf_token });
}));
accessRouter.post('/auth/logout', handle((req, res) => {
  revokeSession(req); clearSessionCookie(req, res);
  res.status(204).end();
}));
accessRouter.get('/auth/users', handle((req, res) => {
  const tenant = administrator(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json(all('SELECT id,tenant_id,name,email,role,active,created_at FROM auth_users WHERE tenant_id=? ORDER BY name,id', tenant));
}));
accessRouter.post('/auth/users', handle((req, res) => {
  const tenant = administrator(req), b = data(req);
  const name = string(b.name, 'Name', 150), address = email(b.email), userRole = role(b.role), encoded = hashPassword(password(b.password));
  // Tenant membership comes from the authenticated administrator, never from the form or a header.
  const result = run('INSERT INTO auth_users(tenant_id,name,email,role,password_hash,active,created_at) VALUES (?,?,?,?,?,1,?)', tenant, name, address, userRole, encoded, nowIso());
  res.status(201).json(get('SELECT id,tenant_id,name,email,role,active,created_at FROM auth_users WHERE id=?', Number(result.lastInsertRowid)));
}));
accessRouter.patch('/auth/users/:id', handle((req, res) => {
  const tenant = administrator(req), b = data(req), userId = Number(req.params.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new AccessError(400, 'Invalid account ID');
  if (!['role', 'active', 'name', 'password'].some(key => key in b)) throw new AccessError(400, 'No account changes supplied');
  const encoded = b.password === undefined ? null : hashPassword(password(b.password));
  transaction(() => {
    const user = get<UserRow>('SELECT * FROM auth_users WHERE id=? AND tenant_id=?', userId, tenant);
    if (!user) throw new AccessError(404, 'Account not found');
    const nextRole = b.role === undefined ? user.role : role(b.role);
    if (b.active !== undefined && ![true,false,0,1].includes(b.active as number)) throw new AccessError(400, 'active must be a boolean');
    const nextActive = b.active === undefined ? user.active : b.active ? 1 : 0;
    if (!nextActive && userId === req.authUser!.id) throw new AccessError(409, 'You cannot disable your own account');
    if (user.active && user.role === 'owner' && (!nextActive || nextRole !== 'owner')) {
      const owners = get<{n:number}>("SELECT COUNT(*) n FROM auth_users WHERE tenant_id=? AND role='owner' AND active=1", tenant)!.n;
      if (owners <= 1) throw new AccessError(409, 'Keep at least one active owner account');
    }
    const name = b.name === undefined ? user.name : string(b.name, 'Name', 150);
    run('UPDATE auth_users SET name=?,role=?,active=?,password_hash=? WHERE id=? AND tenant_id=?', name, nextRole, nextActive, encoded ?? user.password_hash, userId, tenant);
    if (!nextActive || encoded || nextRole !== user.role) run('DELETE FROM auth_sessions WHERE user_id=?', userId);
  });
  res.json(get('SELECT id,tenant_id,name,email,role,active,created_at FROM auth_users WHERE id=? AND tenant_id=?', userId, tenant));
}));
accessRouter.get('/erp/audit', handle((req, res) => {
  const tenant = administrator(req);
  const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
  const before = req.query.before === undefined ? null : Number(req.query.before);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 250 || (before !== null && (!Number.isSafeInteger(before) || before <= 0))) throw new AccessError(400, 'Invalid audit pagination');
  res.setHeader('Cache-Control', 'no-store');
  res.json(before === null
    ? all('SELECT * FROM erp_audit WHERE tenant_id=? ORDER BY id DESC LIMIT ?', tenant, limit)
    : all('SELECT * FROM erp_audit WHERE tenant_id=? AND id<? ORDER BY id DESC LIMIT ?', tenant, before, limit));
}));
