import { useEffect, useRef, useState } from 'react';
import { MODULES, MODULE_GROUPS, useApp, type ModuleGroup } from '../state/store';
import { Icon } from '../ui/icons';

function GroupTab({
  group,
  open,
  onToggle,
  onSelect,
}: {
  group: ModuleGroup;
  open: boolean;
  onToggle: () => void;
  onSelect: (id: (typeof group.items)[number]) => void;
}) {
  const module = useApp((s) => s.module);
  const activeInGroup = group.items.includes(module);

  // Single-item categories render as a plain direct tab.
  if (group.items.length === 1) {
    const only = group.items[0];
    return (
      <button
        className={`tab${module === only ? ' active' : ''}`}
        onClick={() => onSelect(only)}
      >
        {group.label}
      </button>
    );
  }

  return (
    <div className="nav-group">
      <button
        className={`tab${activeInGroup ? ' active' : ''}${open ? ' open' : ''}`}
        onClick={onToggle}
        aria-expanded={open}
      >
        {group.label}
        <span className="caret">
          <Icon name="chevron-down" size={11} />
        </span>
      </button>
      {open && (
        <div className="nav-menu">
          {group.items.map((id) => {
            const def = MODULES.find((m) => m.id === id)!;
            return (
              <button
                key={id}
                className={`nav-item${module === id ? ' active' : ''}`}
                onClick={() => onSelect(id)}
              >
                <Icon name={def.icon} size={15} />
                {def.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const setModule = useApp((s) => s.setModule);
  const lastPollAt = useApp((s) => s.lastPollAt);
  const pollError = useApp((s) => s.pollError);
  const mapStyle = useApp((s) => s.mapStyle);
  const setMapStyle = useApp((s) => s.setMapStyle);
  const rightOpen = useApp((s) => s.rightOpen);
  const setRightOpen = useApp((s) => s.setRightOpen);

  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const navRef = useRef<HTMLDivElement>(null);

  // Any tap outside the nav closes an open menu.
  useEffect(() => {
    if (!openGroup) return;
    const close = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setOpenGroup(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [openGroup]);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">
          <Icon name="mountain" size={20} />
        </span>
        <span className="brand-name">
          DirtWorks <span className="brand-sub">Ops</span>
        </span>
        <span className="brand-tenant">Summit DirtWorks &amp; Paving</span>
      </div>

      <nav className="module-tabs" aria-label="Modules" ref={navRef}>
        {MODULE_GROUPS.map((g) => (
          <GroupTab
            key={g.id}
            group={g}
            open={openGroup === g.id}
            onToggle={() => setOpenGroup(openGroup === g.id ? null : g.id)}
            onSelect={(id) => {
              setModule(id);
              setOpenGroup(null);
            }}
          />
        ))}
      </nav>

      <div className="topbar-right">
        <span
          className={`sync-dot${pollError ? ' err' : ''}`}
          title={pollError ? `Sync error: ${pollError}` : `Live — last update ${lastPollAt ? new Date(lastPollAt).toLocaleTimeString() : '…'}`}
        />
        <button
          className="ghost-btn"
          onClick={() => setMapStyle(mapStyle === 'satellite' ? 'streets' : 'satellite')}
          title={`Basemap: ${mapStyle} — tap to switch`}
        >
          <Icon name="layers" size={17} />
        </button>
        <button className="ghost-btn" onClick={() => setRightOpen(!rightOpen)} title="Toggle detail panel">
          <Icon name={rightOpen ? 'chevron-right' : 'chevron-left'} size={17} />
        </button>
      </div>
    </header>
  );
}
