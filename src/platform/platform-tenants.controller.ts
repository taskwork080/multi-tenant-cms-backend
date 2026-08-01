import { Body, Controller, Get, Injectable, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { PLATFORM_ADMIN } from "../auth/auth.types";
import { Roles } from "../auth/decorators";
import { TenantDb } from "../db/tenant-db.service";
import { staffUsers, tenantEntitlements, tenants } from "../db/schema";
import { TenantService } from "../tenant/tenant.service";
import { Audit, AuditService, type AuditCtx } from "./audit.service";
import { adminTenantCreateSchema, adminTenantPatchSchema, tenantListSchema } from "./dto";

@Injectable()
export class PlatformTenantsService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly tenantSvc: TenantService,
    private readonly audit: AuditService,
  ) {}

  async list(query: unknown) {
    const q = tenantListSchema.parse(query);
    const where = q.q ? or(ilike(tenants.name, `%${q.q}%`), ilike(tenants.slug, `%${q.q}%`)) : undefined;
    const offset = (q.page - 1) * q.pageSize;

    return this.tdb.asPlatform(async (tx) => {
      // Counts come from grouped subqueries, not a query per row.
      const [rows, [{ count }], userCounts, entCounts] = await Promise.all([
        tx
          .select()
          .from(tenants)
          .where(where)
          .orderBy(q.sort === "name" ? asc(tenants.name) : desc(tenants.createdAt), asc(tenants.id))
          .limit(q.pageSize)
          .offset(offset),
        tx.select({ count: sql<number>`count(*)::int` }).from(tenants).where(where),
        tx
          .select({ tenantId: staffUsers.tenantId, n: sql<number>`count(*)::int` })
          .from(staffUsers)
          .groupBy(staffUsers.tenantId),
        tx
          .select({ tenantId: tenantEntitlements.tenantId, n: sql<number>`count(*)::int` })
          .from(tenantEntitlements)
          .groupBy(tenantEntitlements.tenantId),
      ]);

      const users = new Map(userCounts.map((r) => [r.tenantId, r.n]));
      const ents = new Map(entCounts.map((r) => [r.tenantId, r.n]));
      const entitlementRows = await tx.select().from(tenantEntitlements);
      const byTenant = new Map<string, string[]>();
      for (const e of entitlementRows) {
        byTenant.set(e.tenantId, [...(byTenant.get(e.tenantId) ?? []), e.module]);
      }

      return {
        data: rows.map((row) => ({
          id: row.id,
          slug: row.slug,
          name: row.name,
          type: row.type,
          region: row.region,
          theme: { brand: row.themeBrand, brandFg: row.themeBrandFg },
          entitlements: (byTenant.get(row.id) ?? []).sort(),
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
          userCount: users.get(row.id) ?? 0,
          entitlementCount: ents.get(row.id) ?? 0,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
        total: count,
        page: q.page,
        pageSize: q.pageSize,
      };
    });
  }

  async create(body: unknown, ctx: AuditCtx) {
    const input = adminTenantCreateSchema.parse(body);
    const dto = await this.tenantSvc.create(input);
    await this.tdb.asPlatform((tx) =>
      this.audit.record(tx, ctx, {
        action: "tenant.create",
        targetType: "tenant",
        targetId: dto.id,
        tenantId: dto.id,
        after: { slug: dto.slug, name: dto.name, type: dto.type, entitlements: dto.entitlements },
      }),
    );
    return dto;
  }

  async update(id: string, body: unknown, ctx: AuditCtx) {
    const input = adminTenantPatchSchema.parse(body);
    const before = await this.tenantSvc.byId(id);
    const dto = await this.tenantSvc.update(before.slug, input);
    // TenantService caches slug -> tenant for 30s; without this the edit looks
    // like it silently failed for half a minute.
    this.tenantSvc.invalidate(before.slug);
    await this.tdb.asPlatform((tx) =>
      this.audit.record(tx, ctx, {
        action: "tenant.update",
        targetType: "tenant",
        targetId: id,
        tenantId: id,
        before: { name: before.name, type: before.type, region: before.region, entitlements: before.entitlements },
        after: { name: dto.name, type: dto.type, region: dto.region, entitlements: dto.entitlements },
      }),
    );
    return dto;
  }

  async get(id: string) {
    return this.tenantSvc.byId(id);
  }

  /** Slug lookup helper for the tenant-scoped ids the frontend already holds. */
  async byId(id: string) {
    return this.tdb.asPlatform(async (tx) => {
      const [row] = await tx.select().from(tenants).where(eq(tenants.id, id)).limit(1);
      return row ?? null;
    });
  }
}

@ApiTags("platform")
@ApiBearerAuth()
@Roles(PLATFORM_ADMIN)
@Controller("api/admin/tenants")
export class PlatformTenantsController {
  constructor(private readonly svc: PlatformTenantsService) {}

  @Get()
  @ApiOperation({ summary: "List every workspace with its user and entitlement counts" })
  list(@Query() query: Record<string, unknown>) {
    return this.svc.list(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a workspace by id" })
  get(@Param("id") id: string) {
    return this.svc.get(id);
  }

  @Post()
  @ApiOperation({ summary: "Create a workspace" })
  create(@Body() body: unknown, @Audit() ctx: AuditCtx) {
    return this.svc.create(body, ctx);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a workspace (slug is immutable)" })
  update(@Param("id") id: string, @Body() body: unknown, @Audit() ctx: AuditCtx) {
    return this.svc.update(id, body, ctx);
  }
}
