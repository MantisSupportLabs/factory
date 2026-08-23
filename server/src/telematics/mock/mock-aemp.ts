/**
 * Mock ISO 15143-3 (AEMP 2.0) endpoint — an in-process simulator that serves
 * the same Fleet / Locations / FaultCodes payload shapes a real OEM API
 * (VisionLink, JDLink, KOMTRAX, CareTrack, ...) would. Demo credentials set
 * baseUrl to "mock://<provider>", which routes the shared AEMP client's
 * transport here instead of HTTP. Nothing else in the pipeline knows the
 * difference — the connector, normalization, and ingestion code paths are
 * identical to production.
 *
 * The simulation is deterministic in wall-clock time: machines work a
 * 7am–5pm CT day, crawl looping paths around their jobsite, burn fuel
 * (refuelling when low), accumulate engine/idle hours, and occasionally
 * throw fault codes. DEMO_TIME_SCALE compresses time so movement is visible
 * between polls.
 */

import { config } from '../../config.js';
import type { AempTransport } from '../aemp/client.js';
import type {
  AempEquipment,
  AempFaultCode,
  AempFleetPage,
  AempLocation,
} from '../aemp/types.js';
import { JOBSITE_ANCHORS, MOCK_FLEETS, type MockMachineDef } from './fleet-defs.js';

/** Simulator epoch — demo history starts here. */
const EPOCH_MS = Date.parse('2026-08-01T12:00:00Z');

/** Deterministic PRNG so every poll agrees on history. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The simulation runs on a compressed clock (machines cycle through whole
 * work days quickly so the demo is alive), but every timestamp REPORTED to
 * the pipeline is real wall time — consumers must never see future dates.
 */
function realToSim(realMs: number): number {
  return EPOCH_MS + (realMs - EPOCH_MS) * config.demoTimeScale;
}

function simToReal(simMs: number): number {
  return EPOCH_MS + (simMs - EPOCH_MS) / config.demoTimeScale;
}

function simNow(): number {
  return realToSim(Date.now());
}

/** Fraction of a sim-day [0,1) in "central time" (UTC-5 for demo). */
function dayFraction(tMs: number): number {
  const local = tMs - 5 * 3600_000;
  return (local % 86_400_000) / 86_400_000;
}

/** Is the fleet working at sim time t? 7:00–17:00 local, Mon–Sat. */
function isWorking(tMs: number): boolean {
  const f = dayFraction(tMs);
  const local = tMs - 5 * 3600_000;
  const dow = Math.floor(local / 86_400_000 + 4) % 7; // 1970-01-01 = Thursday(4)
  if (dow === 0) return false; // Sunday off
  return f >= 7 / 24 && f < 17 / 24;
}

/** Total worked ms between epoch and t (10h/day, skipping Sundays). */
function workedMs(tMs: number): number {
  let total = 0;
  const step = 3600_000; // hour resolution is plenty for the demo
  for (let t = EPOCH_MS; t < tMs; t += step) {
    if (isWorking(t)) total += Math.min(step, tMs - t);
  }
  return total;
}

interface MachineState {
  loc: AempLocation;
  engineOn: boolean;
  engineHours: number;
  idleHours: number;
  fuelPct: number;
  defPct: number;
  fuelUsedL: number;
  odoKm?: number;
  payloadT?: number;
  faults: AempFaultCode[];
}

