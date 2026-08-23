/**
 * Right-sidebar inspector for the selected jobsite: identity + status,
 * summary counts as stat tiles, production plan progress bars, and a
 * one-tap daily report generator.
 */

import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Jobsite } from '../api/types';
import { useApp } from '../state/store';
import { Icon } from '../ui/icons';

interface JobsiteSummary {
  machines: number;
  trucks: number;
  small_tools: number;
  cameras: number;
  active_faults: number;
  tools_out: number;
  timecards_today: number;
}

interface JobsiteWithSummary extends Jobsite {
  summary: JobsiteSummary;
}

interface PlanRow {
  id: number;
  phase: string | null;
  activity: string;
  unit: string;
  planned_qty: number;
  planned_hours: number | null;
  actual_qty: number;
  actual_hours: number;
  pct_complete: number;
}

function fmt(v: number | null | undefined, digits = 0, suffix = ''): string {
  if (v == null || Number.isNaN(v)) return '—';
  return v.toLocaleString(undefined, { maximumFractionDigits: digits }) + suffix;
}

function statusPillClass(status: string): string {
  switch (status) {
    case 'active':
      return 'pill pill-green';
    case 'planned':
      return 'pill pill-blue';
    case 'paused':
    case 'on_hold':
      return 'pill pill-amber';
    default:
      return 'pill';
  }
}

export default function JobsiteDetail() {
  const id = useApp((s) => s.selectedJobsiteId);
  const dataVersion = useApp((s) => s.dataVersion);

  const [site, setSite] = useState<JobsiteWithSummary | null>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reportMsg, setReportMsg] = useState<string | null>(null);

  useEffect(() => {
    if (id == null) return;
    let cancelled = false;
    setError(null);
    Promise.all([
      api.get<JobsiteWithSummary>(`/jobsites/${id}`),
      api.get<PlanRow[]>(`/jobsites/${id}/plans`),
    ])
      .then(([j, p]) => {
        if (!cancelled) {
          setSite(j);
          setPlans(p);
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [id, dataVersion]);

  if (id == null) return null;

  const generateReport = async () => {
    setBusy(true);
    setReportMsg(null);
    try {
      await api.post('/reports/generate', { kind: 'daily', jobsite_id: id });
      await useApp.getState().refresh();
      useApp.getState().bumpVersion();
      setReportMsg('Report created — see Reports.');
      window.setTimeout(() => setReportMsg(null), 4000);
    } catch (err) {
      setReportMsg(`Failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="asset-detail">
        <div className="detail-title">
          <h2>Jobsite</h2>
          <button className="ghost-btn" onClick={() => useApp.getState().selectJobsite(null)}><Icon name="x" size={15} /></button>
        </div>
        <p className="muted">Error: {error}</p>
      </div>
    );
  }

  if (site == null || site.id !== id) {
    return <div className="detail-empty">Loading jobsite…</div>;
  }

  const s = site.summary;
  const tiles: Array<{ label: string; value: string; alert?: boolean }> = [
    { label: 'Machines', value: fmt(s.machines) },
    { label: 'Trucks', value: fmt(s.trucks) },
    { label: 'Small tools', value: fmt(s.small_tools) },
    { label: 'Cameras', value: fmt(s.cameras) },
    { label: 'Active faults', value: fmt(s.active_faults), alert: s.active_faults > 0 },
    { label: 'Tools out', value: fmt(s.tools_out) },
    { label: 'Timecards today', value: fmt(s.timecards_today) },
  ];

  return (
    <div className="asset-detail">
      <div className="detail-title">
        <h2>{site.name}</h2>
        <button className="ghost-btn" title="Close" onClick={() => useApp.getState().selectJobsite(null)}>
          ✕
        </button>
      </div>
      <div className="detail-sub">
        {site.code} · <span className={statusPillClass(site.status)}>{site.status}</span>
      </div>
      <div className="detail-meta">
        <span>Super: {site.superintendent ?? '—'}</span>
        <span>
          Dates: {site.start_date ?? '—'} → {site.end_date ?? 'open'}
        </span>
        {site.address && <span>{site.address}</span>}
      </div>

      <div className="stat-grid">
        {tiles.map((t) => (
          <div className="stat" key={t.label}>
            <label>{t.label}</label>
            <b style={t.alert ? { color: 'var(--red)' } : undefined}>{t.value}</b>
          </div>
        ))}
      </div>

      <div className="detail-section">
        <h3>Production plans</h3>
        {plans.length === 0 && <p className="muted">No production plans for this jobsite.</p>}
        {plans.map((p) => {
          const pct = Math.max(0, Math.min(100, p.pct_complete));
          const color = pct >= 90 ? 'var(--green)' : pct >= 50 ? 'var(--blue)' : 'var(--accent)';
          return (
            <div key={p.id} className="gauge">
              <div className="gauge-head">
                <span>
                  {p.activity}
                  {p.phase ? <span className="muted"> · {p.phase}</span> : null}
                </span>
                <b style={{ color }}>{pct.toFixed(0)}%</b>
              </div>
              <div className="gauge-track">
                <div className="gauge-fill" style={{ width: `${pct}%`, background: color }} />
              </div>
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                {fmt(p.actual_qty, 1)} of {fmt(p.planned_qty, 1)} {p.unit} · {fmt(p.actual_hours, 1)} hrs
              </div>
            </div>
          );
        })}
      </div>

      {site.notes && (
        <div className="detail-section">
          <h3>Notes</h3>
          <p className="muted">{site.notes}</p>
        </div>
      )}

      <div className="detail-section">
        <button className="btn primary wide" disabled={busy} onClick={generateReport}>
          {busy ? 'Generating…' : <><Icon name="file" size={14} /> Generate daily report</>}
        </button>
        {reportMsg && (
          <p className="muted" style={{ marginTop: 8 }}>
            {reportMsg}
          </p>
        )}
      </div>
    </div>
  );
}
