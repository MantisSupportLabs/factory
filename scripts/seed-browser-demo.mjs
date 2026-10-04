// Always seed a fresh, temporary database; never copy a developer's real data.
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const directory = mkdtempSync(path.join(tmpdir(), 'dirtworks-demo-'));
process.env.DB_PATH = path.join(directory, 'demo.db');
process.env.NODE_ENV = 'development';
const { getDb, all, run } = await import('../server/src/db/database.ts');
const { seedIfNeeded } = await import('../server/src/db/seed/seed.ts');
const { registerAllConnectors } = await import('../server/src/telematics/connectors/index.ts');
const { runCredentialSync } = await import('../server/src/telematics/ingestion.ts');
const { listEnabledCredentials } = await import('../server/src/telematics/credentials.ts');
getDb(); registerAllConnectors(); seedIfNeeded();
for (const credential of listEnabledCredentials()) await runCredentialSync(credential);
for (const [module, fn] of [
  ['seed', 'initializeErp'], ['commercial', 'initCommercial'],
  ['equipment-operations', 'initializeEquipmentOperations'],
  ['procurement', 'initializeProcurement'], ['documents', 'initializeDocuments'],
  ['project-finance', 'initializeProjectFinance'], ['estimating', 'initializeEstimatingSchema'],
]) (await import(`../server/src/erp/${module}.ts`))[fn]();
const { listConnectors } = await import('../server/src/telematics/connector.ts');
const connectors = listConnectors();
// Remove even mock encrypted credentials from the public demo artifact.
run("UPDATE provider_credentials SET ciphertext='',enabled=0");
getDb().exec('PRAGMA wal_checkpoint(TRUNCATE);');
getDb().close();
mkdirSync('web/public/demo', { recursive: true });
writeFileSync('web/public/demo/seed.sqlite', readFileSync(process.env.DB_PATH));
writeFileSync('web/demo/connectors.json', JSON.stringify(connectors));
rmSync(directory, { recursive: true, force: true });
process.exit(0); // The seed's operator-assignment timer is unnecessary here.
