import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, asc, desc, eq, gte, ilike, inArray, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  BAN_FOREVER,
  BAN_NONE,
  SupabaseAdminService,
  type AdminAuthUser,
} from "../auth/supabase-admin.service";
import type { Db } from "../db/db.tokens";
import { TenantDb } from "../db/tenant-db.service";
import { activities, authEvents, platformAuditLog, rolePermissions, roles, staffUsers, tenants } from "../db/schema";
import { AuditService, type AuditCtx } from "./audit.service";
import {
  adminUserCreateSchema,
  adminUserListSchema,
  adminUserStatusSchema,
  adminUserUpdateSchema,
  moveTenantSchema,
  resetPasswordSchema,
} from "./dto";

type StaffRow = typeof staffUsers.$inferSelect;

/** Sort keys a client may name. The query joins, so this cannot be open-ended. */
const SORTABLE = {
  name: staffUsers.name,
  email: staffUsers.email,
  status: staffUsers.status,
  createdAt: staffUsers.createdAt,
  lastActive: staffUsers.lastActive,
} as const;

const STATUS_BANNED = new Set(["suspended", "deactivated"]);

@Injectable()
export class PlatformUsersService {
  private readonly log = new Logger(PlatformUsersService.name);

  constructor(
    private readonly tdb: TenantDb,
    private readonly supabase: SupabaseAdminService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  // --- Read ----------------------------------------------------------------

  async list(query: unknown) {
    const q = adminUserListSchema.parse(query);

    const where: SQL[] = [];
    if (q.q) {
      where.push(or(ilike(staffUsers.name, `%${q.q}%`), ilike(staffUsers.email, `%${q.q}%`))!);
    }
    if (q.tenantId) where.push(eq(staffUsers.tenantId, q.tenantId));
    if (q.roleId) where.push(eq(staffUsers.roleId, q.roleId));
    if (q.status) {
      const statuses = Array.isArray(q.status) ? q.status : [q.status];
      where.push(statuses.length === 1 ? eq(staffUsers.status, statuses[0]) : inArray(staffUsers.status, statuses));
    }
    if (q.createdAt?.gte) where.push(gte(staffUsers.createdAt, new Date(q.createdAt.gte)));
    if (q.createdAt?.lte) where.push(lte(staffUsers.createdAt, new Date(q.createdAt.lte)));

    const raw = q.sort ?? "-createdAt";
    const key = raw.replace(/^-/, "") as keyof typeof SORTABLE;
    const col = SORTABLE[key];
    if (q.sort && !col) throw new BadRequestException(`Cannot sort by "${key}"`);
    const primary = raw.startsWith("-") ? desc(col ?? staffUsers.createdAt) : asc(col ?? staffUsers.createdAt);

    const predicate = where.length ? and(...where) : undefined;
    const offset = (q.page - 1) * q.pageSize;

    return this.tdb.asPlatform(async (tx) => {
      const [rows, [{ count }]] = await Promise.all([
        tx
          .select({
            id: staffUsers.id,
            authUserId: staffUsers.authUserId,
            name: staffUsers.name,
            email: staffUsers.email,
            status: staffUsers.status,
            roleId: staffUsers.roleId,
            lastActive: staffUsers.lastActive,
            createdAt: staffUsers.createdAt,
            updatedAt: staffUsers.updatedAt,
            tenantId: staffUsers.tenantId,
            // Joined so the table renders in one round trip, not N+1.
            tenantSlug: tenants.slug,
            tenantName: tenants.name,
            roleName: roles.name,
          })
          .from(staffUsers)
          .leftJoin(tenants, eq(tenants.id, staffUsers.tenantId))
          .leftJoin(roles, eq(roles.id, staffUsers.roleId))
          .where(predicate)
          // id breaks ties so OFFSET paging can't drop or duplicate rows.
          .orderBy(primary, asc(staffUsers.id))
          .limit(q.pageSize)
          .offset(offset),
        tx.select({ count: sql<number>`count(*)::int` }).from(staffUsers).where(predicate),
      ]);
      return { data: rows, total: count, page: q.page, pageSize: q.pageSize };
    });
  }

  async get(id: string) {
    const base = await this.tdb.asPlatform(async (tx) => {
      const row = await this.loadJoined(tx, id);
      const [permissions, events, auditRows] = await Promise.all([
        row.roleId
          ? tx
              .select({ permission: rolePermissions.permission })
              .from(rolePermissions)
              .where(eq(rolePermissions.roleId, row.roleId))
              .orderBy(asc(rolePermissions.sort))
          : Promise.resolve([]),
        tx
          .select()
          .from(authEvents)
          .where(row.authUserId ? eq(authEvents.authUserId, row.authUserId) : sql`false`)
          .orderBy(desc(authEvents.createdAt))
          .limit(20),
        tx
          .select()
          .from(platformAuditLog)
          .where(and(eq(platformAuditLog.targetType, "staff_user"), eq(platformAuditLog.targetId, id)))
          .orderBy(desc(platformAuditLog.createdAt))
          .limit(20),
      ]);
      return {
        ...row,
        permissions: permissions.map((p) => p.permission),
        recentAuthEvents: events,
        recentAudit: auditRows,
      };
    });

    // Best-effort: a GoTrue hiccup must not 500 the detail page.
    let auth: AdminAuthUser | null = null;
    if (base.authUserId) {
      try {
        auth = await this.supabase.getUserById(base.authUserId);
      } catch (err) {
        this.log.warn(`Auth lookup failed for ${base.authUserId}: ${(err as Error).message}`);
      }
    }

    return {
      ...base,
      orphaned: !base.authUserId || auth === null,
      auth: auth
        ? {
            lastSignInAt: auth.last_sign_in_at ?? null,
            emailConfirmedAt: auth.email_confirmed_at ?? null,
            banned: Boolean(auth.banned_until && new Date(auth.banned_until) > new Date()),
            appRole: String(auth.app_metadata?.role ?? ""),
            providers: (auth.identities ?? []).map((i) => i.provider),
            createdAt: auth.created_at ?? null,
          }
        : null,
    };
  }

  /** Merged, time-sorted feed across the three places a user leaves traces. */
  async activity(id: string) {
    return this.tdb.asPlatform(async (tx) => {
      const row = await this.loadJoined(tx, id);
      const [events, auditRows, tenantActivity] = await Promise.all([
        tx
          .select()
          .from(authEvents)
          .where(row.authUserId ? eq(authEvents.authUserId, row.authUserId) : sql`false`)
          .orderBy(desc(authEvents.createdAt))
          .limit(100),
        tx
          .select()
          .from(platformAuditLog)
          .where(and(eq(platformAuditLog.targetType, "staff_user"), eq(platformAuditLog.targetId, id)))
          .orderBy(desc(platformAuditLog.createdAt))
          .limit(100),
        tx
          .select()
          .from(activities)
          .where(and(eq(activities.tenantId, row.tenantId), eq(activities.actor, row.email)))
          .orderBy(desc(activities.createdAt))
          .limit(100),
      ]);

      const merged = [
        ...events.map((e) => ({
          id: e.id,
          at: e.createdAt,
          kind: "auth" as const,
          title: e.event,
          detail: [e.ip, e.userAgent].filter(Boolean).join(" · "),
          actorEmail: e.email,
        })),
        ...auditRows.map((a) => ({
          id: a.id,
          at: a.createdAt,
          kind: "admin" as const,
          title: a.action,
          detail: describeDiff(a.before, a.after),
          actorEmail: a.actorEmail,
        })),
        ...tenantActivity.map((a) => ({
          id: a.id,
          at: a.createdAt,
          kind: "activity" as const,
          title: a.action,
          detail: a.target,
          actorEmail: a.actor,
        })),
      ].sort((x, y) => y.at.getTime() - x.at.getTime());

      return { data: merged.slice(0, 100) };
    });
  }

  // --- Create --------------------------------------------------------------

  async create(body: unknown, ctx: AuditCtx) {
    const input = adminUserCreateSchema.parse(body);

    const { tenant, roleId } = await this.tdb.asPlatform(async (tx) => {
      const [t] = await tx.select().from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
      if (!t) throw new NotFoundException("Unknown workspace");
      await this.assertRoleInTenant(tx, input.roleId ?? null, input.tenantId);
      const [existing] = await tx
        .select({ id: staffUsers.id })
        .from(staffUsers)
        .where(sql`lower(${staffUsers.email}) = ${input.email}`)
        .limit(1);
      if (existing) throw new ConflictException("A user with that email already exists");
      return { tenant: t, roleId: input.roleId ?? null };
    });

    // GoTrue and Postgres cannot share a transaction. Create the auth identity
    // first (reversible via deleteUser), then let the DB transaction be the
    // commit point — see the compensation below.
    let authUser: AdminAuthUser;
    let adopted = false;
    try {
      authUser = await this.supabase.createUser({
        email: input.email,
        password: input.password,
        emailConfirm: !input.sendInvite,
        appMetadata: { role: input.appRole, tenant_id: input.tenantId },
      });
    } catch (err) {
      if (!(err instanceof ConflictException)) throw err;
      // The identity exists but no staff row references it. Adopt it if it is
      // unattached; refuse if it already belongs to another workspace.
      const found = await this.supabase.findByEmail(input.email);
      if (!found) throw err;
      const claimed = found.app_metadata?.tenant_id;
      if (claimed && claimed !== input.tenantId) {
        throw new ConflictException("That email already belongs to another workspace");
      }
      await this.supabase.updateUserById(found.id, {
        app_metadata: { role: input.appRole, tenant_id: input.tenantId },
      });
      authUser = found;
      adopted = true;
    }

    let created: StaffRow;
    try {
      created = await this.tdb.asPlatform(async (tx) => {
        const [row] = await tx
          .insert(staffUsers)
          .values({
            tenantId: input.tenantId,
            authUserId: authUser.id,
            name: input.name,
            email: input.email,
            roleId,
            status: input.sendInvite ? "invited" : "active",
          })
          .returning();
        await this.audit.record(tx, ctx, {
          action: "user.create",
          targetType: "staff_user",
          targetId: row.id,
          tenantId: input.tenantId,
          after: { email: row.email, name: row.name, roleId, appRole: input.appRole, status: row.status },
        });
        await this.writeTenantActivity(tx, input.tenantId, ctx, `Added ${input.email}`, input.name);
        return row;
      });
    } catch (err) {
      // Compensation: never leave an auth identity nobody can reach. Only undo
      // what we created — an adopted user pre-existed this request.
      if (!adopted) {
        try {
          await this.supabase.deleteUser(authUser.id);
        } catch (cleanupErr) {
          this.log.error(
            `ORPHANED AUTH USER ${authUser.id} (${input.email}): staff insert failed ` +
              `(${(err as Error).message}) and cleanup also failed (${(cleanupErr as Error).message})`,
          );
          throw new InternalServerErrorException(
            `Could not create the user, and an orphaned auth account was left behind for ${input.email}. ` +
              `Delete it in Supabase before retrying.`,
          );
        }
      }
      throw err;
    }

    // After the commit: a failure here leaves a valid staff row the admin can
    // resend an invite for, so warn rather than fail the whole request.
    let inviteLink: string | null = null;
    let warning: string | undefined;
    if (input.sendInvite) {
      try {
        const { actionLink } = await this.supabase.generateLink({
          type: "invite",
          email: input.email,
          redirectTo: this.frontendUrl(),
        });
        inviteLink = actionLink;
      } catch (err) {
        warning = "The user was created but the invite link could not be generated. Use Reset password to retry.";
        this.log.warn(`Invite link failed for ${input.email}: ${(err as Error).message}`);
      }
    }

    return { user: { ...created, tenantSlug: tenant.slug, tenantName: tenant.name }, inviteLink, warning };
  }

  // --- Update --------------------------------------------------------------

  async update(id: string, body: unknown, ctx: AuditCtx) {
    const input = adminUserUpdateSchema.parse(body);
    const before = await this.load(id);

    if (input.email && input.email !== before.email) {
      await this.assertEmailFree(input.email, id);
    }

    // Supabase first: a DB failure afterwards is compensated below, whereas a
    // committed DB row pointing at an unchanged login address is silent drift.
    const authPatch: Record<string, unknown> = {};
    if (input.email && input.email !== before.email) {
      authPatch.email = input.email;
      authPatch.email_confirm = true;
    }
    if (input.appRole) {
      // app_metadata merges server-side; send both keys so a partial write
      // can't leave a stale tenant_id behind.
      authPatch.app_metadata = { role: input.appRole, tenant_id: before.tenantId };
    }
    if (before.authUserId && Object.keys(authPatch).length) {
      await this.supabase.updateUserById(before.authUserId, authPatch);
    }

    try {
      return await this.tdb.asPlatform(async (tx) => {
        if (input.roleId !== undefined) await this.assertRoleInTenant(tx, input.roleId, before.tenantId);
        const [row] = await tx
          .update(staffUsers)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.email !== undefined ? { email: input.email } : {}),
            ...(input.roleId !== undefined ? { roleId: input.roleId } : {}),
            updatedAt: new Date(),
          })
          .where(eq(staffUsers.id, id))
          .returning();
        const roleChanged = input.roleId !== undefined && input.roleId !== before.roleId;
        await this.audit.record(tx, ctx, {
          action: roleChanged ? "user.role" : "user.update",
          targetType: "staff_user",
          targetId: id,
          tenantId: before.tenantId,
          before: { name: before.name, email: before.email, roleId: before.roleId },
          after: { name: row.name, email: row.email, roleId: row.roleId, appRole: input.appRole },
        });
        await this.writeTenantActivity(tx, before.tenantId, ctx, `Updated ${row.email}`, row.name);
        return row;
      });
    } catch (err) {
      if (before.authUserId && authPatch.email) {
        await this.supabase
          .updateUserById(before.authUserId, { email: before.email, email_confirm: true })
          .catch((e) =>
            this.log.error(`Failed to roll back the auth email for ${before.authUserId}: ${(e as Error).message}`),
          );
      }
      throw err;
    }
  }

  async setStatus(id: string, body: unknown, ctx: AuditCtx) {
    const input = adminUserStatusSchema.parse(body);
    const before = await this.load(id);
    this.assertNotSelf(ctx, before, `${input.action} your own account`);

    const nextStatus =
      input.action === "suspend" ? "suspended" : input.action === "deactivate" ? "deactivated" : "active";

    if (STATUS_BANNED.has(nextStatus)) await this.assertNotLastPlatformAdmin(before, input.action);

    if (before.authUserId) {
      await this.supabase.updateUserById(before.authUserId, {
        ban_duration: STATUS_BANNED.has(nextStatus) ? BAN_FOREVER : BAN_NONE,
      });
    }

    return this.tdb.asPlatform(async (tx) => {
      const [row] = await tx
        .update(staffUsers)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(eq(staffUsers.id, id))
        .returning();
      await this.audit.record(tx, ctx, {
        action: "user.status",
        targetType: "staff_user",
        targetId: id,
        tenantId: before.tenantId,
        before: { status: before.status },
        after: { status: nextStatus, reason: input.reason },
      });
      await this.writeTenantActivity(
        tx,
        before.tenantId,
        ctx,
        `${capitalize(input.action)}d ${before.email}${input.reason ? ` — ${input.reason}` : ""}`,
        before.name,
      );
      return row;
    });
  }

  async resetPassword(id: string, body: unknown, ctx: AuditCtx) {
    const input = resetPasswordSchema.parse(body);
    const user = await this.load(id);
    if (!user.authUserId) throw new BadRequestException("This user has no auth account yet");

    if (input.mode === "set") {
      if (!this.supabase.allowPasswordSet) {
        throw new ForbiddenException(
          "Setting passwords directly is disabled. Enable PLATFORM_ALLOW_PASSWORD_SET to allow it.",
        );
      }
      await this.supabase.updateUserById(user.authUserId, { password: input.password });
      await this.recordStandalone(ctx, {
        action: "user.reset_password",
        targetType: "staff_user",
        targetId: id,
        tenantId: user.tenantId,
        // The password itself is never persisted or logged.
        after: { mode: "set" },
      });
      return { mode: "set" as const, actionLink: null };
    }

    const { actionLink } = await this.supabase.generateLink({
      type: "recovery",
      email: user.email,
      redirectTo: this.frontendUrl(),
    });
    await this.recordStandalone(ctx, {
      action: "user.reset_password",
      targetType: "staff_user",
      targetId: id,
      tenantId: user.tenantId,
      after: { mode: "link" },
    });
    // Returned once, to the requesting admin only — never listed or stored.
    return { mode: "link" as const, actionLink };
  }

  async moveTenant(id: string, body: unknown, ctx: AuditCtx) {
    const input = moveTenantSchema.parse(body);
    const before = await this.load(id);
    this.assertNotSelf(ctx, before, "move your own account");
    if (before.tenantId === input.tenantId) {
      throw new BadRequestException("The user is already in that workspace");
    }

    const appRole = await this.currentAppRole(before.authUserId);

    try {
      return await this.tdb.asPlatform(async (tx) => {
        // Lock the row so a concurrent status/role write can't interleave.
        const [locked] = await tx.select().from(staffUsers).where(eq(staffUsers.id, id)).for("update").limit(1);
        if (!locked) throw new NotFoundException("User not found");

        const [target] = await tx.select().from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
        if (!target) throw new NotFoundException("Unknown workspace");

        // Roles are tenant-scoped, so the old roleId is meaningless in the new
        // workspace. Carry the assignment over only if a role of the same name
        // exists there; otherwise clear it and let an admin re-assign.
        let mappedRoleId: string | null = null;
        if (locked.roleId) {
          const [oldRole] = await tx.select().from(roles).where(eq(roles.id, locked.roleId)).limit(1);
          if (oldRole) {
            const [match] = await tx
              .select({ id: roles.id })
              .from(roles)
              .where(and(eq(roles.tenantId, input.tenantId), eq(roles.name, oldRole.name)))
              .limit(1);
            mappedRoleId = match?.id ?? null;
          }
        }

        const [row] = await tx
          .update(staffUsers)
          .set({ tenantId: input.tenantId, roleId: mappedRoleId, updatedAt: new Date() })
          .where(eq(staffUsers.id, id))
          .returning();

        // Inside the transaction: if GoTrue rejects, the DB rolls back too.
        if (before.authUserId) {
          await this.supabase.updateUserById(before.authUserId, {
            app_metadata: { role: appRole, tenant_id: input.tenantId },
          });
        }

        await this.audit.record(tx, ctx, {
          action: "user.move_tenant",
          targetType: "staff_user",
          targetId: id,
          tenantId: input.tenantId,
          before: { tenantId: before.tenantId, roleId: before.roleId },
          after: { tenantId: input.tenantId, roleId: mappedRoleId, reason: input.reason },
        });
        // Both sides of the move should see it in their own activity feed.
        await this.writeTenantActivity(tx, before.tenantId, ctx, `Moved ${before.email} to ${target.name}`, before.name);
        await this.writeTenantActivity(tx, input.tenantId, ctx, `Moved ${before.email} into this workspace`, before.name);
        return { ...row, tenantSlug: target.slug, tenantName: target.name };
      });
    } catch (err) {
      // The inverse window: GoTrue committed, the transaction did not. Put the
      // claim back where the staff row still says it belongs.
      if (before.authUserId) {
        await this.supabase
          .updateUserById(before.authUserId, { app_metadata: { role: appRole, tenant_id: before.tenantId } })
          .catch((e) =>
            this.log.error(
              `SPLIT STATE: staff_users.tenant_id=${before.tenantId} but app_metadata may point at ` +
                `${input.tenantId} for auth user ${before.authUserId}: ${(e as Error).message}`,
            ),
          );
      }
      throw err;
    }
  }

  async remove(id: string, hard: boolean, ctx: AuditCtx) {
    const before = await this.load(id);
    this.assertNotSelf(ctx, before, "delete your own account");
    await this.assertNotLastPlatformAdmin(before, "delete");

    if (!hard) {
      // Soft delete keeps the audit trail and the activities.actor references
      // meaningful; it is the default for exactly that reason.
      return this.setStatus(id, { action: "deactivate", reason: "Deleted by platform admin" }, ctx);
    }

    if (before.authUserId) await this.supabase.deleteUser(before.authUserId);

    return this.tdb.asPlatform(async (tx) => {
      await this.audit.record(tx, ctx, {
        action: "user.delete",
        targetType: "staff_user",
        targetId: id,
        tenantId: before.tenantId,
        before: { email: before.email, name: before.name, status: before.status, tenantId: before.tenantId },
        after: { hard: true },
      });
      await this.writeTenantActivity(tx, before.tenantId, ctx, `Deleted ${before.email}`, before.name);
      await tx.delete(staffUsers).where(eq(staffUsers.id, id));
      return { deleted: true, id };
    });
  }

  // --- Helpers -------------------------------------------------------------

  private frontendUrl(): string {
    return this.config.get<string>("FRONTEND_URL") ?? "http://localhost:5000";
  }

  private async load(id: string): Promise<StaffRow> {
    return this.tdb.asPlatform(async (tx) => {
      const [row] = await tx.select().from(staffUsers).where(eq(staffUsers.id, id)).limit(1);
      if (!row) throw new NotFoundException("User not found");
      return row;
    });
  }

  private async loadJoined(tx: Db, id: string) {
    const [row] = await tx
      .select({
        id: staffUsers.id,
        authUserId: staffUsers.authUserId,
        name: staffUsers.name,
        email: staffUsers.email,
        status: staffUsers.status,
        roleId: staffUsers.roleId,
        lastActive: staffUsers.lastActive,
        createdAt: staffUsers.createdAt,
        updatedAt: staffUsers.updatedAt,
        tenantId: staffUsers.tenantId,
        tenantSlug: tenants.slug,
        tenantName: tenants.name,
        roleName: roles.name,
      })
      .from(staffUsers)
      .leftJoin(tenants, eq(tenants.id, staffUsers.tenantId))
      .leftJoin(roles, eq(roles.id, staffUsers.roleId))
      .where(eq(staffUsers.id, id))
      .limit(1);
    if (!row) throw new NotFoundException("User not found");
    return row;
  }

  /**
   * roles.id is globally unique, so the FK alone happily accepts a role from
   * another tenant. Check membership explicitly.
   */
  private async assertRoleInTenant(tx: Db, roleId: string | null, tenantId: string) {
    if (!roleId) return;
    const [row] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.id, roleId), eq(roles.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new BadRequestException("That role belongs to a different workspace");
  }

  private async assertEmailFree(email: string, exceptId: string) {
    await this.tdb.asPlatform(async (tx) => {
      const [row] = await tx
        .select({ id: staffUsers.id })
        .from(staffUsers)
        .where(and(sql`lower(${staffUsers.email}) = ${email}`, ne(staffUsers.id, exceptId)))
        .limit(1);
      if (row) throw new ConflictException("A user with that email already exists");
    });
  }

  /** A super admin must not be able to lock themselves out. */
  private assertNotSelf(ctx: AuditCtx, target: { authUserId: string | null }, verb: string) {
    if (target.authUserId && ctx.actorId && target.authUserId === ctx.actorId) {
      throw new ForbiddenException(`You cannot ${verb}`);
    }
  }

  /** Nor may the last platform admin be disabled, leaving nobody in control. */
  private async assertNotLastPlatformAdmin(target: StaffRow, verb: string) {
    if (!target.authUserId) return;
    const appRole = await this.currentAppRole(target.authUserId);
    if (appRole !== "platform_admin") return;
    const n = await this.tdb.asPlatform(async (tx) => {
      const rows = await tx.execute<{ n: number }>(sql`select n from public.platform_admin_count`);
      return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
    });
    if (n <= 1) throw new ForbiddenException(`You cannot ${verb} the last platform admin`);
  }

  private async currentAppRole(authUserId: string | null): Promise<string> {
    if (!authUserId) return "staff";
    try {
      const u = await this.supabase.getUserById(authUserId);
      return String(u?.app_metadata?.role ?? "staff");
    } catch {
      return "staff";
    }
  }

  /**
   * Mirror of the audit row in the tenant's own feed, so a workspace can see
   * that the platform touched one of its accounts.
   */
  private async writeTenantActivity(tx: Db, tenantId: string, ctx: AuditCtx, action: string, target: string) {
    await tx.insert(activities).values({
      tenantId,
      actor: ctx.actorEmail || "platform",
      action,
      target,
      kind: "auth",
    });
  }

  /** For actions with no DB mutation of their own (e.g. password reset). */
  private async recordStandalone(ctx: AuditCtx, entry: Parameters<AuditService["record"]>[2]) {
    await this.tdb.asPlatform((tx) => this.audit.record(tx, ctx, entry));
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function describeDiff(before: unknown, after: unknown): string {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  return keys
    .filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]))
    .map((k) => `${k}: ${fmt(b[k])} → ${fmt(a[k])}`)
    .join(", ");
}

function fmt(v: unknown): string {
  if (v === undefined || v === null) return "—";
  return typeof v === "string" ? v : JSON.stringify(v);
}

export type AdminUserListQuery = z.infer<typeof adminUserListSchema>;
