import { Controller, Get, Injectable } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { desc, eq, sql } from "drizzle-orm";
import { PLATFORM_ADMIN } from "../auth/auth.types";
import { Roles } from "../auth/decorators";
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

  async get() {
    return this.tdb.asPlatform(async (tx) => {
      const [tenantsByType, tenantsByStatus, usersByStatus, adminCount, recentAudit, recentSignIns] = await Promise.all([
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
          .where(eq(authEvents.event, "sign_in"))
          .orderBy(desc(authEvents.createdAt))
          .limit(10),
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
  get() {
    return this.svc.get();
  }
}
