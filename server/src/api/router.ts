/**
 * API composition root. Feature route modules are mounted here; each module
 * owns its URL slice and never imports another module's internals.
 */

import { Router } from 'express';
import { all } from '../db/database.js';
import { assetsRouter } from './routes/assets.js';
import { connectorsRouter } from './routes/connectors.js';
import { jobsitesRouter } from './routes/jobsites.js';
import { toolsRouter } from './routes/tools.js';
import { camerasRouter } from './routes/cameras.js';
import { connectivityRouter } from './routes/connectivity.js';
import { fleetRouter } from './routes/fleet.js';
import { workforceRouter } from './routes/workforce.js';
import { safetyRouter } from './routes/safety.js';
import { aiRouter } from './routes/ai.js';
import { reportsRouter } from './routes/reports.js';
import { crewsRouter } from './routes/crews.js';

export function buildApiRouter(): Router {
  const api = Router();

  api.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'dirtworks-server', time: new Date().toISOString() });
  });

  api.get('/tenants', (_req, res) => {
    res.json(all(`SELECT id, slug, name FROM tenants ORDER BY id`));
  });

  api.use(assetsRouter);
  api.use(connectorsRouter);
  api.use(jobsitesRouter);
  api.use(toolsRouter);
  api.use(camerasRouter);
  api.use(connectivityRouter);
  api.use(fleetRouter);
  api.use(workforceRouter);
  api.use(safetyRouter);
  api.use(aiRouter);
  api.use(reportsRouter);
  api.use(crewsRouter);

  return api;
}
