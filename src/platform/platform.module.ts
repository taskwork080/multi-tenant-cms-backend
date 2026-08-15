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
@Module({
  controllers: [
    PlatformUsersController,
    PlatformTenantsController,
    PlatformRolesController,
    PlatformAdminsController,
    PlatformOverviewController,
    PlatformAuditController,
    AuthEventsController,
  ],
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
    // Invariant 1, enforced at boot rather than in a test: a missing decorator
    // is silent, and the repo has no test runner to catch it. Failing to start
    // is the correct response to "these routes are currently unguarded".
    // Every controller in this module except AuthEventsController belongs here.
    // The check only inspects what is listed, so an omission is silent.
    const guarded = [
      PlatformUsersController,
      PlatformTenantsController,
      PlatformRolesController,
      PlatformAdminsController,
      PlatformOverviewController,
      PlatformAuditController,
    ];
    const unguarded = guarded.filter((c) => !(Reflect.getMetadata(ROLES, c) ?? []).includes(PLATFORM_ADMIN));
    if (unguarded.length) {
      throw new Error(
        `Platform controllers missing @Roles(PLATFORM_ADMIN): ${unguarded.map((c) => c.name).join(", ")}. ` +
          `These routes read and write across every tenant and must never be reachable without it.`,
      );
    }
    // AuthEventsController is intentionally not in that list: any authenticated
    // user records their own sign-in, and the handler ignores the request body
    // when deciding whose row to write.
    new Logger("PlatformModule").log(`Super-admin routes active at /api/admin/* (${guarded.length} controllers guarded)`);
  }
}
