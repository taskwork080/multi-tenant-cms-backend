import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { Roles } from "../auth/decorators";
import { RESERVED_TENANT_SLUGS } from "../platform/dto";
import { MODULE_KEYS, TENANT_TYPES, presetFor } from "../platform/module-presets";
import { TenantGuard } from "./tenant.guard";
import { TenantService } from "./tenant.service";

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

const tenantPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    type: z.enum(TENANT_TYPES).optional(),
    region: z.string().optional(),
    theme: z.object({ brand: z.string(), brandFg: z.string() }).partial().optional(),
    // Same closed set as the platform surface (src/platform/dto.ts) — if only
    // one side validated, a tenant owner could write modules a platform admin
    // could not.
    entitlements: z.array(z.enum(MODULE_KEYS)).optional(),
    config: configSchema.optional(),
  })
  .strict();

const tenantCreateSchema = tenantPatchSchema.extend({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/)
    // A tenant named "admin" would make /api/admin/users ambiguous with the
    // platform routes; the others shadow top-level API paths the same way.
    .refine((s) => !RESERVED_TENANT_SLUGS.has(s), "That slug is reserved by the platform"),
  name: z.string().min(1),
  type: z.enum(TENANT_TYPES),
});

@ApiTags("tenants")
@ApiBearerAuth()
@Controller("api/tenants")
export class TenantsController {
  constructor(private readonly tenants: TenantService) {}

  @Get()
  @Roles("platform_admin")
  @ApiOperation({ summary: "List all tenants (platform admin only)" })
  list() {
    return this.tenants.list();
  }

  @Post()
  @Roles("platform_admin")
  @ApiOperation({ summary: "Create a tenant (platform admin only)" })
  @ApiBody({ description: "Tenant shape: { slug, name, type, region?, theme?, entitlements?, config? }" })
  create(@Body() body: unknown) {
    const input = tenantCreateSchema.parse(body);
    // No entitlements given => start from the preset for this tenant type
    // rather than a workspace with an empty sidebar.
    return this.tenants.create({ ...input, entitlements: input.entitlements ?? presetFor(input.type) });
  }

  @Get(":tenant")
  @UseGuards(TenantGuard)
  @ApiParam({ name: "tenant", description: "Tenant slug" })
  @ApiOperation({ summary: "Get a tenant (config + entitlements) — members only" })
  get(@Param("tenant") slug: string) {
    return this.tenants.bySlug(slug);
  }

  @Patch(":tenant")
  @UseGuards(TenantGuard)
  @Roles("owner", "admin")
  @ApiParam({ name: "tenant", description: "Tenant slug" })
  @ApiOperation({ summary: "Update tenant config / entitlements / theme (owner or admin)" })
  update(@Param("tenant") slug: string, @Body() body: unknown) {
    return this.tenants.update(slug, tenantPatchSchema.parse(body));
  }
}
