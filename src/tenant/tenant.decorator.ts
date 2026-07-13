import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { TenantDto } from "./tenant.service";

/** Injects the tenant resolved by TenantGuard from the :tenant route param. */
export const CurrentTenant = createParamDecorator((_: unknown, ctx: ExecutionContext): TenantDto => {
  return ctx.switchToHttp().getRequest().tenant;
});
