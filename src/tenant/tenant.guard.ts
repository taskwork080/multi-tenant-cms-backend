import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { AuthUser, PLATFORM_ADMIN } from "../auth/auth.types";
import { IS_PUBLIC } from "../auth/decorators";
import { TenantService, TenantDto } from "./tenant.service";

export type TenantRequest = Request & { user: AuthUser; tenant: TenantDto };

/**
 * Resolves the `:tenant` slug in the route to a tenant row and verifies the
 * authenticated user belongs to that tenant (platform admins pass for any).
 * Attaches the tenant to the request for controllers to consume.
 *
 * Registered globally (auth.module.ts) rather than per-controller. It no-ops on
 * routes without a `:tenant` param, so being global is additive — and it
 * removes the failure mode where a new tenant-scoped controller simply forgets
 * `@UseGuards(TenantGuard)` and ships unprotected. EntitlementGuard and
 * AccessGuard both depend on `req.tenant` being populated by then.
 *
 * Also enforces the workspace lifecycle: a suspended or archived workspace is
 * closed to its own members. Platform admins still get in BY DESIGN — repair
 * work on a suspended workspace is exactly why the state exists.
 *
 * TIMING CAVEAT: TenantService.bySlug caches for 30s per process, so a status
 * change can take up to that long to take effect on an instance that did not
 * serve the write. Suspension is an administrative action, not a defence
 * against an attacker mid-session, so the window is accepted. Note also that
 * suspending does not invalidate anyone's existing token — enforcement happens
 * here, on their next request.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly tenantService: TenantService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // The public storefront routes are @Public() *and* carry a :tenant param.
    // They deliberately resolve the tenant themselves, answering a uniform
    // "Store unavailable" 404 for unknown slug / disabled site / revoked
    // module — running this guard first would leak the difference as a 403.
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }

    const req = context.switchToHttp().getRequest<TenantRequest>();
    const slug = typeof req.params.tenant === "string" ? req.params.tenant : undefined;
    if (!slug) return true; // route is not tenant-scoped

    const tenant = await this.tenantService.bySlug(slug);
    const user = req.user;
    if (user.role !== PLATFORM_ADMIN) {
      if (user.tenantId !== tenant.id) {
        throw new ForbiddenException("You do not have access to this tenant");
      }
      if (tenant.status !== "active") {
        throw new ForbiddenException({
          message:
            tenant.status === "archived"
              ? "This workspace has been archived."
              : "This workspace is suspended. Contact your platform administrator.",
          code: "TENANT_SUSPENDED",
          status: tenant.status,
        });
      }
    }
    req.tenant = tenant;
    return true;
  }
}
