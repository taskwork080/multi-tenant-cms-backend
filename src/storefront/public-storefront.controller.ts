import { Controller, Get, Headers, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Public } from "../auth/decorators";
import { StorefrontService } from "./storefront.service";

/**
 * The anonymous read API behind every public storefront.
 *
 * Three things make this controller different from every other one here, and
 * all three are deliberate:
 *
 *  1. `@Public()` — no Bearer token. These responses are served to the open
 *     internet, so a leak here is public, not merely cross-tenant.
 *  2. No `TenantGuard` — it authorises a *user* against a tenant and needs
 *     req.user, which does not exist for a shopper. The tenant is resolved
 *     from the host/slug instead, then every read still runs inside
 *     TenantDb.forTenant.
 *  3. Nothing returns a raw row. Each response is an explicit DTO built in
 *     StorefrontService, so adding a column to a storefront table can never
 *     silently publish it.
 *
 * Unknown tenant, disabled storefront and revoked module all answer with the
 * same 404 "Store unavailable" — anything else lets a caller enumerate the
 * platform's tenants.
 *
 * Registered before CrudModule: /api/public/storefront/... would otherwise be
 * matched by /api/:tenant/:resource with tenant="public".
 */
@ApiTags("storefront-public")
@Public()
@Controller("api/public/storefront")
export class PublicStorefrontController {
  constructor(private readonly storefront: StorefrontService) {}

  @Get("resolve")
  @ApiQuery({ name: "host", required: false, description: "Host header of the incoming public request" })
  @ApiQuery({ name: "slug", required: false, description: "Explicit tenant slug (path-prefix routing)" })
  @ApiOperation({
    summary: "Resolve a host or slug to a live storefront",
    description:
      "Tries custom domain, then platform subdomain, then the slug. 404 if the storefront is not live. The X-Forwarded-Host / Host header is used when no host query param is given.",
  })
  resolve(
    @Query("host") host?: string,
    @Query("slug") slug?: string,
    @Headers("x-forwarded-host") forwardedHost?: string,
    @Headers("host") requestHost?: string,
  ) {
    return this.storefront.resolve(host ?? forwardedHost ?? requestHost, slug);
  }

  @Get(":tenant/site")
  @ApiParam({ name: "tenant", description: "Tenant slug" })
  @ApiOperation({
    summary: "Theme, SEO, navigation and published page list",
    description: "Everything the storefront shell needs, in one round trip.",
  })
  site(@Param("tenant") tenant: string) {
    return this.storefront.publicSite(tenant);
  }

  @Get(":tenant/sitemap")
  @ApiParam({ name: "tenant", description: "Tenant slug" })
  @ApiOperation({ summary: "Published slugs + last-modified, for sitemap.xml and static generation" })
  sitemap(@Param("tenant") tenant: string) {
    return this.storefront.publicSitemap(tenant);
  }

  @Get(":tenant/products")
  @ApiParam({ name: "tenant", description: "Tenant slug" })
  @ApiQuery({ name: "categoryId", required: false })
  @ApiQuery({ name: "limit", required: false, description: "1–24, default 8" })
  @ApiOperation({
    summary: "Active products for the storefront's product grid",
    description: "Drafts are excluded. Returns a card-sized DTO — no stock, cost or seller data.",
  })
  products(
    @Param("tenant") tenant: string,
    @Query("categoryId") categoryId?: string,
    @Query("limit") limit?: string,
  ) {
    return this.storefront.publicProducts(tenant, {
      categoryId: categoryId || undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get(":tenant/pages/:slug")
  @ApiParam({ name: "tenant", description: "Tenant slug" })
  @ApiParam({ name: "slug", description: 'Page slug; "home" serves the site root' })
  @ApiOperation({ summary: "Get one published page", description: "Drafts are 404, never 403." })
  page(@Param("tenant") tenant: string, @Param("slug") slug: string) {
    return this.storefront.publicPage(tenant, slug);
  }
}
