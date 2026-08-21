import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/db.tokens";
import { TenantDb } from "../db/tenant-db.service";
import {
  brands,
  categories,
  DEFAULT_STOREFRONT_SEO,
  DEFAULT_STOREFRONT_THEME,
  inventoryLevels,
  orderItems,
  orders,
  productBadges,
  productImages,
  productPricingTiers,
  products,
  productSpecs,
  productTags,
  productVariants,
  reviews,
  skus,
  storefrontConfigs,
  storefrontDeliveryZones,
  storefrontNavigation,
  storefrontPages,
  storefrontPaymentMethods,
  type ContentBlock,
  type NavItem,
  type StorefrontSeo,
  type StorefrontTheme,
} from "../db/schema";
import { TenantService, type TenantDto } from "../tenant/tenant.service";
import { assertEntitled as assertEntitledTo } from "../tenant/entitlement.guard";
import {
  configUpdateSchema,
  customDomainSchema,
  HOME_SLUG,
  type ConfigUpdateInput,
  type NavLocation,
  type PageCreateInput,
  type PageUpdateInput,
  type PublicBrandQuery,
  type PublicProductQuery,
} from "./storefront.schemas";

/**
 * Entitlement key gating the public storefront.
 *
 * Was "cms", which made one key mean two different things: whether the tenant
 * can edit content inside the admin, AND whether a public website exists at
 * all. schema.ts already flagged the conflation. A workspace that wanted
 * internal CMS blocks but no public site could not have one, and a warehouse
 * tenant given "cms" for internal content silently acquired a storefront.
 *
 * drizzle/0012_storefront_module.sql backfills this key for every tenant that
 * already held "cms", so the split changes nothing for existing workspaces.
 */
const STOREFRONT_MODULE = "storefront";

type ConfigRow = typeof storefrontConfigs.$inferSelect;
type PageRow = typeof storefrontPages.$inferSelect;

export interface StorefrontConfigDto {
  id: string;
  isActive: boolean;
  customDomain: string | null;
  theme: StorefrontTheme;
  seo: StorefrontSeo;
  createdAt: Date;
  updatedAt: Date;
}

/** What an anonymous visitor is allowed to see. Deliberately not the full row. */
export interface PublicSiteDto {
  tenantSlug: string;
  tenantName: string;
  currency: string;
  currencySymbol: string;
  theme: StorefrontTheme;
  seo: StorefrontSeo;
  navigation: { header: NavItem[]; footer: NavItem[] };
  pages: { slug: string; title: string }[];
  /**
   * What checkout charges. Served with the shell so the storefront can render
   * its payment options and quote delivery without a second round trip — and
   * so those figures come from the shop's configuration rather than being
   * hard-coded in the storefront the way they used to be.
   */
  commerce: {
    deliveryZones: { name: string; district: string | null; fee: number }[];
    paymentMethods: {
      code: string;
      label: string;
      description: string;
      feePct: number;
      skipsDelivery: boolean;
      payOnDelivery: boolean;
    }[];
  };
}

/** The catalogue fields a storefront product card needs — nothing else. */
export interface PublicProductDto {
  id: string;
  name: string;
  slug: string;
  price: number;
  offerPrice: number | null;
  imageUrl: string | null;
  brand: string | null;
  categoryName: string | null;
  categorySlug: string | null;
  badges: string[];
  /**
   * Mean of the approved reviews, to one decimal. Null when there are none —
   * distinct from a genuine 0, and the difference matters: a storefront that
   * renders "0.0 ★" on every new product looks broken and sells nothing.
   */
  rating: number | null;
  reviewCount: number;
  /** Units sold across orders that were not cancelled. */
  sold: number;
  /**
   * Deliberately a boolean.
   *
   * `products.stock` is a denormalised counter that drifts from
   * inventory_levels, and the real figure is competitive information. A shopper
   * only ever needs to know whether they can buy it.
   */
  inStock: boolean;
}

export interface PublicProductListDto {
  items: PublicProductDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PublicProductDetailDto extends PublicProductDto {
  shortDescription: string | null;
  description: string | null;
  subCategoryName: string | null;
  subCategorySlug: string | null;
  videoUrl: string | null;
  unit: string;
  minOrderQty: number;
  maxOrderQty: number | null;
  images: string[];
  specs: { label: string; value: string }[];
  tags: string[];
  variants: {
    id: string;
    label: string;
    type: string;
    price: number;
    originalPrice: number | null;
    badge: string | null;
  }[];
  pricingTiers: { minQty: number; unitPrice: number }[];
}

export interface PublicCategoryDto {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  level: number;
  /** Active products filed directly under this category. */
  productCount: number;
}

export interface PublicBrandDto {
  id: string;
  name: string;
  productCount: number;
}

export interface PublicReviewDto {
  id: string;
  author: string;
  rating: number;
  comment: string;
  createdAt: Date;
}

export interface PublicPageDto {
  title: string;
  slug: string;
  contentBlocks: ContentBlock[];
  metaTitle: string | null;
  metaDescription: string | null;
  publishedAt: Date | null;
  updatedAt: Date;
}

@Injectable()
export class StorefrontService {
  /** host -> tenant slug. Hit on every anonymous request; see resolveHost. */
  private domainCache = new Map<string, { slug: string; at: number }>();
  private static TTL_MS = 30_000;

