/**
 * Safety panel (wide drawer): summary stat tiles, the JSA list with expandable
 * hazard/control detail and sign-off actions, an incident log with close
 * actions, plus forms to file a new JSA and report an incident.
 */

import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useApp } from '../state/store';

interface SafetySummary {
  open_jsas: number;
  incidents_30d: number;
  open_incidents: number;
  days_since_recordable: number | null;
}

interface JsaRow {
  id: number;
  jobsite_id: number;
  jobsite_name: string;
  date: string;
  task: string;
  hazards: unknown;
  crew: unknown;
  created_by: string | null;
  status: string;
}

interface IncidentRow {
  id: number;
  jobsite_id: number | null;
  jobsite_name: string | null;
  date: string;
  type: string;
  severity: string;
  description: string;
  status: string;
}

interface HazardPair {
  hazard: string;
  control: string;
}

const INCIDENT_TYPES = ['near_miss', 'first_aid', 'recordable', 'property', 'utility_strike'] as const;
const SEVERITIES = ['low', 'medium', 'high'] as const;

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseHazards(raw: unknown): HazardPair[] {
  let v: unknown = raw;
  if (typeof v === 'string') {
    const s = v;
    try {
      v = JSON.parse(s);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v
    .filter((h): h is Record<string, unknown> => typeof h === 'object' && h !== null)
    .map((h) => ({ hazard: String(h.hazard ?? ''), control: String(h.control ?? '') }));
}

function parseCrew(raw: unknown): string[] {
  let v: unknown = raw;
  if (typeof v === 'string') {
    const s = v;
    try {
      v = JSON.parse(s);
    } catch {
      return s.length > 0 ? [s] : [];
    }
  }
  if (!Array.isArray(v)) return [];
  return v.map((n) => String(n)).filter((n) => n.length > 0);
}

function jsaStatusPill(status: string): string {
  if (status === 'open') return 'pill pill-amber';
  if (status === 'signed') return 'pill pill-green';
  return 'pill';
}

function typePill(type: string): string {
  if (type === 'recordable' || type === 'utility_strike') return 'pill pill-red';
  if (type === 'near_miss') return 'pill pill-amber';
  if (type === 'first_aid') return 'pill pill-blue';
  return 'pill';
}

function severityPill(sev: string): string {
  if (sev === 'high' || sev === 'critical') return 'pill pill-red';
  if (sev === 'medium') return 'pill pill-amber';
  return 'pill';
}

export default function SafetyPanel() {
  const dataVersion = useApp((s) => s.dataVersion);
  const jobsites = useApp((s) => s.jobsites);

  const [summary, setSummary] = useState<SafetySummary | null>(null);
  const [jsas, setJsas] = useState<JsaRow[] | null>(null);
  const [incidents, setIncidents] = useState<IncidentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expandedJsa, setExpandedJsa] = useState<number | null>(null);

  // New JSA form
  const [jsaFormOpen, setJsaFormOpen] = useState(false);
  const [jsaJobsite, setJsaJobsite] = useState('');
  const [jsaDate, setJsaDate] = useState(todayStr());
  const [jsaTask, setJsaTask] = useState('');
  const [jsaHazards, setJsaHazards] = useState<HazardPair[]>([{ hazard: '', control: '' }]);
  const [jsaCrew, setJsaCrew] = useState('');
  const [jsaError, setJsaError] = useState<string | null>(null);

  // Report incident form
  const [incFormOpen, setIncFormOpen] = useState(false);
  const [incJobsite, setIncJobsite] = useState('');
  const [incDate, setIncDate] = useState(todayStr());
  const [incType, setIncType] = useState<string>('near_miss');
  const [incSeverity, setIncSeverity] = useState<string>('low');
  const [incDescription, setIncDescription] = useState('');
  const [incError, setIncError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<SafetySummary>('/safety/summary'),
      api.get<JsaRow[]>('/safety/jsas'),
      api.get<IncidentRow[]>('/safety/incidents'),
    ])
      .then(([s, j, i]) => {
        if (cancelled) return;
        setSummary(s);
        setJsas(j);
        setIncidents(i);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  const patchJsa = async (id: number, status: string) => {
    setBusy(true);
    try {
      await api.patch(`/safety/jsas/${id}`, { status });
      useApp.getState().bumpVersion();
      await useApp.getState().refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const closeIncident = async (id: number) => {
    setBusy(true);
    try {
      await api.patch(`/safety/incidents/${id}`, { status: 'closed' });
      useApp.getState().bumpVersion();
      await useApp.getState().refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setHazardField = (i: number, field: 'hazard' | 'control', value: string) => {
    setJsaHazards((rows) =>
      rows.map((r, idx) => {
        if (idx !== i) return r;
        return field === 'hazard' ? { ...r, hazard: value } : { ...r, control: value };
      }),
    );
  };

  const submitJsa = async () => {
    if (jsaJobsite === '') {
      setJsaError('Pick a jobsite.');
      return;
    }
    if (jsaTask.trim() === '') {
      setJsaError('Describe the task.');
      return;
    }
    const hazards = jsaHazards
      .map((h) => ({ hazard: h.hazard.trim(), control: h.control.trim() }))
      .filter((h) => h.hazard !== '');
    const crew = jsaCrew
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n !== '');
    setBusy(true);
    setJsaError(null);
    try {
      await api.post('/safety/jsas', {
        jobsite_id: Number(jsaJobsite),
        date: jsaDate,
        task: jsaTask.trim(),
        hazards,
        crew,
      });
      setJsaFormOpen(false);
      setJsaTask('');
      setJsaHazards([{ hazard: '', control: '' }]);
      setJsaCrew('');
      useApp.getState().bumpVersion();
      await useApp.getState().refresh();
    } catch (err) {
      setJsaError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitIncident = async () => {
    if (incDescription.trim() === '') {
      setIncError('Describe what happened.');
      return;
    }
    setBusy(true);
    setIncError(null);
    try {
      const body: Record<string, unknown> = {
        date: incDate,
        type: incType,
        severity: incSeverity,
        description: incDescription.trim(),
      };
      if (incJobsite !== '') body.jobsite_id = Number(incJobsite);
      await api.post('/safety/incidents', body);
      setIncFormOpen(false);
      setIncDescription('');
      useApp.getState().bumpVersion();
      await useApp.getState().refresh();
    } catch (err) {
      setIncError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {error && <p className="muted">Error: {error}</p>}
      {summary === null && !error && <p className="muted">Loading safety data…</p>}

      {summary !== null && (
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
          <div className="stat">
            <label>Open JSAs</label>
            <b>{summary.open_jsas}</b>
          </div>
          <div className="stat">
            <label>Incidents (30d)</label>
            <b>{summary.incidents_30d}</b>
          </div>
          <div className="stat">
            <label>Open incidents</label>
            <b>{summary.open_incidents}</b>
          </div>
          <div className="stat">
            <label>Days since recordable</label>
            <b>{summary.days_since_recordable ?? '—'}</b>
          </div>
        </div>
      )}

      <h3 style={{ margin: '18px 2px 6px', fontSize: 14 }}>
        JSAs {jsas !== null && jsas.length > 0 && <span className="pill">{jsas.length}</span>}
      </h3>

      <div className="card">
        <button className="btn" onClick={() => setJsaFormOpen(!jsaFormOpen)}>
          {jsaFormOpen ? '− Hide new JSA' : '+ New JSA'}
        </button>
        {jsaFormOpen && (
          <div style={{ marginTop: 6 }}>
            <label className="field">Jobsite</label>
            <select value={jsaJobsite} onChange={(e) => setJsaJobsite(e.target.value)}>
              <option value="">Select jobsite…</option>
              {jobsites.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
            <label className="field">Date</label>
            <input type="date" value={jsaDate} onChange={(e) => setJsaDate(e.target.value)} />
            <label className="field">Task</label>
            <input
              type="text"
              value={jsaTask}
              placeholder="e.g. Trenching along east utility corridor"
              onChange={(e) => setJsaTask(e.target.value)}
            />
            <label className="field">Hazards &amp; controls</label>
            {jsaHazards.map((h, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <input
                  type="text"
                  value={h.hazard}
                  placeholder="Hazard"
                  onChange={(e) => setHazardField(i, 'hazard', e.target.value)}
                />
                <input
                  type="text"
                  value={h.control}
                  placeholder="Control"
                  onChange={(e) => setHazardField(i, 'control', e.target.value)}
                />
              </div>
            ))}
            <button
              className="btn small"
              onClick={() => setJsaHazards((rows) => [...rows, { hazard: '', control: '' }])}
            >
              + Add hazard
            </button>
            <label className="field">Crew (comma-separated names)</label>
            <input
              type="text"
              value={jsaCrew}
              placeholder="e.g. M. Alvarez, T. Nguyen"
              onChange={(e) => setJsaCrew(e.target.value)}
            />
            {jsaError && <p className="muted">Error: {jsaError}</p>}
            <button className="btn primary wide" disabled={busy} onClick={() => void submitJsa()}>
              File JSA
            </button>
          </div>
        )}
      </div>

      {jsas !== null && jsas.length === 0 && <p className="muted">No JSAs on file yet.</p>}
      {jsas?.map((j) => {
        const hazards = parseHazards(j.hazards);
        const crew = parseCrew(j.crew);
        const open = expandedJsa === j.id;
        return (
          <div key={j.id} className="card">
            <button
              className="list-row"
              style={{ borderBottom: 'none', padding: 0 }}
              onClick={() => setExpandedJsa(open ? null : j.id)}
            >
              <div className="row-main">
                <div className="row-title">{j.task}</div>
                <div className="row-sub">
                  {j.date} · {j.jobsite_name}
                  {j.created_by ? ` · by ${j.created_by}` : ''}
                </div>
              </div>
              <div className="row-end">
                <span className={jsaStatusPill(j.status)}>{j.status}</span>
                <span className="pill">
                  {hazards.length} hazard{hazards.length === 1 ? '' : 's'}
                </span>
              </div>
            </button>
            {open && (
              <div style={{ marginTop: 8 }}>
                {hazards.length === 0 && <p className="muted">No hazards listed.</p>}
                {hazards.length > 0 && (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Hazard</th>
                        <th>Control</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hazards.map((h, i) => (
                        <tr key={i}>
                          <td>{h.hazard}</td>
                          <td>{h.control}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {crew.length > 0 && (
                  <p className="muted" style={{ fontSize: 12, margin: '8px 0' }}>
                    Crew: {crew.join(', ')}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  {j.status === 'open' && (
                    <button className="btn small" disabled={busy} onClick={() => void patchJsa(j.id, 'signed')}>
                      Mark signed
                    </button>
                  )}
                  {j.status !== 'closed' && (
                    <button className="btn small" disabled={busy} onClick={() => void patchJsa(j.id, 'closed')}>
                      Close
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}

      <h3 style={{ margin: '18px 2px 6px', fontSize: 14 }}>
        Incidents{' '}
        {incidents !== null && incidents.some((i) => i.status === 'open') && (
          <span className="pill pill-red">{incidents.filter((i) => i.status === 'open').length} open</span>
        )}
      </h3>

      <div className="card">
        <button className="btn" onClick={() => setIncFormOpen(!incFormOpen)}>
          {incFormOpen ? '− Hide incident form' : '+ Report incident'}
        </button>
        {incFormOpen && (
          <div style={{ marginTop: 6 }}>
            <label className="field">Jobsite</label>
            <select value={incJobsite} onChange={(e) => setIncJobsite(e.target.value)}>
              <option value="">No jobsite</option>
              {jobsites.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
            <label className="field">Date</label>
            <input type="date" value={incDate} onChange={(e) => setIncDate(e.target.value)} />
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label className="field">Type</label>
                <select value={incType} onChange={(e) => setIncType(e.target.value)}>
                  {INCIDENT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label className="field">Severity</label>
                <select value={incSeverity} onChange={(e) => setIncSeverity(e.target.value)}>
                  {SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <label className="field">Description</label>
            <textarea
              value={incDescription}
              placeholder="What happened, who was involved, immediate actions taken…"
              onChange={(e) => setIncDescription(e.target.value)}
            />
            {incError && <p className="muted">Error: {incError}</p>}
            <button className="btn primary wide" disabled={busy} onClick={() => void submitIncident()}>
              Report incident
            </button>
          </div>
        )}
      </div>

      {incidents !== null && incidents.length === 0 && <p className="muted">No incidents on record.</p>}
      {incidents?.map((inc) => (
        <div key={inc.id} className="card">
          <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className={typePill(inc.type)}>{inc.type.replace(/_/g, ' ')}</span>
              <span className={severityPill(inc.severity)}>{inc.severity}</span>
              <span className={inc.status === 'open' ? 'pill pill-amber' : 'pill pill-green'}>{inc.status}</span>
            </div>
            {inc.status === 'open' && (
              <button className="btn small" disabled={busy} onClick={() => void closeIncident(inc.id)}>
                Close
              </button>
            )}
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 13 }}>{inc.description}</p>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>
            {inc.date}
            {inc.jobsite_name ? ` · ${inc.jobsite_name}` : ''}
          </p>
        </div>
      ))}
    </div>
  );
}
