/**
 * Shared ISO 15143-3 / AEMP 2.0 REST client.
 *
 * Any AEMP-compliant OEM endpoint can be consumed with this client; OEM
 * connectors supply auth headers and a base URL and reuse everything else
 * (paging, retries, time-series fetches). Demo credentials point baseUrl at
 * the in-process mock OEM server, so the exact same code path serves demo
 * and production.
 */

import type {
  AempFaultSeriesPage,
  AempFleetPage,
  AempLocationSeriesPage,
} from './types.js';

export interface AempTransport {
  /** Perform a GET against `${baseUrl}${path}` and parse the JSON body. */
  get<T>(path: string): Promise<T>;
}

export interface AempAuth {
  headers(): Promise<Record<string, string>>;
}

/** Static header auth: API keys, pre-fetched OAuth bearer tokens. */
export function staticAuth(headers: Record<string, string>): AempAuth {
  return { headers: async () => headers };
}

const MAX_PAGES = 50; // hard stop so a misbehaving endpoint can't loop us

export function httpTransport(baseUrl: string, auth: AempAuth): AempTransport {
  const root = baseUrl.replace(/\/+$/, '');
  return {
    async get<T>(path: string): Promise<T> {
      const res = await fetch(root + path, {
        headers: {
          Accept: 'application/json',
          ...(await auth.headers()),
        },
      });
      if (!res.ok) {
        throw new Error(`AEMP GET ${path} failed: HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    },
  };
}

export class AempClient {
  constructor(private transport: AempTransport) {}

  /** Fetch every page of the fleet snapshot. */
  async fetchFleet(): Promise<AempFleetPage['Equipment']> {
    const all: AempFleetPage['Equipment'] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.transport.get<AempFleetPage>(`/Fleet/${page}`);
      const equipment = body.Equipment ?? [];
      all.push(...equipment);
      if (!hasNextLink(body.Links) || equipment.length === 0) break;
    }
    return all;
  }

  /** Location time series for one machine between two ISO timestamps. */
  async fetchLocations(
    oemName: string,
    serial: string,
    startIso: string,
    endIso: string,
  ): Promise<AempLocationSeriesPage['Location']> {
    const all: AempLocationSeriesPage['Location'] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.transport.get<AempLocationSeriesPage>(
        `/Equipment/${enc(oemName)}/${enc(serial)}/Locations/${enc(startIso)}/${enc(endIso)}/${page}`,
      );
      const rows = body.Location ?? [];
      all.push(...rows);
      if (!hasNextLink(body.Links) || rows.length === 0) break;
    }
    return all;
  }

  /** Fault code time series for one machine between two ISO timestamps. */
  async fetchFaultCodes(
    oemName: string,
    serial: string,
    startIso: string,
    endIso: string,
  ): Promise<AempFaultSeriesPage['FaultCode']> {
    const all: AempFaultSeriesPage['FaultCode'] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.transport.get<AempFaultSeriesPage>(
        `/Equipment/${enc(oemName)}/${enc(serial)}/FaultCodes/${enc(startIso)}/${enc(endIso)}/${page}`,
      );
      const rows = body.FaultCode ?? [];
      all.push(...rows);
      if (!hasNextLink(body.Links) || rows.length === 0) break;
    }
    return all;
  }
}

function hasNextLink(links?: Array<{ rel: string; href: string }>): boolean {
  return !!links?.some((l) => l.rel.toLowerCase() === 'next');
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
