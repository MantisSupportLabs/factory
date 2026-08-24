/**
 * Bottom schedule timeline. One row per jobsite, phase bars spanning their
 * planned dates on a shared time axis, progress fill inside each bar, and a
 * today line. Bars carry schedule status: red = projected behind plan,
 * green = ahead, steel = on track (status comes from the projection engine).
 *
 * Click to edit: a phase bar opens the schedule editor sheet — every
 * activity's name, unit, quantity, hours, and dates editable inline, plus
 * add-activity and delete; "+ phase" on each row starts a new phase.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { SchedulePhase, SiteSchedule } from '../api/types';
import { useApp } from '../state/store';
import { Icon } from '../ui/icons';

const DAY = 86_400_000;

function statusColor(s: SchedulePhase['status']): string {
  return s === 'behind' ? 'var(--red)' : s === 'ahead' ? 'var(--green)' : 'var(--line2)';
}

interface Editing {
  siteId: number;
  phase: string | null; // null = creating a new phase
}

export function TimelineBar() {
  const schedule = useApp((s) => s.schedule);
  const open = useApp((s) => s.timelineOpen);
  const setOpen = useApp((s) => s.setTimelineOpen);
  const selectJobsite = useApp((s) => s.selectJobsite);
  const [tip, setTip] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);

  const window_ = useMemo(() => {
    const dates: number[] = [];
    for (const site of schedule) {
      for (const p of site.phases) {
        if (p.start) dates.push(Date.parse(p.start));
        if (p.end) dates.push(Date.parse(p.end));
      }
    }
    if (dates.length === 0) return null;
    const min = Math.min(...dates) - 10 * DAY;
    const max = Math.max(...dates) + 10 * DAY;
    return { min, max, span: max - min };
  }, [schedule]);

  if (!window_ || schedule.length === 0) return null;

  const pos = (ms: number) => `${(((ms - window_.min) / window_.span) * 100).toFixed(2)}%`;
  const width = (a: number, b: number) => `${(((b - a) / window_.span) * 100).toFixed(2)}%`;
  const now = Date.now();

  const ticks: { ms: number; label: string }[] = [];
  const d = new Date(window_.min);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCMonth(d.getUTCMonth() + 1);
  while (d.getTime() < window_.max) {
    ticks.push({
      ms: d.getTime(),
      label: d.toLocaleDateString(undefined, { month: 'short', year: d.getUTCMonth() === 0 ? '2-digit' : undefined, timeZone: 'UTC' }),
    });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }

  const behindCount = schedule.filter((s) => s.schedule_status === 'behind').length;
  const aheadCount = schedule.filter((s) => s.schedule_status === 'ahead').length;
  const editingSite = editing ? schedule.find((s) => s.jobsite_id === editing.siteId) : null;

  return (
    <div className={`timeline${open ? '' : ' collapsed'}`}>
      {editing && editingSite && (
        <PhaseEditor site={editingSite} phase={editing.phase} onClose={() => setEditing(null)} />
      )}
      <div className="timeline-head">
        <span className="timeline-title">
          <Icon name="gantt" size={13} /> Schedule
        </span>
        <span className="timeline-legend">
          <i className="lg lg-behind" /> behind {behindCount > 0 && <b className="tl-red">({behindCount})</b>}
          <i className="lg lg-ontrack" /> on track
          <i className="lg lg-ahead" /> ahead {aheadCount > 0 && <b className="tl-green">({aheadCount})</b>}
        </span>
        {tip && <span className="timeline-tip">{tip}</span>}
        <button className="ghost-btn" onClick={() => setOpen(!open)} title={open ? 'Collapse timeline' : 'Expand timeline'}>
          <Icon name="chevron-down" size={14} className={open ? '' : 'flip'} />
        </button>
      </div>

      {open && (
        <div className="timeline-body">
          <div className="timeline-axis">
            {ticks.map((t) => (
              <span key={t.ms} className="tick" style={{ left: pos(t.ms) }}>
                {t.label}
              </span>
            ))}
            <span className="today-flag" style={{ left: pos(now) }}>
              today
            </span>
          </div>
          <div className="timeline-rows">
            <div className="today-line" style={{ left: pos(now) }} />
            {schedule.map((site) => (
              <SiteRow
                key={site.jobsite_id}
                site={site}
                pos={pos}
                width={width}
                onTip={setTip}
                onSelect={selectJobsite}
                onEdit={(phase) => setEditing({ siteId: site.jobsite_id, phase })}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SiteRow({
  site,
  pos,
  width,
  onTip,
  onSelect,
  onEdit,
}: {
  site: SiteSchedule;
  pos: (ms: number) => string;
  width: (a: number, b: number) => string;
  onTip: (t: string | null) => void;
  onSelect: (id: number) => void;
  onEdit: (phase: string | null) => void;
}) {
  const cls =
    site.schedule_status === 'behind' ? 'tl-red' : site.schedule_status === 'ahead' ? 'tl-green' : '';

  // Overlapping phases stack into lanes so names never overprint.
  const sorted = site.phases
    .filter((p) => p.start && p.end)
    .map((p) => ({ p, a: Date.parse(p.start!), b: Date.parse(p.end!) }))
    .sort((x, y) => x.a - y.a);
  const laneEnds: number[] = [];
  const bars = sorted.map((bar) => {
    let lane = laneEnds.findIndex((end) => end <= bar.a);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(bar.b);
    } else {
      laneEnds[lane] = bar.b;
    }
    return { ...bar, lane };
  });
  const laneCount = Math.max(1, laneEnds.length);

  return (
    <div className="timeline-row">
      <button className="timeline-label" onClick={() => onSelect(site.jobsite_id)}>
        <span className={`tl-code ${cls}`}>{site.code}</span>
        <span className="tl-name">{site.name}</span>
        {site.days_variance != null && site.days_variance !== 0 && (
          <span className={`tl-var ${cls}`}>
            {site.days_variance > 0 ? `+${site.days_variance}d` : `${site.days_variance}d`}
          </span>
        )}
      </button>
      <button className="tl-add" title="Add phase" onClick={() => onEdit(null)}>
        +
      </button>
      <div className="timeline-track" style={{ height: laneCount * 20 + 4 }}>
        {bars.map(({ p, a, b, lane }) => {
          return (
            <button
              key={p.phase}
              className={`phase-bar st-${p.status}`}
              style={{ left: pos(a), width: width(a, b), top: 2 + lane * 20, borderColor: statusColor(p.status) }}
              onClick={() => onEdit(p.phase)}
              onPointerEnter={() =>
                onTip(
                  `${site.code} · ${p.phase} — ${p.pct_complete}% · ${p.start} → ${p.end}` +
                    (p.days_variance != null && p.days_variance !== 0
                      ? ` · projected ${p.days_variance > 0 ? `${p.days_variance}d late` : `${-p.days_variance}d early`}`
                      : '') +
                    ' · tap to edit',
                )
              }
              onPointerLeave={() => onTip(null)}
            >
              <span className="phase-fill" style={{ width: `${Math.min(100, p.pct_complete)}%` }} />
              <span className="phase-name">{p.phase}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Click-to-edit sheet                                                 */
