import { Controller, Get } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { asc, eq } from "drizzle-orm";
import { TenantDb } from "../db/tenant-db.service";
import { rolePermissions, roles, staffUsers } from "../db/schema";
import { TenantService, type TenantDto } from "../tenant/tenant.service";
import { CurrentUser } from "./decorators";
import { PLATFORM_ADMIN, type AuthUser } from "./auth.types";
import { resolveMenuAccess, type MenuAccess } from "./menu-access";

/**
 * What this user is allowed to see, resolved from their staff record.
 *
 * Deliberately a sibling of `user` rather than fields on it: AuthUser is the
 * JWT-claims mirror that every guard and actorOf() reads, and widening it with
 * DB-derived state would make those call sites lie about where the data came
 * from.
 */
export interface MeAccess {
  staffUserId: string | null;
  roleId: string | null;
  roleName: string | null;
  /** Raw role_permissions rows in `sort` order — capability *and* menu keys. */
  permissions: string[];
  /** Resolved server-side so precedence lives in exactly one place. */
  menu: MenuAccess;
}

export interface MeResponse {
  user: AuthUser;
  /** Tenants visible to this user: all for platform admins, else their own. */
  tenants: TenantDto[];
  access: MeAccess;
}

/** Platform admins and users with no workspace skip the staff lookup entirely. */
const BYPASS_ACCESS: MeAccess = {
  staffUserId: null,
  roleId: null,
  roleName: null,
  permissions: [],
  menu: { unrestricted: true, hrefs: [] },
};

/** App roles that ignore menu permissions. */
function bypassesMenu(role: string): boolean {
  // owner is included on purpose: there is no in-app recovery from an owner
  // hiding /staff/roles from themselves — only a platform admin or raw SQL.
  return role === PLATFORM_ADMIN || role === "owner";
}

@ApiTags("auth")
@ApiBearerAuth()
@Controller("api/me")
export class MeController {
  constructor(
    private readonly tenants: TenantService,
    private readonly tdb: TenantDb,
  ) {}

  @Get()
  @ApiOperation({ summary: "Current user, their tenant(s), and their resolved access" })
  async me(@CurrentUser() user: AuthUser): Promise<MeResponse> {
    if (user.role === PLATFORM_ADMIN) {
      return { user, tenants: await this.tenants.list(), access: BYPASS_ACCESS };
    }
    if (!user.tenantId) return { user, tenants: [], access: BYPASS_ACCESS };

    const [tenant, access] = await Promise.all([
      this.tenants.byId(user.tenantId),
      this.loadAccess(user),
    ]);
    return { user, tenants: [tenant], access };
  }

  /**
   * auth user -> staff_users -> roles -> role_permissions, in one round trip.
   *
   * Must run inside forTenant(): RLS is enabled AND FORCED on all three tables
   * (drizzle/0001_rls.sql). Using tdb.raw here would return zero rows, which
   * resolves to "unrestricted" and would silently disable the whole feature
   * without any visible error.
   */
  private async loadAccess(user: AuthUser): Promise<MeAccess> {
    const rows = await this.tdb.forTenant(user.tenantId!, (tx) =>
      tx
        .select({
          staffUserId: staffUsers.id,
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

    return {
      staffUserId: head?.staffUserId ?? null,
      roleId: head?.roleId ?? null,
      roleName: head?.roleName ?? null,
      permissions,
      menu: resolveMenuAccess(permissions, {
        bypass: bypassesMenu(user.role),
        hasRole: Boolean(head?.roleId),
      }),
    };
  }
}
