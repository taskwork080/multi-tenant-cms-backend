/**
 * The application's role model, in one place.
 *
 * There are exactly three identities:
 *
 *   platform_admin  cross-tenant super admin. Exactly one exists (enforced by
 *                   the partial unique index in drizzle/0014_single_platform_admin.sql
 *                   and by PlatformAdminsService.promote). No tenant.
 *   owner           runs one workspace. Appointed by the platform admin ONLY.
 *   staff           invited by an owner. Everything they may do comes from the
 *                   tenant Role assigned to them.
 *
 * `admin` and `viewer` used to sit between owner and staff. They carried no
 * meaning the tenant Role could not express — an "admin" was just a staff member
 * whose Role happened to include settings.manage — so they were removed rather
 * than kept as two more strings every call site has to remember.
 *
 * Mirrored on the frontend at multi-tenant-cms/src/lib/schemas.ts (APP_ROLES)
 * and src/lib/types.ts (AppRole). There is no shared package; keep them in step.
 */

export const PLATFORM_ADMIN = "platform_admin";

/** Tenant-scoped app roles, most privileged first. Excludes PLATFORM_ADMIN. */
export const APP_ROLES = ["owner", "staff"] as const;
export type AppRole = (typeof APP_ROLES)[number];

/**
 * Rank ladder for the invite path: an inviter may grant their own rank or lower,
 * never higher. Without it a staff member holding staff.manage could invite an
 * owner and let themselves back in as one, turning a tenant capability into
 * privilege escalation.
 *
 * PLATFORM_ADMIN is deliberately absent — it is not grantable through any tenant
 * surface, and assertMayGrant short-circuits for it before consulting this.
 */
export const RANK: Record<string, number> = { owner: 0, staff: 1 };

/**
 * Map whatever is in a token's app_metadata onto a role this app understands.
 *
 * Called at the JWT boundary (JwtVerifier.verify), which is what makes the
 * legacy-role migration safe to deploy: a browser still holding an `admin` or
 * `viewer` token behaves as `staff` from its very next request, with no forced
 * sign-out and no 401. The same fallback covers an absent claim, which used to
 * resolve to "viewer" — a role that no longer exists.
 *
 * Unknown input degrades to the LEAST privileged role. Never widen here.
 */
export function normalizeAppRole(raw: unknown): string {
  const role = String(raw ?? "");
  if (role === PLATFORM_ADMIN || role === "owner") return role;
  return "staff";
}

/**
 * Skips capability checks entirely.
 *
 * owner is included on purpose: there is no in-app recovery from an owner
 * locking themselves out of /staff/roles — only the platform admin or raw SQL.
 * The consequence is that menu scoping is the only lever the platform admin has
 * over an owner's UI, and it is cosmetic; the ENFORCED lever on an owner is the
 * workspace's module entitlements (EntitlementGuard), not this.
 */
export function bypassesCapabilityChecks(role: string): boolean {
  return role === PLATFORM_ADMIN || role === "owner";
}

/**
 * Skips MENU checks. Platform admin only — deliberately narrower than
 * bypassesCapabilityChecks.
 *
 * These two used to be one predicate, which meant an owner bypassed menus too
 * and every menu permission the platform admin assigned to an owner was
 * silently discarded. Splitting them is what makes that grant bind.
 */
export function bypassesMenuChecks(role: string): boolean {
  return role === PLATFORM_ADMIN;
}