/* ------------------------------------------------------------------ */

interface PlanRow {
  id: number;
  phase: string;
  activity: string;
  unit: string;
  planned_qty: number;
  planned_hours: number;
  planned_start: string | null;
  planned_end: string | null;
  pct_complete: number;
}

function isoInDays(days: number): string {
  return new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
}

function PhaseEditor({ site, phase, onClose }: { site: SiteSchedule; phase: string | null; onClose: () => void }) {
  const dataVersion = useApp((s) => s.dataVersion);
  const [rows, setRows] = useState<PlanRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [phaseName, setPhaseName] = useState(phase ?? '');

  useEffect(() => {
    let cancelled = false;
    api
      .get<PlanRow[]>(`/jobsites/${site.jobsite_id}/plans`)
      .then((all) => {
        if (!cancelled) setRows(phase ? all.filter((r) => r.phase === phase) : []);
      })
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [site.jobsite_id, phase, dataVersion]);

  const done = () => {
    useApp.getState().bumpVersion();
    useApp.getState().refresh();
  };

  return (
    <div className="sched-editor">
      <div className="row-between" style={{ marginBottom: 8 }}>
        <h3 className="se-title">
          <Icon name="gantt" size={13} /> {site.code} · {phase ?? 'New phase'}
          <span className="muted" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {' '}
            — schedule editor
          </span>
        </h3>
        <button className="ghost-btn" onClick={onClose}>
          <Icon name="x" size={15} />
        </button>
      </div>
      {error && <p className="muted">Failed to load plans: {error}</p>}

      {phase === null && (
        <label className="field" style={{ maxWidth: 300 }}>
          Phase name
          <input
            type="text"
            placeholder="e.g. Paving, Utilities, Final Grade"
            value={phaseName}
            onChange={(e) => setPhaseName(e.target.value)}
          />
        </label>
      )}

      {rows.length > 0 && (
        <table className="table se-table">
          <thead>
            <tr>
              <th>Activity</th>
              <th>Unit</th>
              <th>Qty</th>
              <th>Hours</th>
              <th>Start</th>
              <th>End</th>
              <th>%</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <ActivityRow key={r.id} row={r} onSaved={done} />
            ))}
          </tbody>
        </table>
      )}

      <AddActivity
        jobsiteId={site.jobsite_id}
        phase={phase ?? phaseName.trim()}
        disabled={phase === null && phaseName.trim() === ''}
        onAdded={done}
      />
    </div>
  );
}

