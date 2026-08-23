/**
 * MY DEVELON (DoosanCONNECT) connector.
 *
 * DEVELON — formerly Doosan Construction Equipment, rebranded in 2023 under
 * HD Hyundai — exposes machine telematics through the MY DEVELON owner
 * portal (https://my.develon-ce.com), the successor to the DoosanCONNECT
 * TMS. Fleet customers can request an ISO 15143-3 (AEMP 2.0) feed for
 * fleet-management integrations; the feed is provisioned per customer by
 * DEVELON or the selling dealer, which issues an API key used on every
 * request (sent as an X-API-Key header here).
 *
 * Honest caveats: endpoint host, key issuance, and which AEMP elements are
 * populated vary by market and by the machine's DoosanCONNECT hardware
 * generation; the base URL below is a placeholder default and real
 * deployments should set `baseUrl` in credentials to the endpoint DEVELON
 * assigns. This connector:
 *
 *   1. builds an API-key transport for the assigned AEMP endpoint,
 *   2. pulls the paged /Fleet snapshot with the shared AEMP client,
 *   3. backfills per-machine Location + FaultCode series since the last sync,
 *   4. hands everything to the shared AEMP normalizer.
 *
 * Read-only by design: no machine-control calls exist in this integration.
 *
 * Demo mode: credentials with baseUrl "mock://develon" route the same
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

const PROVIDER = 'develon';
/** Provisioned per customer — real tenants override via credentials.baseUrl. */
const DEFAULT_BASE_URL = 'https://api.mydevelon.com/aemp';

/** How far back to request per-machine series on first sync. */
const FIRST_SYNC_LOOKBACK_MS = 24 * 3600_000;

const CATEGORY_BY_MODEL: Array<[RegExp, string]> = [
  [/^DX/i, 'Excavator'],          // DX-series crawler/wheeled excavators
  [/^DL/i, 'Wheel Loader'],       // DL-series wheel loaders
  [/^DA/i, 'Articulated Truck'],  // DA-series articulated dump trucks
  [/^DD/i, 'Dozer'],              // DD-series dozers
];

function develonCategory(model: string): string | undefined {
  for (const [re, cat] of CATEGORY_BY_MODEL) if (re.test(model)) return cat;
  return undefined;
}

async function buildTransport(ctx: ConnectorContext): Promise<AempTransport> {
  const baseUrl = ctx.credentials.baseUrl;
  if (isMockBaseUrl(baseUrl)) {
    return mockAempTransport(mockProviderFromBaseUrl(baseUrl!));
  }
  const { apiKey } = ctx.credentials;
  if (!apiKey) {
    throw new Error('develon: apiKey is required');
  }
  return httpTransport(baseUrl ?? DEFAULT_BASE_URL, staticAuth({ 'X-API-Key': apiKey }));
}

const info: ConnectorInfo = {
  provider: PROVIDER,
  displayName: 'MY DEVELON (DoosanCONNECT)',
  oemPortal: 'https://my.develon-ce.com',
  aemp2: true,
  authType: 'api_key',
  capabilities: [
    'location', 'location_history', 'engine_hours', 'idle_hours', 'fuel_percent',
    'fuel_used_l', 'def_percent', 'engine_status', 'utilization_pct', 'fault_codes',
    'odometer_km', 'payload_tons',
  ],
  notes:
    'ISO 15143-3 via MY DEVELON / DoosanCONNECT TMS; API key provisioned per customer by DEVELON or the dealer. Coverage varies by market and hardware generation. Read-only.',
};

export const develonConnector: TelematicsConnector = {
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
      const snap = normalizeAempEquipment(eq, { defaultCategory: develonCategory });
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

    ctx.log(`develon: ${snapshots.length} machines, ${warnings.length} warnings`);
    return { provider: PROVIDER, snapshots, warnings };
  },
};
