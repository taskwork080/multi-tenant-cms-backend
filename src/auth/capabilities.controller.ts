import { Controller, Get } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { CurrentTenant } from "../tenant/tenant.decorator";
import type { TenantDto } from "../tenant/tenant.service";
import { capabilitiesFor, type Capability } from "./capabilities";

/**
 * The capability vocabulary this workspace's roles may be built from.
 *
 * Served rather than mirrored: the frontend used to hardcode its own list, so
 * a warehouse tenant's role editor offered "Manage discounts" and nothing at
 * all for receiving, counting or packing. Filtering by the tenant's
 * entitlements here is what makes the role editor vertical-aware without the
 * frontend knowing anything about verticals.
 */
@ApiTags("auth")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@Controller("api/:tenant/capabilities")
export class CapabilitiesController {
  @Get()
  @ApiOperation({ summary: "Capabilities a role in this workspace can grant, grouped for the role editor" })
  list(@CurrentTenant() tenant: TenantDto): { data: Capability[]; groups: string[] } {
    const data = capabilitiesFor(tenant.entitlements);
    return { data, groups: Array.from(new Set(data.map((c) => c.group))) };
  }
}
