import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { APP_ROLES } from "../auth/roles";
import { AUDIT_ACTIONS, AUDIT_TARGET_TYPES } from "./audit.actions";
import { MODULE_KEYS, TENANT_TYPES, modulesOutsideType } from "./module-presets";

/**
 * Request schemas for /api/admin/*.
 *
 * MIRRORED on the frontend in `src/lib/schemas.ts` (multi-tenant-cms repo).
 * There is no shared package between the two repos, so any change here needs
 * the matching change there or the client will send bodies the server rejects.
 */

/**
 * Application roles carried in the JWT's app_metadata.role.
 *
 * Re-exported rather than redeclared: the role model lives in src/auth/roles.ts
 * so the guards and these schemas cannot drift into accepting different sets.
 * platform_admin is deliberately not in here — it is never granted through a
 * request body.
 */
export { APP_ROLES };

/** CMS-level account states. `deactivated` and `suspended` both ban in GoTrue. */
export const USER_STATUSES = ["active", "invited", "suspended", "deactivated"] as const;

const uuid = z.string().uuid();
const email = z.string().trim().toLowerCase().email();

export const adminUserCreateSchema = z
  .object({
    tenantId: uuid,
    name: z.string().trim().min(1).max(120),
    email,
    roleId: uuid.nullable().optional(),
    appRole: z.enum(APP_ROLES).default("staff"),
    // Defaults to false: the ordinary path is the admin handing over a temporary
    // password, which the user is forced to replace on first sign-in. Invite
    // links remain available for self-serve onboarding — /:tenant/staff/invite
    // passes sendInvite: true explicitly and is unaffected by this default.
    sendInvite: z.boolean().default(false),
    // Only honoured when sendInvite is false; otherwise the invite link sets it.
    password: z.string().min(8).max(128).optional(),
    /**
     * Defaults to "yes, whenever a password was supplied" — an admin-chosen
     * password is temporary by construction. The opt-out exists for the
     * provisioning scripts (scripts/seed.ts, scripts/create-user.ts), where the
     * operator IS the account holder and choosing their own password twice is
     * just friction.
     *
     * Unlike resetPasswordSchema's "set", this is not gated on
     * PLATFORM_ALLOW_PASSWORD_SET: that flag protects accounts that already have
     * an owner and data behind them. A brand new account has neither.
     */
    mustChangePassword: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.sendInvite || !!v.password, {
    message: "A password is required when no invite is sent",
    path: ["password"],
  });

export const adminUserUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    email: email.optional(),
    roleId: uuid.nullable().optional(),
    appRole: z.enum(APP_ROLES).optional(),
  })
  .strict();

