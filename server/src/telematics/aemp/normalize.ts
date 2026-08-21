/**
 * AEMP 2.0 → normalized model mapping.
 *
 * Shared by every AEMP-capable connector. Unit conversions happen here so
 * the rest of the system only ever sees metric units and percentages.
 */

import type {
  GeoPoint,
  MetricReading,
  NormalizedAssetSnapshot,
  NormalizedFault,
} from '../model.js';
import type { AempEquipment, AempFaultCode, AempLocation } from './types.js';

const GALLON_L = 3.78541;
const MILE_KM = 1.609344;
const FOOT_M = 0.3048;

export function normalizeAempEquipment(
  eq: AempEquipment,
  opts: { defaultCategory?: (model: string) => string | undefined } = {},
): NormalizedAssetSnapshot {
  const h = eq.EquipmentHeader;
  const metrics: MetricReading[] = [];
  const timestamps: string[] = [];

  const push = (m: MetricReading | null) => {
    if (m && Number.isFinite(m.value)) {
      metrics.push(m);
      timestamps.push(m.ts);
    }
  };

  if (eq.CumulativeOperatingHours) {
    push({
      metric: 'engine_hours',
      value: eq.CumulativeOperatingHours.Hour,
      unit: 'h',
      ts: eq.CumulativeOperatingHours.datetime,
    });
  }
  if (eq.CumulativeIdleHours) {
    push({
      metric: 'idle_hours',
      value: eq.CumulativeIdleHours.Hour,
      unit: 'h',
      ts: eq.CumulativeIdleHours.datetime,
    });
  }
  if (eq.FuelRemaining) {
    push({
      metric: 'fuel_percent',
      value: clampPct(eq.FuelRemaining.Percent),
      unit: '%',
      ts: eq.FuelRemaining.datetime,
    });
  }
  if (eq.DEFRemaining) {
    push({
      metric: 'def_percent',
      value: clampPct(eq.DEFRemaining.Percent),
      unit: '%',
      ts: eq.DEFRemaining.datetime,
    });
  }
  if (eq.FuelUsed) {
    const litres =
      eq.FuelUsed.FuelUnits === 'gallon'
        ? eq.FuelUsed.FuelConsumed * GALLON_L
        : eq.FuelUsed.FuelConsumed;
    push({ metric: 'fuel_used_l', value: round2(litres), unit: 'L', ts: eq.FuelUsed.datetime });
  }
  if (eq.Distance) {
    const km =
      eq.Distance.OdometerUnits === 'mile'
        ? eq.Distance.Odometer * MILE_KM
        : eq.Distance.Odometer;
    push({ metric: 'odometer_km', value: round2(km), unit: 'km', ts: eq.Distance.datetime });
  }
  if (eq.CumulativePayloadTotals) {
    const p = eq.CumulativePayloadTotals;
    const tons =
      p.PayloadUnits === 'kilogram' ? p.Payload / 1000 : p.PayloadUnits === 'ton' ? p.Payload * 0.907185 : p.Payload;
    push({ metric: 'payload_tons', value: round2(tons), unit: 't', ts: p.datetime });
  }

  // Derived utilization: idle vs operating hours, when both are present.
  const eng = eq.CumulativeOperatingHours;
  const idle = eq.CumulativeIdleHours;
  if (eng && idle && eng.Hour > 0) {
    const util = clampPct(((eng.Hour - idle.Hour) / eng.Hour) * 100);
    push({ metric: 'utilization_pct', value: round2(util), unit: '%', ts: eng.datetime });
  }

  const location = eq.Location ? normalizeAempLocation(eq.Location) : undefined;
  if (location) timestamps.push(location.ts);

  let engineStatus: NormalizedAssetSnapshot['engineStatus'];
  if (eq.EngineStatus) {
    engineStatus = {
      status: eq.EngineStatus.Running ? 'running' : 'off',
      ts: eq.EngineStatus.datetime,
    };
    timestamps.push(eq.EngineStatus.datetime);
  }

  const faults = (eq.FaultCodes ?? []).map(normalizeAempFault);
  for (const f of faults) timestamps.push(f.occurredAt);

  return {
    identity: {
      providerAssetId: h.EquipmentID,
      make: h.OEMName,
      model: h.Model,
      serialNumber: h.SerialNumber || h.PIN || h.EquipmentID,
      category: opts.defaultCategory?.(h.Model),
    },
    kind: 'machine',
    location,
    engineStatus,
    metrics,
    faults,
    lastTelemetryAt: maxIso(timestamps),
    raw: eq,
  };
}

export function normalizeAempLocation(loc: AempLocation): GeoPoint {
  return {
    lat: loc.Latitude,
    lng: loc.Longitude,
    altitudeM:
      loc.Altitude === undefined
        ? undefined
        : loc.AltitudeUnits === 'foot'
          ? round2(loc.Altitude * FOOT_M)
          : loc.Altitude,
    ts: loc.datetime,
  };
}

export function normalizeAempFault(f: AempFaultCode): NormalizedFault {
  const spnMatch = /SPN\s*(\d+)/i.exec(f.CodeIdentifier);
  const fmiMatch = /FMI\s*(\d+)/i.exec(f.CodeIdentifier);
  return {
    code: f.CodeIdentifier,
    spn: spnMatch ? Number(spnMatch[1]) : undefined,
    fmi: fmiMatch ? Number(fmiMatch[1]) : undefined,
    severity: normalizeSeverity(f.CodeSeverity),
    description: f.CodeDescription ?? f.CodeIdentifier,
    occurredAt: f.Datetime,
  };
}

export function normalizeSeverity(s?: string): NormalizedFault['severity'] {
  const v = (s ?? '').toLowerCase();
  if (/(critical|severe|stop|red|3)/.test(v)) return 'critical';
  if (/(high|warn.*2|amber|2)/.test(v)) return 'high';
  if (/(medium|moderate|caution|1)/.test(v)) return 'medium';
  return 'low';
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function maxIso(list: string[]): string | undefined {
  if (list.length === 0) return undefined;
  return list.reduce((a, b) => (a > b ? a : b));
}
