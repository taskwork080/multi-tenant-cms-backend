import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { and, eq, sql } from "drizzle-orm";
import { PLATFORM_ADMIN } from "../auth/auth.types";
import { Roles } from "../auth/decorators";
import { SupabaseAdminService } from "../auth/supabase-admin.service";
import { TenantDb } from "../db/tenant-db.service";
import { staffUsers, tenants } from "../db/schema";
import { Audit, AuditService, type AuditCtx } from "./audit.service";
import { adminListSchema, demoteAdminSchema, promoteAdminSchema } from "./dto";
import { PlatformUsersService } from "./platform-users.service";

/** One row of the roster, as the /platform/admins table renders it. */
export interface PlatformAdminRow {
  authUserId: string;
  email: string;
  createdAt: Date | null;
  lastSignInAt: Date | null;
  banned: boolean;
  /** null for the CLI-bootstrapped root admin, who has no staff_users row. */
  staffUserId: string | null;
  name: string | null;
  homeTenantId: string | null;
  homeTenantSlug: string | null;
  homeTenantName: string | null;
  isSelf: boolean;
}

@Injectable()
export class PlatformAdminsService {
  private readonly log = new Logger(PlatformAdminsService.name);

  constructor(
    private readonly tdb: TenantDb,
    private readonly supabase: SupabaseAdminService,
    private readonly audit: AuditService,
    private readonly users: PlatformUsersService,
  ) {}

  /**
   * Reads public.platform_admins (drizzle/0010_platform_expansion.sql) rather
   * than GoTrue: the admin list endpoint cannot filter on app_metadata, so that
   * route would mean paging every user in the project into Node on every render
   * just to keep the handful with the platform role.
   *
   * The staff_users join is a LEFT join on purpose — a promoted user keeps
   * their home workspace, the bootstrapped root admin never had one.
   */
  async list(query: unknown, ctx: AuditCtx) {
    const q = adminListSchema.parse(query);
    const offset = (q.page - 1) * q.pageSize;
    const like = q.q ? `%${q.q.toLowerCase()}%` : null;

    return this.tdb.asPlatform(async (tx) => {
      const rows = await tx.execute<{
        id: string;
        email: string;
        created_at: Date | null;
        last_sign_in_at: Date | null;
        banned_until: Date | null;
        staff_user_id: string | null;
        name: string | null;
        tenant_id: string | null;
        tenant_slug: string | null;
        tenant_name: string | null;
        total: string;
      }>(sql`
        select a.id,
               a.email,
               a.created_at,
               a.last_sign_in_at,
               a.banned_until,
               s.id           as staff_user_id,
               s.name         as name,
               t.id           as tenant_id,
               t.slug         as tenant_slug,
               t.name         as tenant_name,
               count(*) over () as total
          from public.platform_admins a
          left join public.staff_users s on s.auth_user_id = a.id
          left join public.tenants t on t.id = s.tenant_id
         where ${like === null ? sql`true` : sql`(lower(a.email) like ${like} or lower(coalesce(s.name, '')) like ${like})`}
         order by a.created_at asc
         limit ${q.pageSize} offset ${offset}
      `);

      const list = rows as unknown as Array<Record<string, unknown>>;
      const data: PlatformAdminRow[] = list.map((r) => ({
        authUserId: String(r.id),
        email: String(r.email ?? ""),
        createdAt: (r.created_at as Date) ?? null,
        lastSignInAt: (r.last_sign_in_at as Date) ?? null,
        // banned_until is a timestamp, not a flag; a past one is not a ban.
        banned: r.banned_until ? new Date(r.banned_until as string) > new Date() : false,
        staffUserId: (r.staff_user_id as string) ?? null,
        name: (r.name as string) ?? null,
        homeTenantId: (r.tenant_id as string) ?? null,
        homeTenantSlug: (r.tenant_slug as string) ?? null,
        homeTenantName: (r.tenant_name as string) ?? null,
        isSelf: String(r.id) === ctx.actorId,
      }));

      return {
        data,
        total: Number(list[0]?.total ?? 0),
        page: q.page,
        pageSize: q.pageSize,
      };
    });
  }

