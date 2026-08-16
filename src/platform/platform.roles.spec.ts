import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { PLATFORM_ADMIN } from "../auth/roles";
import { ROLES } from "../auth/decorators";
import {
  PLATFORM_CONTROLLERS,
  UNGUARDED_PLATFORM_CONTROLLERS,
  findUnguardedPlatformControllers,
} from "./platform.module";
import { AuthEventsController } from "./auth-events.controller";

/**
 * The super-admin surface is admin-only.
 *
 * This used to iterate a list of controllers written out by hand — the same
 * failure mode PlatformModule's own boot check had, and its comment admitted:
 * "the check only inspects what is listed, so an omission is silent." A new
 * controller added to the module and forgotten here shipped unguarded and
 * passed. Both now walk PLATFORM_CONTROLLERS, which IS the module's
 * `controllers` array, so registering a route and auditing it are the same act.
 */
describe("platform surface is admin-only", () => {
  const audited = PLATFORM_CONTROLLERS.filter((c) => !UNGUARDED_PLATFORM_CONTROLLERS.includes(c));

  it("has controllers to audit", () => {
    // Guards against the whole suite silently passing on an empty list if the
    // module is ever refactored to build `controllers` some other way.
    expect(audited.length).toBeGreaterThan(0);
  });

  it.each(audited.map((c) => [c.name, c] as const))("%s carries @Roles(PLATFORM_ADMIN)", (_name, controller) => {
    const roles: string[] = Reflect.getMetadata(ROLES, controller) ?? [];
    expect(roles).toContain(PLATFORM_ADMIN);
  });

  it("reports nothing unguarded — the same check PlatformModule runs at boot", () => {
    expect(findUnguardedPlatformControllers().map((c) => c.name)).toEqual([]);
  });

  /**
   * Deliberately NOT admin-gated: any authenticated user records their own
   * sign-in, and the handler ignores the request body when deciding whose row
   * to write. Asserted so that if someone "fixes" it by adding the decorator,
   * they have to delete this test and read why first.
   */
  it("AuthEventsController is intentionally open to any authenticated user", () => {
    expect(UNGUARDED_PLATFORM_CONTROLLERS).toContain(AuthEventsController);
    const roles: string[] = Reflect.getMetadata(ROLES, AuthEventsController) ?? [];
    expect(roles).not.toContain(PLATFORM_ADMIN);
  });

  /**
   * The exception list is the one place "unguarded on purpose" can be declared,
   * so it must stay short enough that a reviewer reads every entry.
   */
  it("keeps the deliberate-exception list minimal", () => {
    expect(UNGUARDED_PLATFORM_CONTROLLERS).toHaveLength(1);
  });
});
