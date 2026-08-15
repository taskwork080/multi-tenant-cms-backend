import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import type { AuthUser } from "./auth.types";
import type { UserAccess } from "./access.service";

export const IS_PUBLIC = "isPublic";
/** Marks a route as reachable without a Bearer token (e.g. health check). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

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
