/**
 * Komatsu KOMTRAX connector.
 *
 * KOMTRAX is Komatsu's factory-installed telematics system (standard on most
 * Komatsu construction machines). Customers view KOMTRAX data in the
 * My Komatsu portal (https://mykomatsu.komatsu); machine-to-machine access is
 * provided as an ISO 15143-3 (AEMP 2.0) feed that is arranged through Komatsu
 * and/or the servicing distributor — there is no public self-service signup.
 * Once provisioned, the distributor issues endpoint details and credentials;
 * an API-key style access header is the common pattern, though some
 * distributors issue HTTP Basic credentials instead. This connector accepts
 * either: credentials.apiKey is sent as an X-API-Key header, and when apiKey
 * is absent, username/password fall back to HTTP Basic.
 *
 * Honest caveats: the AEMP base URL, header name, and rate limits are
 * distributor-provisioned and vary by region/dealer — the DEFAULT_BASE_URL
 * below is a placeholder default and most tenants will need to enter the URL
 * their distributor supplies. Element coverage also varies by machine model
 * and KOMTRAX generation (older units may omit DEF, payload, or fault detail).
 *
 * Sync flow (identical shape to the Caterpillar reference connector):
 *   1. build a transport (mock:// demo routing or HTTP with auth headers),
 *   2. pull the paged /Fleet snapshot with the shared AEMP client,
 *   3. backfill per-machine Location + FaultCode series since the last sync,
 *   4. hand everything to the shared AEMP normalizer.
 *
 * Read-only by design: no machine-control calls exist in this integration.
 *
 * Demo mode: credentials with baseUrl "mock://komatsu" route the same client
 * through the in-process mock ISO 15143-3 endpoint.
 */

import {
  AempClient,
  httpTransport,
  staticAuth,
  type AempTransport,
} from '../aemp/client.js';
import { normalizeAempEquipment, normalizeAempFault, normalizeAempLocation } from '../aemp/normalize.js';
import type {
  ConnectorContext,
  ConnectorInfo,
  TelematicsConnector,
} from '../connector.js';
import type { ConnectorSyncResult } from '../model.js';
import { isMockBaseUrl, mockAempTransport, mockProviderFromBaseUrl } from '../mock/mock-aemp.js';

const PROVIDER = 'komatsu';
/** Distributor-provisioned in reality; varies by region. Overridable via credentials.baseUrl. */
const DEFAULT_BASE_URL = 'https://api.komtrax.komatsu/aemp';

/** How far back to request per-machine series on first sync. */
const FIRST_SYNC_LOOKBACK_MS = 24 * 3600_000;

const CATEGORY_BY_MODEL: Array<[RegExp, string]> = [
  [/^PC/i, 'Excavator'],          // PC210, PC490LC-11, ...
  [/^D\d/i, 'Dozer'],             // D61PX, D65EX, D155AX, ...
  [/^HM/i, 'Articulated Truck'],  // HM300, HM400, ...
  [/^WA/i, 'Wheel Loader'],       // WA270, WA500, ...
  [/^GD/i, 'Motor Grader'],       // GD655, ...
  [/^HD/i, 'Rigid Truck'],        // HD325, HD605, ...
];

function komatsuCategory(model: string): string | undefined {
  for (const [re, cat] of CATEGORY_BY_MODEL) if (re.test(model)) return cat;
  return undefined;
}

function buildAuthHeaders(ctx: ConnectorContext): Record<string, string> {
  const { apiKey, username, password } = ctx.credentials;
  if (apiKey) {
    return { 'X-API-Key': apiKey };
  }
  if (username && password) {
    const basic = Buffer.from(`${username}:${password}`).toString('base64');
    return { Authorization: `Basic ${basic}` };
  }
  throw new Error('komatsu: apiKey (or username/password) is required');
}

async function buildTransport(ctx: ConnectorContext): Promise<AempTransport> {
  const baseUrl = ctx.credentials.baseUrl;
  if (isMockBaseUrl(baseUrl)) {
    return mockAempTransport(mockProviderFromBaseUrl(baseUrl!));
  }
  return httpTransport(baseUrl ?? DEFAULT_BASE_URL, staticAuth(buildAuthHeaders(ctx)));
}

const info: ConnectorInfo = {
  provider: PROVIDER,
  displayName: 'Komatsu KOMTRAX',
  oemPortal: 'https://mykomatsu.komatsu',
  aemp2: true,
  authType: 'api_key',
  capabilities: [
    'location', 'location_history', 'engine_hours', 'idle_hours', 'fuel_percent',
    'fuel_used_l', 'def_percent', 'engine_status', 'utilization_pct', 'fault_codes',
    'odometer_km', 'payload_tons',
  ],
  notes:
    'ISO 15143-3 feed arranged through Komatsu / the distributor (My Komatsu). ' +
    'API-key header auth is common; Basic auth accepted as fallback. Base URL is ' +
    'distributor-provisioned and varies by region. Read-only.',
};

export const komatsuConnector: TelematicsConnector = {
  info,

  async testConnection(ctx: ConnectorContext) {
    try {
      const client = new AempClient(await buildTransport(ctx));
      const fleet = await client.fetchFleet();
      return { ok: true, detail: `Fleet endpoint reachable — ${fleet.length} machine(s) visible` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  },

  async sync(ctx: ConnectorContext): Promise<ConnectorSyncResult> {
    const warnings: string[] = [];
    const client = new AempClient(await buildTransport(ctx));

    const fleet = await client.fetchFleet();
    const snapshots = [];
    const sinceIso =
      ctx.lastSyncAt ?? new Date(Date.now() - FIRST_SYNC_LOOKBACK_MS).toISOString();
    const nowIso = new Date().toISOString();

    for (const eq of fleet) {
      const snap = normalizeAempEquipment(eq, { defaultCategory: komatsuCategory });
      const { OEMName, SerialNumber } = eq.EquipmentHeader;

      // Backfill series since last sync; tolerate per-machine failures.
      try {
        const locs = await client.fetchLocations(OEMName, SerialNumber, sinceIso, nowIso);
        if (locs.length > 0) snap.locationHistory = locs.map(normalizeAempLocation);
      } catch (err) {
        warnings.push(`locations ${SerialNumber}: ${(err as Error).message}`);
      }
      try {
        const faults = await client.fetchFaultCodes(OEMName, SerialNumber, sinceIso, nowIso);
        const known = new Set(snap.faults.map((f) => `${f.code}@${f.occurredAt}`));
        for (const f of faults.map(normalizeAempFault)) {
          if (!known.has(`${f.code}@${f.occurredAt}`)) snap.faults.push(f);
        }
      } catch (err) {
        warnings.push(`faults ${SerialNumber}: ${(err as Error).message}`);
      }

      snapshots.push(snap);
    }

    ctx.log(`komatsu: ${snapshots.length} machines, ${warnings.length} warnings`);
    return { provider: PROVIDER, snapshots, warnings };
  },
};
