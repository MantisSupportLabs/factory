/** Shared API row shapes used across panels. */

export interface Jobsite {
  id: number;
  name: string;
  code: string;
  status: string;
  lat: number;
  lng: number;
  boundary: string | null; // GeoJSON polygon string
  address: string | null;
  superintendent: string | null;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
}

/** Row from GET /api/assets/state — drives the live map + equipment lists. */
export interface AssetStateRow {
  id: number;
  kind: string;
  name: string;
  make: string | null;
  model: string | null;
  category: string | null;
  jobsite_id: number | null;
  provider: string | null;
  tracking_mode: 'auto' | 'manual';
  status: string;
  operator: string | null;
  meta: string | null;
  ts: string | null;
  lat: number | null;
  lng: number | null;
  heading_deg: number | null;
  speed_kph: number | null;
  location_ts: string | null;
  engine_status: 'running' | 'idle' | 'off' | 'unknown' | null;
  engine_hours: number | null;
  idle_hours: number | null;
  fuel_percent: number | null;
  fuel_used_l: number | null;
  def_percent: number | null;
  odometer_km: number | null;
  utilization_pct: number | null;
  payload_tons: number | null;
  battery_pct: number | null;
  active_faults: number;
  source: string | null;
}

export interface FaultRow {
  id: number;
  asset_id?: number;
  asset_name?: string;
  code: string;
  spn: number | null;
  fmi: number | null;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  occurred_at: string;
  active: number;
  resolved_at: string | null;
}

export interface MetricPoint {
  metric: string;
  ts: string;
  value: number;
  unit: string;
  source: string;
}

export interface LocationPoint {
  ts: string;
  lat: number;
  lng: number;
  altitude_m: number | null;
  heading_deg: number | null;
  speed_kph: number | null;
  source: string;
}

export interface ConnectorInfo {
  provider: string;
  displayName: string;
  oemPortal: string;
  aemp2: boolean;
  authType: string;
  capabilities: string[];
  notes?: string;
}

export interface CredentialRow {
  id: number;
  provider: string;
  label: string;
  auth_type: string;
  enabled: number;
  last_sync_at: string | null;
  last_status: string | null;
}

export interface AiSetting {
  feature: string;
  enabled: number;
}

export interface AiInsight {
  id: number;
  jobsite_id: number | null;
  asset_id: number | null;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  data: string | null;
  status: 'suggested' | 'accepted' | 'dismissed' | 'corrected';
  created_at: string;
}
