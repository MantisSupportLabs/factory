import { createHash } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { all, get, nowIso, run, transaction } from '../../db/database.js';
import { getErpOverview } from '../../erp/overview.js';
import { assertFinancialSetupEdit, assertProjectOpen, assertProjectStatusEdit } from '../../erp/project-state.js';
import { assertNoIssuedMaterialCost } from '../../erp/procurement.js';
import { assertNoShiftLabor, captureMembership, initializeWorkforcePlanning, snapshotAssignment } from '../../erp/workforce-planning.js';
import { activeEmployee, body, date, dateRange, ErpError, hasEdits, id, nullableText, number, option, optionalPm, related, text, type Body } from '../../erp/validation.js';

export const erpRouter = Router();
function route(handler: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    try { handler(req, res); }
    catch (error) {
      if (error instanceof ErpError) { res.status(error.status).json({error: error.message}); return; }
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        res.status(409).json({error: 'This record conflicts with an existing code, crew membership, assignment, or report for this date'}); return;
      }
      next(error);
    }
  };
}
const projectFields = ['name','code','status','client','pm_id','contract_value','budget','start_date','end_date','superintendent','lat','lng','address'];
function projectPayload(t: number, b: Body) {
  const start = date(b.start_date, 'start_date', true), end = date(b.end_date, 'end_date', true);
  dateRange(start, end);
  return {
    name: text(b.name, 'name', true, 150), code: text(b.code, 'code', true, 50),
    status: option(b.status ?? 'active', 'status', ['planned','active','paused','complete'] as const),
    client: text(b.client, 'client', false, 150), pm_id: optionalPm(t, b.pm_id),
    contract_value: number(b.contract_value ?? 0, 'contract_value'), budget: number(b.budget ?? 0, 'budget'),
    start_date: start, end_date: end, superintendent: nullableText(b.superintendent, 'superintendent', 150),
    lat: number(b.lat ?? 32.9, 'lat', -90, 90), lng: number(b.lng ?? -97.4, 'lng', -180, 180),
    address: nullableText(b.address, 'address', 300),
  };
}
erpRouter.get('/erp/overview', route((req,res) => {res.json(getErpOverview(req.tenant.id,{hidePayrollDetails:Boolean(req.authUser&&['foreman','dispatcher','mechanic'].includes(req.authUser.role))}));}));
erpRouter.post('/erp/projects', route((req,res) => {
  const t = req.tenant.id, p = projectPayload(t, body(req.body));
  assertProjectStatusEdit(t,0,'planned',p.status);
  const projectId = transaction(() => {
    const result = run(`INSERT INTO jobsites (tenant_id,name,code,status,lat,lng,start_date,end_date,superintendent,address) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      t,p.name,p.code,p.status,p.lat,p.lng,p.start_date,p.end_date,p.superintendent,p.address);
    const projectId = Number(result.lastInsertRowid);
    run('INSERT INTO project_profiles (tenant_id,jobsite_id,client,pm_id,contract_value,budget) VALUES (?,?,?,?,?,?)',
      t,projectId,p.client,p.pm_id,p.contract_value,p.budget);
    return projectId;
  });
  res.status(201).json(getErpOverview(t).projects.find(p => p.id === projectId));
}));
erpRouter.patch('/erp/projects/:id', route((req,res) => {
  const t = req.tenant.id, projectId = related(t,'jobsites',req.params.id,'project'), b = body(req.body);
  hasEdits(b,projectFields);
  const existing = get<Body>(`SELECT j.*, p.client, p.pm_id, p.contract_value, p.budget FROM jobsites j
    LEFT JOIN project_profiles p ON p.jobsite_id = j.id AND p.tenant_id = j.tenant_id WHERE j.tenant_id = ? AND j.id = ?`,t,projectId)!;
  const p = projectPayload(t,{...existing,...b});
  assertProjectStatusEdit(t,projectId,existing.status,p.status);
  if(p.contract_value!==existing.contract_value || p.budget!==existing.budget) assertFinancialSetupEdit(t,projectId);
  transaction(() => {
    run('UPDATE jobsites SET name=?,code=?,status=?,lat=?,lng=?,start_date=?,end_date=?,superintendent=?,address=? WHERE tenant_id=? AND id=?',
      p.name,p.code,p.status,p.lat,p.lng,p.start_date,p.end_date,p.superintendent,p.address,t,projectId);
    run(`INSERT INTO project_profiles (tenant_id,jobsite_id,client,pm_id,contract_value,budget) VALUES (?,?,?,?,?,?)
      ON CONFLICT(jobsite_id) DO UPDATE SET client=excluded.client,pm_id=excluded.pm_id,contract_value=excluded.contract_value,budget=excluded.budget`,
      t,projectId,p.client,p.pm_id,p.contract_value,p.budget);
  });
  res.json(getErpOverview(t).projects.find(p => p.id === projectId));
}));
function personPayload(b: Body) {
  const aliases: Record<string,string> = {project_manager:'pm',superintendent:'super'};
  const rawRole = text(b.role,'role');
  const role = option(aliases[rawRole] ?? rawRole,'role',['owner','pm','super','foreman','operator','laborer','driver','mechanic','administrator'] as const);
  let certs: string | null = null;
  if (b.certs !== undefined && b.certs !== null && b.certs !== '') {
    if (Array.isArray(b.certs)) certs = JSON.stringify(b.certs.map(c => text(c,'certification',true,150)));
    else {
      const raw = text(b.certs,'certs',false,4000);
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.some(c => typeof c !== 'string')) throw new Error('invalid');
        certs = JSON.stringify(parsed.map(c => text(c,'certification',true,150)));
      } catch { certs = JSON.stringify(raw.split(',').map(c => c.trim()).filter(Boolean)); }
    }
  }
  const rawActive = b.active ?? 1;
  if (![0,1,true,false].includes(rawActive as number)) throw new ErpError(400,'active must be a boolean or 0/1');
  return {name:text(b.name,'name',true,150),role,phone:nullableText(b.phone,'phone',50),certs,active:rawActive ? 1 : 0};
}
erpRouter.post('/erp/people', route((req,res) => {
  const t=req.tenant.id,p=personPayload(body(req.body));
  const result=run('INSERT INTO employees (tenant_id,name,role,phone,certs,active) VALUES (?,?,?,?,?,?)',t,p.name,p.role,p.phone,p.certs,p.active);
  res.status(201).json(getErpOverview(t).people.find(p=>p.id===Number(result.lastInsertRowid)));
}));
erpRouter.patch('/erp/people/:id', route((req,res) => {
  const t=req.tenant.id,personId=related(t,'employees',req.params.id,'person'),b=body(req.body);
  hasEdits(b,['name','role','phone','certs','active']);
  const existing=get<Body>('SELECT * FROM employees WHERE tenant_id=? AND id=?',t,personId)!;
  const p=personPayload({...existing,...b});
  if (!p.active && get('SELECT employee_id FROM crew_members WHERE tenant_id=? AND employee_id=?',t,personId)) {
    throw new ErpError(409,'Remove this employee from their crew before deactivating them');
  }
  if ((!p.active || !['foreman','super'].includes(p.role)) && get('SELECT id FROM crews WHERE tenant_id=? AND foreman_id=?',t,personId)) {
    throw new ErpError(409,'Assign another qualified crew foreman before changing this employee');
  }
  if ((!p.active || !['pm','super'].includes(p.role)) && get('SELECT jobsite_id FROM project_profiles WHERE tenant_id=? AND pm_id=?',t,personId)) {
    throw new ErpError(409,'Reassign their projects before changing this project manager');
  }
  run('UPDATE employees SET name=?,role=?,phone=?,certs=?,active=? WHERE tenant_id=? AND id=?',p.name,p.role,p.phone,p.certs,p.active,t,personId);
  res.json(getErpOverview(t).people.find(p=>p.id===personId));
}));
function crewPayload(t: number,b: Body,currentId?: number) {
  const foremanId=activeEmployee(t,b.foreman_id,'foreman_id',['foreman','super']);
  if (!Array.isArray(b.members)) throw new ErpError(400,'members must be an array of employee IDs');
  const members=[...new Set([foremanId,...b.members.map(value=>activeEmployee(t,value,'member'))])];
  if (members.length>100) throw new ErpError(400,'A crew can contain at most 100 people');
  for (const memberId of members) {
    const existing=get<{crew_id:number}>('SELECT crew_id FROM crew_members WHERE tenant_id=? AND employee_id=?',t,memberId);
    if (existing && existing.crew_id!==currentId) throw new ErpError(409,'An employee is already assigned to another crew');
  }
  return {name:text(b.name,'name',true,150),trade:text(b.trade,'trade',true,100),foreman_id:foremanId,members};
}
function saveMembers(t:number,crewId:number,members:number[]) {
  run('DELETE FROM crew_members WHERE tenant_id=? AND crew_id=?',t,crewId);
  for (const memberId of members) run('INSERT INTO crew_members (tenant_id,crew_id,employee_id) VALUES (?,?,?)',t,crewId,memberId);
}
erpRouter.post('/erp/crews', route((req,res) => {
  const t=req.tenant.id,c=crewPayload(t,body(req.body));
  const crewId=transaction(()=> {
    const result=run('INSERT INTO crews (tenant_id,name,trade,foreman_id) VALUES (?,?,?,?)',t,c.name,c.trade,c.foreman_id);
    const crewId=Number(result.lastInsertRowid);saveMembers(t,crewId,c.members);captureMembership(t,crewId,'crew_create');return crewId;
  });
  res.status(201).json(getErpOverview(t).crews.find(c=>c.id===crewId));
}));
erpRouter.patch('/erp/crews/:id', route((req,res) => {
  const t=req.tenant.id,crewId=related(t,'crews',req.params.id,'crew'),b=body(req.body);
  hasEdits(b,['name','trade','foreman_id','members']);
  const existing=get<Body>('SELECT * FROM crews WHERE tenant_id=? AND id=?',t,crewId)!;
  const members=all<{employee_id:number}>('SELECT employee_id FROM crew_members WHERE tenant_id=? AND crew_id=?',t,crewId).map(m=>m.employee_id);
  const c=crewPayload(t,{...existing,members,...b},crewId);
  transaction(()=>{run('UPDATE crews SET name=?,trade=?,foreman_id=? WHERE tenant_id=? AND id=?',c.name,c.trade,c.foreman_id,t,crewId);saveMembers(t,crewId,c.members);captureMembership(t,crewId);});
  res.json(getErpOverview(t).crews.find(c=>c.id===crewId));
}));
erpRouter.post('/erp/assignments', route((req,res) => {
  const t=req.tenant.id,b=body(req.body),crewId=related(t,'crews',b.crew_id,'crew_id'),projectId=related(t,'jobsites',b.jobsite_id,'jobsite_id');
  assertProjectOpen(t,projectId);
  const assignmentDate=date(b.date,'date')!;
  if (get('SELECT id FROM crew_assignments WHERE tenant_id=? AND crew_id=? AND date=?',t,crewId,assignmentDate)) throw new ErpError(409,'This crew already has an assignment on this date');
  if (get(`SELECT e.id FROM crew_members m JOIN employees e ON e.id=m.employee_id AND e.tenant_id=m.tenant_id
    WHERE m.tenant_id=? AND m.crew_id=? AND e.active=0`,t,crewId)) throw new ErpError(400,'All crew members must be active');
  if (b.required_certifications!==undefined && (!Array.isArray(b.required_certifications)||b.required_certifications.length>30)) throw new ErpError(400,'required_certifications must be an array of at most 30 certification names');
  const requirements=[...new Set((b.required_certifications as unknown[]|undefined ?? []).map(c=>text(c,'required certification',true,150)))];
  const assignmentId=transaction(()=>{
    const result=run('INSERT INTO crew_assignments (tenant_id,crew_id,jobsite_id,date,task,cost_code) VALUES (?,?,?,?,?,?)',
      t,crewId,projectId,assignmentDate,text(b.task,'task',true,300),text(b.cost_code,'cost_code',true,100));
    const assignmentId=Number(result.lastInsertRowid);snapshotAssignment(t,assignmentId,crewId,assignmentDate,requirements);return assignmentId;
  });
  res.status(201).json(getErpOverview(t).assignments.find(a=>a.id===assignmentId));
}));
erpRouter.delete('/erp/assignments/:id', route((req,res) => {
  const result=run('DELETE FROM crew_assignments WHERE tenant_id=? AND id=?',req.tenant.id,id(req.params.id));
  if (!result.changes) throw new ErpError(404,'Assignment not found');
  res.status(204).send();
}));
erpRouter.post('/erp/work-items', route((req,res) => {
  const t=req.tenant.id,b=body(req.body),projectId=related(t,'jobsites',b.jobsite_id,'jobsite_id');
  assertProjectOpen(t,projectId);
  const start=date(b.planned_start,'planned_start',true),end=date(b.planned_end,'planned_end',true);dateRange(start,end);
  const costCode=text(b.cost_code,'cost_code',true,100);
  if (get(`SELECT p.id FROM production_plans p JOIN work_item_profiles w ON w.plan_id=p.id AND w.tenant_id=p.tenant_id
    WHERE p.tenant_id=? AND p.jobsite_id=? AND w.cost_code=?`,t,projectId,costCode)) throw new ErpError(409,'Use a unique cost code for each work item within this project');
  const phase=text(b.phase,'phase',true,100),activity=text(b.activity,'activity',true,200),unit=text(b.unit,'unit',true,20);
  const qty=number(b.planned_qty,'planned_qty',Number.MIN_VALUE),hours=number(b.planned_hours,'planned_hours',Number.MIN_VALUE),budget=number(b.budget??0,'budget');
  const planId=transaction(()=> {
    const result=run(`INSERT INTO production_plans (tenant_id,jobsite_id,phase,activity,unit,planned_qty,planned_hours,planned_start,planned_end) VALUES (?,?,?,?,?,?,?,?,?)`,t,projectId,phase,activity,unit,qty,hours,start,end);
    const planId=Number(result.lastInsertRowid);
    run('INSERT INTO work_item_profiles (tenant_id,plan_id,cost_code,budget) VALUES (?,?,?,?)',t,planId,costCode,budget);return planId;
  });
  res.status(201).json(getErpOverview(t).work_items.find(w=>w.id===planId));
}));
interface ReportLine {plan_id:number;qty:number;labor_hours:number;equipment_hours:number;labor_cost:number;equipment_cost:number;material_cost:number}
function reportPayload(t:number,b:Body) {
  const projectId=related(t,'jobsites',b.jobsite_id,'jobsite_id'),crewId=related(t,'crews',b.crew_id,'crew_id');
  assertProjectOpen(t,projectId);
  const reportDate=date(b.date,'date')!,status=option(b.status??'draft','status',['draft','submitted'] as const);
  if (!Array.isArray(b.lines) || b.lines.length>200) throw new ErpError(400,'lines must be an array containing at most 200 work items');
  const lines:ReportLine[]=b.lines.map(value=> {
    const line=body(value),planId=related(t,'production_plans',line.plan_id,'plan_id');
    if (!get('SELECT id FROM production_plans WHERE tenant_id=? AND jobsite_id=? AND id=?',t,projectId,planId)) throw new ErpError(400,'Every work item must belong to the report project');
    return {plan_id:planId,qty:number(line.qty??0,'qty'),labor_hours:number(line.labor_hours??0,'labor_hours'),equipment_hours:number(line.equipment_hours??0,'equipment_hours'),
      labor_cost:number(line.labor_cost??0,'labor_cost'),equipment_cost:number(line.equipment_cost??0,'equipment_cost'),material_cost:number(line.material_cost??0,'material_cost')};
  });
  if (new Set(lines.map(l=>l.plan_id)).size!==lines.length) throw new ErpError(400,'A report can contain each work item only once');
  const notes=text(b.notes,'notes',false,10000);
  const hasActivity=lines.some(l=>l.qty>0||l.labor_hours>0||l.equipment_hours>0||l.labor_cost>0||l.equipment_cost>0||l.material_cost>0);
  if (status==='submitted' && !hasActivity && !notes) throw new ErpError(400,'A no-production report needs notes explaining the day');
  return {jobsite_id:projectId,crew_id:crewId,date:reportDate,status,weather:text(b.weather,'weather',false,300),notes,
    rough_pct:b.rough_pct===null || b.rough_pct===undefined || b.rough_pct==='' ? null : number(b.rough_pct,'rough_pct',0,100),
    created_by:text(b.created_by,'created_by',true,150),lines};
}
function insertReportLines(t:number,reportId:number,lines:ReportLine[]) {
  for (const l of lines) run(`INSERT INTO daily_report_lines (tenant_id,report_id,plan_id,qty,labor_hours,equipment_hours,labor_cost,equipment_cost,material_cost) VALUES (?,?,?,?,?,?,?,?,?)`,
    t,reportId,l.plan_id,l.qty,l.labor_hours,l.equipment_hours,l.labor_cost,l.equipment_cost,l.material_cost);
}
erpRouter.post('/erp/daily-reports', route((req,res) => {
  initializeWorkforcePlanning();
  const t=req.tenant.id,b=body(req.body),p=reportPayload(t,b);
  const requestKey=b.client_request_id===undefined?null:text(b.client_request_id,'client_request_id',true,100);
  const payloadHash=createHash('sha256').update(JSON.stringify(p)).digest('hex');
  if(requestKey) {
    const previous=get<{report_id:number;payload_hash:string}>('SELECT report_id,payload_hash FROM daily_report_request_keys WHERE tenant_id=? AND client_request_id=?',t,requestKey);
    if(previous) {
      if(previous.payload_hash!==payloadHash) throw new ErpError(409,'This request key has already been used for a different daily report');
      res.json(getErpOverview(t).daily_reports.find(r=>r.id===previous.report_id));return;
    }
  }
  const reportId=transaction(()=> {
    const result=run(`INSERT INTO daily_reports (tenant_id,jobsite_id,crew_id,date,weather,notes,rough_pct,status,created_by,submitted_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      t,p.jobsite_id,p.crew_id,p.date,p.weather,p.notes,p.rough_pct,p.status,p.created_by,p.status==='submitted'?nowIso():null);
    const reportId=Number(result.lastInsertRowid);insertReportLines(t,reportId,p.lines);
    if(requestKey) run('INSERT INTO daily_report_request_keys(tenant_id,client_request_id,payload_hash,report_id) VALUES(?,?,?,?)',t,requestKey,payloadHash,reportId);
    return reportId;
  });
  res.status(201).json(getErpOverview(t).daily_reports.find(r=>r.id===reportId));
}));
erpRouter.patch('/erp/daily-reports/:id', route((req,res) => {
  const t=req.tenant.id,reportId=related(t,'daily_reports',req.params.id,'report'),b=body(req.body);
  hasEdits(b,['jobsite_id','crew_id','date','weather','notes','rough_pct','created_by','status','lines']);
  const existing=get<Body>('SELECT * FROM daily_reports WHERE tenant_id=? AND id=?',t,reportId)!;
  if (existing.status!=='draft') throw new ErpError(409,'Only draft reports can be edited');
  const lines=all<Body>('SELECT * FROM daily_report_lines WHERE tenant_id=? AND report_id=?',t,reportId);
  const p=reportPayload(t,{...existing,lines,...b});
  transaction(()=> {
    run(`UPDATE daily_reports SET jobsite_id=?,crew_id=?,date=?,weather=?,notes=?,rough_pct=?,status=?,created_by=?,submitted_at=? WHERE tenant_id=? AND id=?`,
      p.jobsite_id,p.crew_id,p.date,p.weather,p.notes,p.rough_pct,p.status,p.created_by,p.status==='submitted'?nowIso():null,t,reportId);
    run('DELETE FROM daily_report_lines WHERE tenant_id=? AND report_id=?',t,reportId);insertReportLines(t,reportId,p.lines);
  });
  res.json(getErpOverview(t).daily_reports.find(r=>r.id===reportId));
}));
erpRouter.post('/erp/daily-reports/:id/submit', route((req,res) => {
  const t=req.tenant.id,reportId=related(t,'daily_reports',req.params.id,'report');
  const report=get<{status:string;notes:string}>('SELECT status,notes FROM daily_reports WHERE tenant_id=? AND id=?',t,reportId)!;
  if (report.status!=='draft') throw new ErpError(409,'Only draft reports can be submitted');
  if (!report.notes.trim() && !get(`SELECT id FROM daily_report_lines WHERE tenant_id=? AND report_id=?
    AND (qty>0 OR labor_hours>0 OR equipment_hours>0 OR labor_cost>0 OR equipment_cost>0 OR material_cost>0)`,t,reportId)) throw new ErpError(400,'A no-production report needs notes explaining the day');
  run("UPDATE daily_reports SET status='submitted',submitted_at=? WHERE tenant_id=? AND id=?",nowIso(),t,reportId);
  res.json(getErpOverview(t).daily_reports.find(r=>r.id===reportId));
}));
erpRouter.post('/erp/daily-reports/:id/approve', route((req,res) => {
  const t=req.tenant.id,reportId=related(t,'daily_reports',req.params.id,'report');
  const report=get<{status:string;date:string}>('SELECT status,date FROM daily_reports WHERE tenant_id=? AND id=?',t,reportId)!;
  assertProjectOpen(t,Number(get<{jobsite_id:number}>('SELECT jobsite_id FROM daily_reports WHERE tenant_id=? AND id=?',t,reportId)!.jobsite_id));
  if (report.status!=='submitted') throw new ErpError(409,'Only submitted reports can be approved');
  if (get(`SELECT p.id FROM production_entries p JOIN daily_report_lines l ON l.plan_id=p.plan_id AND l.tenant_id=p.tenant_id
    WHERE l.tenant_id=? AND l.report_id=? AND p.source='manual' AND p.date=? AND (p.qty>0 OR p.hours>0)
      AND (l.qty>0 OR l.labor_hours>0)`,t,reportId,report.date)) {
    throw new ErpError(409,'Manual production is already recorded for a work item on this date; reconcile it before approving this report');
  }
  const approvedBy=text(req.authUser?.name??body(req.body??{}).approved_by??'PM review','approved_by',true,150);
  transaction(()=>{
    assertNoShiftLabor(t,reportId);
    assertNoIssuedMaterialCost(t,reportId);
    run("UPDATE daily_reports SET status='approved',approved_at=?,approved_by=? WHERE tenant_id=? AND id=?",nowIso(),approvedBy,t,reportId);
  });
  res.json(getErpOverview(t).daily_reports.find(r=>r.id===reportId));
}));
erpRouter.post('/erp/daily-reports/:id/reject', route((req,res) => {
  initializeWorkforcePlanning();
  const t=req.tenant.id,reportId=related(t,'daily_reports',req.params.id,'report'),b=body(req.body??{});
  const report=get<{status:string}>('SELECT status FROM daily_reports WHERE tenant_id=? AND id=?',t,reportId)!;
  if(report.status!=='submitted') throw new ErpError(409,'Only submitted reports can be returned for correction');
  const reason=text(b.reason,'reason',true,2000),reviewer=text(req.authUser?.name??b.rejected_by??'PM review','rejected_by',true,150);
  transaction(()=>{
    run('INSERT INTO daily_report_rejections(tenant_id,report_id,reason,rejected_at,rejected_by) VALUES(?,?,?,?,?)',t,reportId,reason,nowIso(),reviewer);
    run("UPDATE daily_reports SET status='draft',submitted_at=NULL WHERE tenant_id=? AND id=?",t,reportId);
  });
  res.json(getErpOverview(t).daily_reports.find(r=>r.id===reportId));
}));
erpRouter.post('/erp/daily-reports/:id/reverse', route((req,res) => {
  initializeWorkforcePlanning();
  const t=req.tenant.id,reportId=related(t,'daily_reports',req.params.id,'report'),b=body(req.body??{});
  const report=get<{status:string}>('SELECT status FROM daily_reports WHERE tenant_id=? AND id=?',t,reportId)!;
  assertProjectOpen(t,Number(get<{jobsite_id:number}>('SELECT jobsite_id FROM daily_reports WHERE tenant_id=? AND id=?',t,reportId)!.jobsite_id));
  if(report.status!=='approved') throw new ErpError(409,'Only approved reports can be reversed');
  if(get('SELECT report_id FROM daily_report_reversals WHERE tenant_id=? AND report_id=?',t,reportId)) throw new ErpError(409,'This report has already been reversed');
  run('INSERT INTO daily_report_reversals(report_id,tenant_id,reason,reversed_at,reversed_by) VALUES(?,?,?,?,?)',reportId,t,text(b.reason,'reason',true,2000),nowIso(),text(req.authUser?.name??b.reversed_by??'PM review','reversed_by',true,150));
  res.json(getErpOverview(t).daily_reports.find(r=>r.id===reportId));
}));
erpRouter.post('/erp/daily-reports/:id/correction', route((req,res) => {
  initializeWorkforcePlanning();
  const t=req.tenant.id,reportId=related(t,'daily_reports',req.params.id,'report'),b=body(req.body??{});
  const report=get<{jobsite_id:number;crew_id:number;date:string;weather:string;notes:string;rough_pct:number|null;created_by:string}>('SELECT * FROM daily_reports WHERE tenant_id=? AND id=?',t,reportId)!;
  assertProjectOpen(t,report.jobsite_id);
  if(!get('SELECT report_id FROM daily_report_reversals WHERE tenant_id=? AND report_id=?',t,reportId)) throw new ErpError(409,'Reverse the approved report before creating a correction');
  const previous=get<{replacement_report_id:number}>('SELECT replacement_report_id FROM daily_report_replacements WHERE tenant_id=? AND original_report_id=?',t,reportId);
  if(previous) {res.json(getErpOverview(t).daily_reports.find(r=>r.id===previous.replacement_report_id));return;}
  const replacementId=transaction(()=>{
    const revision=get<{revision:number}>('SELECT COALESCE(MAX(revision),0)+1 revision FROM daily_reports WHERE tenant_id=? AND jobsite_id=? AND crew_id=? AND date=?',t,report.jobsite_id,report.crew_id,report.date)!.revision;
    const result=run(`INSERT INTO daily_reports(tenant_id,jobsite_id,crew_id,date,weather,notes,rough_pct,status,created_by,revision) VALUES(?,?,?,?,?,?,?,'draft',?,?)`,
      t,report.jobsite_id,report.crew_id,report.date,report.weather,report.notes,report.rough_pct,text(b.created_by??report.created_by,'created_by',true,150),revision);
    const replacementId=Number(result.lastInsertRowid);
    const lines=all<ReportLine>('SELECT * FROM daily_report_lines WHERE tenant_id=? AND report_id=?',t,reportId);
    insertReportLines(t,replacementId,lines);
    run('INSERT INTO daily_report_replacements(original_report_id,replacement_report_id,tenant_id,created_at) VALUES(?,?,?,?)',reportId,replacementId,t,nowIso());
    return replacementId;
  });
  res.status(201).json(getErpOverview(t).daily_reports.find(r=>r.id===replacementId));
}));
erpRouter.post('/erp/cost-entries', route((req,res) => {
  const t=req.tenant.id,b=body(req.body),projectId=related(t,'jobsites',b.jobsite_id,'jobsite_id');
  const category=option(b.category==='materials'?'material':b.category,'category',['labor','equipment','material','subcontract','other'] as const);
  const result=run('INSERT INTO job_cost_entries (tenant_id,jobsite_id,date,cost_code,category,amount,description) VALUES (?,?,?,?,?,?,?)',
    t,projectId,date(b.date,'date')!,text(b.cost_code,'cost_code',true,100),category,number(b.amount,'amount'),text(b.description,'description',true,1000));
  res.status(201).json(getErpOverview(t).cost_entries.find(c=>c.id===Number(result.lastInsertRowid)));
}));
function weeklyPayload(t:number,b:Body) {
  return {jobsite_id:related(t,'jobsites',b.jobsite_id,'jobsite_id'),pm_id:activeEmployee(t,b.pm_id,'pm_id',['pm','super']),
    week_ending:date(b.week_ending,'week_ending')!,rough_pct:number(b.rough_pct,'rough_pct',0,100),
    forecast_finish:date(b.forecast_finish,'forecast_finish',true),forecast_cost:b.forecast_cost===undefined||b.forecast_cost===null||b.forecast_cost===''?null:number(b.forecast_cost,'forecast_cost'),
    health:option(b.health,'health',['on_track','at_risk','delayed'] as const),blockers:text(b.blockers,'blockers',false,5000),next_steps:text(b.next_steps,'next_steps',false,5000),notes:text(b.notes,'notes',false,10000)};
}
erpRouter.post('/erp/weekly-updates', route((req,res) => {
  const t=req.tenant.id,p=weeklyPayload(t,body(req.body));
  const result=run(`INSERT INTO weekly_updates (tenant_id,jobsite_id,pm_id,week_ending,rough_pct,forecast_finish,forecast_cost,health,blockers,next_steps,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    t,p.jobsite_id,p.pm_id,p.week_ending,p.rough_pct,p.forecast_finish,p.forecast_cost,p.health,p.blockers,p.next_steps,p.notes);
  res.status(201).json(getErpOverview(t).weekly_updates.find(u=>u.id===Number(result.lastInsertRowid)));
}));
erpRouter.patch('/erp/weekly-updates/:id', route((req,res) => {
  const t=req.tenant.id,updateId=related(t,'weekly_updates',req.params.id,'weekly update'),b=body(req.body);
  hasEdits(b,['jobsite_id','pm_id','week_ending','rough_pct','forecast_finish','forecast_cost','health','blockers','next_steps','notes']);
  const existing=get<Body>('SELECT * FROM weekly_updates WHERE tenant_id=? AND id=?',t,updateId)!;
  const p=weeklyPayload(t,{...existing,...b});
  run(`UPDATE weekly_updates SET jobsite_id=?,pm_id=?,week_ending=?,rough_pct=?,forecast_finish=?,forecast_cost=?,health=?,blockers=?,next_steps=?,notes=? WHERE tenant_id=? AND id=?`,
    p.jobsite_id,p.pm_id,p.week_ending,p.rough_pct,p.forecast_finish,p.forecast_cost,p.health,p.blockers,p.next_steps,p.notes,t,updateId);
  res.json(getErpOverview(t).weekly_updates.find(u=>u.id===updateId));
}));
