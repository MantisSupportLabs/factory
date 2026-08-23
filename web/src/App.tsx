import { Suspense, lazy, useEffect } from 'react';
import { Icon } from './ui/icons';
import { TopBar } from './layout/TopBar';
import { AssetDetail } from './layout/AssetDetail';
import { MapView } from './map/MapView';
import { PANELS } from './panels/registry';
import { MODULES, WIDE_MODULES, useApp } from './state/store';

const JobsiteDetail = lazy(() => import('./panels/JobsiteDetail'));

const POLL_MS = 10_000;

export default function App() {
  const module = useApp((s) => s.module);
  const wideOpen = useApp((s) => s.wideOpen);
  const setWideOpen = useApp((s) => s.setWideOpen);
  const rightOpen = useApp((s) => s.rightOpen);
  const selectedJobsiteId = useApp((s) => s.selectedJobsiteId);
  const refresh = useApp((s) => s.refresh);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const Panel = PANELS[module];
  const moduleDef = MODULES.find((m) => m.id === module)!;
  const isWide = WIDE_MODULES.has(module);

  return (
    <div className={`app${rightOpen ? '' : ' right-closed'}`}>
      <TopBar />
      <aside className="sidebar-left">
        <div className="panel-header">
          <span className="panel-icon">
            <Icon name={moduleDef.icon} size={16} />
          </span>
          <h1>{moduleDef.label}</h1>
          {isWide && (
            <button className="ghost-btn" onClick={() => setWideOpen(!wideOpen)} title="Expand">
              <Icon name={wideOpen ? 'chevron-left' : 'chevron-right'} size={15} />
            </button>
          )}
        </div>
        <div className="panel-body">
          <Suspense fallback={<div className="panel-loading">Loading…</div>}>
            {!isWide || !wideOpen ? <Panel /> : <p className="muted pad">Open in the wide drawer →</p>}
          </Suspense>
        </div>
      </aside>

      <main className="map-area">
        <MapView />
        {isWide && wideOpen && (
          <div className="wide-drawer">
            <div className="wide-head">
              <h1>
                <Icon name={moduleDef.icon} size={16} /> {moduleDef.label}
              </h1>
              <button className="ghost-btn" onClick={() => setWideOpen(false)}>
                <Icon name="x" size={16} />
              </button>
            </div>
            <div className="wide-body">
              <Suspense fallback={<div className="panel-loading">Loading…</div>}>
                <Panel />
              </Suspense>
            </div>
          </div>
        )}
      </main>

      <aside className="sidebar-right">
        <Suspense fallback={<div className="panel-loading">Loading…</div>}>
          {selectedJobsiteId != null ? <JobsiteDetail /> : <AssetDetail />}
        </Suspense>
      </aside>
    </div>
  );
}
