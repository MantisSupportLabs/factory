/**
 * Connectivity panel (left sidebar): per-jobsite network health — Starlink
 * dishes (throughput / latency / obstruction meters) and the UniFi gateway
 * behind each one at the job trailer.
 */

import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useApp } from '../state/store';
import { Icon } from '../ui/icons';

interface StarlinkItem {
  asset_id: number;
  name: string;
  model: string | null;
  kit_serial: string | null;
  service: string | null;
  status: 'online' | 'degraded' | 'offline';
  downlink_mbps: number | null;
  uplink_mbps: number | null;
  latency_ms: number | null;
  obstruction_pct: number | null;
  uptime_pct: number | null;
}

interface GatewayItem {
  asset_id: number;
  name: string;
  model: string | null;
  status: 'online' | 'offline';
  clients: number | null;
  wan: string | null;
}

interface SiteConnectivity {
  jobsite_id: number;
  jobsite_name: string;
  starlink: StarlinkItem[];
  gateways: GatewayItem[];
}

function starlinkPill(status: StarlinkItem['status']): string {
  if (status === 'online') return 'pill pill-green';
  if (status === 'degraded') return 'pill pill-amber';
  return 'pill pill-red';
}

function latencyColor(ms: number | null): string {
  if (ms == null) return 'var(--text-dim)';
  if (ms <= 60) return 'var(--green)';
  if (ms <= 120) return 'var(--accent)';
  return 'var(--red)';
}

function obstructionColor(pct: number | null): string {
  if (pct == null) return 'var(--text-dim)';
  if (pct < 1) return 'var(--green)';
  if (pct < 5) return 'var(--accent)';
  return 'var(--red)';
}

function Meter({
  label,
  value,
  unit,
  pct,
  color,
  digits = 0,
}: {
  label: string;
  value: number | null;
  unit: string;
  pct: number;
  color: string;
  digits?: number;
}) {
  const v = value != null && Number.isFinite(value) ? value : null;
  const width = v === null ? 0 : Math.max(2, Math.min(100, pct));
  return (
    <div style={{ margin: '6px 0 0' }}>
      <div className="gauge-head" style={{ marginBottom: 2 }}>
        <span className="muted">{label}</span>
        <b style={{ color: v === null ? 'var(--text-dim)' : color }}>
          {v === null ? '—' : `${v.toLocaleString(undefined, { maximumFractionDigits: digits })} ${unit}`}
        </b>
      </div>
      <div className="gauge-track" style={{ height: 6 }}>
        <div className="gauge-fill" style={{ width: `${width}%`, background: color }} />
      </div>
    </div>
  );
}

export default function ConnectivityPanel() {
  const dataVersion = useApp((s) => s.dataVersion);

  const [sites, setSites] = useState<SiteConnectivity[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<SiteConnectivity[]>('/connectivity')
      .then((rows) => {
        if (!cancelled) {
          setSites(rows);
          setLoadError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  if (sites === null && loadError !== null) return <p className="muted pad">Error: {loadError}</p>;
  if (sites === null) return <p className="muted pad">Loading connectivity…</p>;

  return (
    <div>
      <p className="muted" style={{ margin: '8px 4px 4px', fontSize: 12 }}>
        Starlink → UniFi gateway at the job trailer
      </p>
      {sites.length === 0 && <p className="muted pad">No network gear registered yet.</p>}

      {sites.map((site) => (
        <div className="card" key={site.jobsite_id}>
          <h3>{site.jobsite_name}</h3>
          {site.starlink.length === 0 && site.gateways.length === 0 && (
            <p className="muted">No network gear at this site.</p>
          )}

          {site.starlink.map((s) => (
            <div key={s.asset_id} style={{ padding: '4px 0 10px', borderBottom: '1px solid var(--border)' }}>
              <div className="row-between" style={{ minHeight: 32 }}>
                <span style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon name="antenna" size={14} /> {s.name}</span>
                <span className={starlinkPill(s.status)}>{s.status}</span>
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {[s.model, s.service, s.kit_serial ? `kit ${s.kit_serial}` : null].filter(Boolean).join(' · ') ||
                  'Starlink'}
              </div>
              <Meter
                label="Downlink"
                value={s.downlink_mbps}
                unit="Mbps"
                pct={s.downlink_mbps != null ? (s.downlink_mbps / 250) * 100 : 0}
                color="var(--blue)"
              />
              <Meter
                label="Uplink"
                value={s.uplink_mbps}
                unit="Mbps"
                pct={s.uplink_mbps != null ? (s.uplink_mbps / 40) * 100 : 0}
                color="var(--blue)"
              />
              <Meter
                label="Latency"
                value={s.latency_ms}
                unit="ms"
                pct={s.latency_ms != null ? (s.latency_ms / 200) * 100 : 0}
                color={latencyColor(s.latency_ms)}
              />
              <Meter
                label="Obstruction"
                value={s.obstruction_pct}
                unit="%"
                pct={s.obstruction_pct != null ? s.obstruction_pct * 10 : 0}
                color={obstructionColor(s.obstruction_pct)}
                digits={1}
              />
            </div>
          ))}

          {site.gateways.map((g) => (
            <div key={g.asset_id} className="row-between" style={{ minHeight: 44, padding: '6px 0' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <Icon name="globe" size={13} /> {g.name}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {[g.model, g.wan ? `WAN ${g.wan}` : null].filter(Boolean).join(' · ') || 'gateway'}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <span className="pill">{g.clients ?? 0} clients</span>
                <span className={g.status === 'online' ? 'pill pill-green' : 'pill pill-red'}>{g.status}</span>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
