# DirtWorks civil construction ERP blueprint

Research and implementation review: October 2, 2026. The operations foundation and the workforce, equipment, commercial, planning, billing, access and estimating phases are implemented. The remaining enterprise scope is identified below.

## The 30,000-foot view

A civil contractor runs a portfolio of jobs competing for people, crews, equipment, trucks, cash and material deliveries. A PM may oversee several jobs; superintendents and foremen turn the plan into work fronts and daily field records. The ERP must preserve the meaning of those events as they reach project control and accounting.

The backbone is **job → phase → cost code/work item → dated field or commercial event**. Each event needs its resource, unit, author, source, review state and financial relationship. Customer pay items serve a different purpose from internal cost codes; their mapping connects accepted work to billing.

```mermaid
flowchart LR
  A[Estimate and bid] --> B[Contract and baseline]
  B --> C[Lookahead and resource plan]
  C --> D[Daily field execution]
  D --> E[Accept quantities and costs]
  E --> F[Forecast and approved changes]
  F --> C
  F --> G[Progress billing and collections]
  G --> H[Final acceptance and closeout]
  H --> A
```

| Lifecycle stage | Working implementation | Further scope |
|---|---|---|
| Estimate and bid | Referenced takeoff, resource rates/quote evidence, allowances/markup, frozen bid revisions and new-job award handover | Drawing measurement, reusable company rate/assembly libraries, quote comparisons and negotiated award revisions |
| Contract and baseline | Client/PM/contract/budget, work targets, baseline snapshots, calendars, dependencies and pay items | Contract master, stations/work fronts, schedule/resource calculation and SOV amendments |
| Resource planning | Daily crew dispatch, qualification checks, historical rosters, timed equipment reservations and accepted transfers | Timed crew splitting, leave, rentals and longer-range capacity planning |
| Field execution | Quantity reports, split worker time, haul/safety tools, document/ticket uploads and queued daily drafts | Asset usage allocations, quality/test workflows and full offline editing |
| Review and control | Submission/approval, labor rate confirmation, source costs, rejection, reversal and same-day corrected report revisions | Accounting reconciliation, procurement returns/credits and broader correction journals |
| Forecast and changes | Weekly PM assessments, bottom-up as-of EAC versions, signed contract/budget/scope approvals | Rate-driven remaining-resource scenarios, accruals and schedule calculation |
| Billing and cash | Pay items, cumulative progress applications, certification, retainage, collections and matched supplier AP records | Legal/tax invoices, credit notes, banking, payroll and GL integration |
| Closeout | Required checklist, pending-work/stock/control checks, final acceptance and retained documents | Warranty obligations, formal reopening and lessons-to-estimate feedback |

## Roles and access

Roster role and login permission are separate records. Development demo access is explicit until an owner enables accounts. Production requires sign-in before access and a configured setup token before the first owner is created. Authenticated accounts belong to a fixed tenant; changing a caller header cannot change company membership.

| Login role | Working responsibilities |
|---|---|
| Owner / administrator | Company accounts, all operations, approvals, audit and business export |
| Project manager | Job setup, weekly reviews, scope/plans, field review and corrections, dispatch, equipment and purchasing; prepares forecasts/billing |
| Field foreman | Daily drafts/submission, worker clock entries, physical receiving/material usage and project records; individual wage data remains private |
| Dispatcher | Crew plans, equipment reservations and accepted transfers |
| Mechanic | Inspections, maintenance, service rules and explicit return to service |
| Accountant | Private wage confirmation/time approval, supplier invoices/payments, forecast/billing certification and customer/retainage receipts |

Operational summaries are shared within the company; this is not per-project visibility or employee-self-service authorization. Payroll preparation exports and personal wage snapshots are restricted. Sessions use hashed opaque tokens, HttpOnly cookies, expiry/revocation, CSRF and origin checks. Login failure throttling persists. Successful API mutations record actor, route, record ID when available and time in an append-only audit. It is not a complete before/after accounting journal.

## Shared data backbone

The app extends the original jobs/assets database; it does not maintain a separate resource model per module. Business tables carry tenant IDs and validate related records against the same tenant.

