/**
 * ISO 15143-3 (AEMP 2.0) data shapes — JSON representation.
 *
 * This mirrors the standard's Fleet snapshot and time-series payloads as
 * served by OEM AEMP endpoints (Caterpillar VisionLink, John Deere JDLink,
 * Volvo CareTrack, Komatsu, Hitachi, DEVELON all expose some subset).
 * Field names follow the ISO schema element names so mapping to OEM docs
 * is one-to-one.
 */

export interface AempDateTimeValue {
  datetime: string; // ISO 8601 UTC
}

export interface AempEquipmentHeader {
  OEMName: string;
  Model: string;
  EquipmentID: string;
  SerialNumber: string;
  PIN?: string;
  /** Non-standard but commonly present vendor extensions. */
  UnitInstallDateTime?: string;
}

export interface AempLocation extends AempDateTimeValue {
  Latitude: number;
  Longitude: number;
  Altitude?: number;
  AltitudeUnits?: 'metre' | 'foot';
}

export interface AempCumulativeOperatingHours extends AempDateTimeValue {
  Hour: number;
}

export interface AempCumulativeIdleHours extends AempDateTimeValue {
  Hour: number;
}

export interface AempEngineStatus extends AempDateTimeValue {
  EngineNumber?: string;
  Running: boolean;
}

export interface AempFuelUsed extends AempDateTimeValue {
  FuelConsumed: number;
  FuelUnits: 'litre' | 'gallon';
}

export interface AempFuelRemaining extends AempDateTimeValue {
  Percent: number;
}

export interface AempDEFRemaining extends AempDateTimeValue {
  Percent: number;
}

export interface AempDistance extends AempDateTimeValue {
  Odometer: number;
  OdometerUnits: 'kilometre' | 'mile';
}

export interface AempCumulativePayloadTotals extends AempDateTimeValue {
  Payload: number;
  PayloadUnits: 'kilogram' | 'tonne' | 'ton';
}

export interface AempFaultCode {
  CodeIdentifier: string;
  CodeDescription?: string;
  CodeSeverity?: string; // OEM-specific vocabulary; normalized downstream
  CodeSource?: string;
  Datetime: string;
}

/** One machine in the Fleet snapshot. */
export interface AempEquipment {
  EquipmentHeader: AempEquipmentHeader;
  Location?: AempLocation;
  CumulativeOperatingHours?: AempCumulativeOperatingHours;
  CumulativeIdleHours?: AempCumulativeIdleHours;
  EngineStatus?: AempEngineStatus;
  FuelUsed?: AempFuelUsed;
  FuelUsedLast24?: AempFuelUsed;
  FuelRemaining?: AempFuelRemaining;
  DEFRemaining?: AempDEFRemaining;
  Distance?: AempDistance;
  CumulativePayloadTotals?: AempCumulativePayloadTotals;
  /** Vendor extension: active fault list included inline by some OEMs. */
  FaultCodes?: AempFaultCode[];
}

/** GET /Fleet/{pageNumber} response. */
export interface AempFleetPage {
  Links?: Array<{ rel: string; href: string }>;
  Equipment: AempEquipment[];
}

/** GET /Equipment/{oem}/{serial}/Locations/{start}/{end}/{page} response. */
export interface AempLocationSeriesPage {
  Links?: Array<{ rel: string; href: string }>;
  Location: AempLocation[];
}

/** GET /Equipment/{oem}/{serial}/FaultCodes/{start}/{end}/{page} response. */
export interface AempFaultSeriesPage {
  Links?: Array<{ rel: string; href: string }>;
  FaultCode: AempFaultCode[];
}
