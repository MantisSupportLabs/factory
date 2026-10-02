import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

const fixtureDir = mkdtempSync(path.join(tmpdir(), 'dirtworks-access-test-'));
process.env.DB_PATH = path.join(fixtureDir, 'access.db');
process.env.NODE_ENV = 'test';
const { all, get, getDb, run } = await import('../dist/db/database.js');
const { initializeAccess, accessMiddleware, authorizationMiddleware, auditMiddleware, canAccess, hashPassword, verifyPassword } = await import('../dist/erp/access.js');
const { accessRouter } = await import('../dist/api/routes/access.js');
const { tenantMiddleware } = await import('../dist/api/tenancy.js');

test('secure access, tenant membership, permissions, and append-only audit', async t => {
  getDb(); initializeAccess(); initializeAccess();
  const tenantId = Number(run("INSERT INTO tenants(slug,name) VALUES ('summit-dirtworks','Test civil company')").lastInsertRowid);
  const foreignTenant = Number(run("INSERT INTO tenants(slug,name) VALUES ('other-company','Other company')").lastInsertRowid);
  const app = express(); app.use(express.json());
  app.use('/api', accessMiddleware, tenantMiddleware, authorizationMiddleware, auditMiddleware, accessRouter);
  app.get('/api/health', (_req,res) => res.json({ok:true}));
  app.get('/api/erp/overview', (req,res) => res.json({tenant_id:req.tenant.id}));
  app.post('/api/erp/daily-reports', (req,res) => res.status(201).json({id:99,created_by:req.body.created_by}));
  app.post('/api/erp/daily-reports/:id/approve', (req,res) => res.json({id:Number(req.params.id),approved_by:req.body.approved_by}));
  app.post('/api/erp/time-entries/:id/approve', (_req,res) => res.json({id:7}));
  app.post('/api/erp/payment-applications/:id/approve', (_req,res) => res.json({id:8}));
  app.post('/api/erp/equipment-work-orders/:id/complete', (_req,res) => res.json({id:4}));
  app.post('/api/erp/asset-transfers/:id/accept', (_req,res) => res.json({id:5}));
  app.post('/api/future-sensitive-action', (_req,res) => res.json({id:6}));
  app.use((error,_req,res,_next) => res.status(500).json({error:error.message}));
  const server = app.listen(0); await new Promise(resolve => server.once('listening',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, url = `${origin}/api`;
  const request = async (endpoint, method='GET', body, {cookie,csrf,tenant,requestOrigin=origin,expected=200}={}) => {
    const res = await fetch(url+endpoint, {method,headers:{'content-type':'application/json',
      ...(requestOrigin ? {origin:requestOrigin}:{}), ...(cookie ? {cookie}:{}), ...(csrf ? {'x-csrf-token':csrf}:{}), ...(tenant ? {'x-tenant-id':String(tenant)}:{})},body:body === undefined ? undefined : JSON.stringify(body)});
    const result = res.status === 204 ? null : await res.json();
    if (expected !== null) assert.equal(res.status,expected,`${method} ${endpoint}: ${JSON.stringify(result)}`);
    return {body:result,cookie:res.headers.get('set-cookie')?.split(';')[0],rawCookie:res.headers.get('set-cookie'),res};
  };
  const ownerPassword='A long owner password 42';
  let owner, foreman, pm, accountant, mechanic, dispatcher, secondOwner;
  const login = async (email,password=ownerPassword) => {
    const response = await request('/auth/login','POST',{email,password});
    return {cookie:response.cookie,csrf:response.body.csrf_token,user:response.body.user};
  };
  try {
    await t.test('demo stays available until setup and production refuses unbounded setup',async () => {
      const session=await request('/auth/session'); assert.equal(session.body.mode,'demo'); assert.equal(session.body.setup_required,true);
      await request('/erp/overview');
      process.env.NODE_ENV='production';
      assert.equal((await request('/auth/session')).body.mode,'secure');
      await request('/erp/overview','GET',undefined,{expected:401});
      await request('/auth/setup','POST',{name:'Owner',email:'owner@example.test',password:ownerPassword},{expected:403});
      process.env.DIRTWORKS_SETUP_TOKEN='server-bootstrap-secret';
      await request('/auth/setup','POST',{name:'Owner',email:'owner@example.test',password:ownerPassword,setup_token:'incorrect'},{expected:403});
      process.env.NODE_ENV='test'; delete process.env.DIRTWORKS_SETUP_TOKEN;
      run('DELETE FROM auth_throttle');
    });
    await t.test('first owner creation hashes credentials and fixes tenant membership',async () => {
      await request('/auth/setup','POST',{name:'Owner',email:'owner@example.test',password:ownerPassword},{requestOrigin:'https://attacker.invalid',expected:403});
      await request('/auth/setup','POST',{name:'Owner',email:'owner@example.test',password:'short'},{expected:400});
      const raced=await Promise.all([request('/auth/setup','POST',{name:'Owner',email:'OWNER@example.test',password:ownerPassword,tenant_id:foreignTenant},{tenant:foreignTenant,expected:null}),request('/auth/setup','POST',{name:'Owner',email:'OWNER@example.test',password:ownerPassword,tenant_id:foreignTenant},{tenant:foreignTenant,expected:null})]);
      assert.deepEqual(raced.map(item=>item.res.status).sort(),[201,409]);
      const setup=raced.find(item=>item.res.status===201);
      owner={cookie:setup.cookie,csrf:setup.body.csrf_token,user:setup.body.user};
      assert.equal(owner.user.tenant_id,tenantId); assert.equal(owner.user.role,'owner');
      assert.match(setup.rawCookie,/HttpOnly/); assert.match(setup.rawCookie,/SameSite=Lax/); assert.match(setup.rawCookie,/Path=\/api/);
      assert.equal(setup.body.password_hash,undefined); assert.equal(setup.body.token,undefined);
      const stored=get('SELECT * FROM auth_users WHERE id=?',owner.user.id);
      assert.notEqual(stored.password_hash,ownerPassword); assert.equal(verifyPassword(ownerPassword,stored.password_hash),true);
      assert.equal(verifyPassword('bad',stored.password_hash),false);
      assert.notEqual(get('SELECT token_hash FROM auth_sessions WHERE user_id=?',owner.user.id).token_hash,setup.cookie.split('=')[1], 'opaque cookie must be stored only as a hash');
    });
    await t.test('setup cannot create a second owner and sessions enforce CSRF and tenant boundaries',async () => {
      await request('/auth/setup','POST',{name:'Intruder',email:'intruder@example.test',password:ownerPassword},{expected:409});
      await request('/erp/overview','GET',undefined,{expected:401});
      assert.equal((await request('/auth/session','GET',undefined,owner)).body.user.id,owner.user.id);
      await request('/erp/overview','GET',undefined,{...owner,tenant:foreignTenant,expected:403});
      await request('/erp/daily-reports','POST',{created_by:'Impersonator'},{cookie:owner.cookie,expected:403});
      await request('/erp/daily-reports','POST',{created_by:'Impersonator'},{...owner,csrf:'bad',expected:403});
      await request('/erp/daily-reports','POST',{created_by:'Impersonator'},{...owner,requestOrigin:'https://attacker.invalid',expected:403});
      const recorded=await request('/erp/daily-reports','POST',{created_by:'Impersonator'},{...owner,expected:201});
      assert.equal(recorded.body.created_by,'Owner');
    });
    await t.test('creates tenant-bound accounts without returning secrets',async () => {
      for (const userRole of ['foreman','pm','accountant','mechanic','dispatcher']) {
        const added=await request('/auth/users','POST',{name:userRole,email:`${userRole}@example.test`,role:userRole,password:ownerPassword,tenant_id:foreignTenant},{...owner,expected:201});
        assert.equal(added.body.tenant_id,tenantId); assert.equal(added.body.password_hash,undefined);
      }
      foreman=await login('foreman@example.test'); pm=await login('pm@example.test'); accountant=await login('accountant@example.test'); mechanic=await login('mechanic@example.test'); dispatcher=await login('dispatcher@example.test');
      const accounts=await request('/auth/users','GET',undefined,owner);
      assert.equal(accounts.body.length,6); assert.ok(accounts.body.every(user=>!('password_hash' in user)));
      await request('/auth/users','GET',undefined,{...foreman,expected:403});
      await request('/auth/users','POST',{name:'Unauthorized',email:'x@example.test',role:'owner',password:ownerPassword},{...foreman,expected:403});
    });
    await t.test('field, PM, financial, mechanic, and dispatcher permissions cannot bypass approvals',async () => {
      await request('/erp/daily-reports','POST',{created_by:'Other'},{...foreman,expected:201});
      await request('/erp/daily-reports/99/approve','POST',{}, {...foreman,expected:403});
      await request('/erp/time-entries/7/approve','POST',{}, {...foreman,expected:403});
      await request('/erp/payment-applications/8/approve','POST',{}, {...pm,expected:403});
      await request('/erp/payment-applications/8/approve','POST',{},accountant);
      assert.equal((await request('/erp/daily-reports/99/approve','POST',{approved_by:'Forgery'},pm)).body.approved_by,'pm');
      await request('/erp/equipment-work-orders/4/complete','POST',{},mechanic);
      await request('/erp/equipment-work-orders/4/complete','POST',{}, {...dispatcher,expected:403});
      await request('/erp/asset-transfers/5/accept','POST',{},dispatcher);
      await request('/future-sensitive-action','POST',{}, {...pm,expected:403});
      await request('/future-sensitive-action','POST',{},owner);
      assert.equal(canAccess('foreman','PATCH','/timecards/1',{status:'approved'}),false);
      assert.equal(canAccess('foreman','POST','/erp/supplier-invoices/1/pay'),false);
      assert.equal(canAccess('dispatcher','POST','/credentials'),false);
      assert.equal(canAccess('foreman','GET','/erp/payroll-export'),false);
      assert.equal(canAccess('pm','GET','/erp/payroll-export'),true);
      assert.equal(canAccess('accountant','POST','/erp/retainage-payments'),true);
      assert.equal(canAccess('pm','POST','/erp/retainage-payments'),false);
      assert.equal(canAccess('pm','POST','/erp/payment-applications/1/withdraw'),true);
    });
    await t.test('last-owner and self-disable safeguards survive competing updates',async () => {
      await request(`/auth/users/${owner.user.id}`,'PATCH',{role:'pm'},{...owner,expected:409});
      await request(`/auth/users/${owner.user.id}`,'PATCH',{active:false},{...owner,expected:409});
      const other=await request('/auth/users','POST',{name:'Second owner',email:'owner2@example.test',role:'owner',password:ownerPassword},{...owner,expected:201});
      secondOwner=await login('owner2@example.test');
      const attempts=await Promise.all([
        request(`/auth/users/${owner.user.id}`,'PATCH',{role:'pm'},{...owner,expected:null}),
        request(`/auth/users/${other.body.id}`,'PATCH',{role:'pm'},{...secondOwner,expected:null})
      ]); assert.deepEqual(attempts.map(item=>item.res.status).sort(),[200,409]);
      assert.equal(get("SELECT COUNT(*) n FROM auth_users WHERE role='owner' AND active=1").n,1);
      const surviving=get("SELECT email FROM auth_users WHERE role='owner' AND active=1");
      const demoted=surviving.email==='owner@example.test'?secondOwner:owner;
      await request('/erp/overview','GET',undefined,{...demoted,expected:401});
      owner=await login(surviving.email);
    });
    await t.test('role changes, disabling, password reset, logout, and expiry revoke sessions',async () => {
      await request(`/auth/users/${foreman.user.id}`,'PATCH',{active:false},owner);
      await request('/erp/overview','GET',undefined,{...foreman,expected:401});
      await request(`/auth/users/${foreman.user.id}`,'PATCH',{active:true},owner);
      foreman=await login('foreman@example.test');
      await request(`/auth/users/${foreman.user.id}`,'PATCH',{password:'A replacement password 43'},owner);
      await request('/erp/overview','GET',undefined,{...foreman,expected:401});
      foreman=await login('foreman@example.test','A replacement password 43');
      const logout=await request('/auth/logout','POST',{},{...foreman,expected:204}); assert.match(logout.rawCookie,/Expires=Thu, 01 Jan 1970/);
      await request('/erp/overview','GET',undefined,{...foreman,expected:401});
      foreman=await login('foreman@example.test','A replacement password 43');
      run("UPDATE auth_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id=?",foreman.user.id);
      await request('/erp/overview','GET',undefined,{...foreman,expected:401});
    });
    await t.test('login throttling persists across middleware reinitialization and cookie is secure in production',async () => {
      run('DELETE FROM auth_throttle');
      for(let i=0;i<5;i++) await request('/auth/login','POST',{email:'nobody@example.test',password:'Wrong password 123'},{expected:401});
      assert.ok(all('SELECT * FROM auth_throttle').length>=2);
      initializeAccess();
      const denied=await request('/auth/login','POST',{email:'another@example.test',password:ownerPassword},{expected:429});
      assert.ok(Number(denied.res.headers.get('retry-after'))>0);
      run('DELETE FROM auth_throttle'); process.env.NODE_ENV='production';
      const secure=await request('/auth/login','POST',{email:owner.user.email,password:ownerPassword}); assert.match(secure.rawCookie,/Secure/);
      process.env.NODE_ENV='test'; owner={cookie:secure.cookie,csrf:secure.body.csrf_token,user:secure.body.user};
    });
    await t.test('audit is tenant-scoped, contains authenticated actors, and cannot expose passwords or be changed',async () => {
      const rows=(await request('/erp/audit','GET',undefined,owner)).body;
      assert.ok(rows.length>10); assert.ok(rows.some(entry=>entry.path==='/erp/daily-reports' && entry.actor_name==='foreman' && entry.record_id==='99'));
      assert.ok(rows.every(entry=>entry.tenant_id===tenantId));
      assert.ok(!JSON.stringify(rows).includes(ownerPassword));
      assert.ok(!JSON.stringify(rows).includes(owner.csrf));
      assert.throws(()=>run("UPDATE erp_audit SET actor_name='Changed' WHERE id=?",rows[0].id),/append-only/);
      assert.throws(()=>run('DELETE FROM erp_audit WHERE id=?',rows[0].id),/append-only/);
      assert.equal(get('SELECT COUNT(*) n FROM erp_audit WHERE tenant_id=?',foreignTenant).n,0);
      await request('/erp/audit','GET',undefined,{...mechanic,expected:403});
    });
    await t.test('scrypt uses individual salts',()=> {
      const a=hashPassword(ownerPassword),b=hashPassword(ownerPassword); assert.notEqual(a,b); assert.equal(verifyPassword(ownerPassword,a),true);
    });
  } finally {
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    getDb().close(); rmSync(fixtureDir,{recursive:true,force:true});
  }
});
