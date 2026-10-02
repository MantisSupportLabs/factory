import { get } from "../db/database.js";
import { ErpError } from "./validation.js";

function hasTable(name: string): boolean {
  return Boolean(
    get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name),
  );
}
export function assertProjectOpen(tenant: number, project: number): void {
  if (
    hasTable("project_closeouts") &&
    get(
      "SELECT jobsite_id FROM project_closeouts WHERE tenant_id=? AND jobsite_id=?",
      tenant,
      project,
    )
  ) {
    throw new ErpError(
      409,
      "This project has final acceptance. New work requires a formal reopening workflow.",
    );
  }
}
export function assertProjectStatusEdit(
  tenant: number,
  project: number,
  previous: unknown,
  next: unknown,
): void {
  if (next === undefined || next === previous) return;
  assertProjectOpen(tenant, project);
  if (next === "complete" && hasTable("project_closeouts"))
    throw new ErpError(
      409,
      "Use the project closeout checklist and final acceptance to complete this job.",
    );
}
export function assertFinancialSetupEdit(
  tenant: number,
  project: number,
): void {
  assertProjectOpen(tenant, project);
  const controlled =
    (hasTable("approved_project_changes") &&
      get(
        "SELECT id FROM approved_project_changes WHERE tenant_id=? AND jobsite_id=? LIMIT 1",
        tenant,
        project,
      )) ||
    (hasTable("project_baselines") &&
      get(
        "SELECT id FROM project_baselines WHERE tenant_id=? AND jobsite_id=? AND status='approved' LIMIT 1",
        tenant,
        project,
      )) ||
    (hasTable("billing_pay_items") &&
      get(
        "SELECT id FROM billing_pay_items WHERE tenant_id=? AND jobsite_id=? LIMIT 1",
        tenant,
        project,
      ));
  if (controlled)
    throw new ErpError(
      409,
      "This project has an approved baseline, signed change, or billing schedule. Use a signed change approval to revise the contract or budget.",
    );
}
