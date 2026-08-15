import { Controller, Get } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { CurrentTenant } from "../tenant/tenant.decorator";
import type { TenantDto } from "../tenant/tenant.service";
import { AlertsService } from "./alerts.service";

/** Badge counts for the app chrome (low stock, unread messages). */
@ApiTags("alerts")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@Controller("api/:tenant/alerts")
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  @ApiOperation({
    summary: "Topbar alert badges",
    description:
      "Low-stock batch count with a 5-row sample, and unread message count with an 8-thread sample.",
  })
  async get(@CurrentTenant() tenant: TenantDto) {
    return this.alerts.alerts(tenant);
  }
}
