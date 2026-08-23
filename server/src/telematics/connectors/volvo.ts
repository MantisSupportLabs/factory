/**
 * Volvo CareTrack connector.
 *
 * Volvo Construction Equipment exposes ISO 15143-3 (AEMP 2.0) through its
 * CareTrack telematics portal (https://caretrack.volvo.com). API access is
 * granted by Volvo CE — typically requested through the owning dealer or
 * CareTrack support, which issues dedicated API credentials (username +
 * password) separate from the portal login. The AEMP endpoint authenticates
 * with HTTP Basic auth using those credentials. Note: newer Volvo programs
 * also offer OAuth-based access via Volvo Group Connected Solutions; this
 * connector targets the widely deployed Basic-auth CareTrack ISO API, and
 * exact base paths / provisioning steps can vary by dealer and region.
 *
 * This connector:
 *
 *   1. builds a Basic Authorization header from the issued credentials,
 *   2. pulls the paged /Fleet snapshot with the shared AEMP client,
 *   3. optionally backfills per-machine Location + FaultCode series since
 *      the last sync,
 *   4. hands everything to the shared AEMP normalizer.
 *
 * Read-only by design: no machine-control calls exist in this integration.
 *
 * Demo mode: credentials with baseUrl "mock://volvo" route the same client
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

const PROVIDER = 'volvo';
const DEFAULT_BASE_URL = 'https://caretrack.volvo.com/isoapi';

/** How far back to request per-machine series on first sync. */
const FIRST_SYNC_LOOKBACK_MS = 24 * 3600_000;

const CATEGORY_BY_MODEL: Array<[RegExp, string]> = [
  [/^E[CW]/i, 'Excavator'],          // EC220E, ECR235E, EW160E
  [/^A(2[5-9]|3[05]|4[05]|60)/i, 'Articulated Truck'], // A25G–A60H haulers
  [/^L\d{2}/i, 'Wheel Loader'],      // L60H … L350H
  [/^SD\d/i, 'Soil Compactor'],      // SD75B, SD115B
  [/^G9\d/i, 'Motor Grader'],        // G940, G946, G960
];

function volvoCategory(model: string): string | undefined {
  for (const [re, cat] of CATEGORY_BY_MODEL) if (re.test(model)) return cat;
  return undefined;
}

function basicAuthHeader(ctx: ConnectorContext): string {
  const { username, password } = ctx.credentials;
  if (!username || !password) {
    throw new Error('volvo: username and password are required');
  }
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function buildTransport(ctx: ConnectorContext): Promise<AempTransport> {
  const baseUrl = ctx.credentials.baseUrl;
  if (isMockBaseUrl(baseUrl)) {
    return mockAempTransport(mockProviderFromBaseUrl(baseUrl!));
  }
  return httpTransport(baseUrl ?? DEFAULT_BASE_URL, staticAuth({ Authorization: basicAuthHeader(ctx) }));
}

const info: ConnectorInfo = {
  provider: PROVIDER,
  displayName: 'Volvo CareTrack',
  oemPortal: 'https://caretrack.volvo.com',
  aemp2: true,
  authType: 'basic',
  capabilities: [
    'location', 'location_history', 'engine_hours', 'idle_hours', 'fuel_percent',
    'fuel_used_l', 'def_percent', 'engine_status', 'utilization_pct', 'fault_codes',
    'odometer_km', 'payload_tons',
  ],
  notes:
    'ISO 15143-3 via CareTrack; HTTP Basic auth with API credentials issued by Volvo CE. ' +
    'Newer programs also offer OAuth via Volvo Group Connected Solutions. Read-only.',
};

export const volvoConnector: TelematicsConnector = {
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
      const snap = normalizeAempEquipment(eq, { defaultCategory: volvoCategory });
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

    ctx.log(`volvo: ${snapshots.length} machines, ${warnings.length} warnings`);
    return { provider: PROVIDER, snapshots, warnings };
  },
};