  constructor(
    private readonly tdb: TenantDb,
    private readonly tenants: TenantService,
    private readonly config: ConfigService,
  ) {}

  // -------------------------------------------------------------------------
  // Guards
  // -------------------------------------------------------------------------

  /**
   * Kept even though StorefrontController now carries
   * `@RequireModule("cms")`, because these methods are also reachable from
   * assertLive() on the *public* path, which has no guard by design. The guard
   * covers the admin surface; this covers the service. Same error either way.
   */
  private assertEntitled(tenant: TenantDto) {
    assertEntitledTo(tenant, [STOREFRONT_MODULE]);
  }

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  private toConfigDto(row: ConfigRow): StorefrontConfigDto {
    return {
      id: row.id,
      isActive: row.isActive,
      customDomain: row.customDomain,
      theme: row.theme,
      seo: row.seo,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Get-or-create. A tenant that has never opened the manager has no row, and
   * making the admin handle "no config yet" everywhere buys nothing — the
   * defaults are the config. Created inactive: turning a storefront on is
   * always an explicit act.
   */
  async getConfig(tenant: TenantDto): Promise<StorefrontConfigDto> {
    this.assertEntitled(tenant);
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [existing] = await tx
        .select()
        .from(storefrontConfigs)
        .where(eq(storefrontConfigs.tenantId, tenant.id))
        .limit(1);
      if (existing) return this.toConfigDto(existing);

      const [created] = await tx
        .insert(storefrontConfigs)
        .values({ tenantId: tenant.id })
        .onConflictDoNothing({ target: storefrontConfigs.tenantId })
        .returning();
      // onConflictDoNothing returns nothing when a concurrent request won the
      // race — re-read rather than throwing at the user.
      if (created) return this.toConfigDto(created);
      const [raced] = await tx
        .select()
        .from(storefrontConfigs)
        .where(eq(storefrontConfigs.tenantId, tenant.id))
        .limit(1);
      return this.toConfigDto(raced);
    });
  }

  /**
   * Strips what people paste out of a browser bar — scheme, path, port,
   * trailing dot — so "https://Shop.Example.com/" and "shop.example.com" don't
   * become two different domains, only one of which resolves.
   */
  private normalizeDomain(raw: string): string {
    return raw
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/:\d+$/, "")
      .replace(/\.$/, "");
  }

  /** Comma-separated hosts whose subdomains map to tenant slugs. */
  private rootDomains(): string[] {
    return (this.config.get<string>("STOREFRONT_ROOT_DOMAIN") ?? "")
      .split(",")
      .map((d) => this.normalizeDomain(d))
      .filter(Boolean);
  }

