import { Injectable, NotFoundException } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/db.tokens";
import { TenantDb } from "../db/tenant-db.service";
import { tenantEntitlements, tenants } from "../db/schema";

type TenantRow = typeof tenants.$inferSelect;

/** API shape — matches the frontend's Tenant type (src/lib/types.ts). */
export interface TenantDto {
  id: string;
  slug: string;
  name: string;
  type: string;
  /** active | suspended | archived — enforced in TenantGuard. */
  status: string;
  region: string;
  theme: { brand: string; brandFg: string };
  entitlements: string[];
  config: {
    defaultLanguage: string;
    currency: string;
    currencySymbol: string;
    ga4Id?: string;
    pixelId?: string;
    strictOrderFlow: boolean;
    defaultSellerName: string;
    locationServiceOn: boolean;
    codEnabled: boolean;
    allowForceDeleteCategory: boolean;
    cordNo?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface TenantInput {
  slug?: string;
  name?: string;
  type?: string;
  status?: string;
  region?: string;
  theme?: { brand?: string; brandFg?: string };
  entitlements?: string[];
  config?: Partial<TenantDto["config"]>;
}

@Injectable()
export class TenantService {
  /** slug -> tenant, small cache to avoid two lookups on every request. */
  private cache = new Map<string, { dto: TenantDto; at: number }>();
  private static TTL_MS = 30_000;

  constructor(private readonly tdb: TenantDb) {}

  private toDto(row: TenantRow, entitlements: string[]): TenantDto {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      type: row.type,
      status: row.status,
      region: row.region,
      theme: { brand: row.themeBrand, brandFg: row.themeBrandFg },
      entitlements,
      config: {
        defaultLanguage: row.defaultLanguage,
        currency: row.currency,
        currencySymbol: row.currencySymbol,
        ga4Id: row.ga4Id ?? undefined,
        pixelId: row.pixelId ?? undefined,
        strictOrderFlow: row.strictOrderFlow,
        defaultSellerName: row.defaultSellerName,
        locationServiceOn: row.locationServiceOn,
        codEnabled: row.codEnabled,
        allowForceDeleteCategory: row.allowForceDeleteCategory,
        cordNo: row.cordNo ?? undefined,
      },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Flattens the nested API shape onto tenants-table columns. */
  private toColumns(input: TenantInput): Partial<TenantRow> {
    const out: Record<string, unknown> = {};
    for (const key of ["slug", "name", "type", "status", "region"] as const) {
      if (input[key] !== undefined) out[key] = input[key];
    }
    if (input.theme?.brand !== undefined) out.themeBrand = input.theme.brand;
    if (input.theme?.brandFg !== undefined) out.themeBrandFg = input.theme.brandFg;
    const c = input.config;
    if (c) {
      const map: Record<string, keyof NonNullable<TenantInput["config"]>> = {
        defaultLanguage: "defaultLanguage",
        currency: "currency",
        currencySymbol: "currencySymbol",
        ga4Id: "ga4Id",
        pixelId: "pixelId",
        strictOrderFlow: "strictOrderFlow",
        defaultSellerName: "defaultSellerName",
        locationServiceOn: "locationServiceOn",
        codEnabled: "codEnabled",
        allowForceDeleteCategory: "allowForceDeleteCategory",
        cordNo: "cordNo",
      };
      for (const [col, key] of Object.entries(map)) {
        if (c[key] !== undefined) out[col] = c[key];
      }
    }
    return out as Partial<TenantRow>;
  }

  private async loadEntitlements(tenantId: string): Promise<string[]> {
    const rows = await this.tdb.raw
      .select({ module: tenantEntitlements.module })
      .from(tenantEntitlements)
      .where(eq(tenantEntitlements.tenantId, tenantId))
      .orderBy(asc(tenantEntitlements.module));
    return rows.map((r) => r.module);
  }

  /**
   * Wholesale replace, in ONE transaction.
   *
   * Delete-then-insert across two round trips left a window where a failed
   * insert (or a dropped connection between them) committed the delete on its
   * own — leaving a workspace with zero modules, which is a locked-out
   * workspace, not a degraded one. asPlatform is the right handle: this is
   * called from the platform surface and tenant_entitlements is not covered by
   * a tenant-scoped policy.
   */
  private async replaceEntitlements(tenantId: string, modules: string[]) {
    await this.tdb.asPlatform(async (tx) => {
      await tx.delete(tenantEntitlements).where(eq(tenantEntitlements.tenantId, tenantId));
      if (modules.length) {
        await tx.insert(tenantEntitlements).values(modules.map((module) => ({ tenantId, module })));
      }
    });
  }

  async bySlug(slug: string): Promise<TenantDto> {
    const hit = this.cache.get(slug);
    if (hit && Date.now() - hit.at < TenantService.TTL_MS) return hit.dto;

    const [row] = await this.tdb.raw.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
    if (!row) throw new NotFoundException(`Unknown tenant "${slug}"`);
    const dto = this.toDto(row, await this.loadEntitlements(row.id));
    this.cache.set(slug, { dto, at: Date.now() });
    return dto;
  }

  async byId(id: string): Promise<TenantDto> {
    const [row] = await this.tdb.raw.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!row) throw new NotFoundException(`Unknown tenant "${id}"`);
    return this.toDto(row, await this.loadEntitlements(row.id));
  }

  invalidate(slug: string) {
    this.cache.delete(slug);
  }

  async list(): Promise<TenantDto[]> {
    const rows = await this.tdb.raw.select().from(tenants);
    return Promise.all(rows.map(async (row) => this.toDto(row, await this.loadEntitlements(row.id))));
  }

  async update(slug: string, input: TenantInput): Promise<TenantDto> {
    const cols = this.toColumns(input);
    delete (cols as Record<string, unknown>).slug; // slug is the identifier, not updatable here
    const [row] = await this.tdb.raw
      .update(tenants)
      .set({ ...cols, updatedAt: new Date() })
      .where(eq(tenants.slug, slug))
      .returning();
    if (!row) throw new NotFoundException(`Unknown tenant "${slug}"`);
    if (input.entitlements) await this.replaceEntitlements(row.id, input.entitlements);
    this.invalidate(slug);
    return this.toDto(row, await this.loadEntitlements(row.id));
  }

  /**
   * Create a workspace, and everything that must exist alongside it, atomically.
   *
   * `provision` runs inside the same transaction as the tenants INSERT — see
   * TenantProvisioningService. This used to be three sequential round trips
   * (tenant, then entitlements, and roles never at all), so a failure between
   * them left a workspace that looked created and could not be used. Either the
   * whole workspace exists or none of it does.
   */
  async create(
    input: TenantInput & { slug: string; name: string; type: string },
    provision?: (tx: Db, tenantId: string, entitlements: string[]) => Promise<unknown>,
  ): Promise<TenantDto> {
    const entitlements = input.entitlements ?? [];
    return this.tdb.asPlatform(async (tx) => {
      const [row] = await tx
        .insert(tenants)
        .values(this.toColumns(input) as typeof tenants.$inferInsert)
        .returning();

      if (provision) {
        await provision(tx, row.id, entitlements);
      } else if (entitlements.length) {
        await tx.insert(tenantEntitlements).values(entitlements.map((module) => ({ tenantId: row.id, module })));
      }

      return this.toDto(row, entitlements);
    });
  }
}
