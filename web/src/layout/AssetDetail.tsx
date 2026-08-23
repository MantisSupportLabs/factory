/**
 * Right-sidebar inspector for the selected asset: identity, live telemetry
 * gauges, faults, tracking-mode toggle, manual position drop, and a
 * fuel/hours history sparkline.
 */

import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { AssetStateRow, FaultRow, MetricPoint } from '../api/types';
import { useApp } from '../state/store';

function fmt(v: number | null | undefined, digits = 0, suffix = ''): string {
  if (v == null || Number.isNaN(v)) return '—';
  return v.toLocaleString(undefined, { maximumFractionDigits: digits }) + suffix;
}

function ago(ts: string | null | undefined): string {
  if (!ts) return 'never';
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function Gauge({ label, pct, warn }: { label: string; pct: number | null; warn: number }) {
  const v = pct == null ? null : Math.max(0, Math.min(100, pct));
  const color = v == null ? '#5a6672' : v <= warn ? '#e5484d' : v <= warn * 2 ? '#f5a623' : '#30a46c';
  return (
    <div className="gauge">
      <div className="gauge-head">
        <span>{label}</span>
        <b style={{ color }}>{v == null ? '—' : `${Math.round(v)}%`}</b>
      </div>
      <div className="gauge-track">
        <div className="gauge-fill" style={{ width: `${v ?? 0}%`, background: color }} />
      </div>
    </div>
  );
}

function Sparkline({ points }: { points: MetricPoint[] }) {
  if (points.length < 2) return null;
  const w = 280;
  const h = 48;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${((i / (points.length - 1)) * w).toFixed(1)},${(h - ((p.value - min) / span) * h).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <path d={d} fill="none" stroke="#4cc2ff" strokeWidth="1.5" />
    </svg>
  );
}

export function AssetDetail() {
  const id = useApp((s) => s.selectedAssetId);
  const assets = useApp((s) => s.assets);
  const dataVersion = useApp((s) => s.dataVersion);
  const [faults, setFaults] = useState<FaultRow[]>([]);
  const [fuelHistory, setFuelHistory] = useState<MetricPoint[]>([]);
  const [busy, setBusy] = useState(false);

  const asset = assets.find((a) => a.id === id) as AssetStateRow | undefined;

  useEffect(() => {
    if (id == null) return;
    let cancelled = false;
    api.get<FaultRow[]>(`/assets/${id}/faults`).then((f) => !cancelled && setFaults(f)).catch(() => {});
    api
      .get<MetricPoint[]>(`/assets/${id}/telemetry/history?metric=fuel_percent&limit=200`)
      .then((p) => !cancelled && setFuelHistory(p))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, dataVersion]);

  if (id == null || !asset) {
    return (
      <div className="detail-empty">
        <p>Select an asset or jobsite on the map to inspect it.</p>
      </div>
    );
  }

  const activeFaults = faults.filter((f) => f.active === 1);

  const toggleTracking = async () => {
    setBusy(true);
    try {
      await api.patch(`/assets/${id}`, {
        tracking_mode: asset.tracking_mode === 'auto' ? 'manual' : 'auto',
      });
      await useApp.getState().refresh();
      useApp.getState().bumpVersion();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="asset-detail">
      <div className="detail-title">
        <h2>{asset.name}</h2>
        <span className={`pill status-${asset.engine_status ?? 'unknown'}`}>{asset.engine_status ?? 'no signal'}</span>
      </div>
      <div className="detail-sub">
        {[asset.make, asset.model, asset.category].filter(Boolean).join(' · ')}
        {asset.provider ? ` · via ${asset.provider}` : ' · manual tracking'}
      </div>
      <div className="detail-meta">
        <span>Last telemetry: {ago(asset.ts)}</span>
        {asset.operator && <span>Operator: {asset.operator}</span>}
      </div>

      <div className="stat-grid">
        <div className="stat">
          <label>Engine hrs</label>
          <b>{fmt(asset.engine_hours, 1)}</b>
        </div>
        <div className="stat">
          <label>Idle hrs</label>
          <b>{fmt(asset.idle_hours, 1)}</b>
        </div>
        <div className="stat">
          <label>Utilization</label>
          <b>{fmt(asset.utilization_pct, 0, '%')}</b>
        </div>
        <div className="stat">
          <label>{asset.odometer_km != null ? 'Odometer' : 'Fuel used'}</label>
          <b>{asset.odometer_km != null ? fmt(asset.odometer_km, 0, ' km') : fmt(asset.fuel_used_l, 0, ' L')}</b>
        </div>
      </div>

      <Gauge label="Fuel" pct={asset.fuel_percent} warn={15} />
      <Gauge label="DEF" pct={asset.def_percent} warn={12} />
      {fuelHistory.length > 1 && (
        <div className="spark-block">
          <label>Fuel — recent history</label>
          <Sparkline points={fuelHistory} />
        </div>
      )}

      <div className="detail-section">
        <h3>
          Faults{' '}
          {activeFaults.length > 0 && <span className="pill pill-red">{activeFaults.length} active</span>}
        </h3>
        {faults.length === 0 && <p className="muted">No fault history.</p>}
        {faults.slice(0, 6).map((f) => (
          <div key={f.id} className={`fault sev-${f.severity}${f.active ? '' : ' resolved'}`}>
            <div className="fault-head">
              <code>{f.code}</code>
              <span>{f.active ? f.severity : 'resolved'}</span>
            </div>
            <div className="fault-desc">{f.description}</div>
            <div className="fault-ts">{ago(f.occurred_at)}</div>
          </div>
        ))}
      </div>

      <div className="detail-section">
        <h3>Tracking</h3>
        <div className="row-between">
          <span className="muted">
            {asset.tracking_mode === 'auto' ? 'Auto (telemetry moves the pin)' : 'Manual (field-set position)'}
          </span>
          <button className="btn" disabled={busy} onClick={toggleTracking}>
            Switch to {asset.tracking_mode === 'auto' ? 'manual' : 'auto'}
          </button>
        </div>
        <button className="btn wide" onClick={() => useApp.getState().armPositionDrop(id)}>
          📍 Set position on map
        </button>
      </div>
    </div>
  );
}
