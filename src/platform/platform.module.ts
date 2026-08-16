import { Logger, Module } from "@nestjs/common";
import { PLATFORM_ADMIN } from "../auth/auth.types";
import { ROLES } from "../auth/decorators";
import { AuthEventsController, AuthEventsService } from "./auth-events.controller";
import { AuditService } from "./audit.service";
import { PlatformAdminsController, PlatformAdminsService } from "./platform-admins.controller";
import { PlatformAuditController, PlatformAuditService } from "./platform-audit.controller";
import { PlatformOverviewController, PlatformOverviewService } from "./platform-overview.controller";
import { PlatformRolesController, PlatformRolesService } from "./platform-roles.controller";
import { PlatformTenantsController, PlatformTenantsService } from "./platform-tenants.controller";
import { PlatformUsersController } from "./platform-users.controller";
import { PlatformUsersService } from "./platform-users.service";
import { TenantProvisioningService } from "./tenant-provisioning.service";

/**
 * Super-admin surface: cross-tenant user, workspace and role administration
 * plus the platform audit trail.
 *
 * TWO INVARIANTS, both load-bearing:
 *
 * 1. Every controller here carries a class-level `@Roles(PLATFORM_ADMIN)`.
 *    These routes read and write across every tenant, so a missing decorator
 *    is a total isolation failure. platform.roles.spec.ts asserts it.
 *
 * 2. This module MUST be imported in app.module.ts BEFORE CrudModule.
 *    CrudController is `@Controller("api/:tenant/:resource")`, so without the
 *    ordering `/api/admin/users` resolves as tenant="admin" and returns a
 *    confusing 404 instead of reaching this module at all.
 *
 * Note: TenantDb, TenantService and SupabaseAdminService all arrive from global
 * modules — importing CrudModule here would drag its catch-all controller
 * forward and defeat invariant 2.
 */
/**
 * Every controller this module registers. Exported and used as the @Module
 * `controllers` array itself, so the boot check below and platform.roles.spec.ts
 * both audit the REAL list.
 *
 * Previously the check kept its own hand-maintained copy, and its own comment
 * admitted the consequence: a controller added here but forgotten there shipped
 * unguarded and booted fine. Deriving both from one array removes the gap
 * rather than documenting it.
 */
export const PLATFORM_CONTROLLERS = [
  PlatformUsersController,
  PlatformTenantsController,
  PlatformRolesController,
  PlatformAdminsController,
  PlatformOverviewController,
  PlatformAuditController,
  AuthEventsController,
] as const;

/**
 * The deliberate exceptions to invariant 1. Adding to this list is how you say
 * "I meant that" — and it is small on purpose.
 *
 * AuthEventsController: any authenticated user records their own sign-in, and
 * the handler ignores the request body when deciding whose row to write.
 */
export const UNGUARDED_PLATFORM_CONTROLLERS: readonly unknown[] = [AuthEventsController];

@Module({
  controllers: [...PLATFORM_CONTROLLERS],
  providers: [
    AuditService,
    PlatformUsersService,
    PlatformTenantsService,
    PlatformRolesService,
    PlatformAdminsService,
    PlatformOverviewService,
    PlatformAuditService,
    AuthEventsService,
    TenantProvisioningService,
  ],
  exports: [PlatformUsersService, AuditService],
})
export class PlatformModule {
  constructor() {
    // Invariant 1, enforced at boot as well as in platform.roles.spec.ts: a
    // missing decorator is silent, and failing to start is the correct response
    // to "these routes are currently unguarded". Derived from
    // PLATFORM_CONTROLLERS, so a controller cannot be registered without also
    // being audited.
    const unguarded = findUnguardedPlatformControllers();
    if (unguarded.length) {
      throw new Error(
        `Platform controllers missing @Roles(PLATFORM_ADMIN): ${unguarded.map((c) => c.name).join(", ")}. ` +
          `These routes read and write across every tenant and must never be reachable without it.`,
      );
    }
    const guarded = PLATFORM_CONTROLLERS.length - UNGUARDED_PLATFORM_CONTROLLERS.length;
    new Logger("PlatformModule").log(`Super-admin routes active at /api/admin/* (${guarded} controllers guarded)`);
  }
}

/**
 * Controllers registered by this module that neither carry @Roles(PLATFORM_ADMIN)
 * nor appear in UNGUARDED_PLATFORM_CONTROLLERS.
 *
 * Shared by the boot check above and platform.roles.spec.ts so the two cannot
 * disagree about what "guarded" means.
 */
export function findUnguardedPlatformControllers(): { name: string }[] {
  return PLATFORM_CONTROLLERS.filter(
    (c) =>
      !UNGUARDED_PLATFORM_CONTROLLERS.includes(c) &&
      !((Reflect.getMetadata(ROLES, c) as string[] | undefined) ?? []).includes(PLATFORM_ADMIN),
  );
}
