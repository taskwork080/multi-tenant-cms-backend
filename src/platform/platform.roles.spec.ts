import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { PLATFORM_ADMIN } from "../auth/auth.types";
import { ROLES } from "../auth/decorators";
import { PlatformAdminsController } from "./platform-admins.controller";
import { PlatformAuditController } from "./platform-audit.controller";
import { PlatformOverviewController } from "./platform-overview.controller";
import { PlatformRolesController } from "./platform-roles.controller";
import { PlatformTenantsController } from "./platform-tenants.controller";
import { PlatformUsersController } from "./platform-users.controller";
import { AuthEventsController } from "./auth-events.controller";

/**
 * The spec platform.module.ts and platform-users.controller.ts have both
 * referenced since they were written, and which never existed. Their comments
 * say "platform.roles.spec.ts asserts it" — now it does.
 *
 * PlatformModule's constructor already throws at boot if a *listed* controller
 * loses its decorator. This covers the gap that check cannot: it only inspects
 * the controllers someone remembered to add to its own array.
 */
describe("platform surface is admin-only", () => {
  const guarded = [
    PlatformUsersController,
    PlatformTenantsController,
    PlatformRolesController,
    PlatformAdminsController,
    PlatformOverviewController,
    PlatformAuditController,
  ];

  it.each(guarded.map((c) => [c.name, c] as const))("%s carries @Roles(PLATFORM_ADMIN)", (_name, controller) => {
    const roles: string[] = Reflect.getMetadata(ROLES, controller) ?? [];
    expect(roles).toContain(PLATFORM_ADMIN);
  });

  /**
   * Deliberately NOT admin-gated: any authenticated user records their own
   * sign-in, and the handler ignores the request body when deciding whose row
   * to write. Asserted so that if someone "fixes" it by adding the decorator,
   * they have to delete this test and read why first.
   */
  it("AuthEventsController is intentionally open to any authenticated user", () => {
    const roles: string[] = Reflect.getMetadata(ROLES, AuthEventsController) ?? [];
    expect(roles).not.toContain(PLATFORM_ADMIN);
  });
});
