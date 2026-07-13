import { Global, Module } from "@nestjs/common";
import { TenantGuard } from "./tenant.guard";
import { TenantService } from "./tenant.service";
import { TenantsController } from "./tenants.controller";

@Global()
@Module({
  controllers: [TenantsController],
  providers: [TenantService, TenantGuard],
  exports: [TenantService, TenantGuard],
})
export class TenantModule {}
