import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { BYPASS_ACCESS, type UserAccess } from "./access.service";
import { assertCapabilities } from "./capability.guard";

function access(over: Partial<UserAccess> = {}): UserAccess {
  return {
    ...BYPASS_ACCESS,
    bypass: false,
    roleId: "role-1",
    roleName: "Inbound Clerk",
    staffUserId: "staff-1",
    staffStatus: "active",
    capabilities: ["inventory.view", "inventory.receive"],
    permissions: ["inventory.view", "inventory.receive"],
    ...over,
  };
}

describe("assertCapabilities", () => {
  it("allows a role that holds the required key", () => {
    expect(() => assertCapabilities(access(), ["inventory.receive"])).not.toThrow();
  });

  it("denies a role that does not — this is the check that did not exist", () => {
    // Before this, a `viewer` could DELETE /api/:tenant/orders/:id.
    expect(() => assertCapabilities(access(), ["inventory.count"])).toThrow(ForbiddenException);
  });

  it("requires ALL listed capabilities, not any", () => {
    expect(() => assertCapabilities(access(), ["inventory.view", "inventory.count"])).toThrow(ForbiddenException);
  });

  it("names the missing key so the client can explain the refusal", () => {
    try {
      assertCapabilities(access(), ["inventory.count"]);
      throw new Error("should have thrown");
    } catch (e) {
      const body = (e as ForbiddenException).getResponse() as { code: string; required: string[] };
      expect(body.code).toBe("CAPABILITY_REQUIRED");
      expect(body.required).toEqual(["inventory.count"]);
    }
  });

  it("platform_admin and owner bypass", () => {
    expect(() => assertCapabilities(access({ bypass: true }), ["anything.at.all"])).not.toThrow();
  });

  /**
   * The migration escape hatch. scripts/backfill-rbac.ts removes both states,
   * after which these branches are unreachable — they exist so a deploy that
   * lands before the backfill degrades to the old behaviour instead of locking
   * a workspace out.
   */
  it("treats a role with no capability keys as unconfigured, not unprivileged", () => {
    expect(() => assertCapabilities(access({ capabilities: [] }), ["inventory.count"])).not.toThrow();
  });

  it("treats a staff row with no role as unconfigured", () => {
    expect(() => assertCapabilities(access({ roleId: null }), ["inventory.count"])).not.toThrow();
  });
});
