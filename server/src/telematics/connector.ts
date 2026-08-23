/**
 * Connector abstraction.
 *
 * A connector adapts exactly one OEM telematics API (or aftermarket feed)
 * to the normalized model. Connectors are registered in a registry keyed by
 * provider slug; the ingestion service and API only ever talk to this
 * interface, so adding an OEM never touches core application code.
 *
 * OEM APIs are treated strictly as READ-ONLY integrations: connectors fetch
 * fleet state and history. No remote start/stop or machine-control paths
 * exist anywhere in this interface, by design.
 */

import type { ConnectorSyncResult, NormalizedAssetSnapshot } from './model.js';

/** Decrypted, provider-specific credential payload for one tenant. */
export interface ConnectorCredentials {
  /** e.g. OAuth2 client id/secret, API key, username/password — per provider. */
  [key: string]: string | undefined;
  /** Base URL override — used to point demo credentials at the mock OEM server. */
  baseUrl?: string;
}

export interface ConnectorContext {
  tenantId: number;
  credentialId: number;
  credentials: ConnectorCredentials;
  /** ISO timestamp of the last successful sync, for incremental fetches. */
  lastSyncAt: string | null;
  log: (msg: string) => void;
}

export interface ConnectorInfo {
  /** Stable slug, e.g. 'caterpillar'. Stored on credentials and assets. */
  provider: string;
  displayName: string;
  oemPortal: string;
  /** True when the OEM exposes an ISO 15143-3 (AEMP 2.0) endpoint we use. */
  aemp2: boolean;
  authType: 'oauth2' | 'api_key' | 'basic';
  /** Which normalized fields this OEM typically reports. */
  capabilities: string[];
  notes?: string;
}

export interface TelematicsConnector {
  readonly info: ConnectorInfo;

  /**
   * Validate that credentials are usable (auth handshake / minimal call).
   * Must not throw for bad credentials — return ok:false with a reason.
   */
  testConnection(ctx: ConnectorContext): Promise<{ ok: boolean; detail: string }>;

  /**
   * Fetch the current fleet snapshot (and whatever history the OEM exposes
   * since lastSyncAt) and return it fully normalized. Read-only.
   */
  sync(ctx: ConnectorContext): Promise<ConnectorSyncResult>;
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

const registry = new Map<string, TelematicsConnector>();

export function registerConnector(connector: TelematicsConnector): void {
  const slug = connector.info.provider;
  if (registry.has(slug)) {
    throw new Error(`Connector already registered for provider '${slug}'`);
  }
  registry.set(slug, connector);
}

export function getConnector(provider: string): TelematicsConnector {
  const c = registry.get(provider);
  if (!c) throw new Error(`No connector registered for provider '${provider}'`);
  return c;
}

export function hasConnector(provider: string): boolean {
  return registry.has(provider);
}

export function listConnectors(): ConnectorInfo[] {
  return [...registry.values()].map((c) => c.info);
}

/** Convenience for connectors: empty result with warnings. */
export function emptyResult(provider: string, warnings: string[] = []): ConnectorSyncResult {
  return { provider, snapshots: [] as NormalizedAssetSnapshot[], warnings };
}
