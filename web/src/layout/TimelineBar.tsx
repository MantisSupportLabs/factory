/**
 * Bottom schedule timeline. One row per jobsite, phase bars spanning their
 * planned dates on a shared time axis, progress fill inside each bar, and a
 * today line. Bars carry schedule status: red = projected behind plan,
 * green = ahead, steel = on track (status comes from the projection engine).
 */

import { useMemo, useState } from 'react';
import type { SchedulePhase, SiteSchedule } from '../api/types';
import { useApp } from '../state/store';
import { Icon } from '../ui/icons';

const DAY = 86_400_000;

function statusColor(s: SchedulePhase['status']): string {
  return s === 'behind' ? 'var(--red)' : s === 'ahead' ? 'var(--green)' : 'var(--line2)';
}

export function TimelineBar() {
  const schedule = useApp((s) => s.schedule);
  const open = useApp((s) => s.timelineOpen);
  const setOpen = useApp((s) => s.setTimelineOpen);
  const selectJobsite = useApp((s) => s.selectJobsite);
  const [tip, setTip] = useState<string | null>(null);

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

  // Month ticks along the axis.
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

  return (
    <div className={`timeline${open ? '' : ' collapsed'}`}>
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
              <SiteRow key={site.jobsite_id} site={site} pos={pos} width={width} onTip={setTip} onSelect={selectJobsite} />
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
}: {
  site: SiteSchedule;
  pos: (ms: number) => string;
  width: (a: number, b: number) => string;
  onTip: (t: string | null) => void;
  onSelect: (id: number) => void;
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
      <div className="timeline-track" style={{ height: laneCount * 20 + 4 }}>
        {bars.map(({ p, a, b, lane }) => {
          return (
            <button
              key={p.phase}
              className={`phase-bar st-${p.status}`}
              style={{ left: pos(a), width: width(a, b), top: 2 + lane * 20, borderColor: statusColor(p.status) }}
              onClick={() => onSelect(site.jobsite_id)}
              onPointerEnter={() =>
                onTip(
                  `${site.code} · ${p.phase} — ${p.pct_complete}% · ${p.start} → ${p.end}` +
                    (p.days_variance != null && p.days_variance !== 0
                      ? ` · projected ${p.days_variance > 0 ? `${p.days_variance}d late` : `${-p.days_variance}d early`}`
                      : ''),
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
