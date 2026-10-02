import { get } from '../db/database.js';

export class ErpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export type Body = Record<string, unknown>;
export function body(value: unknown): Body {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ErpError(400, 'A JSON object is required');
  return value as Body;
}
export function text(value: unknown, field: string, required = true, max = 2000): string {
  if (value === undefined || value === null) {
    if (!required) return '';
    throw new ErpError(400, `${field} is required`);
  }
  if (typeof value !== 'string') throw new ErpError(400, `${field} must be text`);
  const result = value.trim();
  if (required && !result) throw new ErpError(400, `${field} is required`);
  if (result.length > max) throw new ErpError(400, `${field} must be ${max} characters or fewer`);
  return result;
}
export function number(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '' || (typeof value === 'string' && !value.trim())) {
    throw new ErpError(400, `${field} must be a finite number`);
  }
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) throw new ErpError(400, `${field} must be between ${min} and ${max}`);
  return result;
}
export function id(value: unknown, field = 'id'): number {
  const result = number(value, field, 1);
  if (!Number.isSafeInteger(result)) throw new ErpError(400, `${field} must be a positive integer`);
  return result;
}
export function date(value: unknown, field: string, nullable = false): string | null {
  if (nullable && (value === undefined || value === null || value === '')) return null;
  const result = text(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(`${result}T00:00:00.000Z`).toISOString().slice(0, 10) !== result) {
    throw new ErpError(400, `${field} must be a valid YYYY-MM-DD date`);
  }
  return result;
}
export function dateRange(start: string | null, end: string | null): void {
  if (start && end && start > end) throw new ErpError(400, 'Start date must be on or before end date');
}
export function option<T extends string>(value: unknown, field: string, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new ErpError(400, `${field} must be one of ${choices.join(', ')}`);
  return value as T;
}
export function related(tenant: number, table: 'jobsites' | 'employees' | 'crews' | 'production_plans' | 'daily_reports' | 'weekly_updates', value: unknown, field: string): number {
  const result = id(value, field);
  if (!get(`SELECT id FROM ${table} WHERE tenant_id = ? AND id = ?`, tenant, result)) throw new ErpError(404, `${field} not found`);
  return result;
}
export function activeEmployee(tenant: number, value: unknown, field: string, roles?: string[]): number {
  const result = related(tenant, 'employees', value, field);
  const employee = get<{active: number; role: string}>('SELECT active, role FROM employees WHERE tenant_id = ? AND id = ?', tenant, result)!;
  if (!employee.active) throw new ErpError(400, `${field} must be an active employee`);
  if (roles && !roles.includes(employee.role)) throw new ErpError(400, `${field} must have role ${roles.join(' or ')}`);
  return result;
}
export function optionalPm(tenant: number, value: unknown): number | null {
  return value === undefined || value === null || value === '' ? null : activeEmployee(tenant, value, 'pm_id', ['pm', 'super']);
}
export function nullableText(value: unknown, field: string, max = 2000): string | null {
  return value === undefined || value === null || value === '' ? null : text(value, field, false, max);
}
export function hasEdits(value: Body, fields: string[]): void {
  if (!fields.some(field => field in value)) throw new ErpError(400, 'No editable fields supplied');
}
