/**
 * Truck Fleet panel (left sidebar): live truck list with today's haul count,
 * a 7-day haul summary table, and a collapsible manual haul-ticket form for
 * sites without scale integration.
 */

import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { AssetStateRow } from '../api/types';
import { useApp } from '../state/store';
import { Icon } from '../ui/icons';

type TruckRow = AssetStateRow & { today: { loads: number; tons: number | null } | null };

interface FleetSummary {
  daily: Array<{ date: string; loads: number; tons: number | null }>;
  materials: Array<{ material: string; loads: number; tons: number | null }>;
}

function fmt(v: number | null | undefined, digits = 0, suffix = ''): string {
  if (v == null || Number.isNaN(v)) return '—';
  return v.toLocaleString(undefined, { maximumFractionDigits: digits }) + suffix;
}

function dayLabel(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' });
}

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function FleetPanel() {
  const dataVersion = useApp((s) => s.dataVersion);
  const jobsites = useApp((s) => s.jobsites);
  const selectedId = useApp((s) => s.selectedAssetId);

  const [trucks, setTrucks] = useState<TruckRow[] | null>(null);
  const [summary, setSummary] = useState<FleetSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [truckId, setTruckId] = useState('');
  const [jobsiteId, setJobsiteId] = useState('');
  const [date, setDate] = useState(todayStr());
  const [material, setMaterial] = useState('');
  const [loads, setLoads] = useState('1');
  const [tons, setTons] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<TruckRow[]>('/fleet/trucks')
      .then((rows) => {
        if (!cancelled) {
          setTrucks(rows);
          setLoadError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError((err as Error).message);
      });
    api
      .get<FleetSummary>('/fleet/summary?days=7')
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  const submit = async () => {
    const loadsN = Number(loads);
    const tonsN = tons.trim() === '' ? undefined : Number(tons);
    if (truckId === '' || jobsiteId === '' || material.trim() === '' || !Number.isFinite(loadsN) || loadsN <= 0) {
      setFormError('Truck, jobsite, material and loads are required.');
      return;
    }
    if (tonsN !== undefined && !Number.isFinite(tonsN)) {
      setFormError('Tons must be a number.');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await api.post('/fleet/hauls', {
        asset_id: Number(truckId),
        jobsite_id: Number(jobsiteId),
        date,
        material: material.trim(),
        loads: loadsN,
        tons: tonsN,
      });
      setFormOpen(false);
      setMaterial('');
      setLoads('1');
      setTons('');
      useApp.getState().bumpVersion();
      await useApp.getState().refresh();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (trucks === null && loadError !== null) return <p className="muted pad">Error: {loadError}</p>;
  if (trucks === null) return <p className="muted pad">Loading trucks…</p>;

  return (
    <div>
      {trucks.length === 0 && <p className="muted pad">No trucks in the fleet yet.</p>}

      {trucks.map((t) => (
        <button
          key={t.id}
          className={`list-row${t.id === selectedId ? ' selected' : ''}`}
          onClick={() => useApp.getState().selectAsset(t.id)}
        >
          <span className="row-icon"><Icon name="truck" /></span>
          <div className="row-main">
            <div className="row-title">{t.name}</div>
            <div className="row-sub">
              {[t.category, t.operator].filter(Boolean).join(' · ') ||
                [t.make, t.model].filter(Boolean).join(' ') ||
                'truck'}
            </div>
          </div>
          <div className="row-end">
            <span className={`pill status-${t.engine_status ?? 'unknown'}`}>{t.engine_status ?? 'no signal'}</span>
            <span className="row-sub">
              {t.today && t.today.loads > 0
                ? `${t.today.loads} loads · ${fmt(t.today.tons, 1)} t today`
                : 'no hauls today'}
            </span>
          </div>
        </button>
      ))}

      <div className="card">
        <h3>7-day haul summary</h3>
        {summary === null && <p className="muted">Loading summary…</p>}
        {summary !== null && summary.daily.length === 0 && <p className="muted">No hauls in the last 7 days.</p>}
        {summary !== null && summary.daily.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Loads</th>
                <th>Tons</th>
              </tr>
            </thead>
            <tbody>
              {summary.daily.map((d) => (
                <tr key={d.date}>
                  <td>{dayLabel(d.date)}</td>
                  <td>{d.loads}</td>
                  <td>{fmt(d.tons, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <button className="btn wide" onClick={() => setFormOpen((o) => !o)}>
        {formOpen ? '− Cancel' : '+ Haul ticket'}
      </button>

      {formOpen && (
        <div className="card">
          <h3>Manual haul ticket</h3>
          <label className="field">Truck</label>
          <select value={truckId} onChange={(e) => setTruckId(e.target.value)}>
            <option value="">Select truck…</option>
            {trucks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <label className="field">Jobsite</label>
          <select value={jobsiteId} onChange={(e) => setJobsiteId(e.target.value)}>
            <option value="">Select jobsite…</option>
            {jobsites.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
          <label className="field">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <label className="field">Material</label>
          <input
            type="text"
            value={material}
            onChange={(e) => setMaterial(e.target.value)}
            placeholder="3/4 minus, structural fill…"
          />
          <label className="field">Loads</label>
          <input type="number" min={1} step={1} value={loads} onChange={(e) => setLoads(e.target.value)} />
          <label className="field">Tons (optional)</label>
          <input type="number" min={0} step={0.1} value={tons} onChange={(e) => setTons(e.target.value)} />
          {formError && (
            <p className="muted" style={{ color: 'var(--red)' }}>
              {formError}
            </p>
          )}
          <button className="btn primary wide" disabled={saving} onClick={submit}>
            {saving ? 'Saving…' : 'Log haul ticket'}
          </button>
        </div>
      )}
    </div>
  );
}
