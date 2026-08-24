/**
 * PlotBoard — a pure DOM/SVG tactical plot used where MapLibre GL cannot run
 * (sandboxed pages that block WebGL or blob workers, e.g. the packaged demo
 * artifact). Renders the same picture from the same store data: graticule,
 * jobsite boundaries, site chips, asset markers, selected-asset trail —
 * with drag pan, wheel/pinch zoom, and tap-to-place. No external requests.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
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

/* ------------------------------------------------------------------ */
/* Synthetic terrain basemap                                           */
/*                                                                     */
/* Sandboxed hosts cannot fetch imagery from any tile server, so the   */
/* plotboard draws its own ground: value-noise scrub/dirt terrain with */
/* hillshade, a rural mile-grid road network, a highway, creeks, and   */
/* scraped-dirt jobsite pads. Deterministic, resolution-independent,   */
/* rendered through a small canvas tile cache.                         */
/* ------------------------------------------------------------------ */

const KCOS0 = Math.cos((33.03 * Math.PI) / 180); // fixed for the demo latitude band

function hash2(ix: number, iy: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

function fbm(x: number, y: number): number {
  return (
    (vnoise(x, y) * 0.5 +
      vnoise(x * 2.1, y * 2.1) * 0.25 +
      vnoise(x * 4.3 + 17.1, y * 4.3 - 8.2) * 0.125 +
      vnoise(x * 8.9 + 3.7, y * 8.9 + 11.4) * 0.0625 +
      vnoise(x * 18.3 + 29.4, y * 18.3 + 5.5) * 0.03125 +
      vnoise(x * 37.1 + 7.7, y * 37.1 + 19.2) * 0.015625) /
    0.984375
  );
}

const tileCache = new Map<string, HTMLCanvasElement>();

function terrainTile(z: number, tx: number, ty: number): HTMLCanvasElement {
  const key = `${z}/${tx}/${ty}`;
  const hit = tileCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(256, 256);
  const span = 256 / 2 ** z; // world units per tile (x = lng·cosφ, y = lat)
  const inv = span / 256;
  const x0 = tx * span;
  const yTop = (ty + 1) * span;
  let i = 0;
  for (let py = 0; py < 256; py++) {
    const y = yTop - py * inv;
    let prevE = fbm((x0 - inv) * 160, y * 160);
    for (let px = 0; px < 256; px++) {
      const x = x0 + px * inv;
      const e = fbm(x * 160, y * 160);
      const m = vnoise(x * 46 + 83.7, y * 46 - 12.3) * 0.6 + vnoise(x * 95 + 3.1, y * 95 + 7.9) * 0.4;
      let r = 20 + e * 26;
      let g = 30 + e * 34;
      let b = 20 + e * 22;
      if (m > 0.56) {
        const t = Math.min(1, (m - 0.56) / 0.22);
        r += (78 + e * 40 - r) * t;
        g += (62 + e * 34 - g) * t;
        b += (40 + e * 22 - b) * t;
      }
      const sh = Math.max(0.78, Math.min(1.18, 1 - (e - prevE) * 7));
      prevE = e;
      img.data[i++] = r * sh;
      img.data[i++] = g * sh;
      img.data[i++] = b * sh;
      img.data[i++] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (tileCache.size > 280) {
    const first = tileCache.keys().next().value;
    if (first) tileCache.delete(first);
  }
  tileCache.set(key, c);
  return c;
}

/** Hand-laid vector features for the demo area (lng/lat polylines). */
const HIGHWAY: [number, number][] = [
  [-97.62, 33.148], [-97.545, 33.104], [-97.4682, 33.0532], [-97.408, 33.012], [-97.3, 32.943], [-97.2, 32.885],
];
const CREEKS: [number, number][][] = [
  [[-97.37, 33.17], [-97.345, 33.128], [-97.318, 33.112], [-97.33, 33.06], [-97.302, 33.02], [-97.31, 32.96]],
  [[-97.53, 32.99], [-97.478, 32.962], [-97.452, 32.93], [-97.462, 32.888], [-97.43, 32.85]],
];

export function PlotBoard() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
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

  /* Keyboard zoom (+ / − / =). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === '+' || e.key === '=') {
        setView((v) => (v ? { ...v, ppd: Math.min(MAX_PPD, v.ppd * 1.4) } : v));
      } else if (e.key === '-' || e.key === '_') {
        setView((v) => (v ? { ...v, ppd: Math.max(MIN_PPD, v.ppd / 1.4) } : v));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* Terrain + vector basemap, redrawn on view/size changes. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !view || size.w < 10) return;
    const raf = requestAnimationFrame(() => {
      const { w, h } = size;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const ppu = view.ppd;
      const cx = view.lng * KCOS0;
      const cy = view.lat;
      const sx = (x: number) => (x - cx) * ppu + w / 2;
      const sy = (y: number) => (cy - y) * ppu + h / 2;
      const px = (lng: number) => sx(lng * KCOS0);
      const path = (line: [number, number][]) => {
        ctx.beginPath();
        line.forEach((c, i) => (i === 0 ? ctx.moveTo(px(c[0]), sy(c[1])) : ctx.lineTo(px(c[0]), sy(c[1]))));
      };

      // Terrain tiles
      const z = Math.min(17, Math.max(7, Math.ceil(Math.log2(ppu))));
      const span = 256 / 2 ** z;
      const drawSize = 256 * (ppu / 2 ** z) + 0.5;
      const xMin = cx - w / 2 / ppu;
      const xMax = cx + w / 2 / ppu;
      const yMin = cy - h / 2 / ppu;
      const yMax = cy + h / 2 / ppu;
      for (let tx = Math.floor(xMin / span); tx <= Math.floor(xMax / span); tx++) {
        for (let ty = Math.floor(yMin / span); ty <= Math.floor(yMax / span); ty++) {
          ctx.drawImage(terrainTile(z, tx, ty), sx(tx * span), sy((ty + 1) * span), drawSize, drawSize);
        }
      }

      // Scraped-dirt jobsite pads
      for (const j of jobsites) {
        if (!j.boundary) continue;
        try {
          const geo = JSON.parse(j.boundary) as { coordinates: [number, number][][] };
          path(geo.coordinates[0]);
          ctx.closePath();
          ctx.fillStyle = 'rgba(112, 92, 60, 0.42)';
          ctx.fill();
        } catch {
          /* bad geometry */
        }
      }

      // Creeks
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(30, 52, 64, 0.9)';
      ctx.lineWidth = Math.max(1.5, ppu * 0.00035);
      for (const creek of CREEKS) {
        path(creek);
        ctx.stroke();
      }

      // Mile-grid county roads
      ctx.strokeStyle = 'rgba(60, 58, 52, 0.6)';
      ctx.lineWidth = Math.max(0.7, ppu * 0.00012);
      ctx.beginPath();
      const gLng = 0.0175;
      const gLat = 0.0145;
      for (let L = Math.floor(xMin / KCOS0 / gLng) * gLng; L * KCOS0 <= xMax; L += gLng) {
        ctx.moveTo(px(L), 0);
        ctx.lineTo(px(L), h);
      }
      for (let A = Math.floor(yMin / gLat) * gLat; A <= yMax; A += gLat) {
        ctx.moveTo(0, sy(A));
        ctx.lineTo(w, sy(A));
      }
      ctx.stroke();

      // Highway with dashed centerline
      ctx.strokeStyle = '#3d3c37';
      ctx.lineWidth = Math.max(3, ppu * 0.0009);
      path(HIGHWAY);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(200, 190, 140, 0.5)';
      ctx.lineWidth = Math.max(0.6, ppu * 0.00008);
      ctx.setLineDash([ppu * 0.0016, ppu * 0.0016]);
      path(HIGHWAY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Faint graticule majors keep the tactical read
      ctx.strokeStyle = 'rgba(63, 198, 240, 0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let L = Math.floor(xMin / KCOS0 / 0.05) * 0.05; L * KCOS0 <= xMax; L += 0.05) {
        ctx.moveTo(px(L), 0);
        ctx.lineTo(px(L), h);
      }
      for (let A = Math.floor(yMin / 0.05) * 0.05; A <= yMax; A += 0.05) {
        ctx.moveTo(0, sy(A));
        ctx.lineTo(w, sy(A));
      }
      ctx.stroke();
    });
    return () => cancelAnimationFrame(raf);
  }, [view, size, jobsites]);

  if (!view) return <div className="plotboard" ref={containerRef} />;

  const zoomedOut = view.ppd < LABEL_PPD;

  return (
    <div
      ref={containerRef}
      className={`plotboard${zoomedOut ? ' zoomed-out' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
    >
      <canvas ref={canvasRef} className="plot-canvas" />
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
      <div className="plot-attr">Synthetic terrain · live imagery unavailable in this sandbox</div>
    </div>
  );
}
