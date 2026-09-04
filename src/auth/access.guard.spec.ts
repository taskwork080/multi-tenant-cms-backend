import { ForbiddenException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AccessGuard, isDisabled } from "./access.guard";
import { ALLOWS_PENDING_PASSWORD, IS_PUBLIC } from "./decorators";
import type { AccessService } from "./access.service";
import type { AuthUser } from "./auth.types";

/**
 * The staff lifecycle gate.
 *
 * This is a regression test with a specific history: the first version of
 * AccessGuard rejected anything that was not `active`, which included
 * `invited` — and since nothing ever promoted an invited row, that locked out
 * every user who had been created through an invite, on a live database where
 * every staff row was still `invited`.
 */
describe("isDisabled", () => {
  it("blocks the two deliberately-disabled states", () => {
    expect(isDisabled("suspended")).toBe(true);
    expect(isDisabled("deactivated")).toBe(true);
  });

  it("does NOT block `invited` — holding a token means the invite was accepted", () => {
    // The promotion to `active` happens when AuthEventsService records the
    // sign-in, which arrives after this session's first requests. Rejecting
    // here would 403 the very session about to promote them.
    expect(isDisabled("invited")).toBe(false);
  });

  it("does not block an active member", () => {
    expect(isDisabled("active")).toBe(false);
  });

  it("does not block callers with no staff row (platform admins)", () => {
    expect(isDisabled(null)).toBe(false);
  });

  it("does not block an unrecognised state — fail open on states we did not define", () => {
    // A new lifecycle value should be added here deliberately, not lock people
    // out the moment someone writes it to the column.
    expect(isDisabled("archived")).toBe(false);
  });
});

/**
 * The forced-password-change gate.
 *
 * The reason this is enforced server-side at all: `must_change_password` rides
 * in the JWT, so while it lived only in the client gates, issuing a temporary
 * password to someone already signed in changed nothing until their token
 * expired — and PlatformGate never checked it, so a deep link to /platform/*
 * handed over the whole super-admin surface.
 */
describe("AccessGuard — must_change_password", () => {
  const flagged: AuthUser = {
    id: "11111111-1111-1111-1111-111111111111",
    email: "temp@example.com",
    role: "staff",
    mustChangePassword: true,
  } as AuthUser;

  /** A context whose handler carries the given metadata keys. */
  function contextFor(user: AuthUser | undefined, metadata: Record<string, boolean> = {}) {
    const req: Record<string, unknown> = { user };
    return {
      ctx: {
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: () => "handler",
        getClass: () => "class",
      },
      req,
      reflector: {
        getAllAndOverride: (key: string) => metadata[key],
      },
    };
  }

  /** Never reached in the blocking cases — a call here means the guard let it past. */
  const access = {
    forUser: vi.fn(async () => ({ staffStatus: "active" })),
  } as unknown as AccessService;

  it("blocks an ordinary route with MUST_CHANGE_PASSWORD", async () => {
    const { ctx, reflector } = contextFor(flagged);
    const guard = new AccessGuard(access, reflector as never);

    await expect(guard.canActivate(ctx as never)).rejects.toThrow(ForbiddenException);
    await guard.canActivate(ctx as never).catch((err: ForbiddenException) => {
      expect((err.getResponse() as { code: string }).code).toBe("MUST_CHANGE_PASSWORD");
    });
  });

  it("allows a route marked @AllowsPendingPassword — the way out must stay open", async () => {
    // GET /api/me and POST /api/me/password. Without these the flagged session
    // could not learn where to go, nor do the one thing it is allowed to do.
    const { ctx, reflector } = contextFor(flagged, { [ALLOWS_PENDING_PASSWORD]: true });
    const guard = new AccessGuard(access, reflector as never);

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });

  it("leaves a user without the flag untouched", async () => {
    const { ctx, reflector } = contextFor({ ...flagged, mustChangePassword: false });
    const guard = new AccessGuard(access, reflector as never);

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });

  it("does not fire on a @Public route", async () => {
    const { ctx, reflector } = contextFor(flagged, { [IS_PUBLIC]: true });
    const guard = new AccessGuard(access, reflector as never);

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });

  it("does not fire for the dev bypass, which attaches no user", async () => {
    const { ctx, reflector } = contextFor(undefined);
    const guard = new AccessGuard(access, reflector as never);

    await expect(guard.canActivate(ctx as never)).resolves.toBe(true);
  });
});
