/**
 * PlotBoard — a pure DOM/SVG tactical plot used where MapLibre GL cannot run
 * (sandboxed pages that block WebGL or blob workers, e.g. the packaged demo
 * artifact). Renders the same picture from the same store data: graticule,
 * jobsite boundaries, site chips, asset markers, selected-asset trail —
 * with drag pan, wheel/pinch zoom, and tap-to-place. No external requests.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { AssetStateRow, LocationPoint } from '../api/types';
import { useApp } from '../state/store';
import { Icon, type IconName } from '../ui/icons';

const KIND_ICON: Record<string, IconName> = {
  machine: 'dozer',
  truck: 'truck',
  small_tool: 'toolbox',
  attachment: 'cog',
  camera: 'camera',
  network: 'antenna',
  trailer: 'trailer',
};

function statusColor(a: AssetStateRow): string {
  if (a.active_faults > 0) return '#e5484d';
  if (a.engine_status === 'running') return '#37c98b';
  if (a.engine_status === 'idle') return '#e8a33d';
  return '#72869a';
}

interface View {
  lng: number; // center
  lat: number;
  ppd: number; // pixels per degree of latitude
}

const MIN_PPD = 400;
const MAX_PPD = 400_000;
const LABEL_PPD = 2800; // labels only once a single site roughly fills the view

export function PlotBoard() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const assets = useApp((s) => s.assets);
  const jobsites = useApp((s) => s.jobsites);
  const schedule = useApp((s) => s.schedule);
  const selectedAssetId = useApp((s) => s.selectedAssetId);
  const [view, setView] = useState<View | null>(null);
  const [trail, setTrail] = useState<LocationPoint[]>([]);
  const didFitRef = useRef(false);

  /* Track container size. */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    const pts: [number, number][] = [];
    for (const j of jobsites) pts.push([j.lng, j.lat]);
    for (const a of assets) if (a.lng != null && a.lat != null) pts.push([a.lng, a.lat]);
    if (pts.length === 0) {
      setView({ lng: -97.41, lat: 33.03, ppd: 1400 });
      return;
    }
    const lngs = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    const cLng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
    const cLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const dLng = Math.max(0.02, Math.max(...lngs) - Math.min(...lngs)) * 1.35;
    const dLat = Math.max(0.02, Math.max(...lats) - Math.min(...lats)) * 1.5;
    const kCos = Math.cos((cLat * Math.PI) / 180);
    const ppd = Math.min(size.w / (dLng * kCos), size.h / dLat);
    setView({ lng: cLng, lat: cLat, ppd: Math.max(MIN_PPD, Math.min(MAX_PPD, ppd)) });
  }, [assets, jobsites, size.w, size.h]);

  useEffect(() => {
    if (!didFitRef.current && (jobsites.length > 0 || assets.length > 0) && size.w > 50) {
      didFitRef.current = true;
      fit();
    }
  }, [jobsites, assets, size, fit]);

  const kCos = view ? Math.cos((view.lat * Math.PI) / 180) : 1;
  const kLng = view ? view.ppd * kCos : 1;
  const kLat = view ? view.ppd : 1;

  const project = useCallback(
    (lng: number, lat: number): [number, number] =>
      view ? [(lng - view.lng) * kLng + size.w / 2, (view.lat - lat) * kLat + size.h / 2] : [0, 0],
    [view, kLng, kLat, size.w, size.h],
  );
  const unproject = useCallback(
    (x: number, y: number): [number, number] =>
      view ? [view.lng + (x - size.w / 2) / kLng, view.lat - (y - size.h / 2) / kLat] : [0, 0],
    [view, kLng, kLat, size.w, size.h],
  );

  /* Selected asset trail. */
  useEffect(() => {
    if (selectedAssetId == null) {
      setTrail([]);
      return;
    }
    let cancelled = false;
    api
      .get<LocationPoint[]>(`/assets/${selectedAssetId}/locations?limit=300`)
      .then((p) => !cancelled && setTrail(p))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedAssetId]);

  /* Pan / zoom / pinch / tap-to-place. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; startDist: number; startPpd: number }>({ moved: false, startDist: 0, startPpd: 0 });

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    gesture.current.moved = false;
    if (pointers.current.size === 2 && view) {
      const [p1, p2] = [...pointers.current.values()];
      gesture.current.startDist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      gesture.current.startPpd = view.ppd;
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev || !view) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (Math.abs(dx) + Math.abs(dy) > 2) gesture.current.moved = true;
    if (pointers.current.size === 1) {
      setView({ ...view, lng: view.lng - dx / kLng, lat: view.lat + dy / kLat });
    } else if (pointers.current.size === 2) {
      const [p1, p2] = [...pointers.current.values()];
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (gesture.current.startDist > 0) {
        const ppd = Math.max(MIN_PPD, Math.min(MAX_PPD, gesture.current.startPpd * (dist / gesture.current.startDist)));
        setView((v) => (v ? { ...v, ppd } : v));
      }
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0 && !gesture.current.moved) {
      // Treat as a tap: manual position drop when armed.
      const { positionDropAssetId } = useApp.getState();
      if (positionDropAssetId != null && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const [lng, lat] = unproject(e.clientX - rect.left, e.clientY - rect.top);
        api
          .post(`/assets/${positionDropAssetId}/position`, { lat, lng })
          .then(() => {
            useApp.getState().armPositionDrop(null);
            useApp.getState().refresh();
            useApp.getState().bumpVersion();
          })
          .catch(() => {});
      }
    }
  };
  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    if (!view || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const [mLng, mLat] = unproject(mx, my);
    const ppd = Math.max(MIN_PPD, Math.min(MAX_PPD, view.ppd * factor));
    // Keep the cursor's geographic point fixed while zooming.
    const kLng2 = ppd * kCos;
    const lng = mLng - (mx - size.w / 2) / kLng2;
    const lat = mLat + (my - size.h / 2) / ppd;
    setView({ lng, lat, ppd });
  };
  const onWheel = (e: React.WheelEvent) => zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0016));
  const onDoubleClick = (e: React.MouseEvent) => zoomAt(e.clientX, e.clientY, 1.8);

  const zoomBtn = (factor: number) =>
    setView((v) => (v ? { ...v, ppd: Math.max(MIN_PPD, Math.min(MAX_PPD, v.ppd * factor)) } : v));

  /* Grid backgrounds track the view: minor 0.01°, major 0.05°. */
  const gridStyle = useMemo(() => {
    if (!view) return {};
    const sx = 0.01 * kLng;
    const sy = 0.01 * kLat;
    const originX = project(Math.floor(view.lng / 0.01) * 0.01, view.lat)[0];
    const originY = project(view.lng, Math.ceil(view.lat / 0.01) * 0.01)[1];
    const Mx = sx * 5;
    const My = sy * 5;
    const majorX = project(Math.floor(view.lng / 0.05) * 0.05, view.lat)[0];
    const majorY = project(view.lng, Math.ceil(view.lat / 0.05) * 0.05)[1];
    return {
      backgroundImage:
        `linear-gradient(90deg, #1b2c40 1px, transparent 1px),` +
        `linear-gradient(0deg, #1b2c40 1px, transparent 1px),` +
        `linear-gradient(90deg, #131f2e 1px, transparent 1px),` +
        `linear-gradient(0deg, #131f2e 1px, transparent 1px)`,
      backgroundSize: `${Mx}px 100%, 100% ${My}px, ${sx}px 100%, 100% ${sy}px`,
      backgroundPosition: `${majorX}px 0, 0 ${majorY}px, ${originX}px 0, 0 ${originY}px`,
    } as React.CSSProperties;
  }, [view, kLng, kLat, project]);

  if (!view) return <div className="plotboard" ref={containerRef} />;

  const zoomedOut = view.ppd < LABEL_PPD;

  return (
    <div
      ref={containerRef}
      className={`plotboard${zoomedOut ? ' zoomed-out' : ''}`}
      style={gridStyle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
    >
      {/* Boundaries + trail */}
      <svg className="plot-svg" width={size.w} height={size.h}>
        {jobsites.map((j) => {
          if (!j.boundary) return null;
          try {
            const geo = JSON.parse(j.boundary) as { coordinates: [number, number][][] };
            const d =
              geo.coordinates[0]
                .map((c, i) => {
                  const [x, y] = project(c[0], c[1]);
                  return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
                })
                .join(' ') + ' Z';
            return (
              <path key={j.id} d={d} fill="rgba(232,163,61,0.07)" stroke="#e8a33d" strokeWidth={1.5} strokeDasharray="6 4" />
            );
          } catch {
            return null;
          }
        })}
        {trail.length > 1 && (
          <polyline
            points={trail.map((p) => project(p.lng, p.lat).map((n) => n.toFixed(1)).join(',')).join(' ')}
            fill="none"
            stroke="#3fc6f0"
            strokeWidth={2}
            opacity={0.85}
          />
        )}
      </svg>

      {/* Site chips */}
      {jobsites.map((j) => {
        const [x, y] = project(j.lng, j.lat);
        const sched = schedule.find((s) => s.jobsite_id === j.id);
        const cls = sched?.schedule_status === 'behind' ? ' behind' : sched?.schedule_status === 'ahead' ? ' ahead' : '';
        return (
          <div
            key={j.id}
            className={`site-chip plot-abs${cls}`}
            style={{ left: x, top: y - 40 }}
            onPointerUp={(e) => {
              e.stopPropagation();
              if (!gesture.current.moved) {
                useApp.getState().selectJobsite(j.id);
                useApp.getState().setModule('jobsites');
              }
            }}
          >
            {j.name}
            {sched?.schedule_status === 'behind' && sched.days_variance ? ` · +${sched.days_variance}D` : ''}
          </div>
        );
      })}

      {/* Asset markers */}
      {assets.map((a) => {
        if (a.lat == null || a.lng == null) return null;
        const [x, y] = project(a.lng, a.lat);
        if (x < -60 || y < -60 || x > size.w + 60 || y > size.h + 60) return null;
        return (
          <div
            key={a.id}
            className={`asset-marker plot-abs${a.id === selectedAssetId ? ' selected' : ''}`}
            style={{ left: x, top: y, ['--ring' as string]: statusColor(a) }}
            onPointerUp={(e) => {
              e.stopPropagation();
              if (!gesture.current.moved) useApp.getState().selectAsset(a.id);
            }}
          >
            <span className="am-icon">
              <Icon name={KIND_ICON[a.kind] ?? 'cube'} size={15} />
            </span>
            <span className="am-label">{a.name}</span>
          </div>
        );
      })}

      {/* Controls */}
      <div className="plot-controls">
        <button className="ghost-btn" onClick={() => zoomBtn(1.5)} title="Zoom in">+</button>
        <button className="ghost-btn" onClick={() => zoomBtn(1 / 1.5)} title="Zoom out">−</button>
        <button className="ghost-btn" onClick={fit} title="Fit fleet">
          <Icon name="crosshair" size={14} />
        </button>
      </div>
      <div className="plot-attr">Offline plotboard · no imagery in this sandbox</div>
    </div>
  );
}
