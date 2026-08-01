import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import { CurrentTenant } from "../tenant/tenant.decorator";
import { TenantGuard } from "../tenant/tenant.guard";
import type { TenantDto } from "../tenant/tenant.service";
import { SearchService, type SearchHit } from "./search.service";

/**
 * Global search backing the admin's ⌘K palette.
 *
 * NOTE: this module must be registered before CrudModule in app.module.ts —
 * otherwise `/api/:tenant/search` is swallowed by the generic
 * `/api/:tenant/:resource` catch-all and 404s as an unknown resource.
 */
@ApiTags("search")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@Controller("api/:tenant/search")
@UseGuards(TenantGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @ApiOperation({ summary: "Global search across products, orders, customers and lookups" })
  @ApiQuery({ name: "q", required: true, description: "Search term" })
  @ApiQuery({ name: "perType", required: false, description: "Max hits per resource (default 4)" })
  async run(
    @CurrentTenant() tenant: TenantDto,
    @Query("q") q?: string,
    @Query("perType") perType?: string,
  ): Promise<SearchHit[]> {
    const n = Math.min(20, Math.max(1, parseInt(perType ?? "4", 10) || 4));
    return this.search.search(tenant, q ?? "", n);
  }
}
