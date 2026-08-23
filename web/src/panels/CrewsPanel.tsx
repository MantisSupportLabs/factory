/**
 * Crews & Staffing (wide drawer).
 *
 * Job staffing: assign a PM and PE to each jobsite. Crew board: crews with
 * foreman, jobsite, and members; move people in and out; edit roles.
 * Filters: jobsite, role, unassigned-only.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { Crew, CrewMember } from '../api/types';
import { useApp } from '../state/store';
import { Icon } from '../ui/icons';

const ROLES = ['pm', 'pe', 'super', 'foreman', 'operator', 'driver', 'laborer', 'mechanic'];

const roleLabel = (r: string) => (r === 'pm' ? 'PM' : r === 'pe' ? 'PE' : r.charAt(0).toUpperCase() + r.slice(1));
const rolePill = (r: string) =>
  r === 'pm' || r === 'pe' ? 'pill-blue' : r === 'super' || r === 'foreman' ? 'pill-amber' : '';

export default function CrewsPanel() {
  const jobsites = useApp((s) => s.jobsites);
  const schedule = useApp((s) => s.schedule);
  const dataVersion = useApp((s) => s.dataVersion);

  const [crews, setCrews] = useState<Crew[]>([]);
  const [people, setPeople] = useState<CrewMember[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [siteFilter, setSiteFilter] = useState<number | 0>(0);
  const [roleFilter, setRoleFilter] = useState<string>('');
  const [unassignedOnly, setUnassignedOnly] = useState(false);
  const [newCrewName, setNewCrewName] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.get<Crew[]>('/crews'), api.get<CrewMember[]>('/employees')])
      .then(([c, e]) => {
        if (!cancelled) {
          setCrews(c);
          setPeople(e);
          setError(null);
        }
      })
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [dataVersion]);

  const done = () => {
    useApp.getState().bumpVersion();
    useApp.getState().refresh();
  };

  const matches = (m: CrewMember, crewSite: number | null) => {
    if (roleFilter && m.role !== roleFilter) return false;
    if (siteFilter && crewSite !== siteFilter) return false;
    return true;
  };

  const visibleCrews = useMemo(
    () =>
      crews.filter((c) => {
        if (siteFilter && c.jobsite_id !== siteFilter) return false;
        if (unassignedOnly) return false;
        if (roleFilter && !c.members.some((m) => m.role === roleFilter)) return false;
        return true;
      }),
    [crews, siteFilter, roleFilter, unassignedOnly],
  );

  const unassigned = useMemo(
    () =>
      people.filter(
        (p) => p.active === 1 && p.crew_id === null && (!roleFilter || p.role === roleFilter) && !siteFilter,
      ),
    [people, roleFilter, siteFilter],
  );

  const staffPool = people.filter((p) => p.active === 1);

  const setJobStaff = async (jobsiteId: number, field: 'pm_id' | 'pe_id', value: string) => {
    await api.patch(`/jobsites/${jobsiteId}`, { [field]: value ? Number(value) : null });
    done();
  };

  if (error) return <p className="muted pad">Failed to load staffing: {error}</p>;

  return (
    <div>
      {/* -------- job staffing: PM / PE per jobsite -------- */}
      <div className="card">
        <h3>Job staffing — PM / PE</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Status</th>
              <th>Project Manager</th>
              <th>Project Engineer</th>
            </tr>
          </thead>
          <tbody>
            {jobsites.map((j) => {
              const sched = schedule.find((s) => s.jobsite_id === j.id);
              return (
                <tr key={j.id}>
                  <td>
                    <b>{j.code}</b> <span className="muted">{j.name}</span>
                  </td>
                  <td>
                    {sched && (
                      <span
                        className={`pill ${sched.schedule_status === 'behind' ? 'pill-red' : sched.schedule_status === 'ahead' ? 'pill-green' : ''}`}
                      >
                        {sched.schedule_status === 'on_track' ? 'On track' : sched.schedule_status}
                        {sched.days_variance != null && sched.days_variance !== 0
                          ? ` ${sched.days_variance > 0 ? '+' : ''}${sched.days_variance}d`
                          : ''}
                      </span>
                    )}
                  </td>
                  <td>
                    <select
                      value={(j as unknown as { pm_id: number | null }).pm_id ?? ''}
                      onChange={(e) => setJobStaff(j.id, 'pm_id', e.target.value)}
                    >
                      <option value="">— unassigned —</option>
                      {staffPool
                        .filter((p) => p.role === 'pm' || p.role === 'super')
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </td>
                  <td>
                    <select
                      value={(j as unknown as { pe_id: number | null }).pe_id ?? ''}
                      onChange={(e) => setJobStaff(j.id, 'pe_id', e.target.value)}
                    >
                      <option value="">— unassigned —</option>
                      {staffPool
                        .filter((p) => p.role === 'pe' || p.role === 'pm')
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* -------- filters -------- */}
      <div className="card">
        <h3>Filters</h3>
        <div className="row-between" style={{ gap: 10, flexWrap: 'wrap' }}>
          <select value={siteFilter} onChange={(e) => setSiteFilter(Number(e.target.value))} style={{ maxWidth: 240 }}>
            <option value={0}>All jobsites</option>
            {jobsites.map((j) => (
              <option key={j.id} value={j.id}>
                {j.code} — {j.name}
              </option>
            ))}
          </select>
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} style={{ maxWidth: 170 }}>
            <option value="">All roles</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
          <button
            className={`btn small${unassignedOnly ? ' primary' : ''}`}
            onClick={() => setUnassignedOnly(!unassignedOnly)}
          >
            Unassigned only
          </button>
        </div>
      </div>

      {/* -------- crews -------- */}
      {!unassignedOnly &&
        visibleCrews.map((crew) => (
          <div className="card" key={crew.id}>
            <div className="row-between">
              <h3 style={{ margin: 0 }}>
                <Icon name="users" size={13} /> {crew.name}
              </h3>
              <button
                className="btn small danger"
                onClick={async () => {
                  await api.del(`/crews/${crew.id}`);
                  done();
                }}
              >
                Disband
              </button>
            </div>
            <div className="row-between" style={{ margin: '8px 0', gap: 10, flexWrap: 'wrap' }}>
              <label className="field" style={{ margin: 0, flex: 1, minWidth: 180 }}>
                Jobsite
                <select
                  value={crew.jobsite_id ?? ''}
                  onChange={async (e) => {
                    await api.patch(`/crews/${crew.id}`, {
                      jobsite_id: e.target.value ? Number(e.target.value) : null,
                    });
                    done();
                  }}
                >
                  <option value="">— none —</option>
                  {jobsites.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.code} — {j.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field" style={{ margin: 0, flex: 1, minWidth: 180 }}>
                Foreman
                <select
                  value={crew.foreman_id ?? ''}
                  onChange={async (e) => {
                    await api.patch(`/crews/${crew.id}`, {
                      foreman_id: e.target.value ? Number(e.target.value) : null,
                    });
                    done();
                  }}
                >
                  <option value="">— none —</option>
                  {crew.members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Phone</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {crew.members
                  .filter((m) => matches(m, crew.jobsite_id))
                  .map((m) => (
                    <tr key={m.id}>
                      <td>
                        <b>{m.name}</b>{' '}
                        {crew.foreman_id === m.id && <span className="pill pill-amber">Foreman</span>}
                      </td>
                      <td>
                        <select
                          value={m.role}
                          onChange={async (e) => {
                            await api.patch(`/employees/${m.id}`, { role: e.target.value });
                            done();
                          }}
                          style={{ minWidth: 120 }}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {roleLabel(r)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="muted">{m.phone ?? '—'}</td>
                      <td>
                        <button
                          className="btn small"
                          onClick={async () => {
                            await api.del(`/crews/${crew.id}/members/${m.id}`);
                            done();
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>

            <div className="row-between" style={{ marginTop: 8 }}>
              <select
                defaultValue=""
                onChange={async (e) => {
                  if (!e.target.value) return;
                  await api.post(`/crews/${crew.id}/members`, { employee_id: Number(e.target.value) });
                  e.target.value = '';
                  done();
                }}
                style={{ maxWidth: 260 }}
              >
                <option value="">+ Add member…</option>
                {people
                  .filter((p) => p.active === 1 && p.crew_id !== crew.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({roleLabel(p.role)}){p.crew_id ? ' — in another crew' : ''}
                    </option>
                  ))}
              </select>
            </div>
          </div>
        ))}

      {/* -------- unassigned pool -------- */}
      <div className="card">
        <h3>Unassigned ({unassigned.length})</h3>
        {unassigned.length === 0 && <p className="muted">Everyone matching the filters is on a crew.</p>}
        {unassigned.map((p) => (
          <div className="row-between" key={p.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
            <span>
              <b>{p.name}</b> <span className={`pill ${rolePill(p.role)}`}>{roleLabel(p.role)}</span>
            </span>
            <select
              defaultValue=""
              onChange={async (e) => {
                if (!e.target.value) return;
                await api.post(`/crews/${Number(e.target.value)}/members`, { employee_id: p.id });
                done();
              }}
              style={{ maxWidth: 200 }}
            >
              <option value="">Assign to crew…</option>
              {crews.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      {/* -------- new crew -------- */}
      <div className="card">
        <h3>New crew</h3>
        <div className="row-between" style={{ gap: 10 }}>
          <input
            type="text"
            placeholder="Crew name (e.g. Pipe Crew 2)"
            value={newCrewName}
            onChange={(e) => setNewCrewName(e.target.value)}
          />
          <button
            className="btn primary"
            disabled={!newCrewName.trim()}
            onClick={async () => {
              await api.post('/crews', { name: newCrewName.trim() });
              setNewCrewName('');
              done();
            }}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
