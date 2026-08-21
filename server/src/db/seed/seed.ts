/**
 * Demo seed — "Summit DirtWorks & Paving", the demo tenant.
 *
 * Idempotent: runs at boot only when the tenant doesn't exist yet. Creates
 * jobsites, crew, OEM credentials (pointed at the in-process mock ISO
 * 15143-3 feeds), manually tracked assets (highway trucks, small tools,
 * Ubiquiti cameras, Starlink kits, trailers), production plans, haul
 * tickets, timecards, JSAs, and incidents. Telemetry itself arrives through
 * the real ingestion pipeline on first sync — the seed never fakes
 * telemetry rows.
 */

import { get, run, transaction } from '../../db/database.js';
import { createCredential } from '../../telematics/credentials.js';
import { JOBSITE_ANCHORS } from '../../telematics/mock/fleet-defs.js';
import { config } from '../../config.js';

export function seedIfNeeded(): void {
  const existing = get<{ id: number }>(`SELECT id FROM tenants WHERE slug = ?`, config.defaultTenantSlug);
  if (existing) return;
  console.log('[seed] creating demo tenant Summit DirtWorks & Paving');
  transaction(() => seed());
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function boundaryAround(lat: number, lng: number, radiusM: number): string {
  const mLat = 111_320;
  const mLng = 111_320 * Math.cos((lat * Math.PI) / 180);
  const pts: [number, number][] = [];
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    pts.push([lng + (Math.cos(a) * radiusM) / mLng, lat + (Math.sin(a) * radiusM * 0.8) / mLat]);
  }
  return JSON.stringify({ type: 'Polygon', coordinates: [pts] });
}