function ActivityRow({ row, onSaved }: { row: PlanRow; onSaved: () => void }) {
  const [v, setV] = useState({
    activity: row.activity,
    unit: row.unit,
    planned_qty: String(row.planned_qty),
    planned_hours: String(row.planned_hours),
    planned_start: row.planned_start ?? '',
    planned_end: row.planned_end ?? '',
  });
  const [busy, setBusy] = useState(false);
  const dirty =
    v.activity !== row.activity ||
    v.unit !== row.unit ||
    Number(v.planned_qty) !== row.planned_qty ||
    Number(v.planned_hours) !== row.planned_hours ||
    v.planned_start !== (row.planned_start ?? '') ||
    v.planned_end !== (row.planned_end ?? '');

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/schedule/plans/${row.id}`, {
        activity: v.activity,
        unit: v.unit,
        planned_qty: Number(v.planned_qty) || 0,
        planned_hours: Number(v.planned_hours) || 0,
        planned_start: v.planned_start || null,
        planned_end: v.planned_end || null,
      });
      onSaved();
    } finally {
      setBusy(false);
    }
  };
  const del = async () => {
    setBusy(true);
    try {
      await api.del(`/schedule/plans/${row.id}`);
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setV({ ...v, [k]: e.target.value });

  return (
    <tr>
      <td style={{ minWidth: 170 }}>
        <input type="text" value={v.activity} onChange={set('activity')} />
      </td>
      <td style={{ width: 70 }}>
        <input type="text" value={v.unit} onChange={set('unit')} />
      </td>
      <td style={{ width: 100 }}>
        <input type="number" value={v.planned_qty} onChange={set('planned_qty')} />
      </td>
      <td style={{ width: 90 }}>
        <input type="number" value={v.planned_hours} onChange={set('planned_hours')} />
      </td>
      <td style={{ width: 140 }}>
        <input type="date" value={v.planned_start} onChange={set('planned_start')} />
      </td>
      <td style={{ width: 140 }}>
        <input type="date" value={v.planned_end} onChange={set('planned_end')} />
      </td>
      <td className="muted" style={{ whiteSpace: 'nowrap' }}>{row.pct_complete}%</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button className="btn small primary" disabled={!dirty || busy} onClick={save}>
          Save
        </button>{' '}
        <button className="btn small danger" disabled={busy} onClick={del}>
          Del
        </button>
      </td>
    </tr>
  );
}

function AddActivity({
  jobsiteId,
  phase,
  disabled,
  onAdded,
}: {
  jobsiteId: number;
  phase: string;
  disabled: boolean;
  onAdded: () => void;
}) {
  const [v, setV] = useState({
    activity: '',
    unit: 'CY',
    qty: '1000',
    hours: '100',
    start: isoInDays(1),
    end: isoInDays(30),
  });
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try {
      await api.post('/schedule/phases', {
        jobsite_id: jobsiteId,
        phase,
        activity: v.activity.trim(),
        unit: v.unit.trim() || 'LS',
        planned_qty: Number(v.qty) || 1,
        planned_hours: Number(v.hours) || 0,
        planned_start: v.start,
        planned_end: v.end,
      });
      setV({ ...v, activity: '' });
      onAdded();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="se-add">
      <input
        type="text"
        placeholder="+ Activity (e.g. Roadway excavation)"
        value={v.activity}
        onChange={(e) => setV({ ...v, activity: e.target.value })}
        style={{ flex: 2, minWidth: 180 }}
      />
      <input type="text" title="Unit" value={v.unit} onChange={(e) => setV({ ...v, unit: e.target.value })} style={{ width: 64 }} />
      <input type="number" title="Quantity" value={v.qty} onChange={(e) => setV({ ...v, qty: e.target.value })} style={{ width: 96 }} />
      <input type="number" title="Hours" value={v.hours} onChange={(e) => setV({ ...v, hours: e.target.value })} style={{ width: 84 }} />
      <input type="date" value={v.start} onChange={(e) => setV({ ...v, start: e.target.value })} style={{ width: 140 }} />
      <input type="date" value={v.end} onChange={(e) => setV({ ...v, end: e.target.value })} style={{ width: 140 }} />
      <button className="btn small primary" disabled={disabled || busy || v.activity.trim() === ''} onClick={add}>
        Add
      </button>
    </div>
  );
}
