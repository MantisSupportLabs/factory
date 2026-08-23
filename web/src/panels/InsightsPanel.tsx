/**
 * AI Insights panel (wide drawer): the field's master AI automation switches,
 * an on-demand analysis run, the suggested-insight review queue, and live
 * schedule projections per production plan.
 */

import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { AiInsight, AiSetting } from '../api/types';
import { useApp } from '../state/store';
import { Icon } from '../ui/icons';

interface AnalyzeStats {
  insightsCreated: number;
  productionEntries: number;
  timecardsSuggested: number;
}

interface ProjectionRow {
  plan_id: number;
  jobsite_id: number;
  jobsite_name: string;
  phase: string;
  activity: string;
  unit: string;
  planned_qty: number;
  planned_hours: number;
  actual_qty: number;
  actual_hours: number;
  pct_complete: number;
  rate_qty_per_day: number;
  projected_finish: string | null;
  planned_end: string | null;
  days_variance: number | null;
  at_risk: boolean;
}

const FEATURES: Array<{ feature: string; name: string; blurb: string }> = [
  {
    feature: 'production_auto',
    name: 'Production auto-logging',
    blurb: "Logs today's plan quantities from machine engine hours — field corrections always win.",
  },
  {
    feature: 'timecards_auto',
    name: 'Auto timecard drafts',
    blurb: 'Drafts operator and driver timecards from machine run time. Drafts only — never auto-approved.',
  },
  {
    feature: 'projections_auto',
    name: 'Schedule projections',
    blurb: 'Projects each plan’s finish date and raises a warning when it slips past the planned end.',
  },
  {
    feature: 'fault_triage_auto',
    name: 'Fault triage',
    blurb: 'Turns critical and high machine faults into maintenance suggestions.',
  },
  {
    feature: 'idle_alerts_auto',
    name: 'Idle alerts',
    blurb: 'Flags machines running at low utilization so iron gets moved or shut down.',
  },
];

