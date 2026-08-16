import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { authEvents, roles, staffUsers, tenants } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { AccessService, type UserAccess } from "./access.service";
import { CAPABILITIES } from "./capabilities";
import { CurrentAccess, CurrentUser } from "./decorators";
import { PLATFORM_ADMIN, type AuthUser } from "./auth.types";
import { SupabaseAdminService } from "./supabase-admin.service";

/**
 * The signed-in user's own profile.
 *
 * DELIBERATELY UNGATED. There is no @RequireCapability and no @Roles here: this
 * is the one surface where the subject and the object are the same person.
 * Every write below is scoped by `auth_user_id = <the caller>`, taken from the
 * verified JWT and never from the body, so there is nothing a capability could
 * usefully add — a role that could not fix the spelling of its own holder's
 * name would just generate support tickets.
 *
 * WORKS FOR EVERY WORKSPACE, including none. A tenant user resolves through
 * their staff_users row. A platform admin has no staff row and no tenant at all
 * (see scripts/create-user.ts), so `kind` discriminates instead of the endpoint
 * 404ing or inventing an empty staff record for them.
 *
 * `kind: "platform"` means EXACTLY ONE THING: the caller is a super admin with
 * no workspace. It briefly also covered "a tenant user whose staff row does not
 * exist yet", which made the account page tell workspace owners they had no
 * profile and hide the form. That case is now handled where it belongs — the
 * row is resolved by email as well as by identity (an invite is a row waiting
 * to be claimed), and a first save writes it if it genuinely is not there.
 */

/**
 * MIRRORS the frontend LOCALES in src/lib/i18n.ts. Kept a closed set for the
 * same reason MODULE_KEYS is: an unknown value here is a preference no string
 * table can satisfy, so it would silently fall back and look like a bug.
 */
const LOCALES = ["en", "bn", "zh", "fil"] as const;

/** Mirrors AuthEventsService: a uuid subject is required to touch auth_events. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const profilePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    jobTitle: z.string().trim().max(120).nullable().optional(),
    avatarUrl: z.string().trim().url().max(2048).nullable().optional(),
    /** Null clears the override and follows the workspace default. */
    locale: z.enum(LOCALES).nullable().optional(),
    timezone: z.string().trim().max(64).nullable().optional(),
  })
  .strict()
  // A PATCH that changes nothing is a client bug worth surfacing, not a no-op
  // that reports success.
  .refine((v) => Object.keys(v).length > 0, { message: "No profile fields to update" });

/**
 * MIRRORS the frontend changePasswordSchema in src/lib/schemas.ts.
 *
 * `currentPassword` is checked even though the caller already holds a verified
 * session: a session can be a laptop someone walked away from, and this is the
 * one write that would lock its owner out of their own account.
 */
const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: z.string().min(8, "Use at least 8 characters").max(128),
  })
  .strict()
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: "The new password must be different from the current one",
    path: ["newPassword"],
  });

export interface MyProfile {
  /** "staff" = a workspace member; "platform" = a super admin with no staff row. */
  kind: "staff" | "platform";
  authUserId: string;
  email: string;
  /** App role from the JWT (owner | admin | staff | viewer | platform_admin). */
  appRole: string;

  staffUserId: string | null;
  name: string;
  phone: string | null;
  jobTitle: string | null;
  avatarUrl: string | null;
  locale: string | null;
  timezone: string | null;
  status: string | null;
  lastActive: Date | null;
  memberSince: Date | null;

  workspace: { id: string; slug: string; name: string; type: string } | null;
  role: { id: string; name: string } | null;
  /** Labelled capabilities, so the page can show what this person may do. */
  can: { key: string; label: string; group: string }[];
  /** True when the app role skips capability checks (platform_admin, owner). */
  unrestricted: boolean;
}

