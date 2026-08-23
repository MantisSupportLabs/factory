/**
 * AI automation endpoints — per-feature toggles, on-demand analysis, the
 * insight review queue (accept/dismiss), and schedule projections.
 *
 *   GET  /api/ai/settings                per-feature enabled flags
 *   PUT  /api/ai/settings/:feature       the field's "turn AI auto off" switch
 *   POST /api/ai/analyze                 run the engine now → stats
 *   GET  /api/ai/insights?status=        review queue (default 'suggested')
 *   POST /api/ai/insights/:id/accept
 *   POST /api/ai/insights/:id/dismiss
 *   GET  /api/ai/projections             plan projections (live)
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { all, get, nowIso, run } from '../../db/database.js';
import { computeProjections, runAiAnalysis } from '../../services/ai-engine.js';

export const aiRouter = Router();

const AI_FEATURES = [
  'production_auto',
  'timecards_auto',
  'projections_auto',
  'fault_triage_auto',
  'idle_alerts_auto',
] as const;

const INSIGHT_COLS = `id, jobsite_id, asset_id, kind, severity, title, body, data, status, created_at`;

aiRouter.get('/ai/settings', (req, res) => {
  const t = req.tenant.id;
  // Missing rows mean "enabled" — materialize them so the panel can toggle.
  for (const feature of AI_FEATURES) {
    run(`INSERT OR IGNORE INTO ai_settings (tenant_id, feature, enabled) VALUES (?, ?, 1)`, t, feature);
  }
  const stored = all<{ feature: string; enabled: number }>(
    `SELECT feature, enabled FROM ai_settings WHERE tenant_id = ?`, t,
  );
  const byFeature = new Map(stored.map((r) => [r.feature, r.enabled]));
  res.json(AI_FEATURES.map((feature) => ({ feature, enabled: byFeature.get(feature) ?? 1 })));
});

aiRouter.put('/ai/settings/:feature', (req, res) => {
  const t = req.tenant.id;
  const feature = req.params.feature;
  if (!(AI_FEATURES as readonly string[]).includes(feature)) {
    res.status(400).json({ error: `unknown feature '${feature}'` });
    return;
  }
  const { enabled } = req.body as { enabled?: unknown };
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled (boolean) is required' });
    return;
  }
  run(
    `INSERT INTO ai_settings (tenant_id, feature, enabled, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(tenant_id, feature) DO UPDATE SET
       enabled = excluded.enabled, updated_at = excluded.updated_at`,
    t, feature, enabled ? 1 : 0, nowIso(),
  );
  res.json(get(`SELECT feature, enabled, updated_at FROM ai_settings WHERE tenant_id = ? AND feature = ?`, t, feature));
});

aiRouter.post('/ai/analyze', (req, res) => {
  res.json(runAiAnalysis(req.tenant.id));
});

aiRouter.get('/ai/insights', (req, res) => {
  const { status } = req.query as Record<string, string | undefined>;
  const rows = all(
    `SELECT ${INSIGHT_COLS} FROM ai_insights
     WHERE tenant_id = ? AND status = ?
     ORDER BY created_at DESC, id DESC LIMIT 100`,
    req.tenant.id, status ?? 'suggested',
  );
  res.json(rows);
});

function insightStatusRoute(status: 'accepted' | 'dismissed') {
  return (req: Request, res: Response): void => {
    const t = req.tenant.id;
    const id = Number(req.params.id);
    const existing = get<{ id: number }>(`SELECT id FROM ai_insights WHERE tenant_id = ? AND id = ?`, t, id);
    if (!existing) {
      res.status(404).json({ error: 'insight not found' });
      return;
    }
    run(`UPDATE ai_insights SET status = ? WHERE id = ?`, status, id);
    res.json(get(`SELECT ${INSIGHT_COLS} FROM ai_insights WHERE id = ?`, id));
  };
}

aiRouter.post('/ai/insights/:id/accept', insightStatusRoute('accepted'));
aiRouter.post('/ai/insights/:id/dismiss', insightStatusRoute('dismissed'));

aiRouter.get('/ai/projections', (req, res) => {
  res.json(computeProjections(req.tenant.id));
});
