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