@Injectable()
export class ProfileService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly access: AccessService,
    private readonly supabase: SupabaseAdminService,
  ) {}

  /** Capability keys → their catalog entries, for display. */
  private label(access: UserAccess): MyProfile["can"] {
    if (access.bypass) return CAPABILITIES.map((c) => ({ key: c.key, label: c.label, group: c.group }));
    const held = new Set(access.capabilities);
    return CAPABILITIES.filter((c) => held.has(c.key)).map((c) => ({
      key: c.key,
      label: c.label,
      group: c.group,
    }));
  }

  /**
   * This user's staff row, by identity first and by email second.
   *
   * The email fallback matters because an invited person exists as a row with
   * `auth_user_id = NULL` until they accept. Matching only on auth_user_id
   * treats them as having no profile at all, and — worse — a later INSERT would
   * collide with the `staff_users_tenant_email` unique index. Case-insensitive
   * because Supabase lowercases the address and an invite may not have.
   *
   * forTenant, not raw: staff_users and roles are RLS-forced, so an unscoped
   * read returns zero rows and would look like "no profile" (the same trap
   * AccessService documents).
   */
  private async findStaffRow(user: AuthUser) {
    const email = user.email?.trim();
    const [row] = await this.tdb.forTenant(user.tenantId!, (tx) =>
      tx
        .select({
          staff: staffUsers,
          roleId: roles.id,
          roleName: roles.name,
          tenantId: tenants.id,
          tenantSlug: tenants.slug,
          tenantName: tenants.name,
          tenantType: tenants.type,
        })
        .from(staffUsers)
        .leftJoin(roles, eq(roles.id, staffUsers.roleId))
        .leftJoin(tenants, eq(tenants.id, staffUsers.tenantId))
        .where(
          email
            ? or(
                eq(staffUsers.authUserId, user.id),
                and(
                  isNull(staffUsers.authUserId),
                  sql`lower(${staffUsers.email}) = lower(${email})`,
                ),
              )
            : eq(staffUsers.authUserId, user.id),
        )
        // A row already claimed by this identity wins over an unclaimed invite
        // that merely shares the address. Ordered on the null-ness itself, not
        // `desc(authUserId)`: Postgres sorts DESC as NULLS FIRST, which would
        // have preferred the unclaimed row — the exact opposite.
        .orderBy(sql`(${staffUsers.authUserId} is null) asc`)
        .limit(1),
    );
    return row;
  }

  async get(user: AuthUser, access: UserAccess): Promise<MyProfile> {
    const base = {
      authUserId: user.id,
      email: user.email ?? "",
      appRole: user.role,
      can: this.label(access),
      unrestricted: access.bypass,
    };

    // A platform admin genuinely has no staff row. Returning a hollow one would
    // make the page render editable fields that write nowhere.
    if (user.role === PLATFORM_ADMIN || !user.tenantId) {
      return {
        ...base,
        kind: "platform",
        staffUserId: null,
        name: user.email?.split("@")[0] ?? "Platform admin",
        phone: null,
        jobTitle: null,
        avatarUrl: null,
        locale: null,
        timezone: null,
        status: "active",
        lastActive: null,
        memberSince: null,
        workspace: null,
        role: null,
      };
    }

    const row = await this.findStaffRow(user);

    // Belongs to a workspace but has no staff row yet — an identity created by
    // a script or provisioned outside the invite flow.
    //
    // This used to return kind: "platform", which made the account page tell a
    // tenant OWNER that "platform admin accounts have no workspace profile" —
    // false, and it hid the form from the one person who could not be less
    // entitled to it. They are workspace staff with an unwritten row, so say
    // that: the form renders, and the first save creates the row (see update).
    if (!row) {
      const [ws] = await this.tdb.forTenant(user.tenantId, (tx) =>
        tx
          .select({ id: tenants.id, slug: tenants.slug, name: tenants.name, type: tenants.type })
          .from(tenants)
          .where(eq(tenants.id, user.tenantId!))
          .limit(1),
      );

      return {
        ...base,
        kind: "staff",
        staffUserId: null,
        name: user.email?.split("@")[0] ?? "",
        phone: null,
        jobTitle: null,
        avatarUrl: null,
        locale: null,
        timezone: null,
        status: "active",
        lastActive: null,
        memberSince: null,
        workspace: ws ?? null,
        role: null,
      };
    }

    return {
      ...base,
      kind: "staff",
      staffUserId: row.staff.id,
      name: row.staff.name,
      email: row.staff.email || base.email,
      phone: row.staff.phone,
      jobTitle: row.staff.jobTitle,
      avatarUrl: row.staff.avatarUrl,
      locale: row.staff.locale,
      timezone: row.staff.timezone,
      status: row.staff.status,
      lastActive: row.staff.lastActive,
      memberSince: row.staff.createdAt,
      workspace: row.tenantId
        ? { id: row.tenantId, slug: row.tenantSlug!, name: row.tenantName!, type: row.tenantType! }
        : null,
      role: row.roleId ? { id: row.roleId, name: row.roleName! } : null,
    };
  }

  async update(user: AuthUser, access: UserAccess, body: unknown): Promise<MyProfile> {
    const input = profilePatchSchema.parse(body);

    if (user.role === PLATFORM_ADMIN || !user.tenantId) {
      // There is no staff row to write to. Answering 200 with an unchanged
      // profile would be a lie the UI cannot detect, so say so plainly.
      throw new BadRequestException({
        message:
          "A platform admin account has no workspace profile. Change your name in Supabase Auth; " +
          "your password can be changed here.",
        code: "PLATFORM_PROFILE_READONLY",
      });
    }

    const existing = await this.findStaffRow(user);

    if (existing) {
      await this.tdb.forTenant(user.tenantId, (tx) =>
        tx
          .update(staffUsers)
          .set({
            ...input,
            // Claim an invite row that was matched by email: from now on this
            // identity owns it, and the email fallback stops being needed.
            authUserId: user.id,
            updatedAt: new Date(),
          })
          // Chosen by the row we just resolved from the verified token, never
          // by an id the caller supplied.
          .where(and(eq(staffUsers.id, existing.staff.id), eq(staffUsers.tenantId, user.tenantId!))),
      );
    } else {
      // First save for a workspace member whose row was never written (created
      // by a provisioning script rather than the invite flow). Everything
      // identifying comes from the token; `roleId` stays null, so this grants
      // no access on its own — the JWT app role still decides what they may do.
      await this.tdb.forTenant(user.tenantId, (tx) =>
        tx.insert(staffUsers).values({
          tenantId: user.tenantId!,
          authUserId: user.id,
          email: user.email ?? "",
          name: input.name?.trim() || user.email?.split("@")[0] || "Member",
          status: "active",
          phone: input.phone ?? null,
          jobTitle: input.jobTitle ?? null,
          avatarUrl: input.avatarUrl ?? null,
          locale: input.locale ?? null,
          timezone: input.timezone ?? null,
        }),
      );
    }

    // The name is denormalised into nothing, but the cached access object holds
    // the role/menu this user resolves to; drop it so a locale change is not
    // shadowed for up to 30s by a stale entry.
    this.access.invalidate(user.id);
    return this.get(user, access);
  }

  /**
   * Change your own password, and clear any forced-change flag with it.
   *
   * This is a backend endpoint rather than a client-side supabase.auth
   * .updateUser() call — which is how the account page used to do it — because
   * clearing app_metadata.must_change_password needs the service-role key. Doing
   * the two halves separately would mean a client that changed its password and
   * then failed to clear the flag, leaving the user forced to change it again.
   *
   * Works for every caller including platform admins, who have no staff row:
   * nothing here touches the database.
   */
  async changePassword(user: AuthUser, body: unknown): Promise<{ ok: true }> {
    const input = passwordChangeSchema.parse(body);

    // The AUTH_DEV_BYPASS identity ("dev", dev@local) is not a real GoTrue user;
    // GoTrue would answer 404 for the update and "wrong password" for the check.
    if (!UUID_RE.test(user.id) || !user.email) {
      throw new BadRequestException("This session has no Supabase Auth account to change a password for.");
    }

    if (!(await this.supabase.verifyPassword(user.email, input.currentPassword))) {
      // Deliberately 400, NOT 401: the frontend api client reads 401 as "this
      // token expired", refreshes, retries the request and signs the user out if
      // that fails — so answering 401 here would log someone out for a typo.
      throw new BadRequestException({
        message: "Current password is incorrect",
        code: "CURRENT_PASSWORD_INCORRECT",
      });
    }

    await this.supabase.updateUserById(user.id, {
      password: input.newPassword,
      // Cleared in the same call as the password, so the two can never disagree.
      app_metadata: { must_change_password: false },
    });
    return { ok: true };
  }

  /**
   * This person's own sign-in history.
   *
   * auth_events is otherwise readable only by a platform admin
   * (drizzle/0008_platform_admin.sql revokes it from everyone else), which is
   * right for the cross-tenant view — but "where was my account used from" is a
   * question the account holder should not have to ask support. Scoped to
   * auth_user_id = caller, so it can only ever return their own rows.
   */
  async signIns(user: AuthUser, limit: number) {
    // auth_events.auth_user_id is a uuid column, so a non-uuid subject — the
    // AUTH_DEV_BYPASS identity "dev" — makes Postgres reject the comparison
    // itself. Same guard AuthEventsService.record uses, for the same reason:
    // this must never be the thing that breaks the account page.
    if (!UUID_RE.test(user.id)) return [];

    return this.tdb.asPlatform((tx) =>
      tx
        .select({
          id: authEvents.id,
          event: authEvents.event,
          ip: authEvents.ip,
          userAgent: authEvents.userAgent,
          at: authEvents.createdAt,
        })
        .from(authEvents)
        .where(eq(authEvents.authUserId, user.id))
        .orderBy(desc(authEvents.createdAt))
        .limit(limit),
    );
  }
}

