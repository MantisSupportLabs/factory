/**
 * Jobsite connectivity endpoints — Starlink kits + UniFi gateways.
 *
 *   GET /api/connectivity   per-jobsite network health
 *
 * Link metrics are a deterministic mock: derived from a hash of the unit's
 * serial and the current minute (uptime/clients drift hourly), so values
 * hold steady between polls but change over time.
 */

import { Router } from 'express';
import { all } from '../../db/database.js';

export const connectivityRouter = Router();

interface NetworkRow {
  id: number;
  name: string;
  model: string | null;
  serial_number: string | null;
  jobsite_id: number;
  jobsite_name: string;
  meta: string | null;
}

interface StarlinkItem {
  asset_id: number;
  name: string;
  model: string | null;
  kit_serial: string | null;
  service: string | null;
  status: 'online' | 'degraded' | 'offline';
  downlink_mbps: number;
  uplink_mbps: number;
  latency_ms: number;
  obstruction_pct: number;
  uptime_pct: number;
}

interface GatewayItem {
  asset_id: number;
  name: string;
  model: string | null;
  status: 'online' | 'offline';
  clients: number;
  wan: string | null;
}

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

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

function parseMeta(meta: string | null): Record<string, unknown> {
  if (!meta) return {};
  try {
    return JSON.parse(meta) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function starlinkItem(row: NetworkRow, meta: Record<string, unknown>): StarlinkItem {
  const minute = Math.floor(Date.now() / 60_000);
  const key = row.serial_number ?? String(row.id);
  const seed = `${key}:${minute}`;
  const offline = unit(`${seed}:offline`) < 0.015;
  // Exponents skew latency/obstruction toward the good end — degradation is occasional.
  const latency = Math.round(25 + 35 * unit(`${seed}:latency`) ** 1.5);
  const obstruction = round2(4 * unit(`${seed}:obstruction`) ** 2);
  const degraded = obstruction > 3.2 || latency > 56;
  const downlink = 80 + 160 * unit(`${seed}:downlink`);
  const uplink = 8 + 17 * unit(`${seed}:uplink`);
  const uptime = 97 + 3 * unit(`${key}:${Math.floor(minute / 60)}:uptime`);
  return {
    asset_id: row.id,
    name: row.name,
    model: row.model,
    kit_serial: row.serial_number,
    service: typeof meta.service === 'string' ? meta.service : null,
    status: offline ? 'offline' : degraded ? 'degraded' : 'online',
    downlink_mbps: offline ? 0 : round1(degraded ? Math.max(80, downlink * 0.6) : downlink),
    uplink_mbps: offline ? 0 : round1(uplink),
    latency_ms: offline ? 0 : latency,
    obstruction_pct: obstruction,
    uptime_pct: round1(uptime),
  };
}

function gatewayItem(row: NetworkRow, meta: Record<string, unknown>): GatewayItem {
  const minute = Math.floor(Date.now() / 60_000);
  const key = row.serial_number ?? String(row.id);
  const offline = unit(`${key}:${minute}:gw-offline`) < 0.02;
  const clients = offline ? 0 : 4 + Math.floor(25 * unit(`${key}:${Math.floor(minute / 60)}:clients`));
  return {
    asset_id: row.id,
    name: row.name,
    model: row.model,
    status: offline ? 'offline' : 'online',
    clients,
    wan: typeof meta.wan === 'string' ? meta.wan : null,
  };
}

/* ---- routes ------------------------------------------------------ */

connectivityRouter.get('/connectivity', (req, res) => {
  const rows = all<NetworkRow>(
    `SELECT a.id, a.name, a.model, a.serial_number, a.jobsite_id, j.name AS jobsite_name, a.meta
     FROM assets a JOIN jobsites j ON j.id = a.jobsite_id
     WHERE a.tenant_id = ? AND a.kind = 'network'
     ORDER BY j.name, a.name`,
    req.tenant.id,
  );
  const groups = new Map<number, {
    jobsite_id: number;
    jobsite_name: string;
    starlink: StarlinkItem[];
    gateways: GatewayItem[];
  }>();
  for (const row of rows) {
    let g = groups.get(row.jobsite_id);
    if (!g) {
      g = { jobsite_id: row.jobsite_id, jobsite_name: row.jobsite_name, starlink: [], gateways: [] };
      groups.set(row.jobsite_id, g);
    }
    const meta = parseMeta(row.meta);
    if (meta.category === 'Starlink Kit') g.starlink.push(starlinkItem(row, meta));
    else if (meta.category === 'Gateway') g.gateways.push(gatewayItem(row, meta));
  }
  res.json([...groups.values()]);
});
