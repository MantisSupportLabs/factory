/**
 * Demo fleet definitions for the mock OEM endpoints (Summit DirtWorks & Paving,
 * the demo tenant). One entry per machine per OEM provider. The simulator
 * turns these into live ISO 15143-3 Fleet payloads.
 */

export interface MockMachineDef {
  equipmentId: string;
  oemName: string;      // AEMP OEMName
  model: string;
  serial: string;
  category: string;
  year: number;
  /** Anchor jobsite key (see JOBSITE_ANCHORS) the machine works at. */
  site: keyof typeof JOBSITE_ANCHORS;
  /** Base cumulative engine hours at simulator epoch. */
  baseHours: number;
  /** Idle fraction personality (0-1) — how much this machine loafs. */
  idleFactor: number;
  /** Work path radius in metres around the site anchor. */
  radiusM: number;
  /** Fuel burn, litres per engine hour. */
  burnLph: number;
  /** Tank size in litres. */
  tankL: number;
  hasDef: boolean;
  /** Trucks report odometer + payload. */
  isHauler?: boolean;
}

/** Demo jobsites (north Fort Worth, TX dirt country). */
export const JOBSITE_ANCHORS = {
  us287: { name: 'US-287 Widening — Phase 2', lat: 33.0532, lng: -97.4682 },
  bluestem: { name: 'Bluestem Ranch — Mass Grading', lat: 33.1121, lng: -97.3205 },
  eagleMtn: { name: 'Eagle Mountain Industrial — Pads & Roads', lat: 32.9312, lng: -97.4488 },
} as const;