@ApiTags("auth")
@ApiBearerAuth()
@Controller("api/me")
export class ProfileController {
  constructor(private readonly svc: ProfileService) {}

  @Get("profile")
  @ApiOperation({ summary: "The signed-in user's own profile, workspace, role and capabilities" })
  get(@CurrentUser() user: AuthUser, @CurrentAccess() access: UserAccess) {
    return this.svc.get(user, access);
  }

  @Patch("profile")
  @ApiOperation({
    summary: "Update your own profile",
    description: "Name, phone, job title, avatar, language and timezone. Scoped to the caller by their token.",
  })
  update(@CurrentUser() user: AuthUser, @CurrentAccess() access: UserAccess, @Body() body: unknown) {
    return this.svc.update(user, access, body);
  }

  @Post("password")
  @ApiOperation({
    summary: "Change your own password",
    description:
      "Verifies the current password, sets the new one, and clears any admin-issued forced-change flag. " +
      "Scoped to the caller by their token.",
  })
  changePassword(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.svc.changePassword(user, body);
  }

  @Get("sign-ins")
  @ApiOperation({ summary: "Your recent sign-in activity" })
  @ApiQuery({ name: "limit", required: false, description: "Rows to return (default 10, max 50)" })
  signIns(@CurrentUser() user: AuthUser, @Query("limit") limit?: string) {
    const n = Math.min(50, Math.max(1, Number.parseInt(limit ?? "10", 10) || 10));
    return this.svc.signIns(user, n);
  }
}
