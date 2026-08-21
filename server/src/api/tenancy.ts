/**
 * Tenant resolution. Single demo tenant today; the X-Tenant-Id header (or
 * subdomain, later) selects the tenant in the SaaS deployment. Every route
 * handler receives a concrete tenantId — no query ever runs untenanted.
 */

import type { NextFunction, Request, Response } from 'express';
import { get } from '../db/database.js';
import { config } from '../config.js';

export interface TenantRow {
  id: number;
  slug: string;
  name: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    tenant: TenantRow;
  }
}

export function tenantMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('x-tenant-id');
  let tenant: TenantRow | undefined;
  if (header) {
    tenant = /^\d+$/.test(header)
      ? get<TenantRow>(`SELECT id, slug, name FROM tenants WHERE id = ?`, Number(header))
      : get<TenantRow>(`SELECT id, slug, name FROM tenants WHERE slug = ?`, header);
    if (!tenant) {
      res.status(404).json({ error: `unknown tenant '${header}'` });
      return;
    }
  } else {
    tenant = get<TenantRow>(`SELECT id, slug, name FROM tenants WHERE slug = ?`, config.defaultTenantSlug);
    if (!tenant) {
      res.status(500).json({ error: 'default tenant missing — run seed' });
      return;
    }
  }
  req.tenant = tenant;
  next();
}
