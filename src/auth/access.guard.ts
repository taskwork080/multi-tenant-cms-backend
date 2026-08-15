import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { AccessService, BYPASS_ACCESS, type UserAccess } from "./access.service";
import { IS_PUBLIC } from "./decorators";
import type { AuthUser } from "./auth.types";

/**
 * Resolves the caller's tenant role once per request and attaches it as
 * `req.access`, so CapabilityGuard, CrudService and controllers all read the
 * same resolved object instead of each running their own lookup.
 *
 * It also enforces the staff lifecycle. That was a real hole: nothing between
 * AuthGuard and the controller read `staff_users.status`, so suspending or
 * deactivating a staff member changed what the platform UI displayed and
 * nothing else — they kept full API access until their GoTrue token expired.
 * Suspension has to bite on the next request to mean anything.
 *
 * TIMING CAVEAT: AccessService caches for 30s per process, the same window and
 * the same trade-off TenantGuard documents for tenant status. A suspension can
 * take that long to bind on an instance that did not serve the write.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly access: AccessService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser; access?: UserAccess }>();
    const user = req.user;
    if (!user) return true; // AuthGuard already let this through (dev bypass); nothing to resolve.

    const access = await this.access.forUser(user);

    // Only the two DELIBERATELY disabled states close the door.
    //
    // `invited` must NOT be one of them, and getting that wrong locks out every
    // user created through an invite. An invited row means "created, has not
    // signed in yet" — but the only way to hold a valid token is to have
    // completed the invite link and set a password, so a request that reaches
    // here from an `invited` row is by definition someone who just accepted.
    // AuthEventsService flips them to `active` when their sign-in is recorded;
    // that call arrives *after* the first authenticated requests, so rejecting
    // here would 403 the very session that is about to promote them.
    //
    // `null` means no staff row at all — platform admins, and identities that
    // predate their staff record — handled by TenantGuard/CapabilityGuard.
    if (isDisabled(access.staffStatus)) {
      throw new ForbiddenException({
        message: "Your access to this workspace has been suspended.",
        code: "STAFF_INACTIVE",
        status: access.staffStatus,
      });
    }

    req.access = access;
    return true;
  }
}

/**
 * Staff states that close the door, as opposed to states that merely describe
 * where someone is in onboarding.
 *
 * Extracted and tested (access.guard.spec.ts) because the distinction is easy
 * to get wrong in exactly one direction: treating `invited` as disabled locks
 * out every user created through an invite, since the promotion to `active`
 * happens when their sign-in is recorded — after the session's first requests.
 */
export function isDisabled(status: string | null): boolean {
  return status === "suspended" || status === "deactivated";
}

/** Fallback for the handful of paths that read req.access without a guard run. */
export function accessOf(req: { access?: UserAccess }): UserAccess {
  return req.access ?? BYPASS_ACCESS;
}
