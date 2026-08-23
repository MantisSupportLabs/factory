/**
 * Connector & credential management endpoints.
 *
 *   GET  /api/connectors                    registry: every supported OEM + capabilities
 *   GET  /api/credentials                   tenant's credentials (no secrets)
 *   POST /api/credentials                   add credentials {provider, label, auth_type, credentials{}}
 *   POST /api/credentials/:id/enabled       {enabled: bool}
 *   POST /api/credentials/:id/test          connection test
 *   POST /api/credentials/:id/sync          sync now
 *   GET  /api/ingestion/runs                recent ingestion audit rows
 */

import { Router } from 'express';
import { all } from '../../db/database.js';
import { hasConnector, listConnectors, getConnector } from '../../telematics/connector.js';
import {
  createCredential,
  getCredentialRow,
  getDecryptedCredentials,
  listCredentials,
  setCredentialEnabled,
} from '../../telematics/credentials.js';
import { runCredentialSync } from '../../telematics/ingestion.js';

export const connectorsRouter = Router();

connectorsRouter.get('/connectors', (_req, res) => {
  res.json(listConnectors());
});

connectorsRouter.get('/credentials', (req, res) => {
  res.json(listCredentials(req.tenant.id));
});

connectorsRouter.post('/credentials', (req, res) => {
  const b = req.body as {
    provider?: string; label?: string; auth_type?: string;
    credentials?: Record<string, string>; enabled?: boolean;
  };
  if (!b.provider || !b.label || !b.credentials) {
    res.status(400).json({ error: 'provider, label, credentials are required' });
    return;
  }
  if (!hasConnector(b.provider)) {
    res.status(400).json({ error: `unsupported provider '${b.provider}'` });
    return;
  }
  const id = createCredential({
    tenantId: req.tenant.id,
    provider: b.provider,
    label: b.label,
    authType: b.auth_type ?? getConnector(b.provider).info.authType,
    credentials: b.credentials,
    enabled: b.enabled,
  });
  res.status(201).json({ id });
});

connectorsRouter.post('/credentials/:id/enabled', (req, res) => {
  const row = getCredentialRow(Number(req.params.id));
  if (!row || row.tenant_id !== req.tenant.id) { res.status(404).json({ error: 'not found' }); return; }
  setCredentialEnabled(row.id, !!(req.body as { enabled?: boolean }).enabled);
  res.json({ ok: true });
});

connectorsRouter.post('/credentials/:id/test', async (req, res) => {
  const row = getCredentialRow(Number(req.params.id));
  if (!row || row.tenant_id !== req.tenant.id) { res.status(404).json({ error: 'not found' }); return; }
  const connector = getConnector(row.provider);
  const result = await connector.testConnection({
    tenantId: row.tenant_id,
    credentialId: row.id,
    credentials: getDecryptedCredentials(row.id),
    lastSyncAt: row.last_sync_at,
    log: () => {},
  });
  res.json(result);
});

connectorsRouter.post('/credentials/:id/sync', async (req, res) => {
  const row = getCredentialRow(Number(req.params.id));
  if (!row || row.tenant_id !== req.tenant.id) { res.status(404).json({ error: 'not found' }); return; }
  try {
    const stats = await runCredentialSync(row);
    res.json(stats);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

connectorsRouter.get('/ingestion/runs', (req, res) => {
  const rows = all(
    `SELECT id, credential_id, provider, started_at, finished_at, status,
       assets_seen, readings_inserted, readings_deduped, faults_seen, error
     FROM ingestion_runs WHERE tenant_id = ? ORDER BY started_at DESC LIMIT 100`,
    req.tenant.id,
  );
  res.json(rows);
});
