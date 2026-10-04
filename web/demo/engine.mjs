import initSqlJs from 'sql.js';
import { setDatabase, getDb, get, all } from './database.mjs';
import { files } from './files.mjs';
import { dispatch } from './router.mjs';
import connectors from './connectors.json';
import { assetsRouter } from '../../server/src/api/routes/assets.ts';
import { jobsitesRouter } from '../../server/src/api/routes/jobsites.ts';
import { toolsRouter } from '../../server/src/api/routes/tools.ts';
import { camerasRouter } from '../../server/src/api/routes/cameras.ts';
import { connectivityRouter } from '../../server/src/api/routes/connectivity.ts';
import { fleetRouter } from '../../server/src/api/routes/fleet.ts';
import { workforceRouter } from '../../server/src/api/routes/workforce.ts';
import { safetyRouter } from '../../server/src/api/routes/safety.ts';
import { aiRouter } from '../../server/src/api/routes/ai.ts';
import { reportsRouter } from '../../server/src/api/routes/reports.ts';
import { erpRouter } from '../../server/src/api/routes/erp.ts';
import { commercialRouter } from '../../server/src/api/routes/commercial.ts';
import { workforcePlanningRouter } from '../../server/src/api/routes/workforce-planning.ts';
import { equipmentOperationsRouter } from '../../server/src/api/routes/equipment-operations.ts';
import { procurementRouter } from '../../server/src/api/routes/procurement.ts';
import { documentsRouter } from '../../server/src/api/routes/documents.ts';
import { projectFinanceRouter } from '../../server/src/api/routes/project-finance.ts';
import { estimatingRouter } from '../../server/src/api/routes/estimating.ts';

const routers = [assetsRouter, jobsitesRouter, toolsRouter, camerasRouter, connectivityRouter,
  fleetRouter, workforceRouter, safetyRouter, aiRouter, reportsRouter, erpRouter,
  commercialRouter, workforcePlanningRouter, equipmentOperationsRouter, procurementRouter,
  documentsRouter, projectFinanceRouter, estimatingRouter];
const NAME = 'dirtworks-browser-demo-v1';
let ready, storage, SQL;
function initialize() {
  return ready ??= Promise.all([
    initSqlJs({ locateFile: () => '/demo/sql-wasm.wasm' }),
    new Promise((resolve, reject) => {
      const request = indexedDB.open(NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('workspace');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Browser storage is unavailable. Enable site storage to save this demo.'));
    }),
  ]).then(([engine, db]) => { SQL = engine; storage = db; });
}
function readSnapshot() {
  return new Promise((resolve, reject) => {
    const request = storage.transaction('workspace').objectStore('workspace').get('current');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Unable to read saved demo data.'));
  });
}
function writeSnapshot(snapshot) {
  return new Promise((resolve, reject) => {
    const transaction = storage.transaction('workspace', 'readwrite');
    transaction.objectStore('workspace').put(snapshot, 'current');
    transaction.oncomplete = resolve;
    transaction.onabort = transaction.onerror = () => reject(new Error('Changes could not be saved. Browser storage may be full; export or free space and retry.'));
  });
}
function load(snapshot) {
  if (getDb()) getDb().close();
  setDatabase(new SQL.Database(snapshot.database));
  files.clear(); for (const [key, value] of snapshot.files) files.set(key, value);
}
function snapshot() { return { version: 1, database: getDb().export(), files: [...files] }; }
async function fresh() {
  const response = await fetch('/demo/seed.sqlite');
  if (!response.ok) throw new Error('Unable to load sample data. Reload the demo and try again.');
  return { version: 1, database: new Uint8Array(await response.arrayBuffer()), files: [] };
}
let queue = Promise.resolve();
function exclusive(fn) {
  const operation = queue.then(async () => {
    await initialize();
    const work = async () => {
      const prior = await readSnapshot() ?? await fresh();
      load(prior);
      try { const result = await fn(); await writeSnapshot(snapshot()); return result; }
      catch (error) { load(prior); throw error; }
    };
    // Reload inside a cross-tab lock so tabs cannot overwrite each other's changes.
    if (!navigator.locks) throw new Error('This demo needs a current browser with Web Locks support to save safely.');
    return navigator.locks.request(NAME, work);
  });
  queue = operation.catch(() => undefined);
  return operation;
}
export function request(method, path, body) {
  return exclusive(async () => {
    if (path === '/auth/session') return Response.json({ mode: 'demo', user: null });
    if (path.startsWith('/auth/')) return Response.json({ error: 'Sign-in is simulated by open demo access. Accounts require the hosted backend.' }, { status: 400 });
    if (path === '/connectors') return Response.json(connectors);
    if (path === '/credentials' || path === '/ingestion/runs') return Response.json([]);
    if (path.startsWith('/credentials')) return Response.json({ error: 'Live provider connections require the hosted backend. This demo uses sample equipment.' }, { status: 400 });
    if (path === '/tenants') return Response.json(all('SELECT id,slug,name FROM tenants'));
    if (path.startsWith('/erp/audit')) return Response.json([]);
    const tenant = get('SELECT id,slug,name FROM tenants WHERE slug=?', 'summit-dirtworks');
    const result = await dispatch(routers, method, path, body, tenant);
    if (!result.ok) {
      const error = await result.clone().json();
      const failure = new Error(error.error || 'Demo request failed');
      failure.response = result; throw failure;
    }
    return result;
  }).catch(error => error.response ?? Response.json({ error: error.message || 'Browser demo request failed' }, { status: 500 }));
}
export function exportDemo() {
  return exclusive(() => JSON.stringify({ format: 'dirtworks-browser-demo', version: 1,
    database: Array.from(getDb().export()), files: [...files].map(([key, bytes]) => [key, Array.from(bytes)]) }));
}
export function resetDemo() { return exclusive(async () => load(await fresh())); }
export function importDemo(text) {
  return exclusive(() => {
    const archive = JSON.parse(text);
    const validBytes = value => Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255);
    if (archive.format !== 'dirtworks-browser-demo' || archive.version !== 1 ||
      !validBytes(archive.database) || !Array.isArray(archive.files) ||
      !archive.files.every(file => Array.isArray(file) && file.length === 2 &&
        typeof file[0] === 'string' && /^\/demo\/documents\/[a-f0-9-]+$/.test(file[0]) && validBytes(file[1])))
      throw new Error('Choose a valid DirtWorks browser demo export.');
    load({ version: 1, database: Uint8Array.from(archive.database),
      files: archive.files.map(([key, bytes]) => [key, Uint8Array.from(bytes)]) });
    if (get('PRAGMA integrity_check').integrity_check !== 'ok' ||
      !get('SELECT id FROM tenants WHERE slug=?', 'summit-dirtworks'))
      throw new Error('The demo export database failed validation.');
  });
}
