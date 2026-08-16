import { describe, expect, it } from "vitest";
import { AccessService, BYPASS_ACCESS, NO_ACCESS } from "./access.service";
import type { AuthUser } from "./auth.types";
import { PLATFORM_ADMIN } from "./roles";

/**
 * The two constants AccessService can return without touching the database, and
 * the branch that picks between them.
 *
 * They used to be ONE constant, selected by `user.role === PLATFORM_ADMIN ||
 * !user.tenantId`. So a token whose tenant_id claim was absent — the exact
 * claim an attacker would strip, and the state a half-finished user move leaves
 * behind — resolved to bypass:true with an unrestricted menu. Splitting them is
 * the fix; these tests are what stop them being merged back.
 */
describe("AccessService.forUser — the no-database branches", () => {
  // `tdb` is never reached on either branch; both return before the lookup.
  const svc = new AccessService(null as never);

  /** AuthUser minus the fields no access decision reads. */
  const as = (u: Omit<AuthUser, "mustChangePassword">): AuthUser => ({ ...u, mustChangePassword: false });

  it("grants a platform admin the bypass", async () => {
    const user = as({ id: "u1", email: "root@cms.test", role: PLATFORM_ADMIN });
    const access = await svc.forUser(user);
    expect(access.bypass).toBe(true);
    expect(access.menu.unrestricted).toBe(true);
    expect(access.actor).toBe("root@cms.test");
  });

  it("grants a platform admin the bypass even with a home workspace", async () => {
    // A promoted admin keeps their staff row and tenant_id; the role decides.
    const access = await svc.forUser(as({ id: "u2", role: PLATFORM_ADMIN, tenantId: "t1" }));
    expect(access.bypass).toBe(true);
  });

  it("grants a tenantless NON-admin nothing at all", async () => {
    const access = await svc.forUser(as({ id: "u3", email: "nobody@x.test", role: "staff" }));
    expect(access.bypass).toBe(false);
    expect(access.menu.unrestricted).toBe(false);
    expect(access.menu.hrefs).toEqual([]);
    expect(access.capabilities).toEqual([]);
  });

  it("grants a tenantless OWNER nothing either — owner is not a platform role", async () => {
    const access = await svc.forUser(as({ id: "u4", role: "owner" }));
    expect(access.bypass).toBe(false);
    expect(access.menu.unrestricted).toBe(false);
  });

  it("keeps the actor identifiable on both branches", async () => {
    // activities.actor / platform_audit_log.actor_email read this; "system" for
    // a real person makes the audit trail useless.
    expect((await svc.forUser(as({ id: "u5", email: "a@x.test", role: "staff" }))).actor).toBe("a@x.test");
    expect((await svc.forUser(as({ id: "u6", role: "staff" }))).actor).toBe("u6");
  });
});

describe("the shared constants are not accidentally the same object", () => {
  it("differ on every field that decides access", () => {
    expect(BYPASS_ACCESS.bypass).toBe(true);
    expect(NO_ACCESS.bypass).toBe(false);
    expect(BYPASS_ACCESS.menu.unrestricted).toBe(true);
    expect(NO_ACCESS.menu.unrestricted).toBe(false);
  });
});
