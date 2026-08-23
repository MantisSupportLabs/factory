/**
 * Jobsite camera endpoints (UniFi Protect–style).
 *
 *   GET  /api/cameras     list cameras + simulated live status
 *   POST /api/cameras     register a camera (kind='camera', make 'Ubiquiti')
 *
 * Live status is a deterministic mock: derived from a hash of the camera's
 * serial and the current hour, so values hold steady between polls but
 * drift over time.
 */

import { Router } from 'express';
import { all, get, nowIso, run } from '../../db/database.js';

export const camerasRouter = Router();

interface CameraRow {
  id: number;
  name: string;
  model: string | null;
  serial_number: string | null;
  jobsite_id: number | null;
  jobsite_name: string | null;
  lat: number | null;
  lng: number | null;
  meta: string | null;
}

const CAMERA_SELECT = `SELECT a.id, a.name, a.model, a.serial_number, a.jobsite_id,
    j.name AS jobsite_name, s.lat, s.lng, a.meta
  FROM assets a
  LEFT JOIN asset_state s ON s.asset_id = a.id
  LEFT JOIN jobsites j ON j.id = a.jobsite_id`;

/* ---- deterministic mock helpers ---------------------------------- */

/** FNV-1a 32-bit. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic [0, 1) for a seed string. */
function unit(seed: string): number {
  return hash32(seed) / 0x100000000;
}

function parseMeta(meta: string | null): Record<string, unknown> {
  if (!meta) return {};
  try {
    return JSON.parse(meta) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function liveStatus(row: CameraRow): {
  online: boolean;
  recording: boolean;
  uptime_pct: number;
  last_motion: string;
  rtsp: string | null;
} {
  const hour = Math.floor(Date.now() / 3_600_000);
  const seed = `${row.serial_number ?? row.id}:${hour}`;
  const online = unit(`${seed}:online`) < 0.95;
  const recording = online && unit(`${seed}:recording`) < 0.97;
  const uptimePct = online ? 97 + unit(`${seed}:uptime`) * 3 : 80 + unit(`${seed}:uptime`) * 15;
  // Last motion within the past 6h, anchored to the hour so it holds between polls.
  const motionAgoS = Math.floor(unit(`${seed}:motion`) * 21_600);
  const meta = parseMeta(row.meta);
  return {
    online,
    recording,
    uptime_pct: Math.round(uptimePct * 10) / 10,
    last_motion: new Date(hour * 3_600_000 - motionAgoS * 1000).toISOString(),
    rtsp: typeof meta.rtsp === 'string' ? meta.rtsp : null,
  };
}

function toCamera(row: CameraRow): Record<string, unknown> {
  return { ...row, meta: parseMeta(row.meta), status: liveStatus(row) };
}

/* ---- routes ------------------------------------------------------ */

camerasRouter.get('/cameras', (req, res) => {
  const rows = all<CameraRow>(
    `${CAMERA_SELECT} WHERE a.tenant_id = ? AND a.kind = 'camera' ORDER BY a.name`,
    req.tenant.id,
  );
  res.json(rows.map(toCamera));
});

camerasRouter.post('/cameras', (req, res) => {
  const t = req.tenant.id;
  const b = req.body as Record<string, unknown>;
  const { name, model, mac, jobsite_id, lat, lng } = b;
  if (!name || !model || !mac || !jobsite_id || typeof lat !== 'number' || typeof lng !== 'number') {
    res.status(400).json({ error: 'name, model, mac, jobsite_id, lat and lng are required' });
    return;
  }
  const macStr = String(mac);
  const rtsp = `rtsps://192.168.1.1:7441/${macStr.replaceAll(':', '').toLowerCase()}`;
  const meta = { mac: macStr, ip: b.ip ? String(b.ip) : null, rtsp };
  const result = run(
    `INSERT INTO assets (tenant_id, kind, name, make, model, serial_number, category,
       jobsite_id, source, tracking_mode, status, meta)
     VALUES (?, 'camera', ?, 'Ubiquiti', ?, ?, 'Security Camera', ?, 'manual', 'manual', 'active', ?)`,
    t, String(name), String(model), macStr, Number(jobsite_id), JSON.stringify(meta),
  );
  const id = Number(result.lastInsertRowid);
  const ts = nowIso();
  run(
    `INSERT INTO asset_state (asset_id, tenant_id, ts, lat, lng, location_ts, source)
     VALUES (?, ?, ?, ?, ?, ?, 'manual')`,
    id, t, ts, lat, lng, ts,
  );
  run(
    `INSERT OR IGNORE INTO location_history (tenant_id, asset_id, ts, lat, lng, source)
     VALUES (?, ?, ?, ?, ?, 'manual')`,
    t, id, ts, lat, lng,
  );
  const row = get<CameraRow>(`${CAMERA_SELECT} WHERE a.id = ?`, id);
  if (!row) { res.status(500).json({ error: 'failed to load created camera' }); return; }
  res.status(201).json(toCamera(row));
});
