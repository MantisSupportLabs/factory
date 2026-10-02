import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  api,
  ApiError,
  offlineDrafts,
  watchOfflineDrafts,
  syncOfflineDrafts,
} from "../api/client";
import { useApp } from "../state/store";
import {
  emptyERP,
  money,
  number,
  today,
  type ERPData,
  type Project,
  type WeeklyUpdate,
} from "./types";
import { Badge, Empty, Field, Modal, Progress, SectionHead } from "./ui";
import { Workforce } from "./Workforce";
import { FieldProduction } from "./FieldProduction";
import { Purchasing, ProjectControls } from "./Commercial";
import { Assets } from "./Assets";
import { WorkforcePlanning } from "./WorkforcePlanning";
import { EquipmentOperations } from "./EquipmentOperations";
import { Procurement } from "./Procurement";
import { Documents, OfflineCenter, BusinessExport } from "./Documents";
import { AccessSettings, useAccess } from "./Access";
import { Forecasts, Billing } from "./ProjectFinance";
import { useCanEdit } from "./permissions";
import "./erp.css";
const FieldApp = lazy(() => import("../FieldApp"));
type View =
  | "overview"
  | "projects"
  | "weekly"
  | "people"
  | "crews"
  | "dispatch"
  | "assets"
  | "production"
  | "costs"
  | "purchasing"
  | "controls"
  | "reports"
  | "map";
type PhaseView =
  | "workforce-planning"
  | "equipment-operations"
  | "procurement"
  | "forecasts"
  | "billing"
  | "documents"
  | "offline"
  | "access";
type WorkspaceView = View | PhaseView;
const nav: Array<{
  id: WorkspaceView;
  label: string;
  icon: string;
  group?: string;
}> = [
  {
    id: "overview",
    label: "Company overview",
    icon: "overview",
    group: "WORKSPACE",
  },
  { id: "projects", label: "Projects", icon: "project" },
  { id: "weekly", label: "Weekly PM updates", icon: "weekly" },
  { id: "people", label: "People", icon: "people", group: "FIELD OPERATIONS" },
  { id: "crews", label: "Crews", icon: "crew" },
  { id: "dispatch", label: "Dispatch board", icon: "dispatch" },
  { id: "workforce-planning", label: "Time & qualifications", icon: "people" },
  { id: "assets", label: "Assets & equipment", icon: "assets" },
  { id: "equipment-operations", label: "Equipment operations", icon: "assets" },
  { id: "production", label: "Production & daily logs", icon: "production" },
  {
    id: "costs",
    label: "Job cost control",
    icon: "costs",
    group: "COMMERCIAL",
  },
  { id: "purchasing", label: "Purchasing", icon: "purchasing" },
  { id: "procurement", label: "Materials & invoices", icon: "purchasing" },
  { id: "forecasts", label: "Planning & forecasts", icon: "weekly" },
  { id: "billing", label: "Progress billing", icon: "costs" },
  { id: "controls", label: "Project controls", icon: "controls" },
  { id: "documents", label: "Project documents", icon: "reports" },
  { id: "reports", label: "Reports & exports", icon: "reports" },
  {
    id: "map",
    label: "Live field workspace",
    icon: "map",
    group: "CONNECTED TOOLS",
  },
  { id: "offline", label: "Device drafts", icon: "production" },
  {
    id: "access",
    label: "Team access & activity",
    icon: "people",
    group: "ADMINISTRATION",
  },
];
function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    overview: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    project: (
      <>
        <path d="M3 7h7l2 2h9v11H3z" />
        <path d="M3 7V4h7l2 3" />
      </>
    ),
    weekly: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M7 3v4m10-4v4M3 11h18m-13 5 3 3 5-5" />
      </>
    ),
    people: (
      <>
        <circle cx="9" cy="7" r="3" />
        <path d="M3 21v-3a6 6 0 0 1 12 0v3m2-17a3 3 0 0 1 0 6m1 4a6 6 0 0 1 3 5v2" />
      </>
    ),
    crew: (
      <>
        <circle cx="12" cy="7" r="3" />
        <path d="M7 21v-3a5 5 0 0 1 10 0v3M4 5a3 3 0 0 0 0 6m0 3a4 4 0 0 0-3 4m19-13a3 3 0 0 1 0 6m0 3a4 4 0 0 1 3 4" />
      </>
    ),
    dispatch: (
      <>
        <rect x="3" y="4" width="18" height="17" rx="2" />
        <path d="M8 4v17M3 10h18m-9 5h5" />
      </>
    ),
    assets: (
      <>
        <path d="M3 17h12V9H8l-3 4H3zm12-4h5l2 4h-7M8 9V5h7v4" />
        <circle cx="7" cy="18" r="2" />
        <circle cx="18" cy="18" r="2" />
      </>
    ),
    production: (
      <>
        <path d="M4 20V10m6 10V4m6 16v-8m5 8H2" />
        <path d="m15 5 4-3 3 4" />
      </>
    ),
    costs: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M15 7h-5a2.5 2.5 0 0 0 0 5h4a2.5 2.5 0 0 1 0 5H8m4-12v14" />
      </>
    ),
    purchasing: (
      <>
        <path d="M3 4h2l3 13h11l2-9H6M9 21h1m7 0h1" />
      </>
    ),
    controls: (
      <>
        <rect x="5" y="4" width="14" height="18" rx="2" />
        <path d="M9 2h6v4H9zm0 9h6m-6 5h6" />
      </>
    ),
    reports: (
      <>
        <path d="M5 3h10l4 4v14H5zm10 0v5h4M8 12h8m-8 4h8" />
      </>
    ),
    map: (
      <>
        <path d="m3 5 6-2 6 3 6-2v15l-6 2-6-3-6 2zm6-2v15m6-12v15" />
      </>
    ),
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] || paths.overview}
    </svg>
  );
}
const healthLabel = (h: string) =>
  ({ on_track: "On track", at_risk: "At risk", delayed: "Delayed" })[h] || h;
const healthTone = (h: string) =>
  h === "on_track" ? "green" : h === "delayed" ? "red" : "amber";
const dateLabel = (d: string | null | undefined) =>
  d
    ? new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";
const latest = (data: ERPData, id: number) =>
  data.weekly_updates
    .filter((w) => w.jobsite_id === id)
    .sort(
      (a, b) => b.week_ending.localeCompare(a.week_ending) || b.id - a.id,
    )[0];