function seed(): void {
  const t = Number(
    run(`INSERT INTO tenants (slug, name) VALUES (?, ?)`, config.defaultTenantSlug, 'Summit DirtWorks & Paving').lastInsertRowid,
  );

  /* Jobsites ------------------------------------------------------- */
  const site = (key: keyof typeof JOBSITE_ANCHORS, code: string, sup: string, start: number, end: number, radius: number, notes: string) => {
    const a = JOBSITE_ANCHORS[key];
    return Number(
      run(
        `INSERT INTO jobsites (tenant_id, name, code, status, lat, lng, boundary, address, superintendent, start_date, end_date, notes)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`,
        t, a.name, code, a.lat, a.lng, boundaryAround(a.lat, a.lng, radius),
        'Tarrant/Wise County, TX', sup, isoDaysAgo(start), isoDaysAgo(-end), notes,
      ).lastInsertRowid,
    );
  };
  const us287 = site('us287', 'J-2401', 'R. Delgado', 140, 210, 1400, 'TxDOT widening — 2.1 mi, 480k CY excavation, flex base + paving subgrade.');
  const bluestem = site('bluestem', 'J-2407', 'M. Okafor', 75, 160, 1600, '212-lot subdivision mass grading, 610k CY cut/fill, storm + detention.');
  const eagleMtn = site('eagleMtn', 'J-2410', 'T. Nguyen', 40, 120, 1200, 'Industrial park: 3 pads, haul roads, utilities. Rock in NE corner.');

  /* Crew ----------------------------------------------------------- */
  const emp = (name: string, role: string, phone: string) =>
    Number(run(`INSERT INTO employees (tenant_id, name, role, phone) VALUES (?, ?, ?, ?)`, t, name, role, phone).lastInsertRowid);
  const crew = {
    delgado: emp('Rafael Delgado', 'super', '817-555-0141'),
    okafor: emp('Marcus Okafor', 'super', '817-555-0152'),
    nguyen: emp('Tracy Nguyen', 'super', '817-555-0163'),
    briggs: emp('Dale Briggs', 'foreman', '817-555-0174'),
    soto: emp('Elena Soto', 'operator', '817-555-0185'),
    cole: emp('Jimmy Cole', 'operator', '817-555-0196'),
    tran: emp('Binh Tran', 'operator', '817-555-0107'),
    hayes: emp('Walt Hayes', 'operator', '817-555-0118'),
    price: emp('Dana Price', 'driver', '817-555-0129'),
    burke: emp('Sam Burke', 'driver', '817-555-0130'),
    ortiz: emp('Nina Ortiz', 'laborer', '817-555-0142'),
    reyes: emp('Carlos Reyes', 'mechanic', '817-555-0153'),
  };

  /* OEM credentials → mock ISO 15143-3 feeds ------------------------ */
  const oem = (provider: string, label: string, extra: Record<string, string> = {}) =>
    createCredential({
      tenantId: t,
      provider,
      label,
      authType: 'oauth2',
      credentials: { baseUrl: `mock://${provider}`, clientId: 'demo', clientSecret: 'demo', ...extra },
    });
  oem('caterpillar', 'VisionLink — Summit fleet');
  oem('john_deere', 'JDLink — Summit fleet');
  oem('komatsu', 'KOMTRAX — Summit fleet');
  oem('volvo', 'CareTrack — Summit fleet');
  oem('hitachi', 'ConSite — Summit fleet');
  oem('develon', 'MY DEVELON — Summit fleet');

  /* Manually tracked assets ---------------------------------------- */
  const asset = (
    kind: string, name: string, make: string | null, model: string | null, serial: string | null,
    jobsite: number | null, lat: number | null, lng: number | null,
    opts: { category?: string; operator?: string; meta?: Record<string, unknown>; year?: number } = {},
  ) => {
    const id = Number(
      run(
        `INSERT INTO assets (tenant_id, kind, name, make, model, serial_number, year, category, jobsite_id,
           source, tracking_mode, operator, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'manual', ?, ?)`,
        t, kind, name, make, model, serial, opts.year ?? null, opts.category ?? null, jobsite,
        opts.operator ?? null, opts.meta ? JSON.stringify(opts.meta) : null,
      ).lastInsertRowid,
    );
    if (lat !== null && lng !== null) {
      const ts = new Date().toISOString();
      run(
        `INSERT INTO asset_state (asset_id, tenant_id, ts, lat, lng, location_ts, source)
         VALUES (?, ?, ?, ?, ?, ?, 'manual')`,
        id, t, ts, lat, lng, ts,
      );
      run(
        `INSERT OR IGNORE INTO location_history (tenant_id, asset_id, ts, lat, lng, source)
         VALUES (?, ?, ?, ?, ?, 'manual')`,
        t, id, ts, lat, lng,
      );
    }
    return id;
  };

  const A = JOBSITE_ANCHORS;

  // On-highway tandem dumps (manual until CAN/J1939 trackers go in).
  const truck1 = asset('truck', 'Truck 12 — Kenworth T880', 'Kenworth', 'T880', '1XKZDP9X5LJ290112', us287, A.us287.lat + 0.004, A.us287.lng + 0.006, { category: 'Tandem Dump', operator: 'Dana Price', year: 2020 });
  const truck2 = asset('truck', 'Truck 14 — Kenworth T880', 'Kenworth', 'T880', '1XKZDP9X5LJ290114', bluestem, A.bluestem.lat - 0.003, A.bluestem.lng + 0.004, { category: 'Tandem Dump', operator: 'Sam Burke', year: 2021 });
  const truck3 = asset('truck', 'Truck 15 — Peterbilt 567', 'Peterbilt', '567', '1XPCDP9X3MD450115', bluestem, A.bluestem.lat + 0.005, A.bluestem.lng - 0.005, { category: 'Tandem Dump', year: 2021 });
  asset('truck', 'Water Truck 7 — Freightliner', 'Freightliner', '114SD', '3ALHGLDR8KDKA0107', eagleMtn, A.eagleMtn.lat + 0.002, A.eagleMtn.lng - 0.004, { category: 'Water Truck', operator: 'Walt Hayes', year: 2019 });
  asset('truck', 'Service Truck 3 — Ford F-550', 'Ford', 'F-550', '1FD0W5HT8KEE55103', eagleMtn, A.eagleMtn.lat - 0.004, A.eagleMtn.lng + 0.003, { category: 'Service Truck', operator: 'Carlos Reyes', year: 2022 });

  // Small tools (BLE tags later — same asset rows, source flips to ble_tracker).
  const tool = (name: string, make: string, model: string, serial: string, jobsite: number | null, lat: number | null, lng: number | null) =>
    asset('small_tool', name, make, model, serial, jobsite, lat, lng, { category: 'Small Tool' });
  const plate1 = tool('Plate Compactor 4', 'Wacker Neuson', 'BPU 3050', 'WN-BPU-24-004', us287, A.us287.lat + 0.001, A.us287.lng - 0.002);
  tool('Plate Compactor 5', 'Wacker Neuson', 'BPU 3050', 'WN-BPU-24-005', bluestem, A.bluestem.lat + 0.002, A.bluestem.lng + 0.001);
  const saw1 = tool('Cutoff Saw 2', 'Husqvarna', 'K 970', 'HQ-K970-23-002', us287, A.us287.lat - 0.001, A.us287.lng + 0.001);
  tool('Trench Roller 1', 'Wacker Neuson', 'RTx-SC3', 'WN-RTX-22-001', bluestem, A.bluestem.lat - 0.002, A.bluestem.lng - 0.002);
  const laser1 = tool('Grade Laser 3', 'Topcon', 'RL-H5A', 'TC-RLH5-24-003', eagleMtn, A.eagleMtn.lat + 0.001, A.eagleMtn.lng + 0.001);
  tool('Pipe Laser 1', 'Topcon', 'TP-L6', 'TC-TPL6-23-001', bluestem, A.bluestem.lat + 0.001, A.bluestem.lng - 0.003);
  tool('Trash Pump 6', 'Honda', 'WT30', 'HN-WT30-21-006', eagleMtn, A.eagleMtn.lat - 0.002, A.eagleMtn.lng - 0.001);
  tool('Generator 8 — 7kW', 'Honda', 'EB10000', 'HN-EB10-22-008', us287, A.us287.lat + 0.002, A.us287.lng + 0.003);
  tool('Trench Box 2 — 8x12', 'GME', '8x12 Std', 'GME-812-19-002', bluestem, A.bluestem.lat - 0.001, A.bluestem.lng + 0.002);
  tool('Demo Saw 1', 'Stihl', 'TS 500i', 'ST-TS500-24-001', eagleMtn, A.eagleMtn.lat + 0.003, A.eagleMtn.lng + 0.002);

  // Job trailers.
  const trailerMeta = (kit: string) => ({ starlinkKit: kit, jobsiteLocked: true });
  asset('trailer', 'Job Trailer — US-287', 'Wells Cargo', 'Office 28ft', 'WC-OF28-287', us287, A.us287.lat + 0.0035, A.us287.lng - 0.0045, { meta: trailerMeta('KIT-287') });
  asset('trailer', 'Job Trailer — Bluestem', 'Wells Cargo', 'Office 28ft', 'WC-OF28-BLU', bluestem, A.bluestem.lat - 0.0040, A.bluestem.lng - 0.0035, { meta: trailerMeta('KIT-BLU') });
  asset('trailer', 'Job Trailer — Eagle Mtn', 'Wells Cargo', 'Office 24ft', 'WC-OF24-EGL', eagleMtn, A.eagleMtn.lat - 0.0030, A.eagleMtn.lng + 0.0040, { meta: trailerMeta('KIT-EGL') });

  // Ubiquiti / UniFi Protect cameras at each trailer + laydown.
  const cam = (name: string, model: string, mac: string, jobsite: number, lat: number, lng: number, ip: string) =>
    asset('camera', name, 'Ubiquiti', model, mac, jobsite, lat, lng, {
      category: 'Security Camera',
      meta: { mac, ip, protect: true, rtsp: `rtsps://192.168.1.1:7441/${mac.replaceAll(':', '').toLowerCase()}` },
    });
  cam('287 Trailer Cam N', 'G5 Bullet', '74:AC:B9:11:22:01', us287, A.us287.lat + 0.0036, A.us287.lng - 0.0044, '192.168.10.21');
  cam('287 Laydown Cam', 'G5 Pro', '74:AC:B9:11:22:02', us287, A.us287.lat + 0.0030, A.us287.lng - 0.0050, '192.168.10.22');
  cam('Bluestem Trailer Cam', 'G5 Bullet', '74:AC:B9:33:44:01', bluestem, A.bluestem.lat - 0.0041, A.bluestem.lng - 0.0034, '192.168.20.21');
  cam('Bluestem Fuel Island Cam', 'G5 Turret Ultra', '74:AC:B9:33:44:02', bluestem, A.bluestem.lat - 0.0036, A.bluestem.lng - 0.0040, '192.168.20.22');
  cam('Eagle Mtn Trailer Cam', 'G5 Bullet', '74:AC:B9:55:66:01', eagleMtn, A.eagleMtn.lat - 0.0031, A.eagleMtn.lng + 0.0041, '192.168.30.21');
  cam('Eagle Mtn Gate Cam', 'G5 Pro', '74:AC:B9:55:66:02', eagleMtn, A.eagleMtn.lat - 0.0025, A.eagleMtn.lng + 0.0047, '192.168.30.22');

  // Starlink kits + UniFi gateways feeding each trailer.
  const net = (name: string, model: string, serial: string, jobsite: number, lat: number, lng: number, meta: Record<string, unknown>) =>
    asset('network', name, meta.vendor as string, model, serial, jobsite, lat, lng, { category: meta.category as string, meta });
  net('Starlink — US-287 Trailer', 'Flat High Performance', 'KIT-287', us287, A.us287.lat + 0.0037, A.us287.lng - 0.0043, { vendor: 'SpaceX', category: 'Starlink Kit', service: 'Priority 1TB' });
  net('Starlink — Bluestem Trailer', 'Flat High Performance', 'KIT-BLU', bluestem, A.bluestem.lat - 0.0042, A.bluestem.lng - 0.0033, { vendor: 'SpaceX', category: 'Starlink Kit', service: 'Priority 1TB' });
  net('Starlink — Eagle Mtn Trailer', 'Standard Actuated', 'KIT-EGL', eagleMtn, A.eagleMtn.lat - 0.0032, A.eagleMtn.lng + 0.0042, { vendor: 'SpaceX', category: 'Starlink Kit', service: 'Priority 500GB' });
  net('UDM — US-287 Trailer', 'UDM-SE', 'UDM-287', us287, A.us287.lat + 0.0036, A.us287.lng - 0.0045, { vendor: 'Ubiquiti', category: 'Gateway', wan: 'KIT-287' });
  net('UDM — Bluestem Trailer', 'UDM-SE', 'UDM-BLU', bluestem, A.bluestem.lat - 0.0041, A.bluestem.lng - 0.0035, { vendor: 'Ubiquiti', category: 'Gateway', wan: 'KIT-BLU' });
  net('UDM — Eagle Mtn Trailer', 'UDM-Pro', 'UDM-EGL', eagleMtn, A.eagleMtn.lat - 0.0031, A.eagleMtn.lng + 0.0040, { vendor: 'Ubiquiti', category: 'Gateway', wan: 'KIT-EGL' });

  /* Tool checkouts -------------------------------------------------- */
  run(
    `INSERT INTO tool_assignments (tenant_id, asset_id, jobsite_id, employee_id, checked_out_at, due_back, condition_out, notes)
     VALUES (?, ?, ?, ?, ?, ?, 'good', 'subgrade prep, station 41+00')`,
    t, plate1, us287, crew.ortiz, isoDaysAgo(2) + 'T13:00:00Z', isoDaysAgo(-3),
  );
  run(
    `INSERT INTO tool_assignments (tenant_id, asset_id, jobsite_id, employee_id, checked_out_at, due_back, condition_out)
     VALUES (?, ?, ?, ?, ?, ?, 'good')`,
    t, laser1, eagleMtn, crew.briggs, isoDaysAgo(1) + 'T12:30:00Z', isoDaysAgo(-6),
  );
  run(
    `INSERT INTO tool_assignments (tenant_id, asset_id, jobsite_id, employee_id, checked_out_at, checked_in_at, condition_out, condition_in)
     VALUES (?, ?, ?, ?, ?, ?, 'good', 'blade worn')`,
    t, saw1, us287, crew.cole, isoDaysAgo(4) + 'T14:00:00Z', isoDaysAgo(1) + 'T22:30:00Z',
  );

  /* Production plans ------------------------------------------------ */
  const plan = (jobsite: number, phase: string, activity: string, unit: string, qty: number, hours: number, startD: number, endD: number) =>
    Number(
      run(
        `INSERT INTO production_plans (tenant_id, jobsite_id, phase, activity, unit, planned_qty, planned_hours, planned_start, planned_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        t, jobsite, phase, activity, unit, qty, hours, isoDaysAgo(startD), isoDaysAgo(-endD),
      ).lastInsertRowid,
    );
  const p287cut = plan(us287, 'Earthwork', 'Roadway excavation', 'CY', 480_000, 5200, 120, 90);
  const p287base = plan(us287, 'Paving Prep', 'Flex base placement', 'SY', 96_000, 2100, 30, 150);
  plan(us287, 'Drainage', 'RCP storm main 36-54in', 'LF', 8_400, 1650, 60, 60);
  const pBluCut = plan(bluestem, 'Earthwork', 'Mass excavation cut/fill', 'CY', 610_000, 6800, 70, 110);
  plan(bluestem, 'Drainage', 'Detention pond excavation', 'CY', 88_000, 950, 40, 70);
  plan(bluestem, 'Utilities', 'Storm drain trunk', 'LF', 12_200, 2400, 30, 130);
  const pEglPads = plan(eagleMtn, 'Earthwork', 'Building pad cut/fill', 'CY', 240_000, 2900, 38, 80);
  plan(eagleMtn, 'Roads', 'Haul road construction', 'SY', 42_000, 800, 30, 60);
  plan(eagleMtn, 'Earthwork', 'Rock excavation NE corner', 'CY', 36_000, 1400, 20, 95);

  /* Manual production actuals (AI adds ai_auto rows on top) ---------- */
  const prod = (planId: number, daysAgo: number, qty: number, hours: number) =>
    run(
      `INSERT INTO production_entries (tenant_id, plan_id, date, qty, hours, source, notes)
       VALUES (?, ?, ?, ?, ?, 'manual', 'foreman daily')`,
      t, planId, isoDaysAgo(daysAgo), qty, hours,
    );
  for (let d = 12; d >= 1; d--) {
    prod(p287cut, d, 3400 + (d % 4) * 260, 38 + (d % 3) * 4);
    prod(pBluCut, d, 4900 + (d % 5) * 300, 52 + (d % 4) * 5);
    prod(pEglPads, d, 2600 + (d % 3) * 240, 30 + (d % 3) * 3);
  }
  prod(p287base, 2, 2200, 18);
  prod(p287base, 1, 2450, 19);

  /* Haul cycles ------------------------------------------------------ */
  const haul = (assetId: number, jobsite: number, daysAgo: number, material: string, loads: number, tons: number) =>
    run(
      `INSERT INTO haul_cycles (tenant_id, asset_id, jobsite_id, date, material, loads, tons, cubic_yards, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
      t, assetId, jobsite, isoDaysAgo(daysAgo), material, loads, tons, Math.round(tons * 0.74),
    );
  for (let d = 6; d >= 1; d--) {
    haul(truck1, us287, d, 'Flex base', 9 + (d % 3), (9 + (d % 3)) * 17.5);
    haul(truck2, bluestem, d, 'Select fill', 11 + (d % 4), (11 + (d % 4)) * 16.8);
    haul(truck3, bluestem, d, 'Waste haul-off', 10 + (d % 3), (10 + (d % 3)) * 16.2);
  }

  /* Timecards (yesterday, manual) ------------------------------------ */
  const tc = (empId: number, jobsite: number, hours: number, cost: string) =>
    run(
      `INSERT INTO timecards (tenant_id, employee_id, jobsite_id, date, start_time, end_time, hours, cost_code, source, status)
       VALUES (?, ?, ?, ?, '07:00', ?, ?, ?, 'manual', 'submitted')`,
      t, empId, jobsite, isoDaysAgo(1), hours >= 10 ? '18:00' : '16:30', hours, cost,
    );
  tc(crew.soto, us287, 10, 'EX-100 Roadway Exc');
  tc(crew.cole, us287, 9.5, 'EX-100 Roadway Exc');
  tc(crew.tran, bluestem, 10, 'EX-200 Mass Grading');
  tc(crew.hayes, eagleMtn, 9, 'EX-300 Pad Grading');
  tc(crew.price, us287, 10, 'HL-100 Base Haul');
  tc(crew.burke, bluestem, 10, 'HL-200 Fill Haul');
  tc(crew.ortiz, us287, 9.5, 'GR-110 Subgrade');

  /* Safety ----------------------------------------------------------- */
  run(
    `INSERT INTO jsa_forms (tenant_id, jobsite_id, date, task, hazards, crew, created_by, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'signed')`,
    t, us287, isoDaysAgo(0), 'Excavation near live traffic — station 38+50 to 42+00',
    JSON.stringify([
      { hazard: 'Live traffic adjacent to work zone', control: 'Positive barrier, TCP per TxDOT WZ std, spotters' },
      { hazard: 'Underground utilities (gas marked)', control: '811 tickets current; pothole before crossing; hand dig within 18in' },
      { hazard: 'Heat (forecast 103°F)', control: 'Water/shade/rest cycle, buddy checks after 14:00' },
    ]),
    JSON.stringify(['R. Delgado', 'E. Soto', 'J. Cole', 'N. Ortiz']), 'R. Delgado',
  );
  run(
    `INSERT INTO jsa_forms (tenant_id, jobsite_id, date, task, hazards, crew, created_by, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
    t, bluestem, isoDaysAgo(0), 'Trench work — storm trunk STA 12+00',
    JSON.stringify([
      { hazard: 'Trench collapse >5ft', control: 'Trench box GME 8x12, ladder within 25ft, daily competent-person inspection' },
      { hazard: 'Equipment swing radius', control: 'Exclusion zone flagged, spotter for 870G' },
    ]),
    JSON.stringify(['M. Okafor', 'B. Tran', 'D. Briggs']), 'M. Okafor',
  );
  run(
    `INSERT INTO incidents (tenant_id, jobsite_id, date, type, severity, description, status)
     VALUES (?, ?, ?, 'near_miss', 'medium', ?, 'open')`,
    t, bluestem, isoDaysAgo(2),
    'A40G backed toward grade checker in blind spot; backup alarm functional, spotter repositioned. Toolbox talk held.',
  );
  run(
    `INSERT INTO incidents (tenant_id, jobsite_id, date, type, severity, description, status)
     VALUES (?, ?, ?, 'utility_strike', 'high', ?, 'closed')`,
    t, us287, isoDaysAgo(9),
    'Unmarked 2in PVC irrigation line cut at STA 40+10. No injuries, line repaired, locate ticket audit completed.',
  );

  /* AI settings: everything on by default; field can toggle off ------ */
  for (const feature of ['production_auto', 'timecards_auto', 'projections_auto', 'fault_triage_auto', 'idle_alerts_auto']) {
    run(`INSERT INTO ai_settings (tenant_id, feature, enabled) VALUES (?, ?, 1)`, t, feature);
  }

  console.log('[seed] demo tenant ready');
}
