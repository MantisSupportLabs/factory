/**
 * Equipment panel (left sidebar): the main machine list. Live rows from the
 * store's polled asset state, filtered to machines/attachments, with search
 * and quick status chips sized for gloved hands.
 */

import { useState } from 'react';
import type { AssetStateRow } from '../api/types';
import { useApp } from '../state/store';
import { Icon } from '../ui/icons';

type Chip = 'all' | 'running' | 'idle' | 'faults';

const CHIPS: Array<{ id: Chip; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'idle', label: 'Idle' },
  { id: 'faults', label: 'Faults' },
];

function fmt(v: number | null | undefined, digits = 0, suffix = ''): string {
  if (v == null || Number.isNaN(v)) return '—';
  return v.toLocaleString(undefined, { maximumFractionDigits: digits }) + suffix;
}

function matchesChip(a: AssetStateRow, chip: Chip): boolean {
  switch (chip) {
    case 'running':
      return a.engine_status === 'running';
    case 'idle':
      return a.engine_status === 'idle';
    case 'faults':
      return a.active_faults > 0;
    default:
      return true;
  }
}

export default function EquipmentPanel() {
  const assets = useApp((s) => s.assets);
  const selectedId = useApp((s) => s.selectedAssetId);
  const pollError = useApp((s) => s.pollError);

  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<Chip>('all');

  const machines = assets.filter((a) => a.kind === 'machine' || a.kind === 'attachment');
  const q = query.trim().toLowerCase();
  const visible = machines.filter((a) => {
    if (!matchesChip(a, chip)) return false;
    if (q === '') return true;
    const hay = `${a.name} ${a.make ?? ''} ${a.model ?? ''} ${a.operator ?? ''}`.toLowerCase();
    return hay.includes(q);
  });

  return (
    <div>
      <input
        type="text"
        placeholder="Search machines…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 6, margin: '8px 0' }}>
        {CHIPS.map((c) => (
          <button
            key={c.id}
            className={`btn small${chip === c.id ? ' primary' : ''}`}
            onClick={() => setChip(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <p className="muted" style={{ margin: '4px 2px 6px', fontSize: 12 }}>
        {visible.length} of {machines.length} machines
      </p>

      {pollError && machines.length === 0 && <p className="muted pad">Error: {pollError}</p>}
      {!pollError && machines.length === 0 && <p className="muted pad">Loading machines…</p>}
      {machines.length > 0 && visible.length === 0 && (
        <p className="muted pad">No machines match this filter.</p>
      )}

      {visible.map((a) => (
        <button
          key={a.id}
          className={`list-row${a.id === selectedId ? ' selected' : ''}`}
          onClick={() => useApp.getState().selectAsset(a.id)}
        >
          <span className="row-icon"><Icon name="dozer" /></span>
          <div className="row-main">
            <div className="row-title">{a.name}</div>
            <div className="row-sub">{[a.make, a.model].filter(Boolean).join(' ') || a.category || 'machine'}</div>
          </div>
          <div className="row-end">
            <span style={{ display: 'flex', gap: 4 }}>
              {a.active_faults > 0 && <span className="pill pill-red">FLT {a.active_faults}</span>}
              <span className={`pill status-${a.engine_status ?? 'unknown'}`}>
                {a.engine_status ?? 'no signal'}
              </span>
            </span>
            <span className="row-sub">
              {fmt(a.fuel_percent, 0, '%')} fuel · {fmt(a.engine_hours, 0, ' h')}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}
