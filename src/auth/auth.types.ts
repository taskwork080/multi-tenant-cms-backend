export interface AuthUser {
  /** Supabase Auth user id (sub claim). */
  id: string;
  email?: string;
  /**
   * Application role, read from app_metadata.role:
   * "platform_admin" (cross-tenant) | "owner" | "admin" | "staff" | "viewer"
   */
  role: string;
  /** Tenant this user belongs to (app_metadata.tenant_id). Absent for platform admins. */
  tenantId?: string;
}

export const PLATFORM_ADMIN = "platform_admin";

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
