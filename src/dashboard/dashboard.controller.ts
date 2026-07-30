import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import { CurrentTenant } from "../tenant/tenant.decorator";
import { TenantGuard } from "../tenant/tenant.guard";
import type { TenantDto } from "../tenant/tenant.service";
import { DashboardService, type Period } from "./dashboard.service";

const PERIODS = new Set<Period>(["7", "30", "all"]);

/** Aggregated stats backing the dashboard page (stat cards + charts + widgets). */
@ApiTags("dashboard")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@Controller("api/:tenant/dashboard")
@UseGuards(TenantGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @ApiOperation({
    summary: "Dashboard KPIs, period-over-period comparison, daily series and widget data",
  })
  @ApiQuery({ name: "period", required: false, enum: ["7", "30", "all"], description: "Window in days (default 30)" })
  async stats(@CurrentTenant() tenant: TenantDto, @Query("period") period?: string) {
    const p = (PERIODS.has(period as Period) ? period : "30") as Period;
    return this.dashboard.stats(tenant, p);
  }
}