function machineState(def: MockMachineDef, tMs: number, realMs: number): MachineState {
  const anchor = JOBSITE_ANCHORS[def.site];
  const seed = hashStr(def.serial);
  const rng = mulberry32(seed);
  const phase = rng() * Math.PI * 2;
  const speed = 0.5 + rng() * 1.2; // loops per sim-hour personality
  const eccentricity = 0.55 + rng() * 0.4;

  const worked = workedMs(tMs);
  const workedH = worked / 3600_000;
  const engineHours = def.baseHours + workedH;
  const idleHours = def.baseHours * def.idleFactor + workedH * def.idleFactor;

  const working = isWorking(tMs);

  // Position: loop an ellipse around the anchor while working; parked at a
  // deterministic laydown spot otherwise.
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos((anchor.lat * Math.PI) / 180);
  let lat: number;
  let lng: number;
  let heading = 0;
  let speedKph = 0;
  if (working) {
    const a = phase + (worked / 3600_000) * speed * Math.PI * 2;
    lat = anchor.lat + (Math.sin(a) * def.radiusM * eccentricity) / mPerDegLat;
    lng = anchor.lng + (Math.cos(a) * def.radiusM) / mPerDegLng;
    heading = ((a * 180) / Math.PI + 90) % 360;
    speedKph = def.isHauler ? 18 + rng() * 14 : 3 + rng() * 5;
  } else {
    lat = anchor.lat + (Math.sin(phase) * 60) / mPerDegLat;
    lng = anchor.lng + (Math.cos(phase) * 60) / mPerDegLng;
  }

  // Fuel: sawtooth from full down to ~12%, then refuel. Personality offset.
  const burnedL = workedH * def.burnLph;
  const usable = def.tankL * 0.88;
  const cycles = burnedL / usable;
  const fuelPct = Math.max(8, Math.round((1 - (cycles % 1)) * 88 + 12 - rng() * 4));
  const defPct = def.hasDef ? Math.max(10, Math.round((1 - ((cycles * 0.35) % 1)) * 80 + 20)) : 0;

  // Faults: hash the (machine, sim-day) pair; ~12% of machine-days throw a
  // code that stays active for a few hours.
  const faults: AempFaultCode[] = [];
  const simDay = Math.floor((tMs - 5 * 3600_000) / 86_400_000);
  for (let d = simDay - 2; d <= simDay; d++) {
    const fr = mulberry32(hashStr(`${def.serial}:${d}`));
    if (fr() < 0.12) {
      const catalog = FAULT_CATALOG[Math.floor(fr() * FAULT_CATALOG.length)];
      const startMs = (d * 86_400_000) + 5 * 3600_000 + Math.floor((7 + fr() * 8) * 3600_000);
      const durMs = (2 + fr() * 30) * 3600_000;
      if (startMs <= tMs && (d === simDay || startMs + durMs > tMs)) {
        faults.push({
          CodeIdentifier: catalog.code,
          CodeDescription: catalog.desc,
          CodeSeverity: catalog.severity,
          CodeSource: def.oemName,
          Datetime: new Date(Math.min(simToReal(startMs), realMs)).toISOString(),
        });
      }
    }
  }

  const ts = new Date(realMs).toISOString();
  const state: MachineState = {
    loc: { Latitude: round6(lat), Longitude: round6(lng), Altitude: 190 + Math.round(rng() * 40), AltitudeUnits: 'metre', datetime: ts },
    engineOn: working,
    engineHours: round1(engineHours),
    idleHours: round1(idleHours),
    fuelPct,
    defPct,
    fuelUsedL: round1(def.baseHours * def.burnLph * 0.92 + burnedL),
    faults,
  };
  if (def.isHauler) {
    state.odoKm = round1(def.baseHours * 14 + workedH * 16);
    state.payloadT = round1(30 + rng() * 8);
  }
  if (working) {
    state.loc = { ...state.loc };
  }
  void heading;
  void speedKph;
  return state;
}

const FAULT_CATALOG = [
  { code: 'SPN 3363 FMI 5', desc: 'DEF tank heater — current below normal', severity: 'medium' },
  { code: 'SPN 100 FMI 1', desc: 'Engine oil pressure low — critical', severity: 'critical' },
  { code: 'SPN 110 FMI 0', desc: 'Engine coolant temperature high', severity: 'high' },
  { code: 'SPN 94 FMI 17', desc: 'Fuel delivery pressure low', severity: 'medium' },
  { code: 'SPN 3719 FMI 15', desc: 'DPF soot load high — regeneration needed', severity: 'medium' },
  { code: 'SPN 168 FMI 18', desc: 'Battery voltage low', severity: 'low' },
  { code: 'SPN 641 FMI 7', desc: 'VGT actuator response fault', severity: 'high' },
  { code: 'SPN 1761 FMI 1', desc: 'DEF level very low', severity: 'high' },
  { code: 'CID 0248 FMI 02', desc: 'CAN data link intermittent', severity: 'low' },
  { code: 'SPN 970 FMI 31', desc: 'Auxiliary engine shutdown switch active', severity: 'medium' },
];