export const MOCK_FLEETS: Record<string, MockMachineDef[]> = {
  caterpillar: [
    { equipmentId: 'CAT-D6-4201', oemName: 'Caterpillar', model: 'D6 XE', serial: 'CAT00D6XKXL04201', category: 'Dozer', year: 2022, site: 'us287', baseHours: 3120, idleFactor: 0.22, radiusM: 420, burnLph: 22, tankL: 420, hasDef: true },
    { equipmentId: 'CAT-D8-8817', oemName: 'Caterpillar', model: 'D8T', serial: 'CAT00D8TCFMB8817', category: 'Dozer', year: 2019, site: 'bluestem', baseHours: 7480, idleFactor: 0.18, radiusM: 520, burnLph: 34, tankL: 640, hasDef: true },
    { equipmentId: 'CAT-336-2231', oemName: 'Caterpillar', model: '336', serial: 'CAT0336EKDKS2231', category: 'Excavator', year: 2021, site: 'us287', baseHours: 4110, idleFactor: 0.28, radiusM: 180, burnLph: 25, tankL: 505, hasDef: true },
    { equipmentId: 'CAT-349-0946', oemName: 'Caterpillar', model: '349', serial: 'CAT0349EHBZ20946', category: 'Excavator', year: 2020, site: 'eagleMtn', baseHours: 5230, idleFactor: 0.25, radiusM: 200, burnLph: 32, tankL: 620, hasDef: true },
    { equipmentId: 'CAT-745-3308', oemName: 'Caterpillar', model: '745', serial: 'CAT00745CT4F3308', category: 'Articulated Truck', year: 2021, site: 'bluestem', baseHours: 3890, idleFactor: 0.15, radiusM: 900, burnLph: 28, tankL: 512, hasDef: true, isHauler: true },
    { equipmentId: 'CAT-745-3309', oemName: 'Caterpillar', model: '745', serial: 'CAT00745CT4F3309', category: 'Articulated Truck', year: 2021, site: 'bluestem', baseHours: 3775, idleFactor: 0.17, radiusM: 900, burnLph: 28, tankL: 512, hasDef: true, isHauler: true },
    { equipmentId: 'CAT-140-5512', oemName: 'Caterpillar', model: '140', serial: 'CAT0140HANB95512', category: 'Motor Grader', year: 2022, site: 'us287', baseHours: 2140, idleFactor: 0.20, radiusM: 800, burnLph: 18, tankL: 379, hasDef: true },
    { equipmentId: 'CAT-825-7734', oemName: 'Caterpillar', model: '825K', serial: 'CAT00825KJWL7734', category: 'Soil Compactor', year: 2018, site: 'eagleMtn', baseHours: 6390, idleFactor: 0.24, radiusM: 350, burnLph: 30, tankL: 530, hasDef: false },
  ],
  john_deere: [
    { equipmentId: 'JD-850K-1104', oemName: 'John Deere', model: '850K', serial: '1T0850KXVJF31104', category: 'Dozer', year: 2020, site: 'eagleMtn', baseHours: 4720, idleFactor: 0.21, radiusM: 400, burnLph: 24, tankL: 420, hasDef: true },
    { equipmentId: 'JD-644K-0288', oemName: 'John Deere', model: '644K', serial: '1DW644KZTHF60288', category: 'Wheel Loader', year: 2019, site: 'us287', baseHours: 6110, idleFactor: 0.30, radiusM: 300, burnLph: 16, tankL: 302, hasDef: true },
    { equipmentId: 'JD-870G-7719', oemName: 'John Deere', model: '870G LC', serial: '1FF870GXKKF97719', category: 'Excavator', year: 2021, site: 'bluestem', baseHours: 3310, idleFactor: 0.26, radiusM: 190, burnLph: 30, tankL: 640, hasDef: true },
  ],
  komatsu: [
    { equipmentId: 'KOM-PC490-0871', oemName: 'Komatsu', model: 'PC490LC-11', serial: 'KMTPC240A5700871', category: 'Excavator', year: 2021, site: 'us287', baseHours: 3960, idleFactor: 0.27, radiusM: 210, burnLph: 31, tankL: 651, hasDef: true },
    { equipmentId: 'KOM-D61-2245', oemName: 'Komatsu', model: 'D61PX-24', serial: 'KMT0D101C7702245', category: 'Dozer', year: 2020, site: 'eagleMtn', baseHours: 5140, idleFactor: 0.23, radiusM: 380, burnLph: 19, tankL: 425, hasDef: true },
    { equipmentId: 'KOM-HM400-6633', oemName: 'Komatsu', model: 'HM400-5', serial: 'KMTHM032E1706633', category: 'Articulated Truck', year: 2019, site: 'us287', baseHours: 6870, idleFactor: 0.16, radiusM: 1100, burnLph: 33, tankL: 530, hasDef: true, isHauler: true },
  ],
  volvo: [
    { equipmentId: 'VOL-A40G-4419', oemName: 'Volvo', model: 'A40G', serial: 'VCE0A40GC00344419', category: 'Articulated Truck', year: 2021, site: 'bluestem', baseHours: 4480, idleFactor: 0.14, radiusM: 950, burnLph: 30, tankL: 553, hasDef: true, isHauler: true },
    { equipmentId: 'VOL-A40G-4420', oemName: 'Volvo', model: 'A40G', serial: 'VCE0A40GC00344420', category: 'Articulated Truck', year: 2021, site: 'bluestem', baseHours: 4515, idleFactor: 0.15, radiusM: 950, burnLph: 30, tankL: 553, hasDef: true, isHauler: true },
    { equipmentId: 'VOL-EC480-9107', oemName: 'Volvo', model: 'EC480E', serial: 'VCEC480EL00319107', category: 'Excavator', year: 2020, site: 'bluestem', baseHours: 5580, idleFactor: 0.24, radiusM: 200, burnLph: 33, tankL: 660, hasDef: true },
  ],
  hitachi: [
    // Deliberately idle-heavy so the AI idle-alert path has something to flag.
    { equipmentId: 'HIT-ZX350-2210', oemName: 'Hitachi', model: 'ZX350LC-6', serial: 'HCM1V500J00302210', category: 'Excavator', year: 2019, site: 'eagleMtn', baseHours: 7120, idleFactor: 0.52, radiusM: 190, burnLph: 26, tankL: 630, hasDef: true },
  ],
  develon: [
    { equipmentId: 'DEV-DX225-0034', oemName: 'DEVELON', model: 'DX225LC-7', serial: 'DHKCEBBRC0000034', category: 'Excavator', year: 2023, site: 'us287', baseHours: 890, idleFactor: 0.25, radiusM: 180, burnLph: 21, tankL: 400, hasDef: true },
    { equipmentId: 'DEV-DL420-0198', oemName: 'DEVELON', model: 'DL420-7', serial: 'DHKHELBTP0000198', category: 'Wheel Loader', year: 2022, site: 'eagleMtn', baseHours: 2310, idleFactor: 0.28, radiusM: 320, burnLph: 20, tankL: 340, hasDef: true },
  ],
};
