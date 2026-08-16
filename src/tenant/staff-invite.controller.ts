import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { actorOf, type AuthUser } from "../auth/auth.types";
import { CurrentUser, RequireCapability, Roles } from "../auth/decorators";
import { AccessService } from "../auth/access.service";
import { APP_ROLES, PLATFORM_ADMIN, RANK } from "../auth/roles";
import { staffUsers } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { PlatformUsersService } from "../platform/platform-users.service";
import type { AuditCtx } from "../platform/audit.service";
import { RequireModule } from "./module.decorator";
import { CurrentTenant } from "./tenant.decorator";
import type { TenantDto } from "./tenant.service";

/**
 * Staff onboarding, owned by the workspace.
 *
 * WHAT THIS REPLACES: adding staff used to mean POSTing to the generic
 * /api/:tenant/staff CRUD route, which wrote a staff_users row with
 * `status: 'invited'` and `auth_user_id: null` — no GoTrue identity, no email,
 * no link. The row sat there and the person could never log in. The only
 * working path was the super admin's POST /api/admin/users, so every customer's
 * hiring went through the platform operator. That does not scale past a
 * handful of workspaces and it is the first thing a customer asks for.
 *
 * WHY IT DELEGATES: PlatformUsersService.create already solves the hard part —
 * GoTrue and Postgres cannot share a transaction, so it creates the identity
 * first, uses the DB write as the commit point, compensates by deleting the
 * identity on failure, adopts a pre-existing unattached identity, and honours
 * the global lower(email) uniqueness that makes "one user = one workspace"
 * enforceable. Reimplementing that here would mean two copies of a
 * split-state protocol, and the second one would be subtly wrong.
 *
 * What this layer adds is the tenant-scoping the platform service cannot do:
 * the workspace is taken from the route, never the body, and an inviter may
 * not mint an app role above their own.
 */

const inviteSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email(),
    /** Must belong to this workspace — PlatformUsersService.assertRoleInTenant checks. */
    roleId: z.string().uuid(),
    appRole: z.enum(APP_ROLES).default("staff"),
  })
  .strict();

/**
 * Who may hand out which app role.
 *
 * Two rules, in this order:
 *
 *  1. `owner` is appointed by the platform admin and nobody else. An owner
 *     inviting a co-owner would otherwise pass the rank check below (equal rank
 *     is allowed, so staff can hire staff), and "who runs this workspace" is a
 *     platform decision, not a tenant one.
 *  2. Otherwise the rank ladder: an inviter may grant their own rank or lower,
 *     never higher. Without it a `staff` member holding staff.manage could mint
 *     themselves a more privileged account — a tenant capability turned into
 *     privilege escalation.
 *
 * A free function rather than a private method so staff-invite.spec.ts can
 * assert the policy directly, without standing up the service's three
 * dependencies to reach it.
 */
export function assertMayGrant(inviterRole: string, appRole: string): void {
  if (inviterRole === PLATFORM_ADMIN) return;

  if (appRole === "owner") {
    throw new ForbiddenException("Only a platform administrator can appoint a workspace owner.");
  }

  const mine = RANK[inviterRole];
  const theirs = RANK[appRole];
  if (mine === undefined || theirs === undefined || theirs < mine) {
    throw new ForbiddenException(`You cannot grant the "${appRole}" role.`);
  }
}

@Injectable()
export class StaffInviteService {
  constructor(
    private readonly users: PlatformUsersService,
    private readonly tdb: TenantDb,
    private readonly access: AccessService,
  ) {}

  /** The staff row, proven to belong to this workspace. */
  private async staffInTenant(tenant: TenantDto, id: string) {
    const [row] = await this.tdb.forTenant(tenant.id, (tx) =>
      tx
        .select()
        .from(staffUsers)
        .where(and(eq(staffUsers.id, id), eq(staffUsers.tenantId, tenant.id)))
        .limit(1),
    );
    if (!row) throw new NotFoundException("No such staff member in this workspace");
    return row;
  }

  async invite(tenant: TenantDto, inviter: AuthUser, body: unknown, ctx: AuditCtx) {
    const input = inviteSchema.parse(body);
    assertMayGrant(inviter.role, input.appRole);

    // tenantId comes from the resolved route tenant, never the body — that is
    // the whole reason this wrapper exists rather than exposing the platform
    // schema to tenant callers.
    return this.users.create(
      {
        tenantId: tenant.id,
        name: input.name,
        email: input.email,
        roleId: input.roleId,
        appRole: input.appRole,
        sendInvite: true,
      },
      ctx,
    );
  }

  async resend(tenant: TenantDto, id: string, ctx: AuditCtx) {
    const staff = await this.staffInTenant(tenant, id);
    if (staff.status !== "invited") {
      throw new BadRequestException("That user has already accepted their invitation.");
    }
    // A recovery link is what an unaccepted invite needs re-sent: it is the same
    // set-your-password flow, and it works whether or not the first link expired.
    return this.users.resetPassword(id, { mode: "link" }, ctx);
  }

  async revoke(tenant: TenantDto, id: string, ctx: AuditCtx) {
    const staff = await this.staffInTenant(tenant, id);
    if (staff.status !== "invited") {
      throw new BadRequestException(
        "That user has already signed in — deactivate them instead of revoking the invitation.",
      );
    }
    // Hard delete: an unaccepted invite has no history worth keeping, and
    // leaving the row would hold the workspace-unique email hostage.
    const result = await this.users.remove(id, true, ctx);
    if (staff.authUserId) this.access.invalidate(staff.authUserId);
    return result;
  }
}

@ApiTags("staff")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@RequireModule("staff")
@RequireCapability("staff.manage")
@Roles("owner", "staff")
@Controller("api/:tenant/staff")
export class StaffInviteController {
  constructor(private readonly svc: StaffInviteService) {}

  /**
   * Tenant invites land in the same platform_audit_log as the super admin's
   * user actions, deliberately: "who added this person" is one question, and
   * splitting it across two logs by which surface happened to be used would
   * make it two.
   */
  private ctx(user: AuthUser): AuditCtx {
    return { actorId: user.id, actorEmail: actorOf(user) };
  }

  @Post("invite")
  @ApiOperation({
    summary: "Invite someone to this workspace",
    description:
      "Creates the login and emails a set-password link. Returns `inviteLink` once — it is never stored.",
  })
  invite(@CurrentTenant() tenant: TenantDto, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.svc.invite(tenant, user, body, this.ctx(user));
  }

  @Post(":id/resend")
  @ApiOperation({ summary: "Re-send an unaccepted invitation" })
  resend(@CurrentTenant() tenant: TenantDto, @CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.resend(tenant, id, this.ctx(user));
  }

  @Delete(":id/invite")
  @ApiOperation({ summary: "Revoke an unaccepted invitation and delete the pending login" })
  revoke(@CurrentTenant() tenant: TenantDto, @CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.svc.revoke(tenant, id, this.ctx(user));
  }
}
