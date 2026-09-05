import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import type { AuthUser } from "./auth.types";
import type { UserAccess } from "./access.service";

export const IS_PUBLIC = "isPublic";
/** Marks a route as reachable without a Bearer token (e.g. health check). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ALLOWS_PENDING_PASSWORD = "allowsPendingPassword";
/**
 * Lets a route serve a session that still carries
 * `app_metadata.must_change_password`.
 *
 * AccessGuard 403s every other route for such a session, which is what makes an
 * admin-issued temporary password actually confine anyone: the flag rides in the
 * JWT, so before this existed an already-signed-in user kept full API access
 * until their token expired, and the only checks were client-side gates that a
 * deep link walked straight past.
 *
 * Exactly two routes need it, and adding a third deserves an argument: reading
 * your own identity (the client cannot decide where to send you without it) and
 * changing your own password (the way out).
 */
export const AllowsPendingPassword = () => SetMetadata(ALLOWS_PENDING_PASSWORD, true);

export const ROLES = "roles";
/** Restricts a route to the given app roles (platform_admin always passes). */
export const Roles = (...roles: string[]) => SetMetadata(ROLES, roles);

export const CAPABILITIES_KEY = "capabilities";
/**
 * Requires the caller's tenant role to grant *every* listed capability.
 *
 * Opt-in per route rather than deny-by-default-everywhere: a route with no
 * decorator stays open, so switching enforcement on is a reviewable diff
 * instead of a big-bang that 403s whatever was missed. The generic CRUD
 * surface can't use this — its requirement depends on `:resource` and the HTTP
 * method — so it declares capabilities in resource-registry.ts and enforces
 * them in CrudService.resolve instead.
 */
export const RequireCapability = (...capabilities: string[]) => SetMetadata(CAPABILITIES_KEY, capabilities);

/** Injects the verified AuthUser attached by AuthGuard. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

/** Injects the UserAccess resolved by AccessGuard. */
export const CurrentAccess = createParamDecorator((_: unknown, ctx: ExecutionContext): UserAccess => {
  return ctx.switchToHttp().getRequest().access;
});
