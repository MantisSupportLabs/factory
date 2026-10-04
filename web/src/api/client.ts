/**
 * Tiny fetch wrapper for the DirtWorks API. Tenant is selected with the
 * X-Tenant-Id header — stored in localStorage for the demo, resolved from
 * the login/subdomain in the SaaS build.
 */

import { browserDemo, demoRequest } from '../demo/client';
const TENANT_KEY = "dirtworks.tenant";
let csrfToken = "";
export function setCsrfToken(value: string | null): void {
  csrfToken = value ?? "";
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function currentTenant(): string {
  try {
    return localStorage.getItem(TENANT_KEY) ?? "summit-dirtworks";
  } catch {
    return "summit-dirtworks";
  }
}

export function setTenant(slug: string): void {
  try {
    localStorage.setItem(TENANT_KEY, slug);
  } catch {
    /* private mode */
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = browserDemo ? await demoRequest(method, path, body) : await fetch(`/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(path.startsWith("/auth/") ? {} : { "X-Tenant-Id": currentTenant() }),
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) detail = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(detail, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export interface OfflineDraft {
  id: string;
  tenant: string;
  saved_at: string;
  body: Record<string, unknown>;
  error?: string;
}
const DRAFT_KEY = "dirtworks.offline-drafts.v1";
const DRAFT_EVENT = "dirtworks-drafts-changed";
function allDrafts(): OfflineDraft[] {
  try {
    return JSON.parse(
      localStorage.getItem(DRAFT_KEY) || "[]",
    ) as OfflineDraft[];
  } catch {
    return [];
  }
}
function storeDrafts(rows: OfflineDraft[]): void {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(rows));
  window.dispatchEvent(new Event(DRAFT_EVENT));
}
export function offlineDrafts(): OfflineDraft[] {
  return allDrafts().filter((row) => row.tenant === currentTenant());
}
export function watchOfflineDrafts(fn: () => void): () => void {
  window.addEventListener(DRAFT_EVENT, fn);
  return () => window.removeEventListener(DRAFT_EVENT, fn);
}
export function discardOfflineDraft(id: string): void {
  storeDrafts(
    allDrafts().filter(
      (row) => row.id !== id || row.tenant !== currentTenant(),
    ),
  );
}
/** Only new field drafts may be queued; approvals and financial actions require the server. */
export async function saveDailyDraft<T>(
  body: Record<string, unknown>,
): Promise<T | { queued: true }> {
  const id = crypto.randomUUID();
  const payload = { ...body, status: "draft", client_request_id: id };
  try {
    return await api.post<T>("/erp/daily-reports", payload);
  } catch (error) {
    if (error instanceof ApiError || !(error instanceof TypeError)) throw error;
    const rows = allDrafts();
    if (rows.length >= 100)
      throw new Error(
        "Device draft storage is full. Sync or remove a draft first.",
      );
    storeDrafts([
      ...rows,
      {
        id,
        tenant: currentTenant(),
        saved_at: new Date().toISOString(),
        body: payload,
      },
    ]);
    return { queued: true };
  }
}
let syncing = false;
export async function syncOfflineDrafts(): Promise<{
  uploaded: number;
  remaining: number;
}> {
  if (syncing) return { uploaded: 0, remaining: offlineDrafts().length };
  syncing = true;
  let uploaded = 0;
  const tenant = currentTenant();
  try {
    for (const draft of offlineDrafts()) {
      if (currentTenant() !== tenant) break;
      try {
        await api.post("/erp/daily-reports", draft.body);
        discardOfflineDraft(draft.id);
        uploaded++;
      } catch (error) {
        if (!(error instanceof ApiError)) break;
        storeDrafts(
          allDrafts().map((row) =>
            row.id === draft.id && row.tenant === tenant
              ? { ...row, error: error.message }
              : row,
          ),
        );
        if (error.status === 401 || error.status === 403) break;
      }
    }
  } finally {
    syncing = false;
  }
  return { uploaded, remaining: offlineDrafts().length };
}
