import { MODULES, useApp } from '../state/store';

export function TopBar() {
  const module = useApp((s) => s.module);
  const setModule = useApp((s) => s.setModule);
  const lastPollAt = useApp((s) => s.lastPollAt);
  const pollError = useApp((s) => s.pollError);
  const mapStyle = useApp((s) => s.mapStyle);
  const setMapStyle = useApp((s) => s.setMapStyle);
  const rightOpen = useApp((s) => s.rightOpen);
  const setRightOpen = useApp((s) => s.setRightOpen);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">⛰</span>
        <span className="brand-name">
          DirtWorks <span className="brand-sub">Ops</span>
        </span>
        <span className="brand-tenant">Summit DirtWorks &amp; Paving</span>
      </div>

      <nav className="module-tabs" aria-label="Modules">
        {MODULES.map((m) => (
          <button
            key={m.id}
            className={`tab${module === m.id ? ' active' : ''}`}
            onClick={() => setModule(m.id)}
          >
            <span className="tab-icon">{m.icon}</span>
            <span className="tab-label">{m.label}</span>
          </button>
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
          title="Toggle basemap"
        >
          {mapStyle === 'satellite' ? '🛰️' : '🗺️'}
        </button>
        <button className="ghost-btn" onClick={() => setRightOpen(!rightOpen)} title="Toggle detail panel">
          {rightOpen ? '⟩' : '⟨'}
        </button>
      </div>
    </header>
  );
}
