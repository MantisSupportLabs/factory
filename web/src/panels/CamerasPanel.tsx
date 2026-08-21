/**
 * Cameras panel (left sidebar): UniFi Protect jobsite cameras with live
 * online/recording status and last motion time. Tapping a row selects the
 * camera asset (shows it on the map / right sidebar).
 */

import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useApp } from '../state/store';

interface CameraStatus {
  online: boolean;
  recording: boolean;
  uptime_pct: number | null;
  last_motion: string | null;
  rtsp: string | null;
}

/** Row from GET /cameras — live status fields may be flat or nested. */
interface CameraRow extends Partial<CameraStatus> {
  id: number;
  name: string;
  model: string | null;
  serial_number: string | null;
  jobsite_id: number | null;
  jobsite_name: string | null;
  lat: number | null;
  lng: number | null;
  meta: string | null;
  status?: CameraStatus | string;
}

function live(c: CameraRow): CameraStatus {
  if (c.status !== undefined && typeof c.status === 'object') return c.status;
  return {
    online: c.online ?? false,
    recording: c.recording ?? false,
    uptime_pct: c.uptime_pct ?? null,
    last_motion: c.last_motion ?? null,
    rtsp: c.rtsp ?? null,
  };
}

function ago(ts: string | null | undefined): string {
  if (!ts) return 'never';
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (!Number.isFinite(s)) return 'never';
  if (s < 90) return `${Math.max(0, Math.round(s))}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export default function CamerasPanel() {
  const dataVersion = useApp((s) => s.dataVersion);
  const selectedId = useApp((s) => s.selectedAssetId);

  const [cameras, setCameras] = useState<CameraRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<CameraRow[]>('/cameras')
      .then((rows) => {
        if (!cancelled) {
          setCameras(rows);
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

  if (cameras === null && loadError !== null) return <p className="muted pad">Error: {loadError}</p>;
  if (cameras === null) return <p className="muted pad">Loading cameras…</p>;

  const online = cameras.filter((c) => live(c).online).length;

  return (
    <div>
      <p className="muted" style={{ margin: '6px 4px 4px', fontSize: 12 }}>
        {online} of {cameras.length} cameras online
      </p>
      {cameras.length === 0 && <p className="muted pad">No cameras registered yet.</p>}

      {cameras.map((c) => {
        const st = live(c);
        return (
          <button
            key={c.id}
            className={`list-row${c.id === selectedId ? ' selected' : ''}`}
            onClick={() => useApp.getState().selectAsset(c.id)}
          >
            <span className="row-icon">📷</span>
            <div className="row-main">
              <div className="row-title">{c.name}</div>
              <div className="row-sub">{[c.model, c.jobsite_name].filter(Boolean).join(' · ') || 'camera'}</div>
            </div>
            <div className="row-end">
              <span style={{ display: 'flex', gap: 4 }}>
                {st.recording && <span className="pill pill-blue">REC</span>}
                <span className={`pill ${st.online ? 'pill-green' : 'pill-red'}`}>
                  {st.online ? 'Online' : 'Offline'}
                </span>
              </span>
              <span className="row-sub">motion {ago(st.last_motion)}</span>
            </div>
          </button>
        );
      })}

      <p className="muted" style={{ margin: '12px 4px', fontSize: 12 }}>
        Feeds come from the UniFi Protect NVR on each jobsite's trailer LAN — join the site Wi-Fi (or use the
        Starlink backhaul) to view live video and clips.
      </p>
    </div>
  );
}
