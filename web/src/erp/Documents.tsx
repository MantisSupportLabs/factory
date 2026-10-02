import { useEffect, useState, type FormEvent } from "react";
import {
  api,
  currentTenant,
  offlineDrafts,
  syncOfflineDrafts,
  discardOfflineDraft,
  watchOfflineDrafts,
  type OfflineDraft,
} from "../api/client";
import type { ERPData } from "./types";
import { Badge, Empty, Field, Modal, SectionHead } from "./ui";

type Document = {
  id: number;
  jobsite_id: number;
  jobsite_name: string;
  group_id: string;
  revision: number;
  supersedes_id: number | null;
  category: string;
  name: string;
  description: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  uploaded_by: string;
  uploaded_at: string;
};
const categories = [
  "drawing",
  "photo",
  "delivery_ticket",
  "permit",
  "quality",
  "safety",
  "correspondence",
  "closeout",
  "other",
];
const label = (value: string) => value.replaceAll("_", " ");
async function download(path: string, name: string): Promise<void> {
  const response = await fetch(`/api${path}`, {
    headers: { "X-Tenant-Id": currentTenant() },
  });
  if (!response.ok) {
    const result = await response.json();
    throw new Error(result.error || "Download failed");
  }
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Documents({ data }: { data: ERPData }) {
  const [rows, setRows] = useState<Document[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [project, setProject] = useState(""),
    [history, setHistory] = useState(false);
  async function load() {
    try {
      setRows(
        (await api.get<{ documents: Document[] }>("/erp/documents")).documents,
      );
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const latest = rows.filter(
    (row) =>
      !rows.some(
        (other) =>
          other.group_id === row.group_id && other.revision > row.revision,
      ),
  );
  const visible = (history ? rows : latest).filter(
    (row) => !project || row.jobsite_id === Number(project),
  );
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const values = new FormData(event.currentTarget),
      file = values.get("file") as File;
    try {
      if (!file?.size || file.size > 5 * 1024 * 1024)
        throw new Error("Choose a file up to 5 MB.");
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("Could not read this file"));
        reader.readAsDataURL(file);
      });
      const mime =
        file.type ||
        (file.name.endsWith(".csv")
          ? "text/csv"
          : file.name.endsWith(".txt")
            ? "text/plain"
            : "");
      await api.post("/erp/documents", {
        jobsite_id: Number(values.get("jobsite_id")),
        category: values.get("category"),
        description: values.get("description"),
        supersedes_id: values.get("supersedes_id") || undefined,
        name: file.name,
        mime_type: mime,
        base64,
      });
      setOpen(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="erp-stack">
      <SectionHead
        title="Project document register"
        description="Drawings, tickets, photos, permits, and closeout records. Each uploaded revision is retained with a file integrity check."
        action={
          <button
            className="erp-button primary"
            disabled={!data.projects.length}
            onClick={() => setOpen(true)}
          >
            Upload document
          </button>
        }
      />
      {error && (
        <div className="erp-alert error" role="alert">
          {error}
        </div>
      )}
      <div className="erp-toolbar">
        <select
          aria-label="Filter documents by project"
          value={project}
          onChange={(e) => setProject(e.target.value)}
        >
          <option value="">All projects</option>
          {data.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <label className="erp-check">
          <input
            type="checkbox"
            checked={history}
            onChange={(e) => setHistory(e.target.checked)}
          />{" "}
          Show revision history
        </label>
      </div>
      <div className="erp-card">
        <div className="erp-table-wrap">
          <table className="erp-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Project</th>
                <th>Category</th>
                <th>Revision</th>
                <th>Uploaded</th>
                <th>File</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.id}>
                  <td>
                    <strong>{row.name}</strong>
                    <small>{row.description || row.uploaded_by}</small>
                  </td>
                  <td>{row.jobsite_name}</td>
                  <td>{label(row.category)}</td>
                  <td>
                    <Badge>Rev {row.revision}</Badge>
                    {!latest.includes(row) && <small>Superseded</small>}
                  </td>
                  <td>
                    {new Date(row.uploaded_at).toLocaleDateString()}
                    <small>{row.uploaded_by}</small>
                  </td>
                  <td>
                    <button
                      className="erp-button"
                      onClick={() =>
                        void download(
                          `/erp/documents/${row.id}/download`,
                          row.name,
                        ).catch((e) => setError(e.message))
                      }
                    >
                      Download
                    </button>
                    <small>
                      {Math.ceil(row.size_bytes / 1024)} KB ·{" "}
                      {row.sha256.slice(0, 10)}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!visible.length && (
          <Empty>
            {loading
              ? "Loading documents…"
              : "Upload the first project record to begin the register."}
          </Empty>
        )}
      </div>
      {open && (
        <Modal title="Upload project document" onClose={() => setOpen(false)}>
          <form onSubmit={upload} className="erp-form">
            <div className="erp-form-grid">
              <Field label="Project">
                <select name="jobsite_id" required>
                  {data.projects.map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Category">
                <select name="category">
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {label(c)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Replaces document (optional)" wide>
                <select name="supersedes_id">
                  <option value="">New document</option>
                  {latest.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.jobsite_name} · {row.name} · rev {row.revision}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="File (PDF, JPG, PNG, WebP, TXT, CSV; up to 5 MB)"
                wide
              >
                <input
                  name="file"
                  type="file"
                  required
                  accept=".pdf,.jpg,.jpeg,.png,.webp,.txt,.csv"
                />
              </Field>
              <Field label="Description" wide>
                <textarea name="description" maxLength={2000} />
              </Field>
            </div>
            {error && (
              <p className="erp-form-error" role="alert">
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
              <button className="erp-button primary" disabled={busy}>
                {busy ? "Uploading…" : "Upload revision"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
export function OfflineCenter({
  data,
  refresh,
}: {
  data: ERPData;
  refresh: () => Promise<void>;
}) {
  const [rows, setRows] = useState<OfflineDraft[]>(offlineDrafts),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => watchOfflineDrafts(() => setRows(offlineDrafts())), []);
  async function sync() {
    setBusy(true);
    try {
      const result = await syncOfflineDrafts();
      setMessage(
        `${result.uploaded} uploaded · ${result.remaining} still on this device`,
      );
      if (result.uploaded) await refresh();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
      setRows(offlineDrafts());
    }
  }
  return (
    <div className="erp-stack">
      <SectionHead
        title="Device drafts"
        description="New daily reports saved during a connection failure stay on this device until they upload as drafts. Review and submit them after syncing."
        action={
          <button
            className="erp-button primary"
            onClick={() => void sync()}
            disabled={busy || !rows.length}
          >
            {busy ? "Syncing…" : "Sync drafts"}
          </button>
        }
      />
      <div className="erp-alert">
        Approvals, payments, and other financial actions require a connection.
        Device storage can be removed by clearing browser data; export important
        drafts before doing so.
      </div>
      {message && (
        <div className="erp-alert" role="status">
          {message}
        </div>
      )}
      <div className="erp-card">
        <div className="erp-table-wrap">
          <table className="erp-table">
            <thead>
              <tr>
                <th>Project / crew</th>
                <th>Work date</th>
                <th>Saved locally</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    {data.projects.find((p) => p.id === row.body.jobsite_id)
                      ?.name || `Project ${row.body.jobsite_id}`}
                    <small>Crew {String(row.body.crew_id)}</small>
                  </td>
                  <td>{String(row.body.date)}</td>
                  <td>{new Date(row.saved_at).toLocaleString()}</td>
                  <td>
                    <Badge tone={row.error ? "red" : "amber"}>
                      {row.error || "Waiting to upload"}
                    </Badge>
                  </td>
                  <td>
                    <button
                      className="erp-button"
                      onClick={() => {
                        const url = URL.createObjectURL(
                          new Blob([JSON.stringify(row, null, 2)], {
                            type: "application/json",
                          }),
                        );
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `daily-draft-${row.id}.json`;
                        a.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      }}
                    >
                      Export
                    </button>{" "}
                    <button
                      className="erp-button"
                      onClick={() => discardOfflineDraft(row.id)}
                    >
                      Discard
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && <Empty>No pending drafts on this device.</Empty>}
      </div>
    </div>
  );
}
export function BusinessExport() {
  const [error, setError] = useState("");
  return (
    <div className="erp-card">
      <SectionHead
        title="Business data export"
        description="Download this company’s records as JSON. Uploaded files and login credentials require the host backup procedure."
        action={
          <button
            className="erp-button"
            onClick={() =>
              void download(
                "/erp/data-export",
                "dirtworks-business-data.json",
              ).catch((e) => setError(e.message))
            }
          >
            Export company data
          </button>
        }
      />
      {error && <p className="erp-form-error">{error}</p>}
    </div>
  );
}
