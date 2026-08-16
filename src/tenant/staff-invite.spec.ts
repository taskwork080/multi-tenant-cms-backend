import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { PLATFORM_ADMIN } from "../auth/roles";
import { assertMayGrant } from "./staff-invite.controller";

/**
 * Who may appoint whom.
 *
 * This is the only place a tenant caller can cause an app role to be written,
 * so it is the whole attack surface for privilege escalation from inside a
 * workspace. Every case below is a rule someone could plausibly "simplify" away.
 */
describe("assertMayGrant", () => {
  const grants = (inviter: string, appRole: string) => () => assertMayGrant(inviter, appRole);

  describe("the platform admin", () => {
    it("may appoint an owner — this is how a workspace gets one", () => {
      expect(grants(PLATFORM_ADMIN, "owner")).not.toThrow();
    });

    it("may also add staff directly", () => {
      expect(grants(PLATFORM_ADMIN, "staff")).not.toThrow();
    });
  });

  describe("an owner", () => {
    it("may hire staff", () => {
      expect(grants("owner", "staff")).not.toThrow();
    });

    /**
     * The rule this change added. Equal rank passes the ladder (staff hire
     * staff), so without an explicit rule an owner could appoint a co-owner —
     * and "who runs this workspace" belongs to the platform, not the tenant.
     */
    it("may NOT appoint another owner", () => {
      expect(grants("owner", "owner")).toThrow(ForbiddenException);
      expect(grants("owner", "owner")).toThrow(/platform administrator/i);
    });

    it("may not mint a platform admin", () => {
      expect(grants("owner", PLATFORM_ADMIN)).toThrow(ForbiddenException);
    });
  });

  describe("a staff member with staff.manage", () => {
    it("may hire more staff — equal rank is allowed", () => {
      expect(grants("staff", "staff")).not.toThrow();
    });

    it("may not promote anyone to owner", () => {
      expect(grants("staff", "owner")).toThrow(ForbiddenException);
    });

    it("may not mint a platform admin", () => {
      expect(grants("staff", PLATFORM_ADMIN)).toThrow(ForbiddenException);
    });
  });

  describe("roles outside the model", () => {
    it("refuses to grant an unknown role", () => {
      expect(grants("owner", "superuser")).toThrow(ForbiddenException);
    });

    it("refuses when the INVITER's role is unknown", () => {
      // Fails closed: an unranked inviter must not be treated as rank 0.
      expect(grants("wizard", "staff")).toThrow(ForbiddenException);
    });

    it.each(["admin", "viewer"])("refuses the retired role %s", (legacy) => {
      // Normalisation happens at the JWT boundary, so nothing should ever ask
      // for these; if something does, it must not resolve to a rank.
      expect(grants("owner", legacy)).toThrow(ForbiddenException);
    });
  });
});
