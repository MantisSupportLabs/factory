import { all, get, nowIso, run, transaction } from '../db/database.js';
import { config } from '../config.js';
import { initializeErpSchema } from './schema.js';
import { businessDate } from './calendar.js';
import { initializeWorkforcePlanning, backfillWorkforceSnapshots } from './workforce-planning.js';

function day(offset: number): string {
  return businessDate(offset);
}
/** Illustrative records extend the existing demo, once, without rewriting user data. */
export function initializeErp(): void {
  initializeErpSchema();
  initializeWorkforcePlanning();
  const tenant = get<{id:number}>('SELECT id FROM tenants WHERE slug=?',config.defaultTenantSlug);
  if (!tenant || get('SELECT version FROM erp_seed_versions WHERE tenant_id=? AND version=1',tenant.id)) return;
  transaction(()=>seedDemo(tenant.id));
  backfillWorkforceSnapshots();
}
function seedDemo(t:number): void {
  const projects=all<{id:number;code:string;end_date:string}>('SELECT id,code,end_date FROM jobsites WHERE tenant_id=? ORDER BY id',t);
  const plans=all<{id:number;jobsite_id:number;activity:string;phase:string}>('SELECT id,jobsite_id,activity,phase FROM production_plans WHERE tenant_id=? ORDER BY id',t);
  // Only augment the original named demo jobs; an empty tenant stays empty.
  const demoProjects=projects.filter(p=>['J-2401','J-2407','J-2410'].includes(p.code));
  if (!demoProjects.length) {run('INSERT INTO erp_seed_versions (tenant_id,version) VALUES (?,1)',t);return;}
  const person=(name:string,role:string,phone:string)=> {
    const existing=get<{id:number}>('SELECT id FROM employees WHERE tenant_id=? AND name=?',t,name);
    return existing?.id??Number(run('INSERT INTO employees (tenant_id,name,role,phone,certs) VALUES (?,?,?,?,?)',t,name,role,phone,JSON.stringify(['OSHA 30'])).lastInsertRowid);
  };
  const jordan=person('Jordan Ellis','pm','817-555-0201'),avery=person('Avery Brooks','pm','817-555-0202');
  const budgets:Record<string,{client:string;contract:number;budget:number;pm:number}>= {
    'J-2401':{client:'TxDOT — Fort Worth District',contract:11800000,budget:9800000,pm:jordan},
    'J-2407':{client:'Bluestem Land Partners',contract:8600000,budget:7100000,pm:jordan},
    'J-2410':{client:'Eagle Mountain Industrial LLC',contract:5200000,budget:4300000,pm:avery},
  };
  for (const p of demoProjects) {
    const profile=budgets[p.code]!;
    run('INSERT OR IGNORE INTO project_profiles (tenant_id,jobsite_id,client,pm_id,contract_value,budget) VALUES (?,?,?,?,?,?)',t,p.id,profile.client,profile.pm,profile.contract,profile.budget);
    const projectPlans=plans.filter(plan=>plan.jobsite_id===p.id);
    const weights=p.code==='J-2401'?[0.55,0.27,0.18]:p.code==='J-2407'?[0.6,0.15,0.25]:[0.5,0.18,0.32];
    for (let i=0;i<projectPlans.length;i++) {
      const plan=projectPlans[i]!,costCode=`${p.code.replace('J-','')}-${String((i+1)*100)}`;
      run('INSERT OR IGNORE INTO work_item_profiles (tenant_id,plan_id,cost_code,budget) VALUES (?,?,?,?)',t,plan.id,costCode,Math.round(profile.budget*(weights[i]??1/projectPlans.length)));
    }
  }
  const crewDefinitions=[
    {name:'Roadway Crew',trade:'Earthwork & roads',foreman:'Rafael Delgado',members:['Elena Soto','Jimmy Cole','Dana Price','Nina Ortiz'],code:'J-2401'},
    {name:'Utilities Crew',trade:'Underground utilities',foreman:'Dale Briggs',members:['Binh Tran','Sam Burke'],code:'J-2407'},
    {name:'Mass Grading Crew',trade:'Earthwork & grading',foreman:'Tracy Nguyen',members:['Walt Hayes'],code:'J-2410'},
  ];
  for (const definition of crewDefinitions) {
    const foreman=get<{id:number}>('SELECT id FROM employees WHERE tenant_id=? AND name=? AND active=1',t,definition.foreman);
    const project=demoProjects.find(p=>p.code===definition.code);
    if (!foreman||!project) continue;
    const existingCrew=get<{id:number}>('SELECT id FROM crews WHERE tenant_id=? AND name=?',t,definition.name);
    const crewId=existingCrew?.id??Number(run('INSERT INTO crews (tenant_id,name,trade,foreman_id) VALUES (?,?,?,?)',t,definition.name,definition.trade,foreman.id).lastInsertRowid);
    for (const name of [definition.foreman,...definition.members]) {
      const employee=get<{id:number}>('SELECT id FROM employees WHERE tenant_id=? AND name=? AND active=1',t,name);
      if (employee) run('INSERT OR IGNORE INTO crew_members (tenant_id,crew_id,employee_id) VALUES (?,?,?)',t,crewId,employee.id);
    }
    const plan=plans.find(p=>p.jobsite_id===project.id);
    const profile=plan?get<{cost_code:string}>('SELECT cost_code FROM work_item_profiles WHERE tenant_id=? AND plan_id=?',t,plan.id):undefined;
    if (!plan||!profile) continue;
    run('INSERT OR IGNORE INTO crew_assignments (tenant_id,crew_id,jobsite_id,date,task,cost_code) VALUES (?,?,?,?,?,?)',t,crewId,project.id,day(0),plan.activity,profile.cost_code);
    const status=definition.code==='J-2401'?'approved':definition.code==='J-2407'?'submitted':'draft';
    const result=run(`INSERT OR IGNORE INTO daily_reports (tenant_id,jobsite_id,crew_id,date,weather,notes,rough_pct,status,created_by,submitted_at,approved_at,approved_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,t,project.id,crewId,day(0),'Clear, 82°F',
      'Illustrative demo field report. Quantities and costs require actual field verification before production use.',definition.code==='J-2401'?12:definition.code==='J-2407'?15:8,status,definition.foreman,
      status==='draft'?null:nowIso(),status==='approved'?nowIso():null,status==='approved'?'Jordan Ellis (demo)':null);
    if (result.changes) {
      run(`INSERT INTO daily_report_lines (tenant_id,report_id,plan_id,qty,labor_hours,equipment_hours,labor_cost,equipment_cost,material_cost) VALUES (?,?,?,?,?,?,?,?,?)`,
        t,Number(result.lastInsertRowid),plan.id,definition.code==='J-2401'?3600:definition.code==='J-2407'?5200:2700,
        definition.code==='J-2401'?42:definition.code==='J-2407'?60:34,24,1890,4200,750);
    }
  }
  // These are explicit illustrative opening balances, not machine-hour-derived costs.
  const openingBalances:Record<string,number[]>= {'J-2401':[524000,148000],'J-2407':[468000],'J-2410':[309000]};
  for (const project of demoProjects) {
    const projectPlans=plans.filter(p=>p.jobsite_id===project.id);
    for (let i=0;i<(openingBalances[project.code]?.length??0);i++) {
      const plan=projectPlans[i];if (!plan) continue;
      const profile=get<{cost_code:string}>('SELECT cost_code FROM work_item_profiles WHERE tenant_id=? AND plan_id=?',t,plan.id);if (!profile) continue;
      run('INSERT INTO job_cost_entries (tenant_id,jobsite_id,date,cost_code,category,amount,description) VALUES (?,?,?,?,?,?,?)',
        t,project.id,day(-1),profile.cost_code,'other',openingBalances[project.code]![i]!,'Illustrative demo opening cost balance — replace with accounting imports');
    }
    const b=budgets[project.code]!,health=project.code==='J-2410'?'at_risk':'on_track';
    run(`INSERT OR IGNORE INTO weekly_updates (tenant_id,jobsite_id,pm_id,week_ending,rough_pct,forecast_finish,forecast_cost,health,blockers,next_steps,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      t,project.id,b.pm,day(0),project.code==='J-2401'?12:project.code==='J-2407'?15:8,project.end_date,b.budget*(health==='at_risk'?1.06:1),health,
      health==='at_risk'?'Rock in NE corner; geotechnical review needed':'No critical blockers reported',
      project.code==='J-2407'?'Advance storm trunk and detention pond':'Continue planned earthwork and coordinate next work front',
      'Illustrative PM weekly estimate. Rough completion is independent of measured quantities.');
  }
  run('INSERT INTO erp_seed_versions (tenant_id,version) VALUES (?,1)',t);
}
