/**
 * Normalized internal asset & telemetry model.
 *
 * Every OEM feed (Caterpillar VisionLink, John Deere JDLink, Komatsu KOMTRAX,
 * Volvo CareTrack, Hitachi ConSite, DEVELON), as well as future aftermarket
 * CAN/J1939 GPS trackers and BLE battery tags, is normalized into these
 * structures before anything touches the database. The application layer
 * never sees OEM-specific shapes.
 */

/** Where a telemetry reading or asset record originated. */
export type TelemetrySource =
  | 'oem_telematics'   // OEM API (AEMP 2.0 / proprietary)
  | 'can_j1939'        // aftermarket CAN bus / J1939 GPS tracker
  | 'ble_tracker'      // battery/BLE asset tag (small tools, attachments)
  | 'manual';          // hand-entered in the field

export type AssetKind =
  | 'machine'      // yellow iron: dozers, excavators, loaders, scrapers, graders...
  | 'truck'        // on/off-highway haul & service trucks
  | 'small_tool'   // compactors, saws, pumps, lasers, trench boxes...
  | 'attachment'   // buckets, hammers, blades
  | 'camera'       // Ubiquiti/UniFi Protect site cameras
  | 'network'      // Starlink kits, UniFi gateways/switches/APs
  | 'trailer';     // job trailers, equipment trailers

export type EngineStatus = 'running' | 'idle' | 'off' | 'unknown';

export type TrackingMode = 'auto' | 'manual';

/** Machine identity as normalized from an OEM header or manual entry. */
export interface NormalizedAssetIdentity {
  /** OEM's stable ID for the asset (AEMP EquipmentHeader.@EquipmentID / PIN). */
  providerAssetId: string;
  make: string;
  model: string;
  serialNumber: string;
  /** Optional friendly name / unit number if the OEM supplies one. */
  name?: string;
  year?: number;
  /** Machine category, e.g. 'Excavator', 'Dozer', 'Articulated Truck'. */
  category?: string;
}

export interface GeoPoint {
  lat: number;
  lng: number;
  altitudeM?: number;
  headingDeg?: number;
  speedKph?: number;
  /** ISO 8601 timestamp of the fix. */
  ts: string;
}

/** A single normalized numeric metric sample. */
export interface MetricReading {
  metric: NormalizedMetric;
  value: number;
  unit: string;
  /** ISO 8601 timestamp reported by the OEM for this datum. */
  ts: string;
}

export type NormalizedMetric =
  | 'engine_hours'        // cumulative, hours
  | 'idle_hours'          // cumulative, hours
  | 'fuel_percent'        // 0-100
  | 'fuel_used_l'         // cumulative litres
  | 'def_percent'         // 0-100 (diesel exhaust fluid)
  | 'odometer_km'         // cumulative km (trucks)
  | 'utilization_pct'     // derived: working vs available, 0-100
  | 'payload_tons'        // last cycle payload (haul trucks)
  | 'battery_pct';        // BLE tags / machines' battery voltage as percent

export interface NormalizedFault {
  /** OEM/J1939 code, e.g. 'CID 0248.02' or 'SPN 3363 FMI 5'. */
  code: string;
  spn?: number;
  fmi?: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  occurredAt: string; // ISO 8601
}

/**
 * One full snapshot for one asset, as returned by a connector sync.
 * All fields except identity are optional — OEMs differ in coverage,
 * and the normalization layer records only what was actually reported.
 */
export interface NormalizedAssetSnapshot {
  identity: NormalizedAssetIdentity;
  kind?: AssetKind;
  location?: GeoPoint;
  /** Additional historical fixes if the OEM exposes a track (newest last). */
  locationHistory?: GeoPoint[];
  engineStatus?: { status: EngineStatus; ts: string };
  metrics: MetricReading[];
  faults: NormalizedFault[];
  /** The most recent timestamp the OEM reported anything for this asset. */
  lastTelemetryAt?: string;
  /** Raw provider payload kept for audit/debug (stored as JSON). */
  raw?: unknown;
}

/** Result of one connector sync run. */
export interface ConnectorSyncResult {
  provider: string;
  snapshots: NormalizedAssetSnapshot[];
  /** Non-fatal warnings surfaced during the sync (missing fields, skipped rows). */
  warnings: string[];
}

/** What the app stores per asset — see db/schema.sql for the table shape. */
export interface AssetRecord {
  id: number;
  tenantId: number;
  kind: AssetKind;
  name: string;
  make: string | null;
  model: string | null;
  serialNumber: string | null;
  year: number | null;
  category: string | null;
  jobsiteId: number | null;
  source: TelemetrySource;
  provider: string | null;
  providerAssetId: string | null;
  credentialId: number | null;
  trackingMode: TrackingMode;
  status: string;
  createdAt: string;
  updatedAt: string;
}
