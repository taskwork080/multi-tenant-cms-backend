import { Controller, Get, Headers, Param, Query } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Public } from "../auth/decorators";
import { publicBrandQuerySchema, publicProductQuerySchema } from "./storefront.schemas";
import { StorefrontService } from "./storefront.service";
import { Throttle } from "@nestjs/throttler";

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
// Tighter than the global ceiling: there is no token here to attribute abuse
// to, only an IP, and every route hits the database.
@Throttle({ default: { ttl: 60_000, limit: 60 } })
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
  @ApiQuery({ name: "q", required: false, description: "Free-text over name, slug, style code and brand" })
  @ApiQuery({ name: "categoryId", required: false })
  @ApiQuery({ name: "categorySlug", required: false })
  @ApiQuery({ name: "subCategoryId", required: false })
  @ApiQuery({ name: "subCategorySlug", required: false })
  @ApiQuery({ name: "brandIds", required: false, description: "Comma-separated brand ids" })
  @ApiQuery({ name: "brands", required: false, description: "Comma-separated brand names" })
  @ApiQuery({ name: "badge", required: false, description: 'One badge label, e.g. "Best Seller"' })
  @ApiQuery({ name: "onSale", required: false, description: "true = only products with an offer price" })
  @ApiQuery({ name: "priceMin", required: false })
  @ApiQuery({ name: "priceMax", required: false })
  @ApiQuery({ name: "sort", required: false, enum: ["pop", "lo", "hi", "new", "discount"] })
  @ApiQuery({ name: "page", required: false, description: "1-based, default 1" })
  @ApiQuery({ name: "pageSize", required: false, description: "1–48, default 24" })
  @ApiOperation({
    summary: "Browse the active catalogue",
    description:
      "Drafts are excluded. Filtering, sorting and paging all happen in SQL. Returns card-sized " +
      "DTOs — brand, category, badges and an inStock boolean, never a stock number, cost or seller.",
  })
  products(@Param("tenant") tenant: string, @Query() query: unknown) {
    return this.storefront.publicProducts(tenant, publicProductQuerySchema.parse(query));
  }

  @Get(":tenant/products/:slug")
  @ApiParam({ name: "tenant", description: "Tenant slug" })
  @ApiParam({ name: "slug", description: "Product slug" })
  @ApiOperation({
    summary: "Get one active product",
    description: "Adds description, gallery, specs, tags, variants and pricing tiers. Drafts are 404.",
  })
  product(@Param("tenant") tenant: string, @Param("slug") slug: string) {
    return this.storefront.publicProduct(tenant, slug);
  }

  @Get(":tenant/categories")
  @ApiParam({ name: "tenant", description: "Tenant slug" })
  @ApiOperation({
    summary: "Active categories, flat and parent-linked",
    description: "Feeds menus, the category bar and static params.",
  })
  categories(@Param("tenant") tenant: string) {
    return this.storefront.publicCategories(tenant);
  }

  @Get(":tenant/brands")
  @ApiParam({ name: "tenant", description: "Tenant slug" })
  @ApiQuery({ name: "categoryId", required: false })
  @ApiQuery({ name: "categorySlug", required: false })
  @ApiQuery({ name: "subCategoryId", required: false })
  @ApiQuery({ name: "subCategorySlug", required: false })
  @ApiOperation({
    summary: "Brand facet counts",
    description: "Scoped to the category being browsed, so a facet never offers an empty result.",
  })
  brands(@Param("tenant") tenant: string, @Query() query: unknown) {
    return this.storefront.publicBrands(tenant, publicBrandQuerySchema.parse(query));
  }

  @Get(":tenant/reviews/:slug")
  @ApiParam({ name: "tenant", description: "Tenant slug" })
  @ApiParam({ name: "slug", description: "Product slug" })
  @ApiOperation({ summary: "Approved reviews for one product", description: "Pending and rejected are invisible." })
  reviews(@Param("tenant") tenant: string, @Param("slug") slug: string) {
    return this.storefront.publicReviews(tenant, slug);
  }

  @Get(":tenant/pages/:slug")
  @ApiParam({ name: "tenant", description: "Tenant slug" })
  @ApiParam({ name: "slug", description: 'Page slug; "home" serves the site root' })
  @ApiOperation({ summary: "Get one published page", description: "Drafts are 404, never 403." })
  page(@Param("tenant") tenant: string, @Param("slug") slug: string) {
    return this.storefront.publicPage(tenant, slug);
  }
}
