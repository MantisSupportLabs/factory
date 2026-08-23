/**
 * Connectors panel (wide drawer): the OEM telematics registry merged with the
 * tenant's stored credentials (enable / test / sync per credential), plus the
 * ingestion-run audit table.
 */

import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { ConnectorInfo, CredentialRow } from '../api/types';
import { useApp } from '../state/store';

interface TestResult {
  ok: boolean;
  detail: string;
}

interface SyncStats {
  provider: string;
  assetsSeen: number;
  readingsInserted: number;
  readingsDeduped: number;
  faultsSeen: number;
  warnings: string[];
}

interface IngestionRun {
  id: number;
  credential_id: number | null;
  provider: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  assets_seen: number | null;
  readings_inserted: number | null;
  readings_deduped: number | null;
  faults_seen: number | null;
  error: string | null;
}

function ago(ts: string | null | undefined): string {
  if (!ts) return 'never';
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function runStatusClass(status: string): string {
  if (status === 'ok') return 'pill pill-green';
  if (status === 'error') return 'pill pill-red';
  if (status === 'running') return 'pill pill-amber';
  return 'pill';
}

export default function ConnectorsPanel() {
  const dataVersion = useApp((s) => s.dataVersion);

  const [connectors, setConnectors] = useState<ConnectorInfo[] | null>(null);
  const [credentials, setCredentials] = useState<CredentialRow[] | null>(null);
  const [runs, setRuns] = useState<IngestionRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  /** Per-credential inline test/sync result line. */
  const [results, setResults] = useState<Record<number, string>>({});

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<ConnectorInfo[]>('/connectors'),
      api.get<CredentialRow[]>('/credentials'),
      api.get<IngestionRun[]>('/ingestion/runs'),
    ])
      .then(([c, cr, r]) => {
        if (cancelled) return;
        setConnectors(c);
        setCredentials(cr);
        setRuns(r);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  const setResult = (id: number, text: string) =>
    setResults((prev) => ({ ...prev, [id]: text }));

  const toggleEnabled = async (cred: CredentialRow) => {
    setBusyId(cred.id);
    try {
      await api.post(`/credentials/${cred.id}/enabled`, { enabled: cred.enabled !== 1 });
      useApp.getState().bumpVersion();
      await useApp.getState().refresh();
    } catch (err) {
      setResult(cred.id, `Error: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  const testCred = async (id: number) => {
    setBusyId(id);
    setResult(id, 'Testing connection…');
    try {
      const r = await api.post<TestResult>(`/credentials/${id}/test`);
      setResult(id, `${r.ok ? '✔' : '✖'} ${r.detail}`);
    } catch (err) {
      setResult(id, `✖ ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  const syncCred = async (id: number) => {
    setBusyId(id);
    setResult(id, 'Syncing…');
    try {
      const s = await api.post<SyncStats>(`/credentials/${id}/sync`);
      setResult(
        id,
        `Synced — ${s.assetsSeen} assets seen · ${s.readingsInserted} readings inserted · ${s.readingsDeduped} deduped`,
      );
      useApp.getState().bumpVersion();
      await useApp.getState().refresh();
    } catch (err) {
      setResult(id, `Sync failed: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  const loading = connectors === null && error === null;

  return (
    <div>
      {error && <p className="muted">Error: {error}</p>}
      {loading && <p className="muted">Loading connectors…</p>}

      {connectors && credentials && (
        <>
          <h3 style={{ margin: '4px 2px 6px', fontSize: 14 }}>OEM integrations</h3>
          {connectors.map((c) => {
            const creds = credentials.filter((cr) => cr.provider === c.provider);
            return (
              <div key={c.provider} className="card">
                <div className="row-between" style={{ flexWrap: 'wrap' }}>
                  <h3 style={{ margin: 0 }}>{c.displayName}</h3>
                  <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {c.aemp2 && <span className="pill pill-blue">AEMP 2.0 / ISO 15143-3</span>}
                    <span className="pill">{c.authType}</span>
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '8px 0' }}>
                  {c.capabilities.map((cap) => (
                    <span key={cap} className="pill">{cap}</span>
                  ))}
                </div>
                {c.notes && (
                  <p className="muted" style={{ margin: '0 0 8px', fontSize: 12 }}>{c.notes}</p>
                )}

                {creds.length === 0 && (
                  <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                    No credentials on file for this tenant.
                  </p>
                )}
                {creds.map((cr) => (
                  <div
                    key={cr.id}
                    style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10 }}
                  >
                    <div className="row-between">
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600 }}>{cr.label}</div>
                        <div className="muted" style={{ fontSize: 12 }}>
                          Last sync {ago(cr.last_sync_at)}
                          {cr.last_status ? ` · ${cr.last_status}` : ''}
                        </div>
                      </div>
                      <label className="switch" title="Enable scheduled ingestion">
                        <input
                          type="checkbox"
                          checked={cr.enabled === 1}
                          disabled={busyId === cr.id}
                          onChange={() => void toggleEnabled(cr)}
                        />
                        <span className="slider" />
                      </label>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button
                        className="btn small"
                        disabled={busyId === cr.id}
                        onClick={() => void testCred(cr.id)}
                      >
                        Test
                      </button>
                      <button
                        className="btn small"
                        disabled={busyId === cr.id}
                        onClick={() => void syncCred(cr.id)}
                      >
                        Sync now
                      </button>
                    </div>
                    {results[cr.id] && (
                      <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
                        {results[cr.id]}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            );
          })}

          <h3 style={{ margin: '18px 2px 6px', fontSize: 14 }}>Ingestion runs</h3>
          {runs && runs.length === 0 && (
            <p className="muted">No ingestion runs yet — press “Sync now” on a credential above.</p>
          )}
          {runs && runs.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Started</th>
                    <th>Status</th>
                    <th>Assets</th>
                    <th>Inserted</th>
                    <th>Deduped</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td>{r.provider}</td>
                      <td>{ago(r.started_at)}</td>
                      <td>
                        <span className={runStatusClass(r.status)}>{r.status}</span>
                      </td>
                      <td>{r.assets_seen ?? '—'}</td>
                      <td>{r.readings_inserted ?? '—'}</td>
                      <td>{r.readings_deduped ?? '—'}</td>
                      <td className="muted">{r.error ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