export default function ERPShell() {
  const [view, setView] = useState<WorkspaceView>("overview");
  const access = useAccess();
  const refreshAccess = access.refresh;
  const [draftCount, setDraftCount] = useState(offlineDrafts().length);
  const [data, setData] = useState<ERPData>(emptyERP);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState(false);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [updated, setUpdated] = useState("");
  const assets = useApp((s) => s.assets);
  const refresh = useCallback(async () => {
    try {
      const d = await api.get<ERPData>("/erp/overview");
      setData({ ...emptyERP, ...d });
      setUpdated(
        new Date().toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          timeZone: "America/Chicago",
        }),
      );
      setError("");
      await useApp.getState().refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401)
        void refreshAccess().catch(() => undefined);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [refreshAccess]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(
    () => watchOfflineDrafts(() => setDraftCount(offlineDrafts().length)),
    [],
  );
  useEffect(() => {
    const sync = () => {
      void syncOfflineDrafts().then((result) => {
        if (result.uploaded) void refresh();
      });
    };
    window.addEventListener("online", sync);
    if (navigator.onLine) sync();
    return () => window.removeEventListener("online", sync);
  }, [refresh]);
  useEffect(() => {
    const main = document.querySelector<HTMLElement>(".erp-main");
    if (main) main.inert = menu;
    if (!menu) return;
    document.querySelector<HTMLButtonElement>(".erp-sidebar-close")?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      if (main) main.inert = false;
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menu]);
  function navigate(v: WorkspaceView, id?: number) {
    setView(v);
    setMenu(false);
    if (id !== undefined) setProjectId(id);
  }
  const title = nav.find((n) => n.id === view)!.label;
  return (
    <div className={`erp-shell ${menu ? "menu-open" : ""}`}>
      <aside className="erp-sidebar">
        <button
          className="erp-sidebar-close erp-icon-button"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        >
          ×
        </button>
        <a
          className="erp-brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("overview");
          }}
        >
          <span className="erp-logo">
            DW
            <span />
          </span>
          <span>
            DirtWorks<small>CIVIL OPERATIONS</small>
          </span>
        </a>
        <div className="erp-company">
          <span className="erp-company-mark">S</span>
          <div>
            Summit DirtWorks
            <small>
              & Paving ·{" "}
              {access.mode === "demo" ? "Demo company" : "Company workspace"}
            </small>
          </div>
        </div>
        <nav aria-label="Main navigation">
          {nav
            .filter(
              (n) =>
                n.id !== "access" ||
                access.mode === "demo" ||
                access.role === "owner" ||
                access.role === "admin",
            )
            .map((n) => (
              <div key={n.id}>
                {n.group && <p className="erp-nav-group">{n.group}</p>}
                <button
                  className={`erp-nav-item ${view === n.id ? "active" : ""}`}
                  onClick={() => navigate(n.id)}
                  aria-current={view === n.id ? "page" : undefined}
                >
                  <Icon name={n.icon} />
                  <span>{n.label}</span>
                  {n.id === "weekly" && data.projects.length > 0 && (
                    <span className="erp-nav-count">
                      {data.projects.length}
                    </span>
                  )}
                </button>
              </div>
            ))}
        </nav>
        <div className="erp-sidebar-footer">
          <span className="erp-avatar">SD</span>
          <div>
            {access.user?.name || "Summit workspace"}
            <small>
              {access.mode === "secure"
                ? `${access.role} · Signed in`
                : "Sample data · Local server"}
            </small>
          </div>
          {access.mode === "secure" && (
            <button
              className="erp-icon-button"
              aria-label="Sign out"
              onClick={() =>
                void access.logout().catch((e) => setError(e.message))
              }
            >
              ↪
            </button>
          )}
        </div>
      </aside>
      {menu && (
        <button
          className="erp-menu-shade"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        />
      )}
      <div className="erp-main">
        <header className="erp-topbar">
          <button
            className="erp-menu-toggle erp-icon-button"
            aria-label="Open navigation"
            onClick={() => setMenu(!menu)}
          >
            ☰
          </button>
          <div className="erp-breadcrumb">
            Workspace <span>/</span> <strong>{title}</strong>
          </div>
          <div className="erp-topbar-end">
            <span className="erp-demo-label">
              {access.mode === "secure" ? "TEAM WORKSPACE" : "DEMO WORKSPACE"}
            </span>
            <span className="erp-date">{dateLabel(today())}</span>
            <button
              className="erp-icon-button"
              title="Refresh workspace"
              aria-label="Refresh workspace"
              onClick={() => void refresh()}
            >
              ↻
            </button>
            <span className="erp-avatar">SD</span>
          </div>
        </header>
        <main className={`erp-content ${view === "map" ? "field-view" : ""}`}>
          {draftCount > 0 && (
            <div className="erp-alert" role="status">
              {draftCount} daily{" "}
              {draftCount === 1 ? "draft saved" : "drafts saved"} on this
              device.{" "}
              <button
                className="erp-button"
                onClick={() => navigate("offline")}
              >
                Review device drafts
              </button>
            </div>
          )}
          {error && (
            <div className="erp-alert error" role="alert">
              Couldn’t refresh the workspace: {error}
              <button className="erp-button" onClick={() => void refresh()}>
                Retry
              </button>
            </div>
          )}
          {loading ? (
            <div className="erp-empty">Loading your operations workspace…</div>
          ) : view === "map" ? (
            <>
              <div className="erp-field-caption">
                Live field workspace{" "}
                <span>
                  Fleet map, tools, timecards, safety, cameras, connectivity,
                  and OEM feeds
                </span>
              </div>
              <Suspense fallback={<Empty>Loading field workspace…</Empty>}>
                <FieldApp />
              </Suspense>
            </>
          ) : (
            <>
              <div className="erp-page-heading">
                <div>
                  <p className="erp-eyebrow">
                    {view === "overview"
                      ? "COMPANY COMMAND CENTER"
                      : view === "weekly"
                        ? "PROJECT MANAGEMENT"
                        : "SUMMIT DIRTWORKS & PAVING"}
                  </p>
                  <h1>
                    {view === "overview" ? "Your operation, in view." : title}
                  </h1>
                  <p>
                    {view === "overview"
                      ? "Every job, crew, and decision. One connected workspace."
                      : view === "weekly"
                        ? "A weekly review of completion, constraints, and the forecast to finish."
                        : view === "projects"
                          ? "Keep scope, people, progress, and costs connected across every job."
                          : view === "costs"
                            ? "Track actual costs and compare the forecast against the job budget."
                            : view === "reports"
                              ? "Take your operational data into the next meeting."
                              : undefined}
                  </p>
                </div>
                <span className="erp-refresh-label">Updated {updated} CT</span>
              </div>
              {view === "overview" && (
                <Overview data={data} assets={assets} navigate={navigate} />
              )}
              {view === "projects" && (
                <Projects
                  data={data}
                  refresh={refresh}
                  projectId={projectId}
                  setProjectId={setProjectId}
                  navigate={navigate}
                />
              )}
              {view === "weekly" && <Weekly data={data} refresh={refresh} />}
              {(view === "people" ||
                view === "crews" ||
                view === "dispatch") && (
                <Workforce data={data} refresh={refresh} view={view} />
              )}
              {view === "assets" && <Assets data={data} refresh={refresh} />}
              {view === "workforce-planning" && (
                <WorkforcePlanning data={data} refresh={refresh} />
              )}
              {view === "equipment-operations" && (
                <EquipmentOperations data={data} refresh={refresh} />
              )}
              {view === "procurement" && (
                <Procurement data={data} refresh={refresh} />
              )}
              {view === "forecasts" && (
                <Forecasts data={data} refresh={refresh} />
              )}
              {view === "billing" && <Billing data={data} refresh={refresh} />}
              {view === "documents" && <Documents data={data} />}
              {view === "offline" && (
                <OfflineCenter data={data} refresh={refresh} />
              )}
              {view === "access" && <AccessSettings />}
              {view === "production" && (
                <FieldProduction data={data} refresh={refresh} />
              )}
              {view === "costs" && <Costs data={data} refresh={refresh} />}
              {view === "purchasing" && <Purchasing projects={data.projects} />}
              {view === "controls" && <ProjectControls data={data} />}
              {view === "reports" && (
                <>
                  <Exports data={data} />
                  {(access.mode === "demo" ||
                    access.role === "owner" ||
                    access.role === "admin") && <BusinessExport />}
                </>
              )}
              <footer className="erp-content-footer">
                DirtWorks <span>Connected civil construction operations</span>
                <span>
                  {access.mode === "demo"
                    ? "Sample company data"
                    : "Authenticated company workspace"}
                </span>
              </footer>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
function Overview({
  data,
  assets,
  navigate,
}: {
  data: ERPData;
  assets: ReturnType<typeof useApp.getState>["assets"];
  navigate: (v: WorkspaceView, id?: number) => void;
}) {
  const active = data.projects.filter((p) => p.status === "active");
  const assigned = new Set(
    data.assignments.filter((a) => a.date === today()).map((a) => a.crew_id),
  );
  const pending = data.daily_reports.filter((r) => r.status === "submitted");
  const risks = data.projects.filter((p) => {
    const w = latest(data, p.id);
    return w && w.health !== "on_track";
  });
  const faults = assets.filter((a) => a.active_faults > 0);
  const down = assets.filter(
    (a) => a.status === "down" || a.status === "maintenance",
  );
  const metrics = [
    {
      label: "Active projects",
      value: active.length,
      foot: `${money(active.reduce((s, p) => s + p.contract_value, 0))} in active contracts`,
      icon: "project",
    },
    {
      label: "People on the roster",
      value: data.people.filter((p) => p.active).length,
      foot: `${data.crews.length} crews across the operation`,
      icon: "people",
    },
    {
      label: "Crews dispatched today",
      value: `${assigned.size} / ${data.crews.length}`,
      foot:
        data.crews.length - assigned.size > 0
          ? `${data.crews.length - assigned.size} crews need an assignment`
          : "All crews assigned",
      icon: "dispatch",
    },
    {
      label: "Tracked assets",
      value: assets.length,
      foot: `${down.length} down or in maintenance`,
      icon: "assets",
    },
  ];
  return (
    <div className="erp-stack">
      <div className="erp-metrics">
        {metrics.map((m) => (
          <div className="erp-metric" key={m.label}>
            <div className="erp-metric-label">
              {m.label}
              <Icon name={m.icon} />
            </div>
            <strong>{m.value}</strong>
            <small>{m.foot}</small>
          </div>
        ))}
      </div>
      <div className="erp-overview-grid">
        <section className="erp-card">
          <SectionHead
            title="Project portfolio"
            description="Measured progress with the latest PM assessment"
            action={
              <button
                className="erp-text-button"
                onClick={() => navigate("projects")}
              >
                All projects
              </button>
            }
          />
          <div className="erp-table-wrap">
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Project manager</th>
                  <th>Measured progress</th>
                  <th>PM status</th>
                </tr>
              </thead>
              <tbody>
                {data.projects.map((p) => {
                  const w = latest(data, p.id);
                  return (
                    <tr key={p.id}>
                      <td>
                        <button
                          className="erp-table-link"
                          onClick={() => navigate("projects", p.id)}
                        >
                          {p.name}
                        </button>
                        <small>
                          {p.code} · {p.client}
                        </small>
                        {(p.budget_coverage_pct ?? 100) < 100 && (
                          <small className="erp-negative">
                            Scope budget allocated:{" "}
                            {number(p.budget_coverage_pct)}%
                          </small>
                        )}
                      </td>
                      <td>
                        <span className="erp-person-inline">
                          <span className="erp-avatar small">
                            {initials(p.pm_name)}
                          </span>
                          {p.pm_name || "Unassigned"}
                        </span>
                      </td>
                      <td>
                        <div className="erp-progress-label">
                          <strong>{number(p.progress_pct, 1)}%</strong>
                          <span>{p.crew_count} crews</span>
                        </div>
                        <Progress value={p.progress_pct} />
                      </td>
                      <td>
                        {w ? (
                          <Badge tone={healthTone(w.health)}>
                            {healthLabel(w.health)}
                          </Badge>
                        ) : (
                          <Badge>No PM update</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {data.projects.length === 0 && (
              <Empty>Add your first project to start tracking.</Empty>
            )}
          </div>
          <div className="erp-card-note">
            Measured completion uses manual quantities and approved field
            reports, weighted by work-item budget.
          </div>
        </section>
        <section className="erp-card erp-attention">
          <SectionHead
            title="Needs attention"
            action={
              <Badge tone="amber">
                {risks.length +
                  pending.length +
                  faults.length +
                  Math.max(0, data.crews.length - assigned.size)}
              </Badge>
            }
          />
          {risks.map((p) => (
            <button
              className="erp-action-row"
              key={p.id}
              onClick={() => navigate("weekly")}
            >
              <span className="erp-action-icon amber">!</span>
              <div>
                <strong>{p.code} · PM flagged risk</strong>
                <small>
                  {latest(data, p.id)?.blockers ||
                    "Review the weekly forecast and next steps."}
                </small>
              </div>
              <span className="erp-action-count">PM</span>
            </button>
          ))}
          {pending.length > 0 && (
            <button
              className="erp-action-row"
              onClick={() => navigate("production")}
            >
              <span className="erp-action-icon blue">
                <Icon name="reports" />
              </span>
              <div>
                <strong>Field reports awaiting review</strong>
                <small>Confirm installed work before posting progress.</small>
              </div>
              <span className="erp-action-count">{pending.length}</span>
            </button>
          )}
          {data.crews.length > assigned.size && (
            <button
              className="erp-action-row"
              onClick={() => navigate("dispatch")}
            >
              <span className="erp-action-icon amber">
                <Icon name="crew" />
              </span>
              <div>
                <strong>Crews need a job assignment</strong>
                <small>Complete today’s dispatch plan.</small>
              </div>
              <span className="erp-action-count">
                {data.crews.length - assigned.size}
              </span>
            </button>
          )}
          {faults.length > 0 && (
            <button
              className="erp-action-row"
              onClick={() => navigate("assets")}
            >
              <span className="erp-action-icon red">
                <Icon name="assets" />
              </span>
              <div>
                <strong>Equipment with active faults</strong>
                <small>Review availability before dispatch.</small>
              </div>
              <span className="erp-action-count">{faults.length}</span>
            </button>
          )}
          {!risks.length &&
            !pending.length &&
            !faults.length &&
            data.crews.length === assigned.size && (
              <Empty>No outstanding operational alerts.</Empty>
            )}
        </section>
      </div>
      <div className="erp-overview-grid lower">
        <section className="erp-card">
          <SectionHead
            title="Today’s crew plan"
            description={dateLabel(today())}
            action={
              <button
                className="erp-text-button"
                onClick={() => navigate("dispatch")}
              >
                Manage dispatch
              </button>
            }
          />
          <div className="erp-crew-plan">
            {data.crews.map((c) => {
              const a = data.assignments.find(
                (a) => a.crew_id === c.id && a.date === today(),
              );
              return (
                <div className="erp-crew-plan-row" key={c.id}>
                  <div className="erp-crew-symbol">
                    <Icon name="crew" />
                  </div>
                  <div>
                    <strong>{c.name}</strong>
                    <small>
                      {c.member_count} people · {c.foreman_name || "No foreman"}
                    </small>
                  </div>
                  <div className="erp-crew-plan-job">
                    <strong>
                      {a?.jobsite_name || "Available for dispatch"}
                    </strong>
                    <small>{a?.task || "No assignment for today"}</small>
                  </div>
                  <Badge tone={a ? "green" : "neutral"}>
                    {a ? "Assigned" : "Available"}
                  </Badge>
                </div>
              );
            })}
          </div>
        </section>
        <section className="erp-card">
          <SectionHead
            title="Weekly PM pulse"
            action={
              <button
                className="erp-text-button"
                onClick={() => navigate("weekly")}
              >
                Weekly updates
              </button>
            }
          />
          <div className="erp-pulse">
            {data.projects.map((p) => {
              const w = latest(data, p.id);
              return (
                <div key={p.id}>
                  <div className="erp-pulse-title">
                    <strong>{p.code}</strong>
                    <span>
                      {w ? dateLabel(w.week_ending) : "No review yet"}
                    </span>
                  </div>
                  <div className="erp-pulse-number">
                    {w ? `${number(w.rough_pct, 1)}%` : "—"}
                    <small>PM estimated completion</small>
                  </div>
                  <div className="erp-pulse-detail">
                    <span>Forecast finish</span>
                    <strong>{dateLabel(w?.forecast_finish)}</strong>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
const initials = (name: string | null | undefined) =>
  name
    ? name
        .split(" ")
        .map((n) => n[0])
        .slice(0, 2)
        .join("")
    : "—";
function ProjectRows({
  projects,
  data,
  onSelect,
}: {
  projects: Project[];
  data: ERPData;
  onSelect: (id: number) => void;
}) {
  return (
    <div className="erp-table-wrap">
      <table className="erp-table">
        <thead>
          <tr>
            <th>Project / client</th>
            <th>PM / superintendent</th>
            <th>Measured completion</th>
            <th>Contract</th>
            <th>Actual cost</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id}>
              <td>
                <button
                  className="erp-table-link"
                  onClick={() => onSelect(p.id)}
                >
                  {p.name}
                </button>
                <small>
                  {p.code} · {p.client}
                </small>
              </td>
              <td>
                {p.pm_name || "Unassigned"}
                <small>
                  {p.superintendent || "Superintendent not assigned"}
                </small>
              </td>
              <td>
                <div className="erp-progress-label">
                  <strong>{number(p.progress_pct, 1)}%</strong>
                </div>
                <Progress value={p.progress_pct} />
              </td>
              <td>{money(p.contract_value)}</td>
              <td>{money(p.actual_cost)}</td>
              <td>
                <Badge tone={p.status === "active" ? "green" : "neutral"}>
                  {p.status}
                </Badge>
                {latest(data, p.id) && (
                  <small>{healthLabel(latest(data, p.id)!.health)}</small>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!projects.length && <Empty>No projects match these filters.</Empty>}
    </div>
  );
}
function Projects({
  data,
  refresh,
  projectId,
  setProjectId,
  navigate,
}: {
  data: ERPData;
  refresh: () => Promise<void>;
  projectId: number | null;
  setProjectId: (id: number | null) => void;
  navigate: (v: View) => void;
}) {
  const [query, setQuery] = useState("");
  const [pm, setPm] = useState("");
  const [editing, setEditing] = useState<Project | null | undefined>(undefined);
  const canEdit = useCanEdit("pm");
  const p = data.projects.find((p) => p.id === projectId);
  const items = data.work_items.filter((i) => i.jobsite_id === projectId);
  const w = p ? latest(data, p.id) : null;
  return (
    <div className="erp-stack">
      <section className="erp-card">
        <SectionHead
          title="All projects"
          description={`${data.projects.length} jobs in the portfolio`}
          action={
            <button
              className="erp-button primary"
              onClick={() => setEditing(null)}
              disabled={!canEdit}
            >
              + New project
            </button>
          }
        />
        <div className="erp-toolbar">
          <input
            aria-label="Search projects"
            placeholder="Search project, code, or client…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label="Filter by project manager"
            value={pm}
            onChange={(e) => setPm(e.target.value)}
          >
            <option value="">All project managers</option>
            {data.people
              .filter((p) => p.role === "pm" || p.role === "super")
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </div>
        <ProjectRows
          projects={data.projects.filter(
            (p) =>
              (!pm || String(p.pm_id) === pm) &&
              `${p.name} ${p.code} ${p.client}`
                .toLowerCase()
                .includes(query.toLowerCase()),
          )}
          data={data}
          onSelect={setProjectId}
        />
      </section>
      {p && (
        <section className="erp-card">
          <SectionHead
            title={`${p.code} · ${p.name}`}
            description={`${p.client} · ${dateLabel(p.start_date)} – ${dateLabel(p.end_date)}`}
            action={
              <div className="erp-inline-actions">
                <button
                  className="erp-button"
                  onClick={() => setEditing(p)}
                  disabled={!canEdit}
                >
                  Edit project
                </button>
                <button
                  className="erp-icon-button"
                  aria-label="Close project detail"
                  onClick={() => setProjectId(null)}
                >
                  ×
                </button>
              </div>
            }
          />
          <div className="erp-detail-metrics">
            <div>
              <span>Budget</span>
              <strong>{money(p.budget)}</strong>
            </div>
            <div>
              <span>Actual cost</span>
              <strong>{money(p.actual_cost)}</strong>
            </div>
            <div>
              <span>Calculated forecast</span>
              <strong>{money(p.forecast_cost)}</strong>
            </div>
            <div>
              <span>PM forecast</span>
              <strong>{money(w?.forecast_cost)}</strong>
            </div>
            <div>
              <span>Approved cost-to-complete EAC</span>
              <strong>{money(p.approved_forecast_cost)}</strong>
              <small>
                {p.approved_forecast_as_of
                  ? `As of ${dateLabel(p.approved_forecast_as_of)} · v${p.approved_forecast_version}`
                  : "Awaiting certified forecast"}
              </small>
            </div>
            <div>
              <span>Measured / PM completion</span>
              <strong>
                {number(p.progress_pct, 1)}% /{" "}
                {w ? number(w.rough_pct, 1) + "%" : "—"}
              </strong>
            </div>
          </div>
          <div className="erp-table-wrap">
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Cost code / activity</th>
                  <th>Installed / scope</th>
                  <th>Measured completion</th>
                  <th>Actual / planned rate</th>
                  <th>Budget</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {i.cost_code}
                      <small>{i.activity}</small>
                    </td>
                    <td>
                      {number(i.actual_qty)} / {number(i.planned_qty)} {i.unit}
                    </td>
                    <td>
                      {number(i.progress_pct, 1)}%
                      <Progress value={i.progress_pct} />
                    </td>
                    <td>
                      {number(i.rate, 1)} / {number(i.planned_rate, 1)} {i.unit}
                      /labor hr
                    </td>
                    <td>{money(i.budget)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!items.length && (
            <Empty>
              No work items yet. Add scope in Production & daily logs.
            </Empty>
          )}
          <div className="erp-card-note">
            Work-item budget coverage: {number(p.budget_coverage_pct)}%.{" "}
            {p.unbudgeted_work_item_count
              ? `${p.unbudgeted_work_item_count} activities need a budget. `
              : ""}
            Calculated forecast extrapolates costs against budget-weighted
            earned work. PM forecast is a dated management estimate.{" "}
            <button
              className="erp-text-button"
              onClick={() => navigate("production")}
            >
              Manage work items
            </button>
          </div>
        </section>
      )}
      {editing !== undefined && (
        <ProjectForm
          data={data}
          project={editing}
          onClose={() => setEditing(undefined)}
          refresh={refresh}
        />
      )}
    </div>
  );
}
function ProjectForm({
  data,
  project,
  onClose,
  refresh,
}: {
  data: ERPData;
  project: Project | null;
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const b = {
      name: f.get("name"),
      code: f.get("code"),
      client: f.get("client"),
      pm_id: f.get("pm_id") ? Number(f.get("pm_id")) : null,
      contract_value: Number(f.get("contract_value")),
      budget: Number(f.get("budget")),
      start_date: f.get("start_date") || null,
      end_date: f.get("end_date") || null,
      superintendent: f.get("superintendent"),
      lat: Number(f.get("lat")),
      lng: Number(f.get("lng")),
      address: f.get("address") || null,
      status: f.get("status") || "active",
    };
    setSaving(true);
    try {
      if (project) await api.patch(`/erp/projects/${project.id}`, b);
      else await api.post("/erp/projects", b);
      await refresh();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={project ? "Edit project" : "New civil project"}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <div className="erp-form-grid">
          <Field label="Project name">
            <input name="name" required defaultValue={project?.name} />
          </Field>
          <Field label="Job code">
            <input name="code" required defaultValue={project?.code} />
          </Field>
          <Field label="Client">
            <input name="client" required defaultValue={project?.client} />
          </Field>
          <Field label="Project manager">
            <select name="pm_id" defaultValue={project?.pm_id || ""}>
              <option value="">Unassigned</option>
              {data.people
                .filter(
                  (p) => p.active && (p.role === "pm" || p.role === "super"),
                )
                .map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Contract value ($)">
            <input
              name="contract_value"
              required
              type="number"
              min="0"
              step="0.01"
              defaultValue={project?.contract_value || 0}
            />
          </Field>
          <Field label="Job budget ($)">
            <input
              name="budget"
              required
              type="number"
              min="0"
              step="0.01"
              defaultValue={project?.budget || 0}
            />
          </Field>
          <Field label="Start date">
            <input
              name="start_date"
              type="date"
              defaultValue={project?.start_date || today()}
            />
          </Field>
          <Field label="Baseline finish">
            <input
              name="end_date"
              type="date"
              defaultValue={project?.end_date || ""}
            />
          </Field>
          <Field label="Site address" wide>
            <input
              name="address"
              maxLength={300}
              defaultValue={project?.address || ""}
              placeholder="Street address or site location"
            />
          </Field>
          <Field label="Latitude">
            <input
              name="lat"
              type="number"
              min="-90"
              max="90"
              step="any"
              required
              defaultValue={project?.lat ?? ""}
              placeholder="e.g. 32.900"
            />
          </Field>
          <Field label="Longitude">
            <input
              name="lng"
              type="number"
              min="-180"
              max="180"
              step="any"
              required
              defaultValue={project?.lng ?? ""}
              placeholder="e.g. -97.400"
            />
          </Field>
          <Field label="Superintendent">
            <input
              name="superintendent"
              defaultValue={project?.superintendent || ""}
            />
          </Field>
          <Field label="Status">
            <select name="status" defaultValue={project?.status || "active"}>
              {["planned", "active", "paused", "complete"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
        </div>
        {error && (
          <p className="erp-alert error" role="alert">
            {error}
          </p>
        )}
        <div className="erp-form-actions">
          <button type="button" className="erp-button" onClick={onClose}>
            Cancel
          </button>
          <button className="erp-button primary" disabled={saving}>
            {saving ? "Saving…" : "Save project"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Weekly({
  data,
  refresh,
}: {
  data: ERPData;
  refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const canEdit = useCanEdit("pm");
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);
  const reviews = [...data.weekly_updates]
    .filter((w) => !filter || String(w.pm_id) === filter)
    .sort((a, b) => b.week_ending.localeCompare(a.week_ending) || b.id - a.id);
  return (
    <div className="erp-stack">
      <section className="erp-weekly-banner">
        <div>
          <span className="erp-eyebrow">WEEKLY CONTROL CYCLE</span>
          <h2>What changed. What’s left. What it takes to finish.</h2>
          <p>
            PM estimates sit beside measured field progress, with a clear author
            and reporting week.
          </p>
        </div>
        <button
          className="erp-button primary"
          onClick={() => setOpen(true)}
          disabled={!canEdit}
        >
          + Weekly job update
        </button>
      </section>
      <section className="erp-card">
        <SectionHead title="Latest position by job" />
        <div className="erp-table-wrap">
          <table className="erp-table">
            <thead>
              <tr>
                <th>Job / PM</th>
                <th>Measured</th>
                <th>PM estimate</th>
                <th>Forecast finish</th>
                <th>Forecast final cost</th>
                <th>Health</th>
              </tr>
            </thead>
            <tbody>
              {data.projects.map((p) => {
                const w = latest(data, p.id);
                return (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                      <small>{p.pm_name || "Unassigned"}</small>
                    </td>
                    <td>{number(p.progress_pct, 1)}%</td>
                    <td>
                      {w ? `${number(w.rough_pct, 1)}%` : "—"}
                      <small>
                        {w ? dateLabel(w.week_ending) : "No weekly review"}
                      </small>
                    </td>
                    <td>{dateLabel(w?.forecast_finish)}</td>
                    <td>
                      {money(w?.forecast_cost)}
                      <small>Budget {money(p.budget)}</small>
                    </td>
                    <td>
                      {w ? (
                        <Badge tone={healthTone(w.health)}>
                          {healthLabel(w.health)}
                        </Badge>
                      ) : (
                        <Badge>Awaiting review</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className="erp-card">
        <SectionHead title="Weekly update history" />
        <div className="erp-toolbar">
          <select
            aria-label="Filter updates by PM"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="">All project managers</option>
            {data.people
              .filter((p) => p.role === "pm" || p.role === "super")
              .map((p) => (
                <option value={p.id} key={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </div>
        <div className="erp-review-list">
          {reviews.map((w) => (
            <article key={w.id} className="erp-review">
              <button
                className="erp-review-head"
                onClick={() => setExpanded(expanded === w.id ? null : w.id)}
                aria-expanded={expanded === w.id}
              >
                <span>
                  <strong>{w.jobsite_name}</strong>
                  <small>
                    {w.pm_name} · Week ending {dateLabel(w.week_ending)}
                  </small>
                </span>
                <strong>{number(w.rough_pct, 1)}%</strong>
                <Badge tone={healthTone(w.health)}>
                  {healthLabel(w.health)}
                </Badge>
                <span>{expanded === w.id ? "−" : "+"}</span>
              </button>
              {expanded === w.id && (
                <div className="erp-review-body">
                  <div>
                    <span>Constraints & blockers</span>
                    <p>{w.blockers || "None reported"}</p>
                  </div>
                  <div>
                    <span>Next week’s plan</span>
                    <p>{w.next_steps || "No plan entered"}</p>
                  </div>
                  <div>
                    <span>PM notes</span>
                    <p>{w.notes || "No notes"}</p>
                  </div>
                  <div>
                    <span>Forecast</span>
                    <p>
                      {dateLabel(w.forecast_finish)} · {money(w.forecast_cost)}{" "}
                      final cost
                    </p>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
        {!reviews.length && <Empty>No weekly updates yet.</Empty>}
      </section>
      {open && (
        <WeeklyForm
          data={data}
          onClose={() => setOpen(false)}
          refresh={refresh}
        />
      )}
    </div>
  );
}
function WeeklyForm({
  data,
  onClose,
  refresh,
}: {
  data: ERPData;
  onClose: () => void;
  refresh: () => Promise<void>;
}) {
  const [job, setJob] = useState(String(data.projects[0]?.id || ""));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const p = data.projects.find((p) => String(p.id) === job);
  const prev = p ? latest(data, p.id) : null;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      jobsite_id: Number(job),
      pm_id: Number(f.get("pm_id")),
      week_ending: f.get("week_ending"),
      rough_pct: Number(f.get("rough_pct")),
      forecast_finish: f.get("forecast_finish") || null,
      forecast_cost: Number(f.get("forecast_cost")),
      health: f.get("health"),
      blockers: f.get("blockers"),
      next_steps: f.get("next_steps"),
      notes: f.get("notes"),
    };
    setSaving(true);
    try {
      const existing = data.weekly_updates.find(
        (w) =>
          w.jobsite_id === Number(job) && w.week_ending === body.week_ending,
      );
      if (existing) await api.patch(`/erp/weekly-updates/${existing.id}`, body);
      else await api.post("/erp/weekly-updates", body);
      await refresh();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title="Weekly PM job update" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="erp-form-grid">
          <Field label="Project">
            <select
              required
              value={job}
              onChange={(e) => setJob(e.target.value)}
            >
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} · {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Week ending">
            <input
              type="date"
              name="week_ending"
              required
              defaultValue={today()}
            />
          </Field>
        </div>
        <div key={job} className="erp-form-grid">
          <Field label="Project manager">
            <select required name="pm_id" defaultValue={p?.pm_id || ""}>
              <option value="">Select PM</option>
              {data.people
                .filter(
                  (p) => p.active && (p.role === "pm" || p.role === "super"),
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Job health">
            <select name="health" defaultValue={prev?.health || "on_track"}>
              <option value="on_track">On track</option>
              <option value="at_risk">At risk</option>
              <option value="delayed">Delayed</option>
            </select>
          </Field>
          <Field label="PM estimated completion (%)">
            <input
              type="number"
              name="rough_pct"
              required
              min="0"
              max="100"
              step="0.1"
              defaultValue={prev?.rough_pct || p?.progress_pct || 0}
            />
          </Field>
          <Field label="Forecast finish">
            <input
              type="date"
              name="forecast_finish"
              required
              defaultValue={prev?.forecast_finish || p?.end_date || ""}
            />
          </Field>
          <Field label="Forecast final cost ($)">
            <input
              type="number"
              name="forecast_cost"
              required
              min="0"
              step="0.01"
              defaultValue={
                prev?.forecast_cost || p?.forecast_cost || p?.budget || 0
              }
            />
          </Field>
          <div className="erp-form-context">
            <span>Measured field completion</span>
            <strong>{number(p?.progress_pct, 1)}%</strong>
            <small>PM estimates don’t overwrite installed quantities.</small>
          </div>
          <Field label="Constraints & blockers" wide>
            <textarea
              name="blockers"
              rows={2}
              placeholder="Utility conflicts, permits, deliveries, staffing…"
            />
          </Field>
          <Field label="Next week’s plan" wide>
            <textarea
              name="next_steps"
              rows={2}
              required
              placeholder="Work fronts, crew moves, and decisions needed…"
            />
          </Field>
          <Field label="Forecast notes" wide>
            <textarea
              name="notes"
              rows={2}
              placeholder="Assumptions behind the finish date and cost forecast…"
            />
          </Field>
        </div>
        {error && (
          <p className="erp-alert error" role="alert">
            {error}
          </p>
        )}
        <p className="erp-card-note">
          Saving for an existing job and week updates that review. Other weeks
          remain in the history.
        </p>
        <div className="erp-form-actions">
          <button type="button" className="erp-button" onClick={onClose}>
            Cancel
          </button>
          <button className="erp-button primary" disabled={saving || !job}>
            {saving ? "Saving…" : "Save weekly update"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Costs({
  data,
  refresh,
}: {
  data: ERPData;
  refresh: () => Promise<void>;
}) {
  const [job, setJob] = useState("");
  const [open, setOpen] = useState(false);
  const canEdit = useCanEdit("pm", "accountant");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const projects = data.projects.filter((p) => !job || String(p.id) === job);
  const entries = data.cost_entries.filter(
    (c) => !job || String(c.jobsite_id) === job,
  );
  const approved = data.daily_reports.filter(
    (r) => r.status === "approved" && !r.reversed_at && (!job || String(r.jobsite_id) === job),
  );
  const actual = projects.reduce((s, p) => s + p.actual_cost, 0);
  const budget = projects.reduce((s, p) => s + p.budget, 0);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setSaving(true);
    try {
      await api.post("/erp/cost-entries", {
        jobsite_id: Number(f.get("jobsite_id")),
        date: f.get("date"),
        cost_code: f.get("cost_code"),
        category: f.get("category"),
        amount: Number(f.get("amount")),
        description: f.get("description"),
      });
      await refresh();
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="erp-stack">
      <div className="erp-metrics three">
        <div className="erp-metric">
          <span>Job budgets</span>
          <strong>{money(budget)}</strong>
          <small>Current approved operational budget</small>
        </div>
        <div className="erp-metric">
          <span>Recorded actual cost</span>
          <strong>{money(actual)}</strong>
          <small>Cost ledger + approved field report costs</small>
        </div>
        <div className="erp-metric">
          <span>Remaining budget</span>
          <strong>{money(budget - actual)}</strong>
          <small>Budget less recorded actuals</small>
        </div>
      </div>
      <section className="erp-card">
        <SectionHead
          title="Budget & forecast by project"
          action={
            <button
              className="erp-button primary"
              disabled={!canEdit}
              onClick={() => {
                setError("");
                setOpen(true);
              }}
            >
              + Record job cost
            </button>
          }
        />
        <div className="erp-toolbar">
          <select
            aria-label="Filter costs by project"
            value={job}
            onChange={(e) => setJob(e.target.value)}
          >
            <option value="">All projects</option>
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="erp-table-wrap">
          <table className="erp-table">
            <thead>
              <tr>
                <th>Project</th>
                <th>Budget</th>
                <th>Actual cost</th>
                <th>Calculated final cost</th>
                <th>PM final cost</th>
                <th>Approved EAC</th>
                <th>Forecast variance to budget</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => {
                const w = latest(data, p.id);
                const finalForecast =
                  p.approved_forecast_cost ?? w?.forecast_cost;
                return (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.code}</strong>
                      <small>{p.name}</small>
                    </td>
                    <td>{money(p.budget)}</td>
                    <td>{money(p.actual_cost)}</td>
                    <td>{money(p.forecast_cost)}</td>
                    <td>{money(w?.forecast_cost)}</td>
                    <td>
                      {money(p.approved_forecast_cost)}
                      <small>
                        {p.approved_forecast_as_of
                          ? `v${p.approved_forecast_version} · ${dateLabel(p.approved_forecast_as_of)}`
                          : "No approved review"}
                      </small>
                    </td>
                    <td
                      className={
                        finalForecast !== undefined && finalForecast > p.budget
                          ? "erp-negative"
                          : ""
                      }
                    >
                      {finalForecast !== undefined
                        ? money(finalForecast - p.budget)
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="erp-card-note">
          Calculated final cost adds remaining budget scaled by recorded cost
          against earned work. Estimates need complete cost capture. Purchase
          commitments are tracked separately in Purchasing. Variance uses the
          latest approved bottom-up forecast when available, then the PM review.
        </div>
      </section>
      <section className="erp-card">
        <SectionHead
          title="Cost ledger"
          description="Manual job costs and the costs posted from approved field reports"
        />
        <div className="erp-table-wrap">
          <table className="erp-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Project</th>
                <th>Cost code</th>
                <th>Category / source</th>
                <th>Description</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((c) => (
                <tr key={`cost-${c.id}`}>
                  <td>{dateLabel(c.date)}</td>
                  <td>{c.jobsite_name}</td>
                  <td>{c.cost_code}</td>
                  <td>
                    <Badge>{c.category}</Badge>
                  </td>
                  <td>{c.description}</td>
                  <td>{money(c.amount)}</td>
                </tr>
              ))}
              {approved.flatMap((r) =>
                r.lines.map((l, i) => (
                  <tr key={`report-${r.id}-${i}`}>
                    <td>{dateLabel(r.date)}</td>
                    <td>{r.jobsite_name}</td>
                    <td>
                      {data.work_items.find((w) => w.id === l.plan_id)
                        ?.cost_code || "—"}
                    </td>
                    <td>
                      <Badge tone="blue">Approved field report</Badge>
                    </td>
                    <td>
                      {
                        data.work_items.find((w) => w.id === l.plan_id)
                          ?.activity
                      }
                      <small>
                        Labor {money(l.labor_cost)} · Equipment{" "}
                        {money(l.equipment_cost)} · Materials{" "}
                        {money(l.material_cost)}
                      </small>
                    </td>
                    <td>
                      {money(l.labor_cost + l.equipment_cost + l.material_cost)}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
        {!entries.length && !approved.length && (
          <Empty>No recorded costs for this selection.</Empty>
        )}
      </section>
      {open && (
        <Modal title="Record a job cost" onClose={() => setOpen(false)}>
          <form onSubmit={submit}>
            <div className="erp-form-grid">
              <Field label="Project">
                <select
                  name="jobsite_id"
                  required
                  defaultValue={job || data.projects[0]?.id}
                >
                  {data.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Date">
                <input
                  name="date"
                  type="date"
                  required
                  defaultValue={today()}
                />
              </Field>
              <Field label="Cost code">
                <input name="cost_code" required list="cost-codes" />
                <datalist id="cost-codes">
                  {data.work_items.map((w) => (
                    <option key={w.id} value={w.cost_code} />
                  ))}
                </datalist>
              </Field>
              <Field label="Category">
                <select name="category">
                  {[
                    "labor",
                    "equipment",
                    "material",
                    "subcontract",
                    "other",
                  ].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </Field>
              <Field label="Amount ($)">
                <input
                  name="amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                />
              </Field>
              <Field label="Description / reference">
                <input
                  name="description"
                  required
                  placeholder="Invoice, time entry, or cost reference"
                />
              </Field>
            </div>
            <p className="erp-card-note">
              Record costs that are not already included in approved daily
              reports.
            </p>
            {error && (
              <p className="erp-alert error" role="alert">
                {error}
              </p>
            )}
            <div className="erp-form-actions">
              <button
                type="button"
                className="erp-button"
                onClick={() => setOpen(false)}
              >
                Cancel
              </button>
              <button className="erp-button primary" disabled={saving}>
                {saving ? "Saving…" : "Record cost"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
function csvDownload(name: string, rows: Array<Record<string, unknown>>) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  const cell = (v: unknown) =>
    '"' +
    String(v ?? "")
      .replace(/^[=+@\-\t\r]/, "'$&")
      .replaceAll('"', '""') +
    '"';
  const content = [
    keys.map(cell).join(","),
    ...rows.map((row) => keys.map((k) => cell(row[k])).join(",")),
  ].join("\r\n");
  const url = URL.createObjectURL(
    new Blob(["\uFEFF" + content], { type: "text/csv;charset=utf-8;" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `dirtworks-${name}-${today()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
function Exports({ data }: { data: ERPData }) {
  const cards = [
    {
      title: "Project portfolio",
      desc: "PM ownership, measured completion, contracts, actual cost, and forecasts.",
      name: "projects",
      rows: data.projects.map((p) => ({
        job_code: p.code,
        project: p.name,
        client: p.client,
        pm: p.pm_name,
        status: p.status,
        budget: p.budget,
        contract_value: p.contract_value,
        measured_pct: p.progress_pct,
        actual_cost: p.actual_cost,
        calculated_forecast: p.forecast_cost,
        approved_eac: p.approved_forecast_cost,
        approved_eac_as_of: p.approved_forecast_as_of,
        approved_forecast_finish: p.approved_forecast_finish,
        pm_completion_pct: latest(data, p.id)?.rough_pct,
        pm_forecast: latest(data, p.id)?.forecast_cost,
      })),
    },
    {
      title: "Weekly PM updates",
      desc: "The full history of completion estimates, finish forecasts, blockers, and plans.",
      name: "weekly-updates",
      rows: data.weekly_updates as unknown as Record<string, unknown>[],
    },
    {
      title: "Crew dispatch",
      desc: "Dated crew assignments by job, work front, and cost code.",
      name: "dispatch",
      rows: data.assignments as unknown as Record<string, unknown>[],
    },
    {
      title: "Production quantities",
      desc: "Installed scope, target rates, and measured work-item completion.",
      name: "production",
      rows: data.work_items as unknown as Record<string, unknown>[],
    },
    {
      title: "Cost ledger",
      desc: "Manual cost entries plus labor, equipment, and material costs from approved field reports.",
      name: "costs",
      rows: [
        ...data.cost_entries.map((c) => ({
          date: c.date,
          project: c.jobsite_name,
          cost_code: c.cost_code,
          category: c.category,
          amount: c.amount,
          description: c.description,
          source: "cost ledger",
        })),
        ...data.daily_reports
          .filter((r) => r.status === "approved" && !r.reversed_at)
          .flatMap((r) =>
            r.lines.map((l) => ({
              date: r.date,
              project: r.jobsite_name,
              cost_code:
                data.work_items.find((w) => w.id === l.plan_id)?.cost_code ||
                "",
              category: "field report",
              amount: l.labor_cost + l.equipment_cost + l.material_cost,
              description:
                data.work_items.find((w) => w.id === l.plan_id)?.activity || "",
              source: `approved report ${r.id}`,
            })),
          ),
      ],
    },
    {
      title: "People roster",
      desc: "People, roles, certifications, and crew membership.",
      name: "people",
      rows: data.people as unknown as Record<string, unknown>[],
    },
  ];
  return (
    <div className="erp-stack">
      <div className="erp-export-grid">
        {cards.map((c) => (
          <section className="erp-card erp-export-card" key={c.name}>
            <span className="erp-export-icon">
              <Icon name="reports" />
            </span>
            <h2>{c.title}</h2>
            <p>{c.desc}</p>
            <div>
              <span>{c.rows.length} records · CSV</span>
              <button
                className="erp-button"
                disabled={!c.rows.length}
                onClick={() => csvDownload(c.name, c.rows)}
              >
                Export CSV
              </button>
            </div>
          </section>
        ))}
      </div>
      <section className="erp-card">
        <SectionHead title="Reporting basis" />
        <div className="erp-reporting-basis">
          <div>
            <strong>Measured progress</strong>
            <p>
              Manual production entries and approved field reports. Work items
              are weighted by budget.
            </p>
          </div>
          <div>
            <strong>PM forecasts</strong>
            <p>
              Dated management estimates. Weekly percentages are snapshots and
              don’t accumulate as quantities.
            </p>
          </div>
          <div>
            <strong>Actual costs</strong>
            <p>
              Explicit cost entries and approved report cost lines. Commitments
              and change requests are separate.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
