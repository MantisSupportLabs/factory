/**
 * DirtWorks server entry point.
 *
 * Boot order: database (schema) → connector registry → demo seed (idempotent)
 * → telemetry ingestion service → AI analysis scheduler → HTTP API + web app.
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getDb } from './db/database.js';
import { seedIfNeeded } from './db/seed/seed.js';
import { registerAllConnectors } from './telematics/connectors/index.js';
import { startIngestionService } from './telematics/ingestion.js';
import { startAiScheduler } from './services/ai-engine.js';
import { buildApiRouter } from './api/router.js';
import { tenantMiddleware } from './api/tenancy.js';

getDb();
registerAllConnectors();
seedIfNeeded();
startIngestionService();
startAiScheduler();

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use('/api', tenantMiddleware, buildApiRouter());

// Serve the built iPad web app when present (production single-process mode).
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(config.webDist, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res
      .type('text/plain')
      .send('DirtWorks API running. Build the web app (npm run build -w web) or use the Vite dev server.');
  });
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[api] unhandled error:', err);
  res.status(500).json({ error: err.message });
});

app.listen(config.port, () => {
  console.log(`DirtWorks server listening on http://localhost:${config.port}`);
});