function ago(ts: string | null | undefined): string {
  if (!ts) return 'never';
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function sevPillClass(sev: AiInsight['severity']): string {
  if (sev === 'critical') return 'pill pill-red';
  if (sev === 'warning') return 'pill pill-amber';
  return 'pill pill-blue';
}

function VariancePill({ days }: { days: number | null }) {
  if (days == null) return <span className="pill">—</span>;
  if (days > 0) return <span className="pill pill-red">{days}d behind</span>;
  if (days < 0) return <span className="pill pill-green">{-days}d ahead</span>;
  return <span className="pill pill-green">on time</span>;
}

export default function InsightsPanel() {
  const dataVersion = useApp((s) => s.dataVersion);

  const [settings, setSettings] = useState<AiSetting[] | null>(null);
  const [insights, setInsights] = useState<AiInsight[] | null>(null);
  const [projections, setProjections] = useState<ProjectionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [analyzeStats, setAnalyzeStats] = useState<AnalyzeStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<AiSetting[]>('/ai/settings'),
      api.get<AiInsight[]>('/ai/insights?status=suggested'),
      api.get<ProjectionRow[]>('/ai/projections'),
    ])
      .then(([s, i, p]) => {
        if (cancelled) return;
        setSettings(s);
        setInsights(i);
        setProjections(p);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  const toggleFeature = async (feature: string, enabled: boolean) => {
    setBusy(true);
    // Optimistic flip so the switch doesn't lag a gloved tap.
    setSettings((prev) =>
      prev ? prev.map((s) => (s.feature === feature ? { ...s, enabled: enabled ? 1 : 0 } : s)) : prev,
    );
    try {
      await api.put(`/ai/settings/${feature}`, { enabled });
      useApp.getState().bumpVersion();
      await useApp.getState().refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runAnalyze = async () => {
    setBusy(true);
    setAnalyzeStats(null);
    try {
      const stats = await api.post<AnalyzeStats>('/ai/analyze');
      setAnalyzeStats(stats);
      useApp.getState().bumpVersion();
      await useApp.getState().refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const insightAction = async (id: number, action: 'accept' | 'dismiss') => {
    setBusy(true);
    try {
      await api.post(`/ai/insights/${id}/${action}`);
      useApp.getState().bumpVersion();
      await useApp.getState().refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const loading = settings === null && error === null;

  return (
    <div>
      {error && <p className="muted">Error: {error}</p>}
      {loading && <p className="muted">Loading AI settings…</p>}

      {settings && (
        <div className="card">
          <h3>Automation</h3>
          <p className="muted" style={{ margin: '0 0 6px', fontSize: 12 }}>
            These are the field&apos;s master &ldquo;AI auto off&rdquo; switches. Flip one off and the
            engine skips that feature everywhere — nothing gets logged, drafted, or flagged until it
            is switched back on.
          </p>
          {FEATURES.map((f) => {
            const row = settings.find((s) => s.feature === f.feature);
            const on = row ? row.enabled === 1 : true;
            return (
              <div
                key={f.feature}
                className="row-between"
                style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{f.name}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{f.blurb}</div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={busy}
                    onChange={() => void toggleFeature(f.feature, !on)}
                  />
                  <span className="slider" />
                </label>
              </div>
            );
          })}
          <div className="row-between" style={{ marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn primary" disabled={busy} onClick={() => void runAnalyze()}>
              <Icon name="spark" size={14} /> Run analysis now
            </button>
            {analyzeStats && (
              <span className="muted" style={{ fontSize: 12 }}>
                {analyzeStats.insightsCreated} insights · {analyzeStats.productionEntries} production
                entries · {analyzeStats.timecardsSuggested} timecard drafts
              </span>
            )}
          </div>
        </div>
      )}

      {insights && (
        <>
          <h3 style={{ margin: '18px 2px 6px', fontSize: 14 }}>
            Suggested insights{' '}
            {insights.length > 0 && <span className="pill pill-amber">{insights.length}</span>}
          </h3>
          {insights.length === 0 && (
            <p className="muted">Nothing suggested right now — run an analysis or check back later.</p>
          )}
          {insights.map((i) => (
            <div key={i.id} className="card">
              <div className="row-between">
                <span className={sevPillClass(i.severity)}>{i.severity}</span>
                <span className="muted" style={{ fontSize: 12 }}>{ago(i.created_at)}</span>
              </div>
              <div style={{ fontWeight: 600, margin: '6px 0 2px' }}>{i.title}</div>
              <p className="muted" style={{ margin: '0 0 10px', fontSize: 13 }}>{i.body}</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() => void insightAction(i.id, 'accept')}
                >
                  Accept
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void insightAction(i.id, 'dismiss')}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {projections && (
        <>
          <h3 style={{ margin: '18px 2px 6px', fontSize: 14 }}>Projections</h3>
          {projections.length === 0 && <p className="muted">No production plans yet.</p>}
          {projections.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Jobsite</th>
                    <th>Activity</th>
                    <th>% done</th>
                    <th>Rate/day</th>
                    <th>Proj. finish</th>
                    <th>Planned end</th>
                    <th>Variance</th>
                  </tr>
                </thead>
                <tbody>
                  {projections.map((p) => (
                    <tr
                      key={p.plan_id}
                      style={p.at_risk ? { background: 'rgba(229, 72, 77, 0.08)' } : undefined}
                    >
                      <td>
                        {p.at_risk && <span title="At risk"><Icon name="warning" size={12} /> </span>}
                        {p.jobsite_name}
                      </td>
                      <td>
                        {p.activity}
                        <div className="muted" style={{ fontSize: 11 }}>{p.phase}</div>
                      </td>
                      <td><b>{p.pct_complete}%</b></td>
                      <td>
                        {p.rate_qty_per_day} {p.unit}
                      </td>
                      <td>{fmtDate(p.projected_finish)}</td>
                      <td>{fmtDate(p.planned_end)}</td>
                      <td><VariancePill days={p.days_variance} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
