/**
 * Small Tools panel (left sidebar): the tool-crib checkout board. Every row
 * shows who has the tool and whether it's overdue; checkout/checkin happens
 * in an inline form under the row so the super never leaves the list.
 */

import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useApp } from '../state/store';

interface ToolOut {
  assignment_id: number;
  employee_id: number;
  employee_name: string | null;
  jobsite_id: number | null;
  jobsite_name: string | null;
  checked_out_at: string;
  due_back: string | null;
  overdue: boolean;
}

interface ToolRow {
  id: number;
  name: string;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  jobsite_id: number | null;
  jobsite_name: string | null;
  lat: number | null;
  lng: number | null;
  status: string;
  out: ToolOut | null;
}

interface EmployeeRow {
  id: number;
  name: string;
  role: string;
}

function ago(ts: string | null | undefined): string {
  if (!ts) return 'a while';
  const s = (Date.now() - Date.parse(ts)) / 1000;
  if (!Number.isFinite(s)) return 'a while';
  if (s < 5400) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export default function ToolsPanel() {
  const dataVersion = useApp((s) => s.dataVersion);
  const jobsites = useApp((s) => s.jobsites);
  const selectedId = useApp((s) => s.selectedAssetId);

  const [tools, setTools] = useState<ToolRow[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Inline form: which tool has it open, and whether it's a checkout or checkin.
  const [openId, setOpenId] = useState<number | null>(null);
  const [mode, setMode] = useState<'out' | 'in'>('out');
  const [employeeId, setEmployeeId] = useState('');
  const [jobsiteId, setJobsiteId] = useState('');
  const [dueBack, setDueBack] = useState('');
  const [notes, setNotes] = useState('');
  const [condition, setCondition] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<ToolRow[]>('/tools')
      .then((rows) => {
        if (!cancelled) {
          setTools(rows);
          setLoadError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError((err as Error).message);
      });
    api
      .get<EmployeeRow[]>('/employees')
      .then((rows) => {
        if (!cancelled) setEmployees(rows);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  const openForm = (tool: ToolRow) => {
    setOpenId(tool.id);
    setMode(tool.out ? 'in' : 'out');
    setEmployeeId('');
    setJobsiteId(tool.jobsite_id != null ? String(tool.jobsite_id) : '');
    setDueBack('');
    setNotes('');
    setCondition('');
    setFormError(null);
  };

  const submit = async (tool: ToolRow) => {
    if (mode === 'out' && employeeId === '') {
      setFormError('Pick an employee.');
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      if (mode === 'out') {
        await api.post(`/tools/${tool.id}/checkout`, {
          employee_id: Number(employeeId),
          jobsite_id: jobsiteId === '' ? undefined : Number(jobsiteId),
          due_back: dueBack === '' ? undefined : dueBack,
          notes: notes.trim() === '' ? undefined : notes.trim(),
        });
      } else {
        await api.post(`/tools/${tool.id}/checkin`, {
          condition_in: condition.trim() === '' ? undefined : condition.trim(),
        });
      }
      setOpenId(null);
      useApp.getState().bumpVersion();
      await useApp.getState().refresh();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (tools === null && loadError !== null) return <p className="muted pad">Error: {loadError}</p>;
  if (tools === null) return <p className="muted pad">Loading tools…</p>;

  const outCount = tools.filter((t) => t.out !== null).length;

  return (
    <div>
      <p className="muted" style={{ margin: '6px 4px 4px', fontSize: 12 }}>
        {tools.length} tools · {outCount} checked out
      </p>
      {tools.length === 0 && <p className="muted pad">No small tools registered yet.</p>}

      {tools.map((t) => (
        <div key={t.id}>
          <div
            className={`list-row${t.id === selectedId ? ' selected' : ''}`}
            role="button"
            onClick={() => useApp.getState().selectAsset(t.id)}
          >
            <span className="row-icon">🧰</span>
            <div className="row-main">
              <div className="row-title">{t.name}</div>
              <div className="row-sub">
                {[t.model, t.serial_number ? `SN ${t.serial_number}` : null].filter(Boolean).join(' · ') ||
                  t.make ||
                  'small tool'}
              </div>
            </div>
            <div className="row-end">
              <span style={{ display: 'flex', gap: 4 }}>
                {t.out ? (
                  <>
                    <span className="pill pill-amber">{t.out.employee_name ?? 'checked out'}</span>
                    {t.out.overdue && <span className="pill pill-red">overdue</span>}
                  </>
                ) : (
                  <span className="pill pill-green">In yard</span>
                )}
              </span>
              <button
                className="btn small"
                onClick={(e) => {
                  e.stopPropagation();
                  if (openId === t.id) {
                    setOpenId(null);
                  } else {
                    openForm(t);
                  }
                }}
              >
                {openId === t.id ? 'Close' : t.out ? 'Check in' : 'Check out'}
              </button>
            </div>
          </div>

          {openId === t.id && (
            <div className="card">
              {mode === 'out' ? (
                <>
                  <h3>Check out {t.name}</h3>
                  <label className="field">Employee</label>
                  <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                    <option value="">Select employee…</option>
                    {employees.map((emp) => (
                      <option key={emp.id} value={emp.id}>
                        {emp.name} ({emp.role})
                      </option>
                    ))}
                  </select>
                  <label className="field">Jobsite</label>
                  <select value={jobsiteId} onChange={(e) => setJobsiteId(e.target.value)}>
                    <option value="">No jobsite</option>
                    {jobsites.map((j) => (
                      <option key={j.id} value={j.id}>
                        {j.name}
                      </option>
                    ))}
                  </select>
                  <label className="field">Due back</label>
                  <input type="date" value={dueBack} onChange={(e) => setDueBack(e.target.value)} />
                  <label className="field">Notes (optional)</label>
                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="In the crew truck toolbox"
                  />
                </>
              ) : (
                <>
                  <h3>Check in {t.name}</h3>
                  {t.out && (
                    <p className="muted" style={{ fontSize: 12, margin: '0 0 4px' }}>
                      Out with {t.out.employee_name ?? 'unknown'} since {ago(t.out.checked_out_at)}.
                    </p>
                  )}
                  <label className="field">Condition note (optional)</label>
                  <input
                    type="text"
                    value={condition}
                    onChange={(e) => setCondition(e.target.value)}
                    placeholder="Good — blade getting dull"
                  />
                </>
              )}
              {formError && (
                <p className="muted" style={{ color: 'var(--red)' }}>
                  {formError}
                </p>
              )}
              <button className="btn primary wide" disabled={busy} onClick={() => submit(t)}>
                {busy ? 'Saving…' : mode === 'out' ? 'Check out' : 'Check in'}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