| Domain | Working records and relationships |
|---|---|
| Estimating | Bid family → editable revision with takeoff/resource assumptions → frozen approved bid → signed award → one new project and mapped work/pay items |
| Jobs and work | Job profile → work items/codes/quantity-hour-budget targets → approved baseline snapshots → signed changes |
| People and crews | Employee → current membership plus dated roster history → frozen assignment members and dated qualifications |
| Time | Employee/job/code/date interval → paid hours → confirmed wage/burden snapshot → unique cost posting → additive void record |
| Equipment | Asset/state → timed reservation or transfer acceptance → inspection/service/work order → unique completed repair charge |
| Field reports | Job/crew/date/revision → lines by work item → submission/review → reversal → linked replacement draft |
| Purchasing | Vendor/item → line order → receipt lots → FIFO usage → unique sourced material expense |
| Supplier AP | Received quantities/prices → matched invoice → payment records and remaining balance |
| Planning | Project calendar/dependency graph → baseline version → as-of actuals plus remaining cost categories → certified forecast version |
| Billing | Customer pay item/work mapping → cumulative application → certified earned/retainage/due → receipts → release and retainage receipts |
| Documents | Job/category → immutable file revision → prior-revision link, content hash and uploader |
| Access/recovery | Tenant-bound accounts/sessions → mutation audit; host snapshot plus immutable attachment files → verified restore |

Current dispatch remains one job per crew/day. History captures roster changes and preserves a dispatched worker after later crew edits. Migrated older assignments cannot reconstruct lost history and explicitly identify current-roster backfill. Dated qualification checks require the named qualification for every member on the selected work date; free-text legacy certification labels do not establish eligibility.

## Weekly PM review across multiple jobs

The requested rough-completion form is **Weekly PM updates**, independent of daily installed quantity. Filter the portfolio by PM and review all of that manager's jobs.

1. Review measured quantities, productivity, pending reports, actual costs, commitments and equipment/crew availability.
2. Record the week's PM estimated completion percentage and explain differences from measured completion.
3. Record finish/final-cost forecasts, health, blockers and next week's work plan.
4. Coordinate moves, reservations and deliveries across jobs. Prepare a bottom-up forecast when the remaining cost assumptions require detail.
5. Save one update per job/week and use portfolio/history exports for the operations meeting.

A 40% assessment followed by 45% means the latest estimate is 45%. It never creates installed quantity. Earlier weeks remain; correcting the same week's entry updates that record. The access audit records the mutation, but a full before/after weekly revision record is future work. The indicated PM is business responsibility; authenticated author/reviewer attribution comes from the session.

## Evidence and financial boundaries

### Estimate, bid and opening job budget

**Estimating & bids** prepares scope before a project exists. Manual quantities retain a source reference; dimensional takeoff uses feet and explicit counts. Length produces LF, area produces SF or SY, and volume produces CY. TON and LS require manual quantity; no density or cross-unit conversion is assumed. This is entered takeoff arithmetic, not automatic measurement of uploaded drawings.

Each scope line has a unique cost code, phase and installed unit. Resource usage per installed unit, waste allowance and unit rate produce separate labor, equipment, material, subcontract and other cost components. Labor/equipment resources use hours; quantities with different installed units remain separate. A supplier quote reference/vendor/validity documents the selected component rate without adding a second expense. These bid rates are assumptions and do not grant access to personal payroll rates.

Component extensions round to cents before rollup. Overhead applies to direct cost; contingency applies to direct cost plus overhead; markup applies to that resulting cost budget. Markup on cost differs from margin on selling value. Allowances are allocated deterministically so line budgets sum exactly to the project budget and line selling values sum exactly to the bid. Authoritative selling values are cents; a displayed rounded unit price does not reconstruct them.

PMs and accountants prepare estimates; accountants, owners and administrators approve them. Approval freezes quantities, rates, evidence, assumptions and totals. Optimistic edit versions prevent stale saves. A revision creates another draft and retains its approved predecessor. A newer draft or approved revision prevents award handover from an older revision.

PM handover requires signed award evidence, an award date within the approved bid/quote validity, an active PM and project dates. It creates one new planned job per bid family, with work targets, cost-code budgets, mapped billing pay items, source links and a **draft baseline** for separate finance review. Identical retries return the original handover. It cannot overwrite an existing job or create installed work, actual cost, stock or payments. Existing-job scope changes follow the signed change workflow. Award values currently equal the approved bid; negotiations require a revised bid before handover. Tax, legal invoice formatting and multiple currencies remain outside this phase.

### Accepted field facts and corrections

Drafts are editable, submitted reports are reviewed, and approved lines become eligible for measured quantities, hours and explicit costs once. Rejection returns a report to draft with a reason. Reversal retains the approved original but removes its eligibility; a linked same-day revision can be edited/submitted/approved. Repeated approvals/reversals cannot post twice.

