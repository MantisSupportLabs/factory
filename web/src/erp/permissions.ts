import { useAccess } from "./Access";
/** Presentation only; the API independently enforces all permissions. */
export function useCanEdit(...roles: string[]): boolean {
  const { mode, role } = useAccess();
  return (
    mode === "demo" ||
    role === "owner" ||
    role === "admin" ||
    roles.includes(role ?? "")
  );
}