  private validateCustomDomain(raw: string): string {
    const domain = this.normalizeDomain(raw);
    const parsed = customDomainSchema.safeParse(domain);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0].message);
    if (domain === "localhost" || domain.endsWith(".localhost")) {
      throw new BadRequestException("localhost cannot be used as a custom domain");
    }
    // A custom domain under the platform's own root would shadow subdomain
    // resolution and let one tenant claim another's subdomain.
    for (const root of this.rootDomains()) {
      if (domain === root || domain.endsWith(`.${root}`)) {
        throw new BadRequestException(`${domain} is a platform domain — use the tenant subdomain instead`);
      }
    }
    return domain;
  }

  async updateConfig(tenant: TenantDto, body: unknown): Promise<StorefrontConfigDto> {
    this.assertEntitled(tenant);
    const input: ConfigUpdateInput = configUpdateSchema.parse(body);
    const current = await this.getConfig(tenant);

    const patch: Partial<typeof storefrontConfigs.$inferInsert> = { updatedAt: new Date() };
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (input.customDomain !== undefined) {
      patch.customDomain =
        input.customDomain === null || input.customDomain.trim() === ""
          ? null
          : this.validateCustomDomain(input.customDomain);
    }
    // Theme and SEO are patched key-by-key onto the stored object, so a partial
    // save can't blank the fields it didn't send.
    if (input.theme) patch.theme = { ...DEFAULT_STOREFRONT_THEME, ...current.theme, ...input.theme };
    if (input.seo) patch.seo = { ...DEFAULT_STOREFRONT_SEO, ...current.seo, ...input.seo };

    const updated = await this.tdb.forTenant(tenant.id, async (tx) => {
      const [row] = await tx
        .update(storefrontConfigs)
        .set(patch)
        .where(eq(storefrontConfigs.tenantId, tenant.id))
        .returning();
      return row;
    });

    // A domain or activation change must not be served from a stale cache.
    this.domainCache.clear();
    return this.toConfigDto(updated);
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  async getNavigation(tenant: TenantDto, location: NavLocation): Promise<{ location: NavLocation; items: NavItem[] }> {
    this.assertEntitled(tenant);
    const items = await this.tdb.forTenant(tenant.id, async (tx) => {
      const [row] = await tx
        .select()
        .from(storefrontNavigation)
        .where(and(eq(storefrontNavigation.tenantId, tenant.id), eq(storefrontNavigation.location, location)))
        .limit(1);
      return row?.items ?? [];
    });
    return { location, items };
  }

  async setNavigation(
    tenant: TenantDto,
    location: NavLocation,
    items: NavItem[],
  ): Promise<{ location: NavLocation; items: NavItem[] }> {
    this.assertEntitled(tenant);
    const saved = await this.tdb.forTenant(tenant.id, async (tx) => {
      const [row] = await tx
        .insert(storefrontNavigation)
        .values({ tenantId: tenant.id, location, items })
        .onConflictDoUpdate({
          target: [storefrontNavigation.tenantId, storefrontNavigation.location],
          set: { items, updatedAt: new Date() },
        })
        .returning();
      return row.items;
    });
    return { location, items: saved };
  }

  // -------------------------------------------------------------------------
  // Pages (admin)
  // -------------------------------------------------------------------------

  async listPages(tenant: TenantDto, query: { q?: string; page?: string; pageSize?: string; published?: string }) {
    this.assertEntitled(tenant);
    const pageNo = Math.max(1, parseInt(query.page ?? "1", 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(query.pageSize ?? "50", 10) || 50));

    const filters = [eq(storefrontPages.tenantId, tenant.id)];
    if (query.q) {
      filters.push(or(ilike(storefrontPages.title, `%${query.q}%`), ilike(storefrontPages.slug, `%${query.q}%`))!);
    }
    if (query.published === "true") filters.push(eq(storefrontPages.isPublished, true));
    if (query.published === "false") filters.push(eq(storefrontPages.isPublished, false));

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const where = and(...filters);
      const [rows, [{ total }]] = await Promise.all([
        tx
          .select()
          .from(storefrontPages)
          .where(where)
          .orderBy(asc(storefrontPages.sortOrder), asc(storefrontPages.title), asc(storefrontPages.id))
          .limit(pageSize)
          .offset((pageNo - 1) * pageSize),
        tx.select({ total: count() }).from(storefrontPages).where(where),
      ]);
      return { data: rows, total, page: pageNo, pageSize };
    });
  }

  async getPage(tenant: TenantDto, id: string): Promise<PageRow> {
    this.assertEntitled(tenant);
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [row] = await tx
        .select()
        .from(storefrontPages)
        .where(and(eq(storefrontPages.id, id), eq(storefrontPages.tenantId, tenant.id)))
        .limit(1);
      if (!row) throw new NotFoundException(`storefront page ${id} not found`);
      return row;
    });
  }

  async createPage(tenant: TenantDto, input: PageCreateInput): Promise<PageRow> {
    this.assertEntitled(tenant);
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [row] = await tx
        .insert(storefrontPages)
        .values({
          tenantId: tenant.id,
          title: input.title,
          slug: input.slug,
          contentBlocks: input.contentBlocks as ContentBlock[],
          isPublished: input.isPublished,
          metaTitle: input.metaTitle,
          metaDescription: input.metaDescription,
          sortOrder: input.sortOrder,
          publishedAt: input.isPublished ? new Date() : null,
        })
        .returning();
      return row;
    });
  }

  async updatePage(tenant: TenantDto, id: string, input: PageUpdateInput): Promise<PageRow> {
    this.assertEntitled(tenant);
    const existing = await this.getPage(tenant, id);

    const patch: Partial<typeof storefrontPages.$inferInsert> = { updatedAt: new Date() };
    if (input.title !== undefined) patch.title = input.title;
    if (input.slug !== undefined) patch.slug = input.slug;
    if (input.contentBlocks !== undefined) patch.contentBlocks = input.contentBlocks as ContentBlock[];
    if (input.metaTitle !== undefined) patch.metaTitle = input.metaTitle;
    if (input.metaDescription !== undefined) patch.metaDescription = input.metaDescription;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    if (input.isPublished !== undefined) {
      patch.isPublished = input.isPublished;
      // Stamped once, on the first publish ever — keyed off publishedAt, not
      // isPublished, so an unpublish/republish cycle doesn't reset the date
      // and make the page look newly written.
      if (input.isPublished && existing.publishedAt === null) patch.publishedAt = new Date();
    }

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [row] = await tx
        .update(storefrontPages)
        .set(patch)
        .where(and(eq(storefrontPages.id, id), eq(storefrontPages.tenantId, tenant.id)))
        .returning();
      if (!row) throw new NotFoundException(`storefront page ${id} not found`);
      return row;
    });
  }

  async deletePage(tenant: TenantDto, id: string): Promise<{ id: string; deleted: true }> {
    this.assertEntitled(tenant);
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [row] = await tx
        .delete(storefrontPages)
        .where(and(eq(storefrontPages.id, id), eq(storefrontPages.tenantId, tenant.id)))
        .returning({ id: storefrontPages.id });
      if (!row) throw new NotFoundException(`storefront page ${id} not found`);
      return { id: row.id, deleted: true as const };
    });
  }

  // -------------------------------------------------------------------------
  // Public reads
  // -------------------------------------------------------------------------

  /**
   * Host -> tenant slug, in the order a request can identify itself:
   *   1. custom domain   shop.acme.com
   *   2. subdomain       acme.storefronts.example.com
   *   3. explicit slug   /s/acme  (dev, and the fallback everywhere)
   *
   * Returns null rather than throwing so callers decide the response — every
   * public failure answers the same way, see assertLive.
   */
  private async resolveHost(host: string | undefined, slugParam: string | undefined): Promise<string | null> {
    const h = host ? this.normalizeDomain(host) : "";

    if (h) {
      const hit = this.domainCache.get(h);
      if (hit && Date.now() - hit.at < StorefrontService.TTL_MS) return hit.slug;

      // Runs with no tenant context — the whole reason storefront_configs is
      // RLS-enabled but not FORCEd (drizzle/0009_storefront_rls.sql).
      const [row] = await this.tdb.raw
        .select({ tenantId: storefrontConfigs.tenantId })
        .from(storefrontConfigs)
        .where(eq(storefrontConfigs.customDomain, h))
        .limit(1);
      if (row) {
        const tenant = await this.tenants.byId(row.tenantId);
        this.domainCache.set(h, { slug: tenant.slug, at: Date.now() });
        return tenant.slug;
      }

      for (const root of this.rootDomains()) {
        if (h.endsWith(`.${root}`)) {
          const label = h.slice(0, -(root.length + 1));
          // Only a single label: a.b.root is not tenant "a.b".
          if (label && !label.includes(".") && label !== "www") {
            this.domainCache.set(h, { slug: label, at: Date.now() });
            return label;
          }
        }
      }
    }

    return slugParam ?? null;
  }

  /**
   * The one gate every public route goes through. A storefront is live only if
   * the tenant exists, still has the module, and has switched it on.
   *
   * Every failure — unknown tenant, disabled storefront, revoked module — is
   * the same 404 with the same message. Distinguishing them would let anyone
   * enumerate which tenants exist on the platform.
   */
  private async assertLive(slug: string): Promise<{ tenant: TenantDto; config: ConfigRow }> {
    const unavailable = new NotFoundException("Store unavailable");
    let tenant: TenantDto;
    try {
      tenant = await this.tenants.bySlug(slug);
    } catch {
      throw unavailable;
    }
    if (!tenant.entitlements.includes(STOREFRONT_MODULE)) throw unavailable;

    const [config] = await this.tdb.raw
      .select()
      .from(storefrontConfigs)
      .where(eq(storefrontConfigs.tenantId, tenant.id))
      .limit(1);
    if (!config || !config.isActive) throw unavailable;
    return { tenant, config };
  }

  /**
   * The public liveness gate, for other services on the anonymous path.
   *
   * PublicCheckoutService needs exactly the same check every read goes through
   * — tenant exists, holds the module, has switched the storefront on — and
   * must fail it exactly the same way. Exposing this is what stops checkout
   * growing a second, subtly different notion of "open for business".
   */
  async requireLiveTenant(slug: string): Promise<TenantDto> {
    const { tenant } = await this.assertLive(slug);
    return tenant;
  }

  /** Host/slug -> the slug the storefront should use for subsequent calls. */
  async resolve(host: string | undefined, slug: string | undefined): Promise<{ tenantSlug: string }> {
    const resolved = await this.resolveHost(host, slug);
    if (!resolved) throw new NotFoundException("Store unavailable");
    const { tenant } = await this.assertLive(resolved);
    return { tenantSlug: tenant.slug };
  }

  /**
   * Is this browser `Origin` a storefront we actually serve?
   *
   * CORS_ORIGIN is a static list, which cannot cover tenant custom domains —
   * those are created by tenants at runtime, and a storefront whose checkout
   * calls are blocked by CORS is a storefront that cannot take an order. Reuses
   * the same host resolution and the same liveness gate as every public read,
   * so an origin is allowed on exactly the terms its storefront is.
   *
   * Backed by resolveHost's 30s cache, so a preflight storm is not a query
   * storm. Never throws: a CORS check answering 500 tells the caller nothing
   * useful and hides the real failure.
   */
  async isLiveOrigin(origin: string): Promise<boolean> {
    try {
      const slug = await this.resolveHost(origin, undefined);
      if (!slug) return false;
      await this.assertLive(slug);
      return true;
    } catch {
      return false;
    }
  }

  /** Everything the storefront shell needs, in one round trip. */
  async publicSite(slug: string): Promise<PublicSiteDto> {
    const { tenant, config } = await this.assertLive(slug);
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [navRows, pageRows, zones, methods] = await Promise.all([
        tx.select().from(storefrontNavigation).where(eq(storefrontNavigation.tenantId, tenant.id)),
        tx
          .select({ slug: storefrontPages.slug, title: storefrontPages.title })
          .from(storefrontPages)
          .where(and(eq(storefrontPages.tenantId, tenant.id), eq(storefrontPages.isPublished, true)))
          .orderBy(asc(storefrontPages.sortOrder), asc(storefrontPages.title)),
        tx
          .select({
            name: storefrontDeliveryZones.name,
            district: storefrontDeliveryZones.district,
            fee: storefrontDeliveryZones.fee,
          })
          .from(storefrontDeliveryZones)
          .where(
            and(
              eq(storefrontDeliveryZones.tenantId, tenant.id),
              eq(storefrontDeliveryZones.active, true),
            ),
          )
          .orderBy(asc(storefrontDeliveryZones.sort)),
        tx
          .select({
            code: storefrontPaymentMethods.code,
            label: storefrontPaymentMethods.label,
            description: storefrontPaymentMethods.description,
            feePct: storefrontPaymentMethods.feePct,
            skipsDelivery: storefrontPaymentMethods.skipsDelivery,
            payOnDelivery: storefrontPaymentMethods.payOnDelivery,
          })
          .from(storefrontPaymentMethods)
          .where(
            and(
              eq(storefrontPaymentMethods.tenantId, tenant.id),
              eq(storefrontPaymentMethods.active, true),
            ),
          )
          .orderBy(asc(storefrontPaymentMethods.sort)),
      ]);
      return {
        tenantSlug: tenant.slug,
        tenantName: tenant.name,
        currency: tenant.config.currency,
        currencySymbol: tenant.config.currencySymbol,
        theme: config.theme,
        seo: config.seo,
        navigation: {
          header: navRows.find((r) => r.location === "header")?.items ?? [],
          footer: navRows.find((r) => r.location === "footer")?.items ?? [],
        },
        pages: pageRows,
        commerce: { deliveryZones: zones, paymentMethods: methods },
      };
    });
  }

  /** A single published page. Drafts are 404s, not 403s. */
  async publicPage(slug: string, pageSlug: string): Promise<PublicPageDto> {
    const { tenant } = await this.assertLive(slug);
    const wanted = pageSlug === "" || pageSlug === "/" ? HOME_SLUG : pageSlug;
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [row] = await tx
        .select()
        .from(storefrontPages)
        .where(
          and(
            eq(storefrontPages.tenantId, tenant.id),
            eq(storefrontPages.slug, wanted),
            eq(storefrontPages.isPublished, true),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundException("Page not found");
      return {
        title: row.title,
        slug: row.slug,
        contentBlocks: row.contentBlocks,
        metaTitle: row.metaTitle,
        metaDescription: row.metaDescription,
        publishedAt: row.publishedAt,
        updatedAt: row.updatedAt,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Public catalogue
  // -------------------------------------------------------------------------

  /**
   * Resolves the category/sub-category filters, which arrive as either an id
   * or a slug depending on the caller — the productGrid block stores ids, the
   * storefront's own URLs carry slugs (/category/laptop).
   *
   * A slug that matches nothing returns `null`, which the callers turn into an
   * empty result rather than silently listing the whole catalogue.
   */
  private async resolveCategoryFilter(
    tx: Db,
    tenantId: string,
    q: Pick<PublicProductQuery, "categoryId" | "categorySlug" | "subCategoryId" | "subCategorySlug">,
  ): Promise<{ categoryId?: string; subCategoryId?: string; missing: boolean }> {
    const wanted = [q.categorySlug, q.subCategorySlug].filter((s): s is string => Boolean(s));
    let bySlug = new Map<string, string>();
    if (wanted.length) {
      const rows = await tx
        .select({ id: categories.id, slug: categories.slug })
        .from(categories)
        .where(and(eq(categories.tenantId, tenantId), inArray(categories.slug, wanted)));
      bySlug = new Map(rows.map((r) => [r.slug, r.id]));
    }

    const categoryId = q.categoryId ?? (q.categorySlug ? bySlug.get(q.categorySlug) : undefined);
    const subCategoryId = q.subCategoryId ?? (q.subCategorySlug ? bySlug.get(q.subCategorySlug) : undefined);
    const missing =
      (Boolean(q.categorySlug) && !categoryId) || (Boolean(q.subCategorySlug) && !subCategoryId);

    return { categoryId, subCategoryId, missing };
  }

  /** Every filter except paging and sort, shared by the list and its facets. */
  private async catalogueFilters(tx: Db, tenantId: string, q: PublicProductQuery | PublicBrandQuery) {
    const filters = [eq(products.tenantId, tenantId), eq(products.status, "active")];

    const { categoryId, subCategoryId, missing } = await this.resolveCategoryFilter(tx, tenantId, q);
    if (categoryId) filters.push(eq(products.categoryId, categoryId));
    if (subCategoryId) filters.push(eq(products.subCategoryId, subCategoryId));

    const full = q as PublicProductQuery;
    if (full.q) {
      const needle = `%${full.q}%`;
      const match = or(
        ilike(products.nameEn, needle),
        ilike(products.slug, needle),
        ilike(products.styleCode, needle),
        ilike(brands.name, needle),
      );
      if (match) filters.push(match);
    }
    if (full.brandIds?.length) filters.push(inArray(products.brandId, full.brandIds));
    if (full.brands?.length) filters.push(inArray(brands.name, full.brands));

    // An offer price that isn't below the list price isn't an offer.
    if (full.onSale) filters.push(sql`${products.offerPrice} is not null and ${products.offerPrice} < ${products.price}`);

    // Exists rather than a join: a product can carry several badges, and
    // joining would multiply its row and break both the count and the page.
    if (full.badge) {
      filters.push(
        sql`exists (select 1 from ${productBadges} where ${productBadges.productId} = ${products.id} and ${productBadges.badge} = ${full.badge})`,
      );
    }

    // Filter on what the shopper is actually charged, not the list price.
    const effectivePrice = sql<number>`coalesce(${products.offerPrice}, ${products.price})`;
    if (full.priceMin !== undefined) filters.push(gte(effectivePrice, full.priceMin));
    if (full.priceMax !== undefined) filters.push(lte(effectivePrice, full.priceMax));

    return { where: and(...filters), missing };
  }

  /**
   * Which of these products can actually be bought.
   *
   * `stockMode: "always"` never runs out. Everything else is the sum of
   * `on_hand - reserved` across the product's SKUs and warehouses —
   * inventory_levels is the stock truth (see its comment in schema.ts);
   * `products.stock` is a denormalised counter and is deliberately not read
   * here.
   */
  private async inStockByProduct(tx: Db, tenantId: string, ids: string[]): Promise<Map<string, boolean>> {
    if (!ids.length) return new Map();
    const rows = await tx
      .select({
        productId: skus.productId,
        available: sql<number>`coalesce(sum(${inventoryLevels.onHand} - ${inventoryLevels.reserved}), 0)`,
      })
      .from(skus)
      .leftJoin(inventoryLevels, eq(inventoryLevels.skuId, skus.id))
      .where(and(eq(skus.tenantId, tenantId), eq(skus.status, "active"), inArray(skus.productId, ids)))
      .groupBy(skus.productId);
    return new Map(rows.map((r) => [r.productId, Number(r.available) > 0]));
  }

  /**
   * The social proof on a product card: star rating and units sold.
   *
   * Both were invented numbers in the storefront until now — stable per
   * product, plausible, and untrue. These are the real figures.
   *
   * Only *approved* reviews count, for the same reason only approved ones are
   * readable: moderation that the average ignores is not moderation. Sales
   * exclude cancelled and failed orders, matching CrudService.isCancelled — a
   * cancelled order returned its stock, so counting it as sold would be double
   * counting in the shopper's favour.
   *
   * Two grouped queries for the whole page rather than per product; this runs
   * on every catalogue listing.
   */
  private async socialProofByProduct(
    tx: Db,
    tenantId: string,
    ids: string[],
  ): Promise<Map<string, { rating: number | null; reviewCount: number; sold: number }>> {
    const out = new Map<string, { rating: number | null; reviewCount: number; sold: number }>();
    if (!ids.length) return out;

    const [ratings, sales] = await Promise.all([
      tx
        .select({
          productId: reviews.productId,
          average: sql<number>`avg(${reviews.rating})`,
          total: count(),
        })
        .from(reviews)
        .where(
          and(
            eq(reviews.tenantId, tenantId),
            eq(reviews.status, "approved"),
            inArray(reviews.productId, ids),
          ),
        )
        .groupBy(reviews.productId),
      tx
        .select({
          productId: orderItems.productId,
          units: sql<number>`coalesce(sum(${orderItems.qty}), 0)`,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(
          and(
            eq(orderItems.tenantId, tenantId),
            inArray(orderItems.productId, ids),
            notInArray(sql`lower(${orders.deliveryStatus})`, ["cancelled", "canceled", "failed"]),
          ),
        )
        .groupBy(orderItems.productId),
    ]);

    for (const id of ids) out.set(id, { rating: null, reviewCount: 0, sold: 0 });
    for (const r of ratings) {
      if (!r.productId) continue;
      const entry = out.get(r.productId);
      if (entry) {
        entry.rating = Math.round(Number(r.average) * 10) / 10;
        entry.reviewCount = r.total;
      }
    }
    for (const s of sales) {
      if (!s.productId) continue;
      const entry = out.get(s.productId);
      if (entry) entry.sold = Number(s.units);
    }
    return out;
  }

  /** Badge labels for a page of products, in their authored order. */
  private async badgesByProduct(tx: Db, tenantId: string, ids: string[]): Promise<Map<string, string[]>> {
    if (!ids.length) return new Map();
    const rows = await tx
      .select({ productId: productBadges.productId, badge: productBadges.badge })
      .from(productBadges)
      .where(and(eq(productBadges.tenantId, tenantId), inArray(productBadges.productId, ids)))
      .orderBy(asc(productBadges.sort));
    const out = new Map<string, string[]>();
    for (const r of rows) out.set(r.productId, [...(out.get(r.productId) ?? []), r.badge]);
    return out;
  }

  /** The columns every product DTO starts from, card and detail alike. */
  private cardColumns() {
    return {
      id: products.id,
      name: products.nameEn,
      slug: products.slug,
      price: products.price,
      offerPrice: products.offerPrice,
      imageUrl: products.imageUrl,
      stockMode: products.stockMode,
      brand: brands.name,
      categoryName: categories.nameEn,
      categorySlug: categories.slug,
    };
  }

  /**
   * Catalogue listing: the storefront's category, search and grid pages.
   *
   * Only `active` products — a draft is as private as an unpublished page.
   * Every filter, sort and page is applied in SQL: the storefront must never
   * have to pull the catalogue down to filter it in memory, and `pageSize` is
   * capped because this route is anonymous.
   *
   * Returns hand-built DTOs rather than rows: products carry cost-side and
   * internal fields (stock, sellerId, styleCode) that must never reach a
   * shopper.
   */
  async publicProducts(slug: string, q: PublicProductQuery): Promise<PublicProductListDto> {
    const { tenant } = await this.assertLive(slug);
    const empty: PublicProductListDto = { items: [], total: 0, page: q.page, pageSize: q.pageSize };

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const { where, missing } = await this.catalogueFilters(tx, tenant.id, q);
      if (missing) return empty;

      // Joined for both filtering (brand name / category slug) and the DTO, so
      // the count has to see the same joins to stay consistent with the page.
      const scoped = tx
        .select(this.cardColumns())
        .from(products)
        .leftJoin(brands, eq(brands.id, products.brandId))
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .where(where);

      const [{ value: total }] = await tx
        .select({ value: count() })
        .from(products)
        .leftJoin(brands, eq(brands.id, products.brandId))
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .where(where);

      const effectivePrice = sql`coalesce(${products.offerPrice}, ${products.price})`;
      // Percentage off, not absolute — a ৳500 saving on a phone is not the
      // deal a ৳500 saving on a mouse is. Undiscounted rows sort to 0.
      const discount = sql`case when ${products.offerPrice} is null or ${products.price} = 0 then 0
        else (${products.price} - ${products.offerPrice}) / ${products.price} end`;
      const order =
        q.sort === "lo"
          ? asc(effectivePrice)
          : q.sort === "hi"
            ? desc(effectivePrice)
            : q.sort === "discount"
              ? desc(discount)
              : desc(products.createdAt);

      const rows = await scoped
        .orderBy(order, asc(products.id))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);

      const ids = rows.map((r) => r.id);
      const [badges, stock, social] = await Promise.all([
        this.badgesByProduct(tx, tenant.id, ids),
        this.inStockByProduct(tx, tenant.id, ids),
        this.socialProofByProduct(tx, tenant.id, ids),
      ]);

      return {
        items: rows.map(({ stockMode, ...r }) => ({
          ...r,
          badges: badges.get(r.id) ?? [],
          inStock: stockMode === "always" || (stock.get(r.id) ?? false),
          ...(social.get(r.id) ?? { rating: null, reviewCount: 0, sold: 0 }),
        })),
        total,
        page: q.page,
        pageSize: q.pageSize,
      };
    });
  }

  /**
   * One product, by its slug. Drafts are 404s, never 403s — same reasoning as
   * unpublished pages.
   */
  async publicProduct(slug: string, productSlug: string): Promise<PublicProductDetailDto> {
    const { tenant } = await this.assertLive(slug);
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const sub = alias(categories, "sub_category");
      const [row] = await tx
        .select({
          ...this.cardColumns(),
          shortDescription: products.shortDescEn,
          description: products.descriptionEn,
          videoUrl: products.videoUrl,
          unit: products.unit,
          minOrderQty: products.minOrderQty,
          maxOrderQty: products.maxOrderQty,
          subCategoryName: sub.nameEn,
          subCategorySlug: sub.slug,
        })
        .from(products)
        .leftJoin(brands, eq(brands.id, products.brandId))
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .leftJoin(sub, eq(sub.id, products.subCategoryId))
        .where(
          and(
            eq(products.tenantId, tenant.id),
            eq(products.slug, productSlug),
            eq(products.status, "active"),
          ),
        )
        .limit(1);
      if (!row) throw new NotFoundException("Product not found");

      const ids = [row.id];
      const [images, specs, tags, variants, tiers, badges, stock, social] = await Promise.all([
        tx
          .select({ url: productImages.url })
          .from(productImages)
          .where(and(eq(productImages.tenantId, tenant.id), eq(productImages.productId, row.id)))
          .orderBy(asc(productImages.sort)),
        tx
          .select({ label: productSpecs.label, value: productSpecs.value })
          .from(productSpecs)
          .where(and(eq(productSpecs.tenantId, tenant.id), eq(productSpecs.productId, row.id)))
          .orderBy(asc(productSpecs.sort)),
        tx
          .select({ tag: productTags.tag })
          .from(productTags)
          .where(and(eq(productTags.tenantId, tenant.id), eq(productTags.productId, row.id)))
          .orderBy(asc(productTags.sort)),
        tx
          .select({
            id: productVariants.id,
            label: productVariants.label,
            type: productVariants.type,
            price: productVariants.price,
            originalPrice: productVariants.originalPrice,
            badge: productVariants.badge,
          })
          .from(productVariants)
          .where(and(eq(productVariants.tenantId, tenant.id), eq(productVariants.productId, row.id)))
          .orderBy(asc(productVariants.sort)),
        tx
          .select({ minQty: productPricingTiers.minQty, unitPrice: productPricingTiers.unitPrice })
          .from(productPricingTiers)
          .where(
            and(eq(productPricingTiers.tenantId, tenant.id), eq(productPricingTiers.productId, row.id)),
          )
          .orderBy(asc(productPricingTiers.minQty)),
        this.badgesByProduct(tx, tenant.id, ids),
        this.inStockByProduct(tx, tenant.id, ids),
        this.socialProofByProduct(tx, tenant.id, ids),
      ]);

      const { stockMode, ...card } = row;
      return {
        ...card,
        badges: badges.get(row.id) ?? [],
        inStock: stockMode === "always" || (stock.get(row.id) ?? false),
        ...(social.get(row.id) ?? { rating: null, reviewCount: 0, sold: 0 }),
        images: images.map((i) => i.url),
        specs,
        tags: tags.map((t) => t.tag),
        variants,
        pricingTiers: tiers,
      };
    });
  }

  /**
   * The category tree, for menus, footers and static params.
   *
   * Flat and parent-linked rather than nested: the storefront's mega-menu,
   * category bar and sidebar each want a different shape, and one of them
   * would have to un-nest it again.
   */
  async publicCategories(slug: string): Promise<PublicCategoryDto[]> {
    const { tenant } = await this.assertLive(slug);
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const rows = await tx
        .select({
          id: categories.id,
          name: categories.nameEn,
          slug: categories.slug,
          parentId: categories.parentId,
          level: categories.level,
        })
        .from(categories)
        .where(and(eq(categories.tenantId, tenant.id), eq(categories.active, true)))
        .orderBy(asc(categories.level), asc(categories.nameEn));

      // One grouped pass rather than a count per category — 18 categories is
      // 18 round trips otherwise, on a route every page in the site calls.
      const counts = await tx
        .select({ categoryId: products.categoryId, value: count() })
        .from(products)
        .where(and(eq(products.tenantId, tenant.id), eq(products.status, "active")))
        .groupBy(products.categoryId);
      const byCategory = new Map(counts.map((c) => [c.categoryId, c.value]));

      return rows.map((r) => ({ ...r, productCount: byCategory.get(r.id) ?? 0 }));
    });
  }

  /**
   * Brand facet counts, scoped to whatever category is being browsed.
   *
   * Counted over the same active-product filter as the listing, so a facet can
   * never offer a brand that would return nothing.
   */
  async publicBrands(slug: string, q: PublicBrandQuery): Promise<PublicBrandDto[]> {
    const { tenant } = await this.assertLive(slug);
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const { where, missing } = await this.catalogueFilters(tx, tenant.id, q);
      if (missing) return [];
      return tx
        .select({ id: brands.id, name: brands.name, productCount: count(products.id) })
        .from(products)
        .innerJoin(brands, eq(brands.id, products.brandId))
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .where(where)
        .groupBy(brands.id, brands.name)
        .orderBy(asc(brands.name));
    });
  }

  /**
   * Approved reviews for one product. Pending and rejected are invisible —
   * moderation would be pointless otherwise.
   */
  async publicReviews(slug: string, productSlug: string): Promise<PublicReviewDto[]> {
    const { tenant } = await this.assertLive(slug);
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [product] = await tx
        .select({ id: products.id })
        .from(products)
        .where(
          and(
            eq(products.tenantId, tenant.id),
            eq(products.slug, productSlug),
            eq(products.status, "active"),
          ),
        )
        .limit(1);
      if (!product) throw new NotFoundException("Product not found");

      return tx
        .select({
          id: reviews.id,
          author: reviews.author,
          rating: reviews.rating,
          comment: reviews.comment,
          createdAt: reviews.createdAt,
        })
        .from(reviews)
        .where(
          and(
            eq(reviews.tenantId, tenant.id),
            eq(reviews.productId, product.id),
            eq(reviews.status, "approved"),
          ),
        )
        .orderBy(desc(reviews.createdAt));
    });
  }

  /** Published slugs + timestamps for sitemap.xml / static generation. */
  async publicSitemap(slug: string): Promise<{ slug: string; updatedAt: Date }[]> {
    const { tenant } = await this.assertLive(slug);
    return this.tdb.forTenant(tenant.id, async (tx) =>
      tx
        .select({ slug: storefrontPages.slug, updatedAt: storefrontPages.updatedAt })
        .from(storefrontPages)
        .where(and(eq(storefrontPages.tenantId, tenant.id), eq(storefrontPages.isPublished, true)))
        .orderBy(asc(storefrontPages.slug)),
    );
  }

  /** Diagnostic for the admin: is DNS actually pointed here yet? */
  async domainStatus(tenant: TenantDto): Promise<{ customDomain: string | null; resolves: boolean }> {
    this.assertEntitled(tenant);
    const config = await this.getConfig(tenant);
    if (!config.customDomain) return { customDomain: null, resolves: false };
    const [row] = await this.tdb.raw
      .select({ tenantId: storefrontConfigs.tenantId })
      .from(storefrontConfigs)
      .where(eq(storefrontConfigs.customDomain, config.customDomain))
      .limit(1);
    return { customDomain: config.customDomain, resolves: row?.tenantId === tenant.id };
  }
}
