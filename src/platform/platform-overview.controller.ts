import { Controller, Get, Injectable, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { PLATFORM_ADMIN } from "../auth/auth.types";
import { Roles } from "../auth/decorators";
import { parseDateWindow, type DateWindow } from "../common/date-window";
import { TenantDb } from "../db/tenant-db.service";
import { authEvents, platformAuditLog, staffUsers, tenants } from "../db/schema";

/**
 * The /platform landing page in one call.
 *
 * One endpoint rather than six, because each would otherwise open its own
 * asPlatform transaction and re-set the app.platform GUC to render a single
 * screen. Every count is a grouped aggregate — nothing here is per-row.
 */
@Injectable()
export class PlatformOverviewService {
  constructor(private readonly tdb: TenantDb) {}

  /**
   * `window` scopes the *event-shaped* data only — the recent feeds and the
   * "new in this window" counts. The tenant/user/admin tallies are
   * point-in-time state: a tenant created before the window still exists today,
   * so filtering those by createdAt would report zero for any short window.
   */
  async get(window: DateWindow = { from: null, to: null }) {
    const bounds = (col: PgColumn): SQL[] => [
      ...(window.from ? [gte(col, window.from)] : []),
      ...(window.to ? [lte(col, window.to)] : []),
    ];
    /** `and()` of no clauses is undefined, which Drizzle reads as "no filter". */
    const within = (col: PgColumn, ...extra: SQL[]) => and(...extra, ...bounds(col));

    return this.tdb.asPlatform(async (tx) => {
      const [
        tenantsByType,
        tenantsByStatus,
        usersByStatus,
        adminCount,
        recentAudit,
        recentSignIns,
        newTenants,
        newUsers,
        signInCount,
        auditCount,
      ] = await Promise.all([
        tx.select({ k: tenants.type, n: sql<number>`count(*)::int` }).from(tenants).groupBy(tenants.type),
        tx.select({ k: tenants.status, n: sql<number>`count(*)::int` }).from(tenants).groupBy(tenants.status),
        tx.select({ k: staffUsers.status, n: sql<number>`count(*)::int` }).from(staffUsers).groupBy(staffUsers.status),
        tx.execute<{ n: number }>(sql`select n from public.platform_admin_count`),
        tx
          .select({
            id: platformAuditLog.id,
            actorEmail: platformAuditLog.actorEmail,
            action: platformAuditLog.action,
            targetType: platformAuditLog.targetType,
            targetId: platformAuditLog.targetId,
            tenantId: platformAuditLog.tenantId,
            tenantName: tenants.name,
            createdAt: platformAuditLog.createdAt,
          })
          .from(platformAuditLog)
          .leftJoin(tenants, eq(tenants.id, platformAuditLog.tenantId))
          .where(within(platformAuditLog.createdAt))
          .orderBy(desc(platformAuditLog.createdAt))
          .limit(10),
        tx
          .select({
            id: authEvents.id,
            email: authEvents.email,
            tenantId: authEvents.tenantId,
            tenantName: tenants.name,
            createdAt: authEvents.createdAt,
          })
          .from(authEvents)
          .leftJoin(tenants, eq(tenants.id, authEvents.tenantId))
          .where(within(authEvents.createdAt, eq(authEvents.event, "sign_in")))
          .orderBy(desc(authEvents.createdAt))
          .limit(10),

        // Windowed counts, so the date filter visibly does something even when
        // the recent feeds are shorter than their limit.
        tx.select({ n: sql<number>`count(*)::int` }).from(tenants).where(within(tenants.createdAt)),
        tx.select({ n: sql<number>`count(*)::int` }).from(staffUsers).where(within(staffUsers.createdAt)),
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(authEvents)
          .where(within(authEvents.createdAt, eq(authEvents.event, "sign_in"))),
        tx.select({ n: sql<number>`count(*)::int` }).from(platformAuditLog).where(within(platformAuditLog.createdAt)),
      ]);

      const tally = (rows: { k: string; n: number }[]) => Object.fromEntries(rows.map((r) => [r.k, r.n]));
      const sum = (rows: { n: number }[]) => rows.reduce((t, r) => t + r.n, 0);

      return {
        tenants: {
          total: sum(tenantsByType),
          byType: tally(tenantsByType),
          byStatus: tally(tenantsByStatus),
        },
        users: {
          total: sum(usersByStatus),
          byStatus: tally(usersByStatus),
        },
        platformAdmins: { count: Number((adminCount as unknown as { n: number }[])[0]?.n ?? 0) },
        recentAudit,
        recentSignIns,
        window: {
          from: window.from?.toISOString() ?? null,
          to: window.to?.toISOString() ?? null,
          newTenants: newTenants[0]?.n ?? 0,
          newUsers: newUsers[0]?.n ?? 0,
          signIns: signInCount[0]?.n ?? 0,
          auditEvents: auditCount[0]?.n ?? 0,
        },
        generatedAt: new Date().toISOString(),
      };
    });
  }
}

@ApiTags("platform")
@ApiBearerAuth()
@Roles(PLATFORM_ADMIN)
@Controller("api/admin/overview")
export class PlatformOverviewController {
  constructor(private readonly svc: PlatformOverviewService) {}

  @Get()
  @ApiOperation({ summary: "Platform-wide counts and recent activity" })
  @ApiQuery({ name: "from", required: false, description: "ISO start — scopes event-shaped data only" })
  @ApiQuery({ name: "to", required: false, description: "ISO end (inclusive)" })
  get(@Query("from") from?: string, @Query("to") to?: string) {
    return this.svc.get(parseDateWindow(from, to));
  }
}