function toAempEquipment(def: MockMachineDef, tMs: number, realMs: number): AempEquipment {
  const s = machineState(def, tMs, realMs);
  const ts = new Date(realMs).toISOString();
  const eq: AempEquipment = {
    EquipmentHeader: {
      OEMName: def.oemName,
      Model: def.model,
      EquipmentID: def.equipmentId,
      SerialNumber: def.serial,
      PIN: def.serial,
    },
    Location: s.loc,
    CumulativeOperatingHours: { Hour: s.engineHours, datetime: ts },
    CumulativeIdleHours: { Hour: s.idleHours, datetime: ts },
    EngineStatus: { EngineNumber: '1', Running: s.engineOn, datetime: ts },
    FuelRemaining: { Percent: s.fuelPct, datetime: ts },
    FuelUsed: { FuelConsumed: s.fuelUsedL, FuelUnits: 'litre', datetime: ts },
    FaultCodes: s.faults,
  };
  if (def.hasDef) eq.DEFRemaining = { Percent: s.defPct, datetime: ts };
  if (s.odoKm !== undefined) eq.Distance = { Odometer: s.odoKm, OdometerUnits: 'kilometre', datetime: ts };
  if (s.payloadT !== undefined) eq.CumulativePayloadTotals = { Payload: s.payloadT, PayloadUnits: 'tonne', datetime: ts };
  return eq;
}

/** In-process AempTransport for "mock://<provider>" base URLs. */
export function mockAempTransport(provider: string): AempTransport {
  const defs = MOCK_FLEETS[provider];
  if (!defs) throw new Error(`No mock fleet for provider '${provider}'`);
  return {
    async get<T>(path: string): Promise<T> {
      const fleetMatch = /^\/Fleet\/(\d+)$/.exec(path);
      if (fleetMatch) {
        const page = Number(fleetMatch[1]);
        // Real OEM snapshots repeat the same datetimes until the machine
        // next reports, so consecutive polls inside one reporting window are
        // byte-identical — that's what makes ingestion's dedup meaningful.
        // Quantize to a 2-real-minute reporting grid to reproduce that.
        const realQ = Math.floor(Date.now() / 120_000) * 120_000;
        const body: AempFleetPage = {
          Links: [],
          Equipment: page === 1 ? defs.map((d) => toAempEquipment(d, realToSim(realQ), realQ)) : [],
        };
        return body as T;
      }
      const locMatch = /^\/Equipment\/([^/]+)\/([^/]+)\/Locations\/([^/]+)\/([^/]+)\/(\d+)$/.exec(path);
      if (locMatch) {
        const serial = decodeURIComponent(locMatch[2]);
        const start = Date.parse(decodeURIComponent(locMatch[3]));
        const end = Date.parse(decodeURIComponent(locMatch[4]));
        const page = Number(locMatch[5]);
        const def = defs.find((d) => d.serial === serial);
        const rows: AempLocation[] = [];
        if (def && page === 1 && Number.isFinite(start) && Number.isFinite(end)) {
          // Fixes on a fixed 10-real-minute grid across the requested
          // (real-time) window, positions sampled from the compressed sim
          // clock. Grid alignment keeps timestamps stable across overlapping
          // windows so ingestion's dedup sees true duplicates.
          const stepMs = 10 * 60_000;
          const from = Math.ceil(Math.max(start, EPOCH_MS) / stepMs) * stepMs;
          const to = Math.min(end, Date.now());
          for (let t = from, n = 0; t <= to && n < 400; t += stepMs, n++) {
            rows.push(machineState(def, realToSim(t), t).loc);
          }
        }
        return { Links: [], Location: rows } as T;
      }
      const faultMatch = /^\/Equipment\/([^/]+)\/([^/]+)\/FaultCodes\/([^/]+)\/([^/]+)\/(\d+)$/.exec(path);
      if (faultMatch) {
        const serial = decodeURIComponent(faultMatch[2]);
        const page = Number(faultMatch[5]);
        const def = defs.find((d) => d.serial === serial);
        const rows: AempFaultCode[] = def && page === 1 ? machineState(def, simNow(), Date.now()).faults : [];
        return { Links: [], FaultCode: rows } as T;
      }
      throw new Error(`mock AEMP: unknown path ${path}`);
    },
  };
}

export function isMockBaseUrl(baseUrl?: string): boolean {
  return !!baseUrl?.startsWith('mock://');
}

export function mockProviderFromBaseUrl(baseUrl: string): string {
  return baseUrl.replace('mock://', '');
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
