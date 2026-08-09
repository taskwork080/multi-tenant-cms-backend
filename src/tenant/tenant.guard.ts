import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { AuthUser, PLATFORM_ADMIN } from "../auth/auth.types";
import { TenantService, TenantDto } from "./tenant.service";

export type TenantRequest = Request & { user: AuthUser; tenant: TenantDto };

/**
 * Resolves the `:tenant` slug in the route to a tenant row and verifies the
 * authenticated user belongs to that tenant (platform admins pass for any).
 * Attaches the tenant to the request for controllers to consume.
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
  constructor(private readonly tenantService: TenantService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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