Approval checks same-activity/date manual production to prevent duplicate quantities. Individual shift labor and aggregate daily-report labor cannot both cost the same job/code/day. Inventory usage and aggregate report material costs receive the same reconciliation guard. Those source checks are conservative; a report may keep quantities/hours while using zero aggregate cost for separately sourced labor/material. Direct manual cost entries still require human reconciliation.

### Production, forecast and telemetry

| Figure | Basis and limits |
|---|---|
| Measured work quantity | Manual field production plus approved, unreversed report lines; draft/submitted/AI estimates excluded |
| Work-item productivity | Measured quantity / report or manual labor hours on that activity; person-level payroll time is separate until production allocation is reconciled |
| Project completion | Budget-weighted work-item completion; CY, LF, tons and each are never summed |
| Automatic indicative EAC | Requires budget coverage and recorded cost/production evidence; sensitive to missing costs and scope |
| Weekly PM estimate | Dated management assessment; independent of measured facts |
| Bottom-up forecast | Actual cost through its as-of date, excluding reversed reports/voided shifts, plus explicit remaining cost by code/category; snapshot freezes on approval |
| Original PO reference | Original approved/received order totals, including consumed/spent amounts; informational and never added to EAC |
| Legacy quantity finish projection | Indicative calendar-day average over recorded days, without critical-path/resource planning |
| Telemetry/heuristics | Engine location/activity and labeled estimates; cannot verify installed work or payable attendance |

Calendars, holidays and dependency links are stored and included in baseline/forecast evidence. They do not yet compute a full critical-path or resource-loaded finish schedule. Bottom-up remaining costs must already include known committed remaining work; the app does not automatically accrue missing invoices.

### Stock, invoices, billing and closeout

Receiving material creates inventory. FIFO usage posts job cost at receipt-lot prices; supplier invoicing/payment records AP/cash evidence without duplicating the expense. Ordered, received, issued and invoiced quantities have separate limits. Formal signed changes preserve before/after contract, project budget and optional work-item quantity/budget. A credit cannot invalidate the existing billing schedule or certified revenue. Once financially controlled, setup edits cannot bypass signed change approval.

Mapped pay items cannot bill beyond accepted measured quantity through the application period. Verified-amount items require explicit evidence and scheduled-value/contract caps. Cumulative applications deduct previously certified values, calculate cents consistently, retain the required percentage and cap receipts at certified unpaid due. Retainage release is distinct from receiving the released cash.

Final acceptance requires completed measured work and required closeout items, with no pending field/billing records, unresolved controls or outstanding project material commitments/stock. Generic status edits cannot bypass it. Accepted projects freeze new work and commercial changes; invoice/cash settlement can continue. Formal reopening, SOV credit amendments and procurement reversal/return workflows remain future scope.

## Offline, files and recovery

New daily drafts are stored on the device after a fetch network failure; only these drafts auto-retry as drafts. A tenant-scoped request key/payload hash prevents duplicate creation after a lost response. Validation/access errors stay visible for manual resolution. Device copies can be exported or discarded. Approval, payments, existing draft edits and uploads require a connection. Browser data clearing removes unsynced copies.

Built deployments cache the application shell; API responses, authenticated datasets and attachments are excluded. During an offline reload, device drafts remain accessible without caching an authenticated session. This is limited recovery, not complete offline field operations.

Document revisions retain metadata and bytes with a SHA256 check; allowed PDF/images/text/CSV download as attachments. Upload size is limited to 5 MB. Owner company JSON exports omit files and credentials. Host-only backups snapshot the entire SQLite database and adjacent files, preserve WAL commits and verify hashes, integrity, foreign keys and attachment references before restoring into a new directory. See [Backup and recovery](BACKUP_RECOVERY.md).

## Remaining development roadmap

| Area | Next work |
|---|---|
| Estimating | Drawing-based measurement, reusable company assemblies/rate libraries, quote comparison, negotiated awards and estimate feedback |
| Workforce | Leave/availability, interval crew assignments, employee-user links, union/prevailing-wage rules and payroll classifications |
| Equipment | Rentals, ownership/operating rates, asset-specific usage reconciliation and parts stock |
| Commercial | Subcontracts, returns/stock reallocation, procurement credits/reversals, contract administration and RFI responses |
| Planning | Rate/resource scenarios, critical-path scheduling, accruals, constraints and before/after weekly update revisions |
| Accounting | Payroll/tax engine, GL/AP/AR reconciliation, legal invoice formats, SOV amendments/credit notes and banking/accounting integrations |
| Closeout | Formal reopening, warranties, quality test acceptance and estimate feedback |
| Production operations | Managed secrets, monitored deployment, storage/concurrency testing, scheduled protected backups, deployed restore rehearsal and real provider validation |