export const adminUserStatusSchema = z
  .object({
    action: z.enum(["activate", "deactivate", "suspend", "restore"]),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const moveTenantSchema = z
  .object({
    tenantId: uuid,
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

/**
 * `temp` and `set` both write a password directly; they differ in what the admin
 * is left holding afterwards. `temp` marks the account must-change, so the
 * password stops working the moment the user signs in — which is why it is NOT
 * gated on PLATFORM_ALLOW_PASSWORD_SET the way `set` is. `set` leaves a
 * permanent password the admin also knows, i.e. silent shared access.
 */
export const resetPasswordSchema = z
  .object({
    // Default stays "link": it is the only mode that needs no further input, so
    // a body that omits both fields must not become a validation error.
    mode: z.enum(["link", "temp", "set"]).default("link"),
    password: z.string().min(8).max(128).optional(),
  })
  .strict()
  .refine((v) => v.mode === "link" || !!v.password, {
    message: "A password is required in 'temp' and 'set' mode",
    path: ["password"],
  });

// --- Tenants ---------------------------------------------------------------

const tenantConfigSchema = z
  .object({
    defaultLanguage: z.enum(["en", "bn"]).optional(),
    currency: z.string().optional(),
    currencySymbol: z.string().optional(),
    ga4Id: z.string().optional(),
    pixelId: z.string().optional(),
    strictOrderFlow: z.boolean().optional(),
    defaultSellerName: z.string().optional(),
    locationServiceOn: z.boolean().optional(),
    codEnabled: z.boolean().optional(),
    allowForceDeleteCategory: z.boolean().optional(),
    cordNo: z.string().optional(),
  })
  .strict();

export const adminTenantPatchSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    type: z.enum(TENANT_TYPES).optional(),
    region: z.string().optional(),
    theme: z.object({ brand: z.string(), brandFg: z.string() }).partial().optional(),
    // Closed set: an unknown module is a dead tenant_entitlements row nothing
    // will ever match, so reject it here instead of storing it.
    entitlements: z.array(z.enum(MODULE_KEYS)).optional(),
    config: tenantConfigSchema.optional(),
    /**
     * Deliberately cross the vertical's ceiling (e.g. give a warehouse
     * workspace a storefront). Recorded in the audit row so the exception is
     * traceable — see assertModulesWithinType.
     */
    allowOutsideType: z.boolean().optional(),
  })
  .strict();

/**
 * Workspace lifecycle. Deliberately NOT part of adminTenantPatchSchema: a
 * status change cuts off every user of the workspace, so it goes through its
 * own audited endpoint rather than riding along on a generic edit.
 */
export const TENANT_STATUSES = ["active", "suspended", "archived"] as const;

export const adminTenantStatusSchema = z
  .object({
    status: z.enum(TENANT_STATUSES),
    reason: z.string().trim().max(500).optional(),
    // Suspending a workspace does not invalidate anyone's existing GoTrue
    // token — TenantGuard rejects them on their next request instead. Banning
    // each user is the only thing that kills live sessions, and it is N
    // non-atomic calls that "restore workspace" does not undo, so it is opt-in.
    suspendUsers: z.boolean().default(false),
  })
  .strict();

/**
 * Slugs that would collide with a top-level API path. `/api/admin/users` is
 * indistinguishable from `/api/:tenant/:resource` with tenant="admin", so a
 * tenant may never claim one of these.
 */
export const RESERVED_TENANT_SLUGS = new Set(["admin", "tenants", "me", "docs", "health", "auth", "api"]);

export const adminTenantCreateSchema = adminTenantPatchSchema.extend({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers and hyphens only")
    .refine((s) => !RESERVED_TENANT_SLUGS.has(s), "That slug is reserved by the platform"),
  name: z.string().trim().min(1),
  type: z.enum(TENANT_TYPES),
});

/**
 * The vertical's ceiling (module-presets.ts TYPE_ALLOWED_MODULES), enforced.
 *
 * Not a zod refinement because the check needs the *effective* type and the
 * *effective* entitlements — on a PATCH either may be absent from the body and
 * come from the stored row instead, and changing `type` has to re-validate
 * entitlements nobody sent.
 */
export function assertModulesWithinType(
  type: string,
  entitlements: readonly string[],
  allowOutsideType: boolean | undefined,
) {
  if (allowOutsideType) return;
  const outside = modulesOutsideType(type, entitlements);
  if (outside.length) {
    throw new BadRequestException({
      message:
        `A "${type}" workspace cannot hold: ${outside.join(", ")}. ` +
        `Change the workspace type, or pass allowOutsideType to override deliberately.`,
      code: "MODULES_OUTSIDE_TYPE",
      type,
      outside,
    });
  }
}

// --- Platform admins -------------------------------------------------------

export const promoteAdminSchema = z
  .object({
    staffUserId: uuid,
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

/**
 * Demotion needs a destination. Dropping the platform role on its own would
 * leave a login that belongs to no workspace and can therefore reach nothing.
 */
export const demoteAdminSchema = z
  .object({
    tenantId: uuid,
    appRole: z.enum(APP_ROLES),
    roleId: uuid.nullable().optional(),
    name: z.string().trim().min(1).max(120).optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

export const adminListSchema = z
  .object({
    q: z.string().trim().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .passthrough();

// --- Roles -----------------------------------------------------------------

export const adminRoleSchema = z
  .object({
    tenantId: uuid,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).default(""),
    permissions: z.array(z.string()).default([]),
  })
  .strict();

export const adminRolePatchSchema = adminRoleSchema.partial().omit({ tenantId: true }).strict();

// --- Auth events -----------------------------------------------------------

export const authEventSchema = z
  .object({
    // NOTE: no user field by design — the row is always written for req.user.
    event: z.enum(["sign_in", "sign_out", "password_recovery", "invite_accepted"]),
  })
  .strict();

// --- Shared list query -----------------------------------------------------

const rangeSchema = z.object({ gte: z.string().optional(), lte: z.string().optional() }).partial();

/** `?status=a&status=b` arrives as a string or string[] depending on arity. */
const multi = z.union([z.string(), z.array(z.string())]).optional();

export const adminUserListSchema = z
  .object({
    q: z.string().trim().optional(),
    tenantId: z.string().optional(),
    roleId: z.string().optional(),
    status: multi,
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
    sort: z.string().optional(),
    createdAt: rangeSchema.optional(),
  })
  .passthrough();

export const auditListSchema = z
  .object({
    q: z.string().trim().optional(),
    actorId: z.string().optional(),
    action: multi,
    targetType: z.enum(AUDIT_TARGET_TYPES).optional(),
    targetId: z.string().optional(),
    tenantId: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
    createdAt: rangeSchema.optional(),
  })
  .passthrough();

export const tenantListSchema = z
  .object({
    q: z.string().trim().optional(),
    status: multi,
    type: multi,
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
    sort: z.string().optional(),
  })
  .passthrough();

export const AUDIT_ACTION_VALUES = AUDIT_ACTIONS;
