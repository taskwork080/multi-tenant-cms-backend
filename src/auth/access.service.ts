import { Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { TenantDb } from "../db/tenant-db.service";
import { rolePermissions, roles, staffUsers } from "../db/schema";
import { PLATFORM_ADMIN, actorOf, type AuthUser } from "./auth.types";
import { isCapabilityKey } from "./capabilities";
import { resolveMenuAccess, type MenuAccess } from "./menu-access";

/**
 * What a user is allowed to do, resolved from their staff record.
 *
 * Lifted out of MeController so the guards and /api/me read the same thing:
 * two resolvers would eventually disagree, and the one the guards use is the
 * one that decides whether a request is allowed — a menu computed from a
 * different rule set would just be a lie the UI tells.
 *
 * Deliberately a sibling of AuthUser rather than fields on it: AuthUser is the
 * JWT-claims mirror that every guard and actorOf() reads, and widening it with
 * DB-derived state would make those call sites lie about where the data
 * came from.
 */
export interface UserAccess {
  /**
   * Display name for an activity/audit `actor` column — the email where we
   * have one. Carried here so a write path that already takes `access` does
   * not also have to take the AuthUser just to name who did it.
   */
  actor: string;
  staffUserId: string | null;
  roleId: string | null;
  roleName: string | null;
  /** Staff lifecycle: active | invited | suspended | deactivated. */
  staffStatus: string | null;
  /** Raw role_permissions rows in `sort` order — capability *and* menu keys. */
  permissions: string[];
  /** The capability subset, pre-split so guards don't refilter per request. */
  capabilities: string[];
  /**
   * True when this user's app role skips capability checks entirely
   * (platform_admin, owner). Kept on the resolved object so the guard has one
   * thing to read rather than re-deriving from AuthUser.
   */
  bypass: boolean;
  /** Resolved server-side so precedence lives in exactly one place. */
  menu: MenuAccess;
}

/** Platform admins and users with no workspace skip the staff lookup entirely. */
export const BYPASS_ACCESS: UserAccess = {
  actor: "system",
  staffUserId: null,
  roleId: null,
  roleName: null,
  staffStatus: null,
  permissions: [],
  capabilities: [],
  bypass: true,
  menu: { unrestricted: true, hrefs: [] },
};

/**
 * App roles that skip menu *and* capability checks.
 *
 * owner is included on purpose: there is no in-app recovery from an owner
 * locking themselves out of /staff/roles — only a platform admin or raw SQL.
 * The same argument that made owner bypass menus makes it bypass capabilities,
 * and splitting the two would give you an owner who can see the roles page but
 * not save it.
 */
export function bypassesAccessChecks(role: string): boolean {
  return role === PLATFORM_ADMIN || role === "owner";
}

@Injectable()
export class AccessService {
  /**
   * Resolved access is read on *every* request by AccessGuard, so it is cached
   * for the same 30s window TenantService uses for tenants. Consequence, and
   * it is the same one documented on TenantGuard: a role edit or a staff
   * suspension takes up to 30s to bind on an instance that did not serve the
   * write. Acceptable for administrative changes; `invalidate` covers the
   * process that made the change.
   */
  private static readonly TTL_MS = 30_000;
  private readonly cache = new Map<string, { access: UserAccess; at: number }>();

  constructor(private readonly tdb: TenantDb) {}

  async forUser(user: AuthUser): Promise<UserAccess> {
    if (user.role === PLATFORM_ADMIN || !user.tenantId) return { ...BYPASS_ACCESS, actor: actorOf(user) };

    const hit = this.cache.get(user.id);
    if (hit && Date.now() - hit.at < AccessService.TTL_MS) return hit.access;

    const access = await this.load(user);
    this.cache.set(user.id, { access, at: Date.now() });
    return access;
  }

  /** Drop a user's cached access — call after editing their role or status. */
  invalidate(authUserId: string) {
    this.cache.delete(authUserId);
  }

  /** Drop everything. Used when a role's permissions change, which can affect many users. */
  invalidateAll() {
    this.cache.clear();
  }

  /**
   * auth user -> staff_users -> roles -> role_permissions, in one round trip.
   *
   * Must run inside forTenant(): RLS is enabled AND FORCED on all three tables
   * (drizzle/0001_rls.sql). Using tdb.raw here would return zero rows, which
   * resolves to "no staff row" and would silently hand every caller an
   * unrestricted menu without any visible error.
   */
  private async load(user: AuthUser): Promise<UserAccess> {
    const rows = await this.tdb.forTenant(user.tenantId!, (tx) =>
      tx
        .select({
          staffUserId: staffUsers.id,
          staffStatus: staffUsers.status,
          roleId: roles.id,
          roleName: roles.name,
          permission: rolePermissions.permission,
        })
        .from(staffUsers)
        .leftJoin(roles, eq(roles.id, staffUsers.roleId))
        .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
        .where(eq(staffUsers.authUserId, user.id))
        .orderBy(asc(rolePermissions.sort)),
    );

    // No staff row at all, or a staff row whose role was deleted (role_id is
    // ON DELETE SET NULL) — either way, don't blank their admin.
    const head = rows[0];
    const permissions = rows.map((r) => r.permission).filter((p): p is string => p !== null);
    const bypass = bypassesAccessChecks(user.role);

    return {
      actor: actorOf(user),
      staffUserId: head?.staffUserId ?? null,
      roleId: head?.roleId ?? null,
      roleName: head?.roleName ?? null,
      staffStatus: head?.staffStatus ?? null,
      permissions,
      capabilities: permissions.filter(isCapabilityKey),
      bypass,
      menu: resolveMenuAccess(permissions, { bypass, hasRole: Boolean(head?.roleId) }),
    };
  }
}