SQLite persistence and tenant checks support this implementation; they do not alone establish enterprise production readiness. Mock OEM/camera/network data and heuristic suggestions remain labeled demo capabilities. Node 24+, typechecks, full builds and isolated API/recovery tests provide repeatable verification. The browser review covers the actual user workflows in separate cloned databases, preserving the main demo.

## Research basis

The following public upstream Frappe/ERPNext sources were retrieved and read on October 2, 2026. They establish useful ERP patterns; the civil-specific workflow and roadmap above are an adaptation, not a claim that upstream ERPNext already implements this construction app.

| Verified source | Observed pattern and construction implication |
|---|---|
| [ERPNext Project schema](https://github.com/frappe/erpnext/blob/version-15/erpnext/projects/doctype/project/project.json) | Separates manual/task-based/weighted completion, planned/actual dates, costing and billing. A PM estimate should have an explicit basis alongside recorded actuals. |
| [ERPNext Task schema](https://github.com/frappe/erpnext/blob/version-15/erpnext/projects/doctype/task/task.json) | Parent/group tasks, dependencies, planned hours, dates, progress and weights support scope hierarchy and lookahead. |
| [ERPNext Timesheet implementation](https://github.com/frappe/erpnext/blob/version-15/erpnext/projects/doctype/timesheet/timesheet.py) and [detail schema](https://github.com/frappe/erpnext/blob/version-15/erpnext/projects/doctype/timesheet_detail/timesheet_detail.json) | Logs split time by project/task/activity, preserve costing versus billing rates and validate overlaps. Construction time capture needs person-level allocations and validation. |
| [Frappe HRMS Shift Assignment schema](https://github.com/frappe/hrms/blob/version-15/hrms/hr/doctype/shift_assignment/shift_assignment.json) | Employee assignment has dates, location and status. Resource scheduling should preserve intervals instead of only a current-job field. |
| [ERPNext Asset Movement implementation](https://github.com/frappe/erpnext/blob/version-15/erpnext/assets/doctype/asset_movement/asset_movement.py) | Issue/receipt/transfer validates location and custodian and preserves movement records. Asset presence, assignment and custody are distinct. |
| [ERPNext Asset Maintenance Task schema](https://github.com/frappe/erpnext/blob/version-15/erpnext/assets/doctype/asset_maintenance_task/asset_maintenance_task.json) | Preventive/calibration tasks have periodicity, owner, due/completion dates and certificate requirements. Fleet availability needs more than a fault alert. |
| [ERPNext Budget schema](https://github.com/frappe/erpnext/blob/version-15/erpnext/accounts/doctype/budget/budget.json) | Project/cost-center budgets distinguish material request, PO and actual expenditure controls. Commitments and actuals must stay separate. |
| [ERPNext Purchase Order Item schema](https://github.com/frappe/erpnext/blob/version-15/erpnext/buying/doctype/purchase_order_item/purchase_order_item.json) | Ordered, received and billed quantities, units, required dates and project/cost-center links support item-level procurement. Whole-order receipt is only a first increment. |
| [ERPNext Quotation implementation](https://github.com/frappe/erpnext/blob/version-15/erpnext/selling/doctype/quotation/quotation.py) and [item schema](https://github.com/frappe/erpnext/blob/version-15/erpnext/selling/doctype/quotation_item/quotation_item.json) | Submitted source documents, validity checks, source-row links and separate quantity/UOM/rate/amount inform frozen bids and one-time award mapping. |
| [ERPNext Sales Order implementation](https://github.com/frappe/erpnext/blob/version-15/erpnext/selling/doctype/sales_order/sales_order.py) and [BOM costing](https://github.com/frappe/erpnext/blob/version-15/erpnext/manufacturing/doctype/bom/bom.py) | Source/UOM consistency, submitted-order project creation, time multiplied by hourly rates and component cost rollups inform estimate-to-job handover and civil resource costing. |

Construction vendor/government pages from HCSS, Procore and FHWA could not be retrieved under this environment's network policy, so no claims above rely on them as reviewed sources. The next discovery round should validate the proposed workflows with the contractor's actual job logs, cost codes, estimate/contract forms, payroll rules, equipment practices and accounting exports.
