/**
 * Hitachi ConSite / Global e-Service connector.
 *
 * Hitachi Construction Machinery (HCM) surfaces machine telematics through
 * its Global e-Service owner portal and the ConSite service suite
 * (https://www.hitachicm.com — ConSite / ConSite Pocket / ConSite OIL).
 * For fleet-management integrations HCM offers an ISO 15143-3 (AEMP 2.0)
 * interface; access is arranged through HCM or the regional Hitachi dealer,
 * which provisions API credentials per customer. Authentication is HTTP
 * Basic with the issued username/password.
 *
 * Honest caveats: the exact host, credential issuance flow, and data
 * coverage vary by region and dealer (the Americas, EMEA, and Japan run
 * separate provisioning); the base URL below is a placeholder default and
 * real deployments should set `baseUrl` in credentials to the endpoint HCM
 * assigns. This connector:
 *
 *   1. builds a Basic-auth transport for the assigned AEMP endpoint,
 *   2. pulls the paged /Fleet snapshot with the shared AEMP client,
 *   3. backfills per-machine Location + FaultCode series since the last sync,
 *   4. hands everything to the shared AEMP normalizer.
 *
 * Read-only by design: no machine-control calls exist in this integration.
 *
 * Demo mode: credentials with baseUrl "mock://hitachi" route the same
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

const PROVIDER = 'hitachi';
/** Region/dealer provisioned — real tenants override via credentials.baseUrl. */
const DEFAULT_BASE_URL = 'https://api.hitachi-c-m.com/iso15143';

/** How far back to request per-machine series on first sync. */
const FIRST_SYNC_LOOKBACK_MS = 24 * 3600_000;

const CATEGORY_BY_MODEL: Array<[RegExp, string]> = [
  [/^ZX/i, 'Excavator'],       // ZX-series (Zaxis) crawler excavators
  [/^ZW/i, 'Wheel Loader'],    // ZW-series wheel loaders
  [/^EH/i, 'Rigid Truck'],     // EH-series rigid haul trucks
];

function hitachiCategory(model: string): string | undefined {
  for (const [re, cat] of CATEGORY_BY_MODEL) if (re.test(model)) return cat;
  return undefined;
}

async function buildTransport(ctx: ConnectorContext): Promise<AempTransport> {
  const baseUrl = ctx.credentials.baseUrl;
  if (isMockBaseUrl(baseUrl)) {
    return mockAempTransport(mockProviderFromBaseUrl(baseUrl!));
  }
  const { username, password } = ctx.credentials;
  if (!username || !password) {
    throw new Error('hitachi: username and password are required');
  }
  const basic = Buffer.from(`${username}:${password}`).toString('base64');
  return httpTransport(baseUrl ?? DEFAULT_BASE_URL, staticAuth({ Authorization: `Basic ${basic}` }));
}

const info: ConnectorInfo = {
  provider: PROVIDER,
  displayName: 'Hitachi ConSite / Global e-Service',
  oemPortal: 'https://www.hitachicm.com',
  aemp2: true,
  authType: 'basic',
  capabilities: [
    'location', 'location_history', 'engine_hours', 'idle_hours', 'fuel_percent',
    'fuel_used_l', 'def_percent', 'engine_status', 'utilization_pct', 'fault_codes',
    'odometer_km', 'payload_tons',
  ],
  notes:
    'ISO 15143-3 via Global e-Service / ConSite; HTTP Basic credentials provisioned by HCM or the regional dealer. Endpoint and coverage vary by region. Read-only.',
};

export const hitachiConnector: TelematicsConnector = {
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
      const snap = normalizeAempEquipment(eq, { defaultCategory: hitachiCategory });
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

    ctx.log(`hitachi: ${snapshots.length} machines, ${warnings.length} warnings`);
    return { provider: PROVIDER, snapshots, warnings };
  },
};
