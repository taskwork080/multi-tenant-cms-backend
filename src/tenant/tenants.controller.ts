import { BadRequestException, Body, Controller, Get, Param, Patch } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { RequireCapability, Roles } from "../auth/decorators";
import { PLATFORM_ADMIN } from "../auth/roles";
import { configFieldsOutsideType } from "../platform/module-presets";
import { CurrentTenant } from "./tenant.decorator";
import { TenantService, type TenantDto } from "./tenant.service";

const configSchema = z
  .object({
    defaultLanguage: z.enum(["en", "bn"]).optional(),
    currency: z.string().optional(),
    currencySymbol: z.string().optional(),
    ga4Id: z.string().optional(),
    pixelId: z.string().optional(),
    strictOrderFlow: z.boolean().optional(),
    defaultSellerName: z.string().optional(),
    locationServiceOn: z.boolean().optional(),
    codEnabled: z.boolean().optional(),
    allowForceDeleteCategory: z.boolean().optional(),
    cordNo: z.string().optional(),
  })
  .strict();

/**
 * What a workspace may change about ITSELF.
 *
 * `entitlements` and `type` are deliberately absent, and their absence is the
 * point. They used to be here, on a route guarded only by @Roles("owner",
 * "admin") — so any tenant owner could unlock any module for their own
 * workspace, silently, and without the audit row the platform path writes.
 * Entitlements are the platform's product boundary (a warehouse workspace does
 * not get a storefront), which makes them the one thing the workspace must not
 * decide. They now move only through PATCH /api/admin/tenants/:id: platform
 * admin only, checked against the vertical's ceiling, and audited.
 *
 * `type` goes with them for the same reason — it *selects* the ceiling, so a
 * workspace able to change its own type could reach any module in two steps.
 */
const tenantPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    region: z.string().optional(),
    theme: z.object({ brand: z.string(), brandFg: z.string() }).partial().optional(),
    config: configSchema.optional(),
  })
  .strict();

@ApiTags("tenants")
@ApiBearerAuth()
@Controller("api/tenants")
export class TenantsController {
  constructor(private readonly tenants: TenantService) {}

  @Get()
  @Roles(PLATFORM_ADMIN)
  @ApiOperation({ summary: "List all tenants (platform admin only)" })
  list() {
    return this.tenants.list();
  }

  // NOTE: creation lives at POST /api/admin/tenants (PlatformTenantsService).
  // The duplicate POST that used to sit here re-implemented the preset logic,
  // skipped the vertical ceiling check and wrote no audit row — so it was
  // removed rather than kept in sync. There is one way to make a workspace.

  @Get(":tenant")
  @ApiParam({ name: "tenant", description: "Tenant slug" })
  @ApiOperation({ summary: "Get a tenant (config + entitlements) — members only" })
  get(@Param("tenant") slug: string) {
    return this.tenants.bySlug(slug);
  }

  @Patch(":tenant")
  // Both tenant roles, because @RequireCapability is the real gate here: the
  // `admin` app role used to carry this and it meant nothing the Role could not
  // say. A staff member reaches it iff their Role grants settings.manage.
  @Roles("owner", "staff")
  @RequireCapability("settings.manage")
  @ApiParam({ name: "tenant", description: "Tenant slug" })
  @ApiOperation({
    summary: "Update this workspace's own name, region, theme and config",
    description:
      "Entitlements and type are not editable here — they are platform-admin only, " +
      "via PATCH /api/admin/tenants/:id.",
  })
  update(@CurrentTenant() tenant: TenantDto, @Param("tenant") slug: string, @Body() body: unknown) {
    const input = tenantPatchSchema.parse(body);
    // A warehouse workspace has no storefront, so `codEnabled` / `ga4Id` /
    // `pixelId` and friends describe nothing it can do. Rejecting them keeps
    // the stored config honest instead of accumulating settings that are read
    // by no code path for this vertical.
    if (input.config) {
      const outside = configFieldsOutsideType(tenant.type, input.config);
      if (outside.length) {
        throw new BadRequestException({
          message: `A "${tenant.type}" workspace has no ${outside.join(", ")} setting.`,
          code: "CONFIG_OUTSIDE_TYPE",
          outside,
        });
      }
    }
    return this.tenants.update(slug, input);
  }
}
