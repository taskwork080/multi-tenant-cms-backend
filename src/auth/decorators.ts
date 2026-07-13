import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import type { AuthUser } from "./auth.types";

export const IS_PUBLIC = "isPublic";
/** Marks a route as reachable without a Bearer token (e.g. health check). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES = "roles";
/** Restricts a route to the given app roles (platform_admin always passes). */
export const Roles = (...roles: string[]) => SetMetadata(ROLES, roles);

/** Injects the verified AuthUser attached by AuthGuard. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
