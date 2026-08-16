export interface AuthUser {
  /** Supabase Auth user id (sub claim). */
  id: string;
  email?: string;
  /**
   * Application role, read from app_metadata.role and passed through
   * normalizeAppRole(), so it is always one of:
   * "platform_admin" (cross-tenant) | "owner" | "staff"
   */
  role: string;
  /** Tenant this user belongs to (app_metadata.tenant_id). Absent for platform admins. */
  tenantId?: string;
}

/**
 * Re-exported so the dozens of existing `from "./auth.types"` imports keep
 * working. The role model itself lives in ./roles — see that file for why there
 * are three roles and not five.
 */
export { PLATFORM_ADMIN } from "./roles";

/**
 * Display name for an activity/audit `actor` column.
 *
 * activities.actor is free text and used to default to "system" at every call
 * site, so the feed recorded what happened but never who. Prefer the email —
 * it is what a human reading the log recognises.
 */
export function actorOf(user?: AuthUser | null): string {
  return user?.email ?? user?.id ?? "system";
}
