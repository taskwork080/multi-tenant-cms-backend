import { describe, expect, it } from "vitest";
import {
  APP_ROLES,
  PLATFORM_ADMIN,
  RANK,
  bypassesCapabilityChecks,
  bypassesMenuChecks,
  normalizeAppRole,
} from "./roles";
import { resolveMenuAccess } from "./menu-access";

/**
 * The three-role model, asserted where it is decided rather than where it is
 * consumed. Every one of these was previously implicit in a string comparison
 * scattered across two repos.
 */
describe("app roles", () => {
  it("has exactly three identities", () => {
    expect([PLATFORM_ADMIN, ...APP_ROLES]).toEqual(["platform_admin", "owner", "staff"]);
  });

  it("does not offer platform_admin as a grantable tenant role", () => {
    // APP_ROLES feeds the zod enums on every create/invite body. If
    // platform_admin ever appears here, a request body can mint a super admin.
    expect(APP_ROLES as readonly string[]).not.toContain(PLATFORM_ADMIN);
  });
});

describe("normalizeAppRole", () => {
  it("passes the three real roles through", () => {
    expect(normalizeAppRole("platform_admin")).toBe("platform_admin");
    expect(normalizeAppRole("owner")).toBe("owner");
    expect(normalizeAppRole("staff")).toBe("staff");
  });

  /**
   * The migration's safety net. A browser holding a token minted before the
   * role collapse still says "admin" or "viewer"; both must behave as staff
   * from the next request, with no forced sign-out.
   */
  it.each(["admin", "viewer"])("degrades the retired role %s to staff", (legacy) => {
    expect(normalizeAppRole(legacy)).toBe("staff");
  });

  it.each([undefined, null, "", "root", "superuser", 42, {}])("degrades %s to staff", (junk) => {
    expect(normalizeAppRole(junk)).toBe("staff");
  });

  it("never widens — nothing but the literal string yields platform_admin", () => {
    for (const input of ["Platform_Admin", "PLATFORM_ADMIN", " platform_admin", "platform_admin "]) {
      expect(normalizeAppRole(input)).toBe("staff");
    }
  });
});

/**
 * The split that makes the platform admin's menu grant on an owner bind. These
 * were one predicate; if they are ever merged again, the owner row below flips
 * and this file fails.
 */
describe("bypass predicates", () => {
  it("owner skips capabilities but NOT menus", () => {
    expect(bypassesCapabilityChecks("owner")).toBe(true);
    expect(bypassesMenuChecks("owner")).toBe(false);
  });

  it("platform_admin skips both", () => {
    expect(bypassesCapabilityChecks(PLATFORM_ADMIN)).toBe(true);
    expect(bypassesMenuChecks(PLATFORM_ADMIN)).toBe(true);
  });

  it("staff skips neither", () => {
    expect(bypassesCapabilityChecks("staff")).toBe(false);
    expect(bypassesMenuChecks("staff")).toBe(false);
  });
});

/**
 * The end-to-end consequence, composed the way AccessService.load composes it.
 * Worth stating here because the interesting cases are the two that must NOT
 * change: an owner is only ever restricted by a deliberate menu grant.
 */
describe("owner menu resolution", () => {
  const forOwner = (permissions: string[], hasRole: boolean) =>
    resolveMenuAccess(permissions, { bypass: bypassesMenuChecks("owner"), hasRole });

  it("binds an explicit grant", () => {
    const menu = forOwner(["menu:/dashboard", "menu:/staff/users"], true);
    expect(menu.unrestricted).toBe(false);
    expect(menu.hrefs.sort()).toEqual(["/dashboard", "/staff/users"]);
  });

  it("leaves an owner with no role untouched", () => {
    expect(forOwner([], false).unrestricted).toBe(true);
  });

  it("leaves an owner whose role predates menus untouched", () => {
    // The deploy-safety property: no existing owner loses a nav item until
    // someone deliberately saves menu keys on their role.
    expect(forOwner(["catalog.view", "orders.manage"], true).unrestricted).toBe(true);
  });
});

describe("invite rank ladder", () => {
  it("covers every grantable role", () => {
    // A role missing from RANK is rejected by assertMayGrant as undefined,
    // which reads as a mysterious 403 rather than a policy.
    for (const role of APP_ROLES) expect(RANK[role]).toBeTypeOf("number");
  });

  it("ranks owner above staff", () => {
    expect(RANK.owner).toBeLessThan(RANK.staff);
  });

  it("does not rank platform_admin — it is not grantable from a tenant", () => {
    expect(RANK[PLATFORM_ADMIN]).toBeUndefined();
  });
});
