import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import { CurrentTenant } from "../tenant/tenant.decorator";
import { TenantGuard } from "../tenant/tenant.guard";
import type { TenantDto } from "../tenant/tenant.service";
import {
  navLocationSchema,
  navUpdateSchema,
  pageCreateSchema,
  pageUpdateSchema,
} from "./storefront.schemas";
import { StorefrontService } from "./storefront.service";

/**
 * Admin-side storefront management.
 *
 * Registered before CrudModule (see app.module.ts): every path here lives
 * under /api/:tenant/storefront/*, which CrudController's `@Get(":resource/:id")`
 * would otherwise swallow.
 *
 * Pages get real handlers rather than a resource-registry entry because their
 * content is jsonb — the generic layer would copy any caller-supplied JSON
 * into a column that gets rendered to anonymous visitors. See the note at the
 * top of storefront.schemas.ts.
 */
@ApiTags("storefront")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@Controller("api/:tenant/storefront")
@UseGuards(TenantGuard)
export class StorefrontController {
  constructor(private readonly storefront: StorefrontService) {}

  // --- Config ---------------------------------------------------------------

  @Get("config")
  @ApiOperation({
    summary: "Get this tenant's storefront config",
    description: "Creates it with defaults (inactive) on first call, so the admin never has to handle a missing row.",
  })
  getConfig(@CurrentTenant() tenant: TenantDto) {
    return this.storefront.getConfig(tenant);
  }

  @Patch("config")
  @ApiOperation({
    summary: "Update storefront config",
    description:
      "Body: { isActive?, customDomain?, theme?, seo? }. theme/seo are merged key-by-key, so a partial save cannot blank untouched fields. A duplicate customDomain returns 409.",
  })
  updateConfig(@CurrentTenant() tenant: TenantDto, @Body() body: unknown) {
    return this.storefront.updateConfig(tenant, body);
  }

  @Get("domain-status")
  @ApiOperation({ summary: "Check whether the saved custom domain resolves to this tenant" })
  domainStatus(@CurrentTenant() tenant: TenantDto) {
    return this.storefront.domainStatus(tenant);
  }

  // --- Navigation -----------------------------------------------------------

  @Get("navigation")
  @ApiQuery({ name: "location", enum: ["header", "footer"], required: false })
  @ApiOperation({ summary: "Get a navigation menu (defaults to header)" })
  getNavigation(@CurrentTenant() tenant: TenantDto, @Query("location") location?: string) {
    return this.storefront.getNavigation(tenant, navLocationSchema.parse(location ?? "header"));
  }

  @Put("navigation")
  @ApiQuery({ name: "location", enum: ["header", "footer"], required: false })
  @ApiOperation({ summary: "Replace a navigation menu", description: "Body: { items: NavItem[] }. One nesting level." })
  setNavigation(@CurrentTenant() tenant: TenantDto, @Body() body: unknown, @Query("location") location?: string) {
    const loc = navLocationSchema.parse(location ?? "header");
    const { items } = navUpdateSchema.parse(body);
    return this.storefront.setNavigation(tenant, loc, items);
  }

  // --- Pages ----------------------------------------------------------------

  @Get("pages")
  @ApiQuery({ name: "q", required: false })
  @ApiQuery({ name: "published", required: false, enum: ["true", "false"] })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiOperation({ summary: "List storefront pages", description: "Returns { data, total, page, pageSize }." })
  listPages(
    @CurrentTenant() tenant: TenantDto,
    @Query() query: { q?: string; published?: string; page?: string; pageSize?: string },
  ) {
    return this.storefront.listPages(tenant, query);
  }

  @Get("pages/:id")
  @ApiOperation({ summary: "Get one storefront page" })
  getPage(@CurrentTenant() tenant: TenantDto, @Param("id") id: string) {
    return this.storefront.getPage(tenant, id);
  }

  @Post("pages")
  @ApiOperation({
    summary: "Create a storefront page",
    description: 'Body: { title, slug, contentBlocks?, isPublished?, metaTitle?, metaDescription?, sortOrder? }. Slug "home" serves the site root; a duplicate slug returns 409.',
  })
  createPage(@CurrentTenant() tenant: TenantDto, @Body() body: unknown) {
    return this.storefront.createPage(tenant, pageCreateSchema.parse(body));
  }

  @Patch("pages/:id")
  @ApiOperation({ summary: "Update a storefront page", description: "Same body as create, all fields optional." })
  updatePage(@CurrentTenant() tenant: TenantDto, @Param("id") id: string, @Body() body: unknown) {
    return this.storefront.updatePage(tenant, id, pageUpdateSchema.parse(body));
  }

  @Post("pages/:id/publish")
  @ApiOperation({ summary: "Publish a page", description: "Stamps published_at on the first publish only." })
  publishPage(@CurrentTenant() tenant: TenantDto, @Param("id") id: string) {
    return this.storefront.updatePage(tenant, id, { isPublished: true });
  }

  @Post("pages/:id/unpublish")
  @ApiOperation({ summary: "Unpublish a page", description: "Removes it from the public storefront immediately." })
  unpublishPage(@CurrentTenant() tenant: TenantDto, @Param("id") id: string) {
    return this.storefront.updatePage(tenant, id, { isPublished: false });
  }

  @Delete("pages/:id")
  @ApiOperation({ summary: "Delete a storefront page" })
  deletePage(@CurrentTenant() tenant: TenantDto, @Param("id") id: string) {
    return this.storefront.deletePage(tenant, id);
  }
}
