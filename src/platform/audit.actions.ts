/**
 * Closed vocabulary for platform_audit_log.action.
 *
 * Kept as a const tuple so the audit filter UI can render an exhaustive list
 * rather than a free-text box. Mirrored on the frontend in
 * src/lib/platform-audit-actions.ts — keep the two in sync.
 */
export const AUDIT_ACTIONS = [
  "user.create",
  "user.update",
  "user.status",
  "user.role",
  "user.move_tenant",
  "user.reset_password",
  "user.delete",
  "tenant.create",
  "tenant.update",
  "tenant.status",
  "tenant.impersonate_start",
  "tenant.impersonate_end",
  "platform_admin.grant",
  "platform_admin.revoke",
  "role.create",
  "role.update",
  "role.delete",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_TARGET_TYPES = ["staff_user", "tenant", "role", "auth_user"] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];
