import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 4000),
  /** SQLite file location (demo). Swap the db layer for Postgres in SaaS. */
  dbPath: process.env.DB_PATH ?? path.resolve(here, '../data/dirtworks.db'),
  /**
   * 32-byte key (hex) for AES-256-GCM credential encryption. The demo falls
   * back to a fixed dev key; production MUST set CREDENTIALS_KEY (KMS-backed).
   */
  credentialsKeyHex:
    process.env.CREDENTIALS_KEY ??
    'a4f8c2d91e6b3057a4f8c2d91e6b3057a4f8c2d91e6b3057a4f8c2d91e6b3057',
  /** How often the ingestion service polls OEM feeds (seconds). */
  ingestIntervalSec: Number(process.env.INGEST_INTERVAL_SEC ?? 45),
  /**
   * Simulated clock speed for the demo fleet (1 = real time). At 12, a full
   * work day plays out in two real hours, so machines visibly move, work,
   * park and fault during a demo session.
   */
  demoTimeScale: Number(process.env.DEMO_TIME_SCALE ?? 12),
  /** Directory of the built web app served statically in production. */
  webDist: process.env.WEB_DIST ?? path.resolve(here, '../../web/dist'),
  defaultTenantSlug: 'summit-dirtworks',
};
