/**
 * Panel registry: module id → lazily loaded panel component. Every panel is
 * a self-contained default-export component that talks to the API client and
 * the app store; the shell renders it in the left sidebar (or the wide
 * drawer for content-heavy modules).
 */

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { ModuleId } from '../state/store';

export const PANELS: Record<ModuleId, LazyExoticComponent<ComponentType>> = {
  jobsites: lazy(() => import('./JobsitesPanel')),
  equipment: lazy(() => import('./EquipmentPanel')),
  tools: lazy(() => import('./ToolsPanel')),
  fleet: lazy(() => import('./FleetPanel')),
  cameras: lazy(() => import('./CamerasPanel')),
  connectivity: lazy(() => import('./ConnectivityPanel')),
  insights: lazy(() => import('./InsightsPanel')),
  reports: lazy(() => import('./ReportsPanel')),
  timecards: lazy(() => import('./TimecardsPanel')),
  safety: lazy(() => import('./SafetyPanel')),
  connectors: lazy(() => import('./ConnectorsPanel')),
};
