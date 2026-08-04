import { Controller, Get, Injectable, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { and, desc, eq, gte, ilike, inArray, lte, sql, type SQL } from "drizzle-orm";
import { PLATFORM_ADMIN } from "../auth/auth.types";
import { Roles } from "../auth/decorators";
import { TenantDb } from "../db/tenant-db.service";
import { platformAuditLog, tenants } from "../db/schema";
import { auditListSchema } from "./dto";

@Injectable()
export class PlatformAuditService {
  constructor(private readonly tdb: TenantDb) {}

  async list(query: unknown) {
    const q = auditListSchema.parse(query);

    const where: SQL[] = [];
    if (q.q) where.push(ilike(platformAuditLog.actorEmail, `%${q.q}%`));
    if (q.actorId) where.push(eq(platformAuditLog.actorId, q.actorId));
    if (q.action) {
      const actions = Array.isArray(q.action) ? q.action : [q.action];
      where.push(actions.length === 1 ? eq(platformAuditLog.action, actions[0]) : inArray(platformAuditLog.action, actions));
    }
    if (q.targetType) where.push(eq(platformAuditLog.targetType, q.targetType));
    if (q.targetId) where.push(eq(platformAuditLog.targetId, q.targetId));
    if (q.tenantId) where.push(eq(platformAuditLog.tenantId, q.tenantId));
    if (q.createdAt?.gte) where.push(gte(platformAuditLog.createdAt, new Date(q.createdAt.gte)));
    if (q.createdAt?.lte) where.push(lte(platformAuditLog.createdAt, new Date(q.createdAt.lte)));

    const predicate = where.length ? and(...where) : undefined;
    const offset = (q.page - 1) * q.pageSize;

    return this.tdb.asPlatform(async (tx) => {
      const [rows, [{ count }]] = await Promise.all([
        tx
          .select({
            id: platformAuditLog.id,
            actorId: platformAuditLog.actorId,
            actorEmail: platformAuditLog.actorEmail,
            action: platformAuditLog.action,
            targetType: platformAuditLog.targetType,
            targetId: platformAuditLog.targetId,
            tenantId: platformAuditLog.tenantId,
            tenantName: tenants.name,
            tenantSlug: tenants.slug,
            before: platformAuditLog.before,
            after: platformAuditLog.after,
            ip: platformAuditLog.ip,
            userAgent: platformAuditLog.userAgent,
            createdAt: platformAuditLog.createdAt,
          })
          .from(platformAuditLog)
          .leftJoin(tenants, eq(tenants.id, platformAuditLog.tenantId))
          .where(predicate)
          // id tiebreak: many rows share a millisecond within one request.
          .orderBy(desc(platformAuditLog.createdAt), desc(platformAuditLog.id))
          .limit(q.pageSize)
          .offset(offset),
        tx.select({ count: sql<number>`count(*)::int` }).from(platformAuditLog).where(predicate),
      ]);
      return { data: rows, total: count, page: q.page, pageSize: q.pageSize };
    });
  }
}

@ApiTags("platform")
@ApiBearerAuth()
@Roles(PLATFORM_ADMIN)
@Controller("api/admin/audit-log")
export class PlatformAuditController {
  constructor(private readonly svc: PlatformAuditService) {}

  @Get()
  @ApiOperation({ summary: "Platform audit trail: every super-admin mutation" })
  @ApiQuery({ name: "action", required: false, description: "Repeat the key for an IN filter" })
  @ApiQuery({ name: "actorId", required: false })
  @ApiQuery({ name: "targetType", required: false })
  @ApiQuery({ name: "tenantId", required: false })
  list(@Query() query: Record<string, unknown>) {
    return this.svc.list(query);
  }
}
