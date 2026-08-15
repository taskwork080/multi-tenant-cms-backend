import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { REQUIRED_MODULES } from "./module.decorator";
import type { TenantDto } from "./tenant.service";

/**
 * Enforces @RequireModule against the tenant resolved by TenantGuard.
 *
 * The message is byte-identical to the one CrudService.resolve throws so the
 * frontend keeps handling a locked module in one place, whichever surface
 * produced it.
 */
@Injectable()
export class EntitlementGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_MODULES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const req = context.switchToHttp().getRequest<Request & { tenant?: TenantDto }>();
    const tenant = req.tenant;
    if (!tenant) return true; // not a tenant-scoped request; nothing to check

    assertEntitled(tenant, required);
    return true;
  }
}

/** Shared with the bespoke services that check entitlements inline. */
export function assertEntitled(tenant: TenantDto, required: readonly string[]) {
  const missing = required.find((m) => !tenant.entitlements.includes(m));
  if (missing) {
    throw new ForbiddenException(`Module "${missing}" is not enabled for this tenant`);
  }
}
