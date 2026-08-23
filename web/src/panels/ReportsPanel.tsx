/**
 * Reports panel (wide drawer): generate a report on demand, browse recent
 * reports in a left-hand list, and read any report's payload rendered
 * generically — arrays of objects as tables, scalar maps as stat tiles,
 * nested objects as sub-sections — with a print button.
 */

import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useApp } from '../state/store';

type ReportKind = 'daily' | 'production' | 'utilization' | 'safety' | 'timecards';

const KINDS: ReportKind[] = ['daily', 'production', 'utilization', 'safety', 'timecards'];

interface ReportListRow {
  id: number;
  jobsite_id: number | null;
  jobsite_name?: string | null;
  date: string;
  kind: string;
  title: string;
  generated_by: string;
  created_at: string;
}

interface ReportFullRow extends ReportListRow {
  payload: unknown;
}

type Scalar = string | number | boolean | null | undefined;

function isScalar(v: unknown): v is Scalar {
  return v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fmtScalar(v: Scalar): string {
  if (v == null) return '—';
  if (typeof v === 'number') return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

function cellText(v: unknown): string {
  if (isScalar(v)) return fmtScalar(v);
  if (Array.isArray(v)) return v.map((x) => (isScalar(x) ? fmtScalar(x) : JSON.stringify(x))).join(', ');
  return JSON.stringify(v);
}

function prettify(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function ago(ts: string | null | undefined): string {
  if (!ts) return 'never';
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function kindPill(kind: string): string {
  if (kind === 'daily') return 'pill pill-blue';
  if (kind === 'production') return 'pill pill-green';
  if (kind === 'utilization') return 'pill pill-amber';
  if (kind === 'safety') return 'pill pill-red';
  return 'pill';
}

/** Table for an array of homogeneous-ish objects — headers are the key union. */
function ObjectTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{prettify(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>{cellText(r[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Recursive generic renderer for one payload section value. */
function SectionBody({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length === 0) return <p className="muted">None recorded.</p>;
    if (value.every((v) => isRecord(v))) return <ObjectTable rows={value as Record<string, unknown>[]} />;
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {value.map((v, i) => (
          <span key={i} className="pill">
            {isScalar(v) ? fmtScalar(v) : JSON.stringify(v)}
          </span>
        ))}
      </div>
    );
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    const scalars = entries.filter(([, v]) => isScalar(v));
    const complex = entries.filter(([, v]) => !isScalar(v));
    return (
      <>
        {scalars.length > 0 && (
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
            {scalars.map(([k, v]) => (
              <div key={k} className="stat">
                <label>{prettify(k)}</label>
                <b>{fmtScalar(v as Scalar)}</b>
              </div>
            ))}
          </div>
        )}
        {complex.map(([k, v]) => (
          <div key={k} style={{ marginTop: 8 }}>
            <div className="muted" style={{ fontSize: 12, fontWeight: 600, margin: '6px 0 4px' }}>{prettify(k)}</div>
            <SectionBody value={v} />
          </div>
        ))}
      </>
    );
  }
  return <p>{fmtScalar(value as Scalar)}</p>;
}

function ReportViewer({ report }: { report: ReportFullRow }) {
  const payload = report.payload;
  const record = isRecord(payload) ? payload : null;

  let jobsiteName: string | null = report.jobsite_name ?? null;
  if (record) {
    const pj = record['jobsite_name'];
    if (typeof pj === 'string') jobsiteName = pj;
  }
  const sections = record
    ? Object.entries(record).filter(([k]) => k !== 'generated_at' && k !== 'jobsite_name')
    : [];

  return (
    <div>
      <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{report.title}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {report.date} · {jobsiteName ?? 'all jobsites'} · generated {ago(report.created_at)} ({report.generated_by})
          </div>
        </div>
        <button className="btn small" onClick={() => window.print()}>
          🖨 Print
        </button>
      </div>
      {Array.isArray(payload) && (
        <div className="card">
          <SectionBody value={payload} />
        </div>
      )}
      {record === null && !Array.isArray(payload) && <p className="muted">Empty report payload.</p>}
      {record !== null && sections.length === 0 && <p className="muted">No sections in this report.</p>}
      {sections.map(([k, v]) => (
        <div key={k} className="card">
          <h3>{prettify(k)}</h3>
          <SectionBody value={v} />
        </div>
      ))}
    </div>
  );
}

function normalizePayload(row: ReportFullRow): ReportFullRow {
  if (typeof row.payload === 'string') {
    try {
      return { ...row, payload: JSON.parse(row.payload) as unknown };
    } catch {
      return row;
    }
  }
  return row;
}

export default function ReportsPanel() {
  const dataVersion = useApp((s) => s.dataVersion);
  const jobsites = useApp((s) => s.jobsites);

  const [kind, setKind] = useState<ReportKind>('daily');
  const [jobsiteId, setJobsiteId] = useState('');
  const [date, setDate] = useState(todayStr());
  const [list, setList] = useState<ReportListRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [report, setReport] = useState<ReportFullRow | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<ReportListRow[]>('/reports')
      .then((rows) => {
        if (!cancelled) {
          setList(rows);
          setListError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setListError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  const openReport = async (id: number) => {
    setViewLoading(true);
    setViewError(null);
    try {
      const full = await api.get<ReportFullRow>(`/reports/${id}`);
      setReport(normalizePayload(full));
    } catch (err) {
      setViewError((err as Error).message);
    } finally {
      setViewLoading(false);
    }
  };

  const generate = async () => {
    setBusy(true);
    setViewError(null);
    try {
      const body: Record<string, unknown> = { kind, date };
      if (jobsiteId !== '') body.jobsite_id = Number(jobsiteId);
      const full = await api.post<ReportFullRow>('/reports/generate', body);
      setReport(normalizePayload(full));
      useApp.getState().bumpVersion();
      await useApp.getState().refresh();
    } catch (err) {
      setViewError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="card">
        <h3>Generate report</h3>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 140px' }}>
            <label className="field">Kind</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as ReportKind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: '1 1 170px' }}>
            <label className="field">Jobsite</label>
            <select value={jobsiteId} onChange={(e) => setJobsiteId(e.target.value)}>
              <option value="">All jobsites</option>
              {jobsites.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: '1 1 150px' }}>
            <label className="field">Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <button className="btn primary" disabled={busy} onClick={() => void generate()}>
            {busy ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start', marginTop: 6 }}>
        <div style={{ flex: '0 1 280px', minWidth: 240 }}>
          {listError && <p className="muted">Error: {listError}</p>}
          {list === null && !listError && <p className="muted">Loading reports…</p>}
          {list !== null && list.length === 0 && <p className="muted">No reports yet — generate one above.</p>}
          {list?.map((r) => (
            <button
              key={r.id}
              className={`list-row${report?.id === r.id ? ' selected' : ''}`}
              onClick={() => void openReport(r.id)}
            >
              <div className="row-main">
                <div className="row-title">{r.title}</div>
                <div className="row-sub">
                  {r.date}
                  {r.jobsite_name ? ` · ${r.jobsite_name}` : ''}
                </div>
              </div>
              <div className="row-end">
                <span className={kindPill(r.kind)}>{r.kind}</span>
                <span className="muted" style={{ fontSize: 11 }}>
                  {ago(r.created_at)}
                </span>
              </div>
            </button>
          ))}
        </div>

        <div style={{ flex: '1 1 360px', minWidth: 0 }}>
          {viewLoading && <p className="muted">Loading report…</p>}
          {viewError && <p className="muted">Error: {viewError}</p>}
          {!viewLoading && !viewError && report === null && (
            <p className="muted">Select a report on the left to read it here.</p>
          )}
          {!viewLoading && report !== null && <ReportViewer report={report} />}
        </div>
      </div>
    </div>
  );
}
