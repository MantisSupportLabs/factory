/**
 * John Deere JDLink connector.
 *
 * Deere exposes ISO 15143-3 (AEMP 2.0) through the John Deere Operations
 * Center / MyJohnDeere platform. Access is set up on developer.deere.com:
 * you register an application there, and each customer then grants that
 * application access to their organization inside Operations Center
 * (Connections → shared org access) — without that per-customer org grant
 * the AEMP endpoints return an empty/forbidden fleet. Auth is OAuth2 against
 * Deere's Okta-hosted authorization server (signin.johndeere.com). Deere's
 * docs steer interactive apps to the authorization-code grant; server-to-
 * server AEMP pulls commonly use client-credentials where enabled for the
 * app — scope names and grant availability vary by program tier and region,
 * so both the token URL and scope are overridable per credential. This
 * connector:
 *
 *   1. acquires a bearer token (client_credentials grant by default),
 *   2. pulls the paged /Fleet snapshot with the shared AEMP client,
 *   3. optionally backfills per-machine Location + FaultCode series since
 *      the last sync,
 *   4. hands everything to the shared AEMP normalizer.
 *
 * Read-only by design: no machine-control calls exist in this integration.
 *
 * Demo mode: credentials with baseUrl "mock://john_deere" route the same
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

const PROVIDER = 'john_deere';
const DEFAULT_BASE_URL = 'https://partnerapi.deere.com/aemp';
const DEFAULT_TOKEN_URL = 'https://signin.johndeere.com/oauth2/aus78tnlaysMraFhC1t7/v1/token';

/** How far back to request per-machine series on first sync. */
const FIRST_SYNC_LOOKBACK_MS = 24 * 3600_000;

/** Deere construction models (crawler dozers, loaders, excavators, ADTs...). */
const CATEGORY_BY_MODEL: Array<[RegExp, string]> = [
  [/^(850|1050)K/i, 'Dozer'],
  [/^(644|744|824)/, 'Wheel Loader'],
  [/^(870|470|350)G/i, 'Excavator'],
  [/^460E/i, 'Articulated Truck'],
  [/^772G/i, 'Motor Grader'],
  [/^333G/i, 'Compact Track Loader'],
];

function deereCategory(model: string): string | undefined {
  for (const [re, cat] of CATEGORY_BY_MODEL) if (re.test(model)) return cat;
  return undefined;
}

async function fetchOAuthToken(ctx: ConnectorContext): Promise<string> {
  const { clientId, clientSecret, tokenUrl, scope } = ctx.credentials;
  if (!clientId || !clientSecret) {
    throw new Error('john_deere: clientId and clientSecret are required');
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
  if (!res.ok) throw new Error(`john_deere: token endpoint HTTP ${res.status}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error('john_deere: token response missing access_token');
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
  displayName: 'John Deere JDLink',
  oemPortal: 'https://developer.deere.com',
  aemp2: true,
  authType: 'oauth2',
  capabilities: [
    'location', 'location_history', 'engine_hours', 'idle_hours', 'fuel_percent',
    'fuel_used_l', 'def_percent', 'engine_status', 'utilization_pct', 'fault_codes',
    'odometer_km', 'payload_tons',
  ],
  notes:
    'ISO 15143-3 via John Deere Operations Center (developer.deere.com); OAuth2. ' +
    'Each customer must grant the app access to their organization in Operations Center. Read-only.',
};

export const johnDeereConnector: TelematicsConnector = {
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
      const snap = normalizeAempEquipment(eq, { defaultCategory: deereCategory });
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

    ctx.log(`john_deere: ${snapshots.length} machines, ${warnings.length} warnings`);
    return { provider: PROVIDER, snapshots, warnings };
  },
};
