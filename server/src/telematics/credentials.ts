/**
 * Multi-tenant OEM credential vault.
 *
 * Credentials are stored per tenant per provider, encrypted at rest with
 * AES-256-GCM. The plaintext JSON never leaves this module except into a
 * ConnectorContext at sync time. In the SaaS deployment the data key comes
 * from KMS; the demo uses a fixed dev key (see config.credentialsKeyHex).
 */

import crypto from 'node:crypto';
import { all, get, nowIso, run } from '../db/database.js';
import { config } from '../config.js';
import type { ConnectorCredentials } from './connector.js';

const ALG = 'aes-256-gcm';

function key(): Buffer {
  const k = Buffer.from(config.credentialsKeyHex, 'hex');
  if (k.length !== 32) throw new Error('CREDENTIALS_KEY must be 32 bytes of hex');
  return k;
}

export function encryptCredentials(payload: ConnectorCredentials): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, data]).toString('base64');
}

export function decryptCredentials(ciphertext: string): ConnectorCredentials {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALG, key(), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(plain) as ConnectorCredentials;
}

export interface StoredCredential {
  id: number;
  tenant_id: number;
  provider: string;
  label: string;
  auth_type: string;
  enabled: number;
  last_sync_at: string | null;
  last_status: string | null;
  created_at: string;
}

export function createCredential(opts: {
  tenantId: number;
  provider: string;
  label: string;
  authType: string;
  credentials: ConnectorCredentials;
  enabled?: boolean;
}): number {
  const res = run(
    `INSERT INTO provider_credentials (tenant_id, provider, label, auth_type, ciphertext, enabled)
     VALUES (?, ?, ?, ?, ?, ?)`,
    opts.tenantId,
    opts.provider,
    opts.label,
    opts.authType,
    encryptCredentials(opts.credentials),
    opts.enabled === false ? 0 : 1,
  );
  return Number(res.lastInsertRowid);
}

/** List credentials WITHOUT secrets — safe for the API. */
export function listCredentials(tenantId: number): StoredCredential[] {
  return all<StoredCredential>(
    `SELECT id, tenant_id, provider, label, auth_type, enabled, last_sync_at, last_status, created_at
     FROM provider_credentials WHERE tenant_id = ? ORDER BY provider, label`,
    tenantId,
  );
}

export function getCredentialRow(id: number): (StoredCredential & { ciphertext: string }) | undefined {
  return get(`SELECT * FROM provider_credentials WHERE id = ?`, id) as
    | (StoredCredential & { ciphertext: string })
    | undefined;
}

export function getDecryptedCredentials(id: number): ConnectorCredentials {
  const row = getCredentialRow(id);
  if (!row) throw new Error(`credential ${id} not found`);
  return decryptCredentials(row.ciphertext);
}

export function setCredentialEnabled(id: number, enabled: boolean): void {
  run(`UPDATE provider_credentials SET enabled = ? WHERE id = ?`, enabled ? 1 : 0, id);
}

export function markSync(id: number, status: string): void {
  run(`UPDATE provider_credentials SET last_sync_at = ?, last_status = ? WHERE id = ?`, nowIso(), status, id);
}

export function listEnabledCredentials(): (StoredCredential & { ciphertext: string })[] {
  return all(`SELECT * FROM provider_credentials WHERE enabled = 1`) as (StoredCredential & {
    ciphertext: string;
  })[];
}
