import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { AuthUser, PLATFORM_ADMIN } from "../auth/auth.types";
import { TenantService, TenantDto } from "./tenant.service";

export type TenantRequest = Request & { user: AuthUser; tenant: TenantDto };

/**
 * Resolves the `:tenant` slug in the route to a tenant row and verifies the
 * authenticated user belongs to that tenant (platform admins pass for any).
 * Attaches the tenant to the request for controllers to consume.
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
    if (user.role !== PLATFORM_ADMIN && user.tenantId !== tenant.id) {
      throw new ForbiddenException("You do not have access to this tenant");
    }
    req.tenant = tenant;
    return true;
  }
}
