import { create } from 'zustand';
import type { AssetStateRow, Jobsite } from '../api/types';
import { api } from '../api/client';
import type { IconName } from '../ui/icons';

export type ModuleId =
  | 'jobsites'
  | 'equipment'
  | 'tools'
  | 'fleet'
  | 'cameras'
  | 'connectivity'
  | 'insights'
  | 'reports'
  | 'timecards'
  | 'safety'
  | 'connectors';

interface AppState {
  module: ModuleId;
  setModule: (m: ModuleId) => void;

  /** Wide overlay drawer for content-heavy modules (reports, timecards...). */
  wideOpen: boolean;
  setWideOpen: (open: boolean) => void;

  selectedAssetId: number | null;
  selectAsset: (id: number | null) => void;
  selectedJobsiteId: number | null;
  selectJobsite: (id: number | null) => void;

  /** When set, the next map tap posts a manual position for this asset. */
  positionDropAssetId: number | null;
  armPositionDrop: (assetId: number | null) => void;

  /** Live data polled by App. */
  assets: AssetStateRow[];
  jobsites: Jobsite[];
  lastPollAt: string | null;
  pollError: string | null;
  refresh: () => Promise<void>;

  /** Bumped after any mutation so open panels refetch. */
  dataVersion: number;
  bumpVersion: () => void;

  mapStyle: 'satellite' | 'streets';
  setMapStyle: (s: 'satellite' | 'streets') => void;

  rightOpen: boolean;
  setRightOpen: (open: boolean) => void;
}

export const useApp = create<AppState>((set, get) => ({
  module: 'equipment',
  setModule: (m) => set({ module: m, wideOpen: WIDE_MODULES.has(m) }),

  wideOpen: false,
  setWideOpen: (open) => set({ wideOpen: open }),

  selectedAssetId: null,
  selectAsset: (id) =>
    set({ selectedAssetId: id, selectedJobsiteId: null, rightOpen: id !== null ? true : get().rightOpen }),
  selectedJobsiteId: null,
  selectJobsite: (id) =>
    set({ selectedJobsiteId: id, selectedAssetId: null, rightOpen: id !== null ? true : get().rightOpen }),

  positionDropAssetId: null,
  armPositionDrop: (assetId) => set({ positionDropAssetId: assetId }),

  assets: [],
  jobsites: [],
  lastPollAt: null,
  pollError: null,
  refresh: async () => {
    try {
      const [assets, jobsites] = await Promise.all([
        api.get<AssetStateRow[]>('/assets/state'),
        api.get<Jobsite[]>('/jobsites'),
      ]);
      set({ assets, jobsites, lastPollAt: new Date().toISOString(), pollError: null });
    } catch (err) {
      set({ pollError: (err as Error).message });
    }
  },

  dataVersion: 0,
  bumpVersion: () => set({ dataVersion: get().dataVersion + 1 }),

  mapStyle: 'satellite',
  setMapStyle: (s) => set({ mapStyle: s }),

  rightOpen: true,
  setRightOpen: (open) => set({ rightOpen: open }),
}));

/** Modules whose panel opens as a wide drawer over the map. */
export const WIDE_MODULES = new Set<ModuleId>(['insights', 'reports', 'timecards', 'safety', 'connectors']);

export interface ModuleDef {
  id: ModuleId;
  label: string;
  /** Compact label for the top tab bar; full label everywhere else. */
  short: string;
  icon: IconName;
}

export const MODULES: ModuleDef[] = [
  { id: 'jobsites', label: 'Jobsites', short: 'Jobsites', icon: 'pin' },
  { id: 'equipment', label: 'Equipment', short: 'Equipment', icon: 'dozer' },
  { id: 'tools', label: 'Small Tools', short: 'Tools', icon: 'toolbox' },
  { id: 'fleet', label: 'Truck Fleet', short: 'Fleet', icon: 'truck' },
  { id: 'cameras', label: 'Cameras', short: 'Cameras', icon: 'camera' },
  { id: 'connectivity', label: 'Connectivity', short: 'Network', icon: 'antenna' },
  { id: 'insights', label: 'AI Insights', short: 'AI', icon: 'spark' },
  { id: 'reports', label: 'Reports', short: 'Reports', icon: 'file' },
  { id: 'timecards', label: 'Timecards', short: 'Timecards', icon: 'clock' },
  { id: 'safety', label: 'Safety', short: 'Safety', icon: 'shield' },
  { id: 'connectors', label: 'Connectors', short: 'OEM', icon: 'plug' },
];
