import { Controller, Get, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import { parseDateWindow } from "../common/date-window";
import { CurrentTenant } from "../tenant/tenant.decorator";
import type { TenantDto } from "../tenant/tenant.service";
import { DashboardService, type Period } from "./dashboard.service";
import { RequireModule } from "../tenant/module.decorator";

const PERIODS = new Set<Period>(["7", "30", "all"]);

/** Postgres rejects a non-uuid compared against a uuid column, so junk in the
 *  query string must be dropped here rather than reaching the driver as a 500. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Aggregated stats backing the dashboard page (stat cards + charts + widgets). */
@ApiTags("dashboard")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@RequireModule("dashboard")
@Controller("api/:tenant/dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @ApiOperation({
    summary: "Dashboard KPIs, period-over-period comparison, daily series and widget data",
  })
  @ApiQuery({
    name: "period",
    required: false,
    enum: ["7", "30", "all"],
    description: "Window in days (default 30). Ignored when from/to are given.",
  })
  @ApiQuery({ name: "from", required: false, description: "ISO start of an explicit window; overrides `period`" })
  @ApiQuery({ name: "to", required: false, description: "ISO end of an explicit window (inclusive)" })
  @ApiQuery({
    name: "warehouseId",
    required: false,
    description: "Narrow a warehouse workspace to one site. Ignored by commerce workspaces.",
  })
  async stats(
    @CurrentTenant() tenant: TenantDto,
    @Query("period") period?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("warehouseId") warehouseId?: string,
  ) {
    const p = (PERIODS.has(period as Period) ? period : "30") as Period;
    const site = warehouseId && UUID.test(warehouseId) ? warehouseId : null;
    return this.dashboard.stats(tenant, p, parseDateWindow(from, to), site);
  }
}
