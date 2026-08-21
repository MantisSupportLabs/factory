/**
 * Caterpillar VisionLink connector — REFERENCE IMPLEMENTATION.
 *
 * Cat exposes ISO 15143-3 (AEMP 2.0) through the VisionLink / Cat Digital
 * "AEMP 2.0 API" (https://digital.cat.com), authenticated with OAuth2
 * client-credentials. This connector:
 *
 *   1. acquires a bearer token (client_credentials grant),
 *   2. pulls the paged /Fleet snapshot with the shared AEMP client,
 *   3. optionally backfills per-machine Location + FaultCode series since
 *      the last sync,
 *   4. hands everything to the shared AEMP normalizer.
 *
 * Read-only by design: no machine-control calls exist in this integration.
 *
 * Demo mode: credentials with baseUrl "mock://caterpillar" route the same
 * client through the in-process mock ISO 15143-3 endpoint.
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

const PROVIDER = 'caterpillar';
const DEFAULT_BASE_URL = 'https://services.cat.com/telematics/iso15143';
const DEFAULT_TOKEN_URL = 'https://fedlogin.cat.com/as/token.oauth2';

/** How far back to request per-machine series on first sync. */
const FIRST_SYNC_LOOKBACK_MS = 24 * 3600_000;

const CATEGORY_BY_MODEL: Array<[RegExp, string]> = [
  [/^D\d/i, 'Dozer'],
  [/^(3\d\d|349|336)/, 'Excavator'],
  [/^7\d\d/, 'Articulated Truck'],
  [/^1\d0/, 'Motor Grader'],
  [/^8\d\dK?/, 'Soil Compactor'],
  [/^9\d\dK?/, 'Track Loader'],
];

function catCategory(model: string): string | undefined {
  for (const [re, cat] of CATEGORY_BY_MODEL) if (re.test(model)) return cat;
  return undefined;
}

async function fetchOAuthToken(ctx: ConnectorContext): Promise<string> {
  const { clientId, clientSecret, tokenUrl, scope } = ctx.credentials;
  if (!clientId || !clientSecret) {
    throw new Error('caterpillar: clientId and clientSecret are required');
  }
  const res = await fetch(tokenUrl ?? DEFAULT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      ...(scope ? { scope } : {}),
    }),
  });
  if (!res.ok) throw new Error(`caterpillar: token endpoint HTTP ${res.status}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('caterpillar: token response missing access_token');
  return body.access_token;
}

async function buildTransport(ctx: ConnectorContext): Promise<AempTransport> {
  const baseUrl = ctx.credentials.baseUrl;
  if (isMockBaseUrl(baseUrl)) {
    return mockAempTransport(mockProviderFromBaseUrl(baseUrl!));
  }
  const token = await fetchOAuthToken(ctx);
  return httpTransport(baseUrl ?? DEFAULT_BASE_URL, staticAuth({ Authorization: `Bearer ${token}` }));
}

const info: ConnectorInfo = {
  provider: PROVIDER,
  displayName: 'Caterpillar VisionLink',
  oemPortal: 'https://digital.cat.com',
  aemp2: true,
  authType: 'oauth2',
  capabilities: [
    'location', 'location_history', 'engine_hours', 'idle_hours', 'fuel_percent',
    'fuel_used_l', 'def_percent', 'engine_status', 'utilization_pct', 'fault_codes',
    'odometer_km', 'payload_tons',
  ],
  notes: 'ISO 15143-3 via Cat Digital APIs; OAuth2 client-credentials. Read-only.',
};

export const caterpillarConnector: TelematicsConnector = {
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
      const snap = normalizeAempEquipment(eq, { defaultCategory: catCategory });
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

    ctx.log(`caterpillar: ${snapshots.length} machines, ${warnings.length} warnings`);
    return { provider: PROVIDER, snapshots, warnings };
  },
};