  /**
   * Promote an existing tenant user to platform admin.
   *
   * THERE IS ONLY EVER ONE. This route is not the way to add a colleague; it is
   * the recovery path for when the seat is vacant (the sole admin was deleted
   * in GoTrue, say) and the CLI is not reachable. While an admin exists it
   * refuses, and drizzle/0014_single_platform_admin.sql refuses underneath it
   * even if this check is bypassed — the promote path used to be exactly how a
   * tenant owner could end up holding platform powers.
   *
   * The staff_users row and its tenant_id are deliberately LEFT INTACT:
   * staff_users.tenant_id is NOT NULL so there is no tenant-less state to move
   * into, auth_events references the row, and destroying someone's history on
   * an audit-first surface is the wrong trade. The consequence — a promoted
   * user appears in both /api/admin/users and this roster — is honest: they
   * have a home workspace and they have platform powers.
   */
  async promote(body: unknown, ctx: AuditCtx) {
    const input = promoteAdminSchema.parse(body);

    if ((await this.count()) >= 1) {
      throw new ConflictException(
        "This platform already has its administrator. Demote the current one before appointing another.",
      );
    }

    const staff = await this.users.load(input.staffUserId);
    this.users.assertNotSelf(ctx, staff, "promote your own account");

    if (!staff.authUserId) {
      throw new BadRequestException(
        "This user has never accepted their invite, so there is no login to promote. Resend the invite first.",
      );
    }

    const priorRole = await this.users.currentAppRole(staff.authUserId);
    if (priorRole === PLATFORM_ADMIN) {
      throw new ConflictException("That user is already a platform admin");
    }

    // GoTrue first, then the audit row; app_metadata merges server-side, so
    // both keys go together or a partial write leaves a stale tenant_id.
    await this.supabase.updateUserById(staff.authUserId, {
      app_metadata: { role: PLATFORM_ADMIN, tenant_id: staff.tenantId },
    });

    try {
      await this.tdb.asPlatform(async (tx) => {
        await this.audit.record(tx, ctx, {
          action: "platform_admin.grant",
          targetType: "auth_user",
          targetId: staff.authUserId!,
          tenantId: staff.tenantId,
          before: { appRole: priorRole },
          after: { appRole: PLATFORM_ADMIN, reason: input.reason, staffUserId: staff.id },
        });
        // The workspace should be able to see that one of its people now has
        // powers over every workspace.
        await this.users.writeTenantActivity(
          tx,
          staff.tenantId,
          ctx,
          `Granted platform admin to ${staff.email}${input.reason ? ` — ${input.reason}` : ""}`,
          staff.name,
        );
      });
    } catch (err) {
      // GoTrue committed, the audit transaction did not. Put the role back.
      await this.supabase
        .updateUserById(staff.authUserId, { app_metadata: { role: priorRole, tenant_id: staff.tenantId } })
        .catch((e) =>
          this.log.error(
            `SPLIT STATE: auth user ${staff.authUserId} may hold platform_admin with no audit row: ${(e as Error).message}`,
          ),
        );
      throw err;
    }

    return { promoted: true, authUserId: staff.authUserId, staffUserId: staff.id };
  }

