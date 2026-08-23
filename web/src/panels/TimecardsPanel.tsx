/**
 * Timecards panel (wide drawer): the day's timecards with inline hour
 * corrections (PATCH on blur), AI-draft provenance badges, per-row approval,
 * status filter chips, a total-hours footer, and a manual entry form.
 */

import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useApp } from '../state/store';

interface TimecardRow {
  id: number;
  employee_id: number;
  jobsite_id: number | null;
  date: string;
  start_time: string | null;
  end_time: string | null;
  hours: number;
  cost_code: string | null;
  asset_id: number | null;
  source: string;
  status: string;
  corrected: number;
  notes: string | null;
  employee_name: string;
  employee_role: string;
  jobsite_name: string | null;
  asset_name: string | null;
}

interface EmployeeRow {
  id: number;
  name: string;
  role: string;
}

const STATUSES = ['all', 'draft', 'submitted', 'approved'] as const;
type StatusFilter = (typeof STATUSES)[number];

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function statusPill(status: string): string {
  if (status === 'approved') return 'pill pill-green';
  if (status === 'submitted') return 'pill pill-blue';
  return 'pill pill-amber';
}

export default function TimecardsPanel() {
  const dataVersion = useApp((s) => s.dataVersion);
  const jobsites = useApp((s) => s.jobsites);

  const [date, setDate] = useState(todayStr());
  const [status, setStatus] = useState<StatusFilter>('all');
  const [rows, setRows] = useState<TimecardRow[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hoursDraft, setHoursDraft] = useState<Record<number, string | undefined>>({});

  const [formOpen, setFormOpen] = useState(false);
  const [formEmployee, setFormEmployee] = useState('');
  const [formJobsite, setFormJobsite] = useState('');
  const [formHours, setFormHours] = useState('8');
  const [formCostCode, setFormCostCode] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const q = status === 'all' ? '' : `&status=${status}`;
    api
      .get<TimecardRow[]>(`/timecards?date=${date}${q}`)
      .then((r) => {
        if (!cancelled) {
          setRows(r);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [date, status, dataVersion]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<EmployeeRow[]>('/employees')
      .then((e) => {
        if (!cancelled) setEmployees(e);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  const clearDraft = (id: number) => {
    setHoursDraft((d) => {
      const next = { ...d };
      delete next[id];
      return next;
    });
  };

  const commitHours = async (row: TimecardRow) => {
    const draft = hoursDraft[row.id];
    if (draft === undefined) return;
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 24 || parsed === row.hours) {
      clearDraft(row.id);
      return;
    }
    setBusy(true);
    try {
      await api.patch(`/timecards/${row.id}`, { hours: parsed });
      clearDraft(row.id);
      useApp.getState().bumpVersion();
      await useApp.getState().refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const approve = async (id: number) => {
    setBusy(true);
    try {
      await api.post(`/timecards/${id}/approve`);
      useApp.getState().bumpVersion();
      await useApp.getState().refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addManual = async () => {
    if (formEmployee === '') {
      setFormError('Pick an employee first.');
      return;
    }
    const hrs = Number(formHours);
    if (!Number.isFinite(hrs) || hrs <= 0 || hrs > 24) {
      setFormError('Enter hours between 0 and 24.');
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const body: Record<string, unknown> = { employee_id: Number(formEmployee), date, hours: hrs };
      if (formJobsite !== '') body.jobsite_id = Number(formJobsite);
      if (formCostCode.trim() !== '') body.cost_code = formCostCode.trim();
      await api.post('/timecards', body);
      setFormOpen(false);
      setFormEmployee('');
      setFormCostCode('');
      setFormHours('8');
      useApp.getState().bumpVersion();
      await useApp.getState().refresh();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const totalHours = (rows ?? []).reduce((sum, r) => sum + r.hours, 0);

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 180 }} />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {STATUSES.map((s) => (
            <button key={s} className={`btn${status === s ? ' primary' : ''}`} onClick={() => setStatus(s)}>
              {s === 'all' ? 'All' : s}
            </button>
          ))}
        </div>
      </div>
      <p className="muted" style={{ margin: '8px 2px', fontSize: 12 }}>
        AI drafts come from equipment telematics hours — edit any value to correct them.
      </p>

      {error && <p className="muted">Error: {error}</p>}
      {rows === null && !error && <p className="muted">Loading timecards…</p>}
      {rows !== null && rows.length === 0 && (
        <p className="muted">No timecards for {date}. Add one below or run the AI drafts.</p>
      )}

      {rows !== null && rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Role</th>
                <th>Jobsite</th>
                <th>Equipment</th>
                <th>Cost code</th>
                <th>Hours</th>
                <th>Source</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>{r.employee_name}</td>
                  <td className="muted">{r.employee_role}</td>
                  <td>{r.jobsite_name ?? '—'}</td>
                  <td>{r.asset_name ?? '—'}</td>
                  <td>{r.cost_code ?? '—'}</td>
                  <td>
                    <input
                      type="number"
                      step={0.5}
                      min={0}
                      max={24}
                      value={hoursDraft[r.id] ?? String(r.hours)}
                      style={{ width: 88 }}
                      onChange={(e) => {
                        const v = e.target.value;
                        setHoursDraft((d) => ({ ...d, [r.id]: v }));
                      }}
                      onBlur={() => void commitHours(r)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.currentTarget.blur();
                      }}
                    />
                  </td>
                  <td>
                    {r.source === 'ai_auto' ? (
                      <span className="pill pill-blue">AI draft</span>
                    ) : (
                      <span className="pill">manual</span>
                    )}
                    {r.corrected === 1 && (
                      <span className="pill pill-amber" style={{ marginLeft: 4 }}>
                        corrected
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={statusPill(r.status)}>{r.status}</span>
                  </td>
                  <td>
                    {r.status !== 'approved' && (
                      <button className="btn small" disabled={busy} onClick={() => void approve(r.id)}>
                        Approve
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} style={{ fontWeight: 700 }}>
                  Total
                </td>
                <td style={{ fontWeight: 700 }}>
                  {totalHours.toLocaleString(undefined, { maximumFractionDigits: 1 })} h
                </td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="card">
        <button className="btn" onClick={() => setFormOpen(!formOpen)}>
          {formOpen ? '− Hide manual entry' : '+ Manual entry'}
        </button>
        {formOpen && (
          <div style={{ marginTop: 6 }}>
            <label className="field">Employee</label>
            <select value={formEmployee} onChange={(e) => setFormEmployee(e.target.value)}>
              <option value="">Select employee…</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.name} — {emp.role}
                </option>
              ))}
            </select>
            <label className="field">Jobsite</label>
            <select value={formJobsite} onChange={(e) => setFormJobsite(e.target.value)}>
              <option value="">No jobsite</option>
              {jobsites.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label className="field">Hours</label>
                <input
                  type="number"
                  step={0.5}
                  min={0}
                  max={24}
                  value={formHours}
                  onChange={(e) => setFormHours(e.target.value)}
                />
              </div>
              <div style={{ flex: 2 }}>
                <label className="field">Cost code</label>
                <input
                  type="text"
                  value={formCostCode}
                  placeholder="e.g. 0210-EXC"
                  onChange={(e) => setFormCostCode(e.target.value)}
                />
              </div>
            </div>
            {formError && <p className="muted">Error: {formError}</p>}
            <button className="btn primary wide" disabled={busy} onClick={() => void addManual()}>
              Add timecard for {date}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
