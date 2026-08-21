/**
 * Tiny fetch wrapper for the DirtWorks API. Tenant is selected with the
 * X-Tenant-Id header — stored in localStorage for the demo, resolved from
 * the login/subdomain in the SaaS build.
 */

const TENANT_KEY = 'dirtworks.tenant';

export function currentTenant(): string {
  try {
    return localStorage.getItem(TENANT_KEY) ?? 'summit-dirtworks';
  } catch {
    return 'summit-dirtworks';
  }
}

export function setTenant(slug: string): void {
  try {
    localStorage.setItem(TENANT_KEY, slug);
  } catch {
    /* private mode */
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Tenant-Id': currentTenant(),
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
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