  /**
   * Revoke platform admin and land the account back in a workspace.
   *
   * A tenant and an app role are required rather than optional: dropping the
   * platform role without giving the account somewhere to be produces a login
   * that can reach nothing at all.
   */
  async demote(authUserId: string, body: unknown, ctx: AuditCtx) {
    const input = demoteAdminSchema.parse(body);
    this.users.assertNotSelf(ctx, { authUserId }, "demote your own account");
    await this.users.assertNotLastPlatformAdmin({ authUserId }, "demote");

    const priorRole = await this.users.currentAppRole(authUserId);
    if (priorRole !== PLATFORM_ADMIN) {
      throw new ConflictException("That user is not a platform admin");
    }

    const authUser = await this.supabase.getUserById(authUserId);
    if (!authUser) throw new NotFoundException("No such auth user");

    const { staff, tenant } = await this.tdb.asPlatform(async (tx) => {
      const [t] = await tx.select().from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
      if (!t) throw new NotFoundException("Unknown workspace");
      const [s] = await tx.select().from(staffUsers).where(eq(staffUsers.authUserId, authUserId)).limit(1);
      if (input.roleId) await this.users.assertRoleInTenant(tx, input.roleId, input.tenantId);
      return { staff: s ?? null, tenant: t };
    });

    let staffUserId: string;

    if (staff && staff.tenantId !== input.tenantId) {
      // Delegate the cross-workspace part: moveTenant already holds the row
      // FOR UPDATE, remaps the role by name, writes GoTrue inside the
      // transaction and compensates on the inverse failure.
      await this.users.moveTenant(staff.id, { tenantId: input.tenantId, reason: input.reason }, ctx);
      staffUserId = staff.id;
    } else if (staff) {
      staffUserId = staff.id;
    } else {
      // The CLI-bootstrapped root admin: no staff row has ever existed.
      staffUserId = await this.tdb.asPlatform(async (tx) => {
        try {
          const [row] = await tx
            .insert(staffUsers)
            .values({
              tenantId: input.tenantId,
              authUserId,
              name: input.name ?? String(authUser.email ?? "").split("@")[0],
              email: String(authUser.email ?? ""),
              roleId: input.roleId ?? null,
              status: "active",
            })
            .returning();
          return row.id;
        } catch (e) {
          // staff_users_email_lower_key is global, staff_users_auth_user_id_key
          // is one-row-per-identity; either means a row already claims them.
          if (String((e as { code?: string }).code) === "23505") {
            throw new ConflictException("A workspace account already exists for that email");
          }
          throw e;
        }
      });
    }

    await this.supabase.updateUserById(authUserId, {
      app_metadata: { role: input.appRole, tenant_id: input.tenantId },
    });

    await this.tdb.asPlatform(async (tx) => {
      if (input.roleId !== undefined) {
        await tx
          .update(staffUsers)
          .set({ roleId: input.roleId ?? null, updatedAt: new Date() })
          .where(eq(staffUsers.id, staffUserId));
      }
      await this.audit.record(tx, ctx, {
        action: "platform_admin.revoke",
        targetType: "auth_user",
        targetId: authUserId,
        tenantId: input.tenantId,
        before: { appRole: PLATFORM_ADMIN },
        after: { appRole: input.appRole, tenantId: input.tenantId, roleId: input.roleId, reason: input.reason },
      });
      await this.users.writeTenantActivity(
        tx,
        input.tenantId,
        ctx,
        `Revoked platform admin from ${authUser.email}${input.reason ? ` — ${input.reason}` : ""}`,
        String(authUser.email ?? ""),
      );
    });

    return { demoted: true, authUserId, staffUserId, tenantSlug: tenant.slug };
  }

  /** Guard against demoting the very last admin via a stale UI. */
  async count() {
    return this.tdb.asPlatform(async (tx) => {
      const rows = await tx.execute<{ n: number }>(sql`select n from public.platform_admin_count`);
      return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
    });
  }

  /** Candidates for promotion: signed-in users who are not already admins. */
  async candidates(q: string | undefined) {
    const like = q ? `%${q.toLowerCase()}%` : null;
    return this.tdb.asPlatform(async (tx) => {
      const rows = await tx
        .select({
          id: staffUsers.id,
          name: staffUsers.name,
          email: staffUsers.email,
          authUserId: staffUsers.authUserId,
          tenantId: staffUsers.tenantId,
          tenantName: tenants.name,
        })
        .from(staffUsers)
        .leftJoin(tenants, eq(tenants.id, staffUsers.tenantId))
        .where(
          and(
            sql`${staffUsers.authUserId} is not null`,
            eq(staffUsers.status, "active"),
            sql`not exists (select 1 from public.platform_admins pa where pa.id = ${staffUsers.authUserId})`,
            like === null
              ? sql`true`
              : sql`(lower(${staffUsers.email}) like ${like} or lower(${staffUsers.name}) like ${like})`,
          ),
        )
        .limit(20);
      return { data: rows };
    });
  }
}

@ApiTags("platform")
@ApiBearerAuth()
@Roles(PLATFORM_ADMIN)
@Controller("api/admin/platform-admins")
export class PlatformAdminsController {
  constructor(private readonly svc: PlatformAdminsService) {}

  @Get()
  @ApiOperation({ summary: "Every platform admin, with their home workspace" })
  list(@Query() query: Record<string, unknown>, @Audit() ctx: AuditCtx) {
    return this.svc.list(query, ctx);
  }

  // Before the :authUserId routes below — a literal segment must not be read
  // as an id.
  @Get("candidates")
  @ApiOperation({ summary: "Users eligible for promotion" })
  candidates(@Query("q") q?: string) {
    return this.svc.candidates(q);
  }

  @Post()
  @ApiOperation({ summary: "Promote an existing workspace user to platform admin" })
  promote(@Body() body: unknown, @Audit() ctx: AuditCtx) {
    return this.svc.promote(body, ctx);
  }

  @Post(":authUserId/demote")
  @ApiOperation({ summary: "Revoke platform admin and return the account to a workspace" })
  demote(@Param("authUserId") authUserId: string, @Body() body: unknown, @Audit() ctx: AuditCtx) {
    return this.svc.demote(authUserId, body, ctx);
  }
}
