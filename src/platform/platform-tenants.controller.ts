import { BadRequestException, Body, Controller, Get, Injectable, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { PLATFORM_ADMIN } from "../auth/auth.types";
import { Roles } from "../auth/decorators";
import { TenantDb } from "../db/tenant-db.service";
import { platformAuditLog, roles, staffUsers, tenantEntitlements, tenants } from "../db/schema";
import { TenantService } from "../tenant/tenant.service";
import { Audit, AuditService, type AuditCtx } from "./audit.service";
import {
  adminTenantCreateSchema,
  adminTenantPatchSchema,
  adminTenantStatusSchema,
  assertModulesWithinType,
  tenantListSchema,
} from "./dto";
import { MODULE_KEYS, MODULE_PRESETS, TYPE_ALLOWED_MODULES, TYPE_CONFIG_FIELDS, presetFor } from "./module-presets";
import { PlatformUsersService } from "./platform-users.service";
import { TenantProvisioningService } from "./tenant-provisioning.service";

@Injectable()
export class PlatformTenantsService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly tenantSvc: TenantService,
    private readonly audit: AuditService,
    private readonly users: PlatformUsersService,
    private readonly provisioning: TenantProvisioningService,
  ) {}

  async list(query: unknown) {
    const q = tenantListSchema.parse(query);
    const filters: SQL[] = [];
    if (q.q) filters.push(or(ilike(tenants.name, `%${q.q}%`), ilike(tenants.slug, `%${q.q}%`))!);
    if (q.status) {
      const v = Array.isArray(q.status) ? q.status : [q.status];
      filters.push(v.length === 1 ? eq(tenants.status, v[0]) : inArray(tenants.status, v));
    }
    if (q.type) {
      const v = Array.isArray(q.type) ? q.type : [q.type];
      filters.push(v.length === 1 ? eq(tenants.type, v[0]) : inArray(tenants.type, v));
    }
    const where = filters.length ? and(...filters) : undefined;
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
          status: row.status,
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
    const { allowOutsideType, ...input } = adminTenantCreateSchema.parse(body);
    // An omitted entitlements array means "give me the sensible default for
    // this kind of business" — otherwise the workspace opens with an empty
    // sidebar. An explicit [] is still honoured as a deliberate empty set.
    const presetApplied = input.entitlements === undefined;
    const entitlements = presetApplied ? presetFor(input.type) : input.entitlements!;
    // A preset is always inside its own ceiling, so this only ever fires on an
    // explicit list — which is exactly the case worth catching.
    assertModulesWithinType(input.type, entitlements, allowOutsideType);

    // Entitlements, the vertical's default roles and (for commerce) the
    // storefront row are all created in the tenants INSERT's own transaction —
    // a workspace with modules but no roles is unusable, and worse, looks fine.
    let provisioned: Awaited<ReturnType<TenantProvisioningService["provision"]>> | undefined;
    const dto = await this.tenantSvc.create({ ...input, entitlements }, async (tx, tenantId, mods) => {
      provisioned = await this.provisioning.provision(tx, tenantId, input.type, mods);
    });
    await this.tdb.asPlatform((tx) =>
      this.audit.record(tx, ctx, {
        action: "tenant.create",
        targetType: "tenant",
        targetId: dto.id,
        tenantId: dto.id,
        after: {
          slug: dto.slug,
          name: dto.name,
          type: dto.type,
          entitlements: dto.entitlements,
          // Records *why* the workspace ended up with these modules.
          presetApplied,
          // What the workspace actually opened with — roles are the part that
          // used to be missing entirely.
          rolesSeeded: provisioned?.roles ?? [],
          storefrontCreated: provisioned?.storefront ?? false,
          // Only present when someone deliberately crossed the vertical's
          // ceiling — the whole point of the flag is that it leaves a trail.
          ...(allowOutsideType ? { allowOutsideType: true } : {}),
        },
      }),
    );
    return dto;
  }

  /**
   * Workspace lifecycle. Separate from update() because it closes the
   * workspace to every one of its members, and that deserves its own audit
   * action and its own confirmation in the UI.
   */
  async setStatus(id: string, body: unknown, ctx: AuditCtx) {
    const input = adminTenantStatusSchema.parse(body);
    const before = await this.tenantSvc.byId(id);

    const dto = await this.tenantSvc.update(before.slug, { status: input.status });
    // TenantService caches slug -> tenant for 30s. update() invalidates the
    // calling process's copy; other instances keep serving the old status for
    // up to the TTL. Documented in TenantGuard.
    this.tenantSvc.invalidate(before.slug);

    await this.tdb.asPlatform((tx) =>
      this.audit.record(tx, ctx, {
        action: "tenant.status",
        targetType: "tenant",
        targetId: id,
        tenantId: id,
        before: { status: before.status },
        after: { status: input.status, reason: input.reason, suspendUsers: input.suspendUsers },
      }),
    );

    // Opt-in, because it is the only thing that kills live sessions: the status
    // flag alone is enforced on the *next* request, not against a token already
    // in flight. N sequential GoTrue calls, not atomic, and restoring the
    // workspace does not un-ban anyone — each user must be restored explicitly.
    let usersAffected = 0;
    if (input.suspendUsers && input.status !== "active") {
      const staff = await this.tdb.asPlatform((tx) =>
        tx.select({ id: staffUsers.id }).from(staffUsers).where(eq(staffUsers.tenantId, id)),
      );
      for (const s of staff) {
        try {
          await this.users.setStatus(s.id, { action: "suspend", reason: input.reason }, ctx);
          usersAffected += 1;
        } catch {
          // A self/last-admin guard refusal must not abort the rest of the
          // workspace; the workspace status change has already committed.
        }
      }
    }

    return { ...dto, usersAffected };
  }

  /**
   * Entering a workspace as a super admin. This grants nothing — TenantGuard
   * already admits a platform admin to every slug — it makes the crossing
   * deliberate and puts a row in the audit log.
   */
  async impersonate(id: string, start: boolean, body: unknown, ctx: AuditCtx) {
    const tenant = await this.tenantSvc.byId(id);
    const reason = typeof (body as { reason?: unknown })?.reason === "string" ? (body as { reason: string }).reason : undefined;
    if (start && tenant.status === "archived") {
      throw new BadRequestException("This workspace is archived. Restore it before entering.");
    }
    await this.tdb.asPlatform((tx) =>
      this.audit.record(tx, ctx, {
        action: start ? "tenant.impersonate_start" : "tenant.impersonate_end",
        targetType: "tenant",
        targetId: id,
        tenantId: id,
        after: { slug: tenant.slug, name: tenant.name, reason },
      }),
    );
    return tenant;
  }

  async update(id: string, body: unknown, ctx: AuditCtx) {
    const { allowOutsideType, ...input } = adminTenantPatchSchema.parse(body);
    const before = await this.tenantSvc.byId(id);

    // Validate the *effective* pair, not just what was sent. Changing type
    // alone has to re-check entitlements nobody mentioned — otherwise flipping
    // an e-commerce workspace to `warehouse` would quietly leave its storefront
    // modules in place and the ceiling would mean nothing after day one.
    const effectiveType = input.type ?? before.type;
    const effectiveEntitlements = input.entitlements ?? before.entitlements;
    assertModulesWithinType(effectiveType, effectiveEntitlements, allowOutsideType);

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

  /**
   * Detail payload for /platform/tenants/[id]. The users / roles / audit tabs
   * on that page use the existing list endpoints with a tenantId filter, so
   * this only has to carry the summary the header needs.
   */
  async get(id: string) {
    const dto = await this.tenantSvc.byId(id);
    const extra = await this.tdb.asPlatform(async (tx) => {
      const [byStatus, [roleCount], recentAudit] = await Promise.all([
        tx
          .select({ status: staffUsers.status, n: sql<number>`count(*)::int` })
          .from(staffUsers)
          .where(eq(staffUsers.tenantId, id))
          .groupBy(staffUsers.status),
        tx.select({ n: sql<number>`count(*)::int` }).from(roles).where(eq(roles.tenantId, id)),
        tx
          .select({
            id: platformAuditLog.id,
            actorEmail: platformAuditLog.actorEmail,
            action: platformAuditLog.action,
            targetType: platformAuditLog.targetType,
            targetId: platformAuditLog.targetId,
            createdAt: platformAuditLog.createdAt,
          })
          .from(platformAuditLog)
          .where(eq(platformAuditLog.tenantId, id))
          .orderBy(desc(platformAuditLog.createdAt))
          .limit(20),
      ]);
      const usersByStatus = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
      return {
        usersByStatus,
        userCount: byStatus.reduce((sum, r) => sum + r.n, 0),
        roleCount: roleCount?.n ?? 0,
        recentAudit,
      };
    });
    return { ...dto, ...extra, entitlementCount: dto.entitlements.length };
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

  // Declared BEFORE @Get(":id") — Nest matches in declaration order, and
  // "module-presets" would otherwise be read as a workspace id.
  @Get("module-presets")
  @ApiOperation({
    summary: "Per-type module defaults and ceilings, plus the full module list",
    description:
      "`presets` is what a new workspace of each type starts with; `allowedByType` is the widest " +
      "set it may ever hold. The tenant-create form should offer only `allowedByType` and " +
      "pre-tick `presets`, so a warehouse workspace is never offered a storefront in the first place.",
  })
  presets() {
    return {
      presets: MODULE_PRESETS,
      allowedByType: TYPE_ALLOWED_MODULES,
      configFieldsByType: TYPE_CONFIG_FIELDS,
      allModules: MODULE_KEYS,
    };
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a workspace by id, with its user/role counts and recent audit" })
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

  @Patch(":id/status")
  @ApiOperation({ summary: "Suspend, archive or restore a workspace" })
  setStatus(@Param("id") id: string, @Body() body: unknown, @Audit() ctx: AuditCtx) {
    return this.svc.setStatus(id, body, ctx);
  }

  @Post(":id/impersonate")
  @ApiOperation({ summary: "Begin a 'view as tenant' session (audited)" })
  impersonate(@Param("id") id: string, @Body() body: unknown, @Audit() ctx: AuditCtx) {
    return this.svc.impersonate(id, true, body, ctx);
  }

  @Post(":id/impersonate/stop")
  @ApiOperation({ summary: "End a 'view as tenant' session (audited)" })
  stopImpersonating(@Param("id") id: string, @Body() body: unknown, @Audit() ctx: AuditCtx) {
    return this.svc.impersonate(id, false, body, ctx);
  }
}
