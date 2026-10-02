import { useState, type FormEvent } from "react";
import { api } from "../api/client";
import { useCanEdit } from "./permissions";
import type { AssetStateRow } from "../api/types";
import { useApp } from "../state/store";
import { number, type ERPData } from "./types";
import { Badge, Empty, Field, Modal, SectionHead } from "./ui";
export function Assets({
  data,
  refresh,
}: {
  data: ERPData;
  refresh: () => Promise<void>;
}) {
  const assets = useApp((s) => s.assets);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [job, setJob] = useState("");
  const [editing, setEditing] = useState<AssetStateRow | null | undefined>();
  const canEdit = useCanEdit();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const visible = assets.filter(
    (a) =>
      (!kind || a.kind === kind) &&
      (!job ||
        String(a.jobsite_id) === job ||
        (job === "unassigned" && a.jobsite_id === null)) &&
      `${a.name} ${a.make || ""} ${a.model || ""} ${a.operator || ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const b = {
      name: f.get("name"),
      kind: f.get("kind"),
      category: f.get("category"),
      make: f.get("make"),
      model: f.get("model"),
      jobsite_id: f.get("jobsite_id") ? Number(f.get("jobsite_id")) : null,
      operator: f.get("operator") || null,
      status: f.get("status") || "active",
      tracking_mode: editing?.tracking_mode || "manual",
    };
    setSaving(true);
    try {
      if (editing) await api.patch(`/assets/${editing.id}`, b);
      else await api.post("/assets", b);
      await refresh();
      setEditing(undefined);
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
          <span>Equipment & vehicles</span>
          <strong>
            {
              assets.filter((a) =>
                ["machine", "truck", "attachment"].includes(a.kind),
              ).length
            }
          </strong>
          <small>Heavy equipment and rolling fleet</small>
        </div>
        <div className="erp-metric">
          <span>Small tools</span>
          <strong>
            {assets.filter((a) => a.kind === "small_tool").length}
          </strong>
          <small>Checkout history in the live field workspace</small>
        </div>
        <div className="erp-metric">
          <span>Needs maintenance review</span>
          <strong>
            {
              assets.filter(
                (a) =>
                  a.status === "down" ||
                  a.status === "maintenance" ||
                  a.active_faults > 0,
              ).length
            }
          </strong>
          <small>Unavailable equipment or active fault codes</small>
        </div>
      </div>
      <section className="erp-card">
        <SectionHead
          title="Asset register"
          description="Job allocation, operator, availability, and latest telemetry"
          action={
            <button
              className="erp-button primary"
              disabled={!canEdit}
              onClick={() => {
                setError("");
                setEditing(null);
              }}
            >
              + Register asset
            </button>
          }
        />
        <div className="erp-toolbar">
          <input
            aria-label="Search assets"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search asset, make, or operator…"
          />
          <select
            aria-label="Filter asset type"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">All asset types</option>
            {[
              "machine",
              "truck",
              "small_tool",
              "attachment",
              "trailer",
              "camera",
              "network",
            ].map((k) => (
              <option key={k} value={k}>
                {k.replace("_", " ")}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter asset project"
            value={job}
            onChange={(e) => setJob(e.target.value)}
          >
            <option value="">All projects</option>
            <option value="unassigned">Unassigned / yard</option>
            {data.projects.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="erp-table-wrap">
          <table className="erp-table">
            <thead>
              <tr>
                <th>Asset / type</th>
                <th>Assigned project</th>
                <th>Operator / custodian</th>
                <th>Availability</th>
                <th>Engine hours</th>
                <th>Fuel / faults</th>
                <th>Tracking</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((a) => (
                <tr key={a.id}>
                  <td>
                    <strong>{a.name}</strong>
                    <small>
                      {a.kind.replace("_", " ")} ·{" "}
                      {[a.make, a.model].filter(Boolean).join(" ")}
                    </small>
                  </td>
                  <td>
                    {data.projects.find((p) => p.id === a.jobsite_id)?.name ||
                      "Yard / unassigned"}
                  </td>
                  <td>{a.operator || "—"}</td>
                  <td>
                    <Badge
                      tone={
                        a.status === "active"
                          ? "green"
                          : a.status === "down"
                            ? "red"
                            : "amber"
                      }
                    >
                      {a.status}
                    </Badge>
                  </td>
                  <td>{number(a.engine_hours, 1)}</td>
                  <td>
                    {a.fuel_percent == null
                      ? "—"
                      : number(a.fuel_percent) + "%"}
                    {a.active_faults > 0 && (
                      <small className="erp-negative">
                        {a.active_faults} active faults
                      </small>
                    )}
                  </td>
                  <td>
                    <Badge tone={a.provider ? "blue" : "neutral"}>
                      {a.provider ? "Simulated OEM" : "Manual"}
                    </Badge>
                  </td>
                  <td>
                    <button
                      className="erp-button small"
                      disabled={!canEdit}
                      onClick={() => {
                        setError("");
                        setEditing(a);
                      }}
                    >
                      Manage
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!visible.length && <Empty>No assets match the filters.</Empty>}
        <div className="erp-card-note">
          A manual job allocation is locked against automatic geofence
          reassignment. OEM feeds currently use the sample fleet simulator.
        </div>
      </section>
      {editing !== undefined && (
        <Modal
          title={editing ? "Manage asset" : "Register asset"}
          onClose={() => setEditing(undefined)}
        >
          <form onSubmit={submit}>
            <div className="erp-form-grid">
              <Field label="Asset name">
                <input name="name" required defaultValue={editing?.name} />
              </Field>
              <Field label="Asset type">
                <select
                  name="kind"
                  defaultValue={editing?.kind || "machine"}
                  disabled={!!editing}
                >
                  {[
                    "machine",
                    "truck",
                    "small_tool",
                    "attachment",
                    "trailer",
                    "camera",
                    "network",
                  ].map((k) => (
                    <option key={k} value={k}>
                      {k.replace("_", " ")}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Category">
                <input
                  name="category"
                  defaultValue={editing?.category || ""}
                  placeholder="Excavator, grade laser…"
                />
              </Field>
              <Field label="Availability">
                <select
                  name="status"
                  defaultValue={editing?.status || "active"}
                >
                  {["active", "down", "maintenance"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </Field>
              <Field label="Make">
                <input
                  name="make"
                  defaultValue={editing?.make || ""}
                  readOnly={!!editing}
                />
              </Field>
              <Field label="Model">
                <input
                  name="model"
                  defaultValue={editing?.model || ""}
                  readOnly={!!editing}
                />
              </Field>
              <Field label="Assigned project">
                <select
                  name="jobsite_id"
                  defaultValue={editing?.jobsite_id || ""}
                >
                  <option value="">Yard / unassigned</option>
                  {data.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Operator / custodian">
                <select name="operator" defaultValue={editing?.operator || ""}>
                  <option value="">Unassigned</option>
                  {data.people
                    .filter((p) => p.active)
                    .map((p) => (
                      <option key={p.id} value={p.name}>
                        {p.name}
                      </option>
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
              <button
                type="button"
                className="erp-button"
                onClick={() => setEditing(undefined)}
              >
                Cancel
              </button>
              <button className="erp-button primary" disabled={saving}>
                {saving ? "Saving…" : "Save asset"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
