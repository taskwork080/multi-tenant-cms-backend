import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, asc, count, desc, eq, ilike, or } from "drizzle-orm";
import { TenantDb } from "../db/tenant-db.service";
import {
  DEFAULT_STOREFRONT_SEO,
  DEFAULT_STOREFRONT_THEME,
  products,
  storefrontConfigs,
  storefrontNavigation,
  storefrontPages,
  type ContentBlock,
  type NavItem,
  type StorefrontSeo,
  type StorefrontTheme,
} from "../db/schema";
import { TenantService, type TenantDto } from "../tenant/tenant.service";
import {
  configUpdateSchema,
  customDomainSchema,
  HOME_SLUG,
  type ConfigUpdateInput,
  type NavLocation,
  type PageCreateInput,
  type PageUpdateInput,
} from "./storefront.schemas";

/** Entitlement key gating the whole storefront feature (frontend ModuleKey). */
const STOREFRONT_MODULE = "cms";

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
}

/** The catalogue fields a storefront product card needs — nothing else. */
export interface PublicProductDto {
  id: string;
  name: string;
  slug: string;
  price: number;
  offerPrice: number | null;
  imageUrl: string | null;
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
   * TenantGuard proves the caller may act for this tenant; it does not check
   * entitlements — that lives in CrudService.resolve for registry resources.
   * Bespoke controllers have to ask, so this mirrors the same error.
   */
  private assertEntitled(tenant: TenantDto) {
    if (!tenant.entitlements.includes(STOREFRONT_MODULE)) {
      throw new ForbiddenException(`Module "${STOREFRONT_MODULE}" is not enabled for this tenant`);
    }
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

  /** Host/slug -> the slug the storefront should use for subsequent calls. */
  async resolve(host: string | undefined, slug: string | undefined): Promise<{ tenantSlug: string }> {
    const resolved = await this.resolveHost(host, slug);
    if (!resolved) throw new NotFoundException("Store unavailable");
    const { tenant } = await this.assertLive(resolved);
    return { tenantSlug: tenant.slug };
  }

  /** Everything the storefront shell needs, in one round trip. */
  async publicSite(slug: string): Promise<PublicSiteDto> {
    const { tenant, config } = await this.assertLive(slug);
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [navRows, pageRows] = await Promise.all([
        tx.select().from(storefrontNavigation).where(eq(storefrontNavigation.tenantId, tenant.id)),
        tx
          .select({ slug: storefrontPages.slug, title: storefrontPages.title })
          .from(storefrontPages)
          .where(and(eq(storefrontPages.tenantId, tenant.id), eq(storefrontPages.isPublished, true)))
          .orderBy(asc(storefrontPages.sortOrder), asc(storefrontPages.title)),
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

  /**
   * Catalogue feed for the storefront's productGrid block.
   *
   * Only `active` products — a draft is as private as an unpublished page.
   * Returns a hand-built DTO rather than the row: products carry cost-side and
   * internal fields (stock, sellerId, styleCode) that must never reach a
   * shopper.
   */
  async publicProducts(
    slug: string,
    opts: { categoryId?: string; limit?: number },
  ): Promise<PublicProductDto[]> {
    const { tenant } = await this.assertLive(slug);
    const limit = Math.min(24, Math.max(1, opts.limit ?? 8));
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const filters = [eq(products.tenantId, tenant.id), eq(products.status, "active")];
      if (opts.categoryId) filters.push(eq(products.categoryId, opts.categoryId));
      const rows = await tx
        .select({
          id: products.id,
          name: products.nameEn,
          slug: products.slug,
          price: products.price,
          offerPrice: products.offerPrice,
          imageUrl: products.imageUrl,
        })
        .from(products)
        .where(and(...filters))
        .orderBy(desc(products.createdAt))
        .limit(limit);
      return rows;
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
