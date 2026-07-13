import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { and, eq, gte, sql } from "drizzle-orm";
import { customers, orders, products, returnRequests, shipments, stockBatches } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { CurrentTenant } from "../tenant/tenant.decorator";
import { TenantGuard } from "../tenant/tenant.guard";
import type { TenantDto } from "../tenant/tenant.service";

/** Aggregated stats backing the dashboard page (stat cards + charts). */
@ApiTags("dashboard")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@Controller("api/:tenant/dashboard")
@UseGuards(TenantGuard)
export class DashboardController {
  constructor(private readonly tdb: TenantDb) {}

  @Get()
  @ApiOperation({ summary: "Dashboard KPIs + 30-day order/revenue series" })
  async stats(@CurrentTenant() tenant: TenantDto) {
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const t = eq(orders.tenantId, tenant.id);
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);

      const [orderStats] = await tx
        .select({
          totalOrders: sql<number>`count(*)::int`,
          pendingOrders: sql<number>`count(*) filter (where delivery_status = 'pending')::int`,
          deliveredOrders: sql<number>`count(*) filter (where delivery_status = 'delivered')::int`,
          revenue: sql<number>`coalesce(sum(total) filter (where payment_status = 'paid'), 0)::float`,
          revenueThisMonth: sql<number>`coalesce(sum(total) filter (where payment_status = 'paid' and created_at >= ${monthStart}), 0)::float`,
        })
        .from(orders)
        .where(t);

      const [[productCount], [customerCount], [lowStock], [openReturns], [activeShipments]] = await Promise.all([
        tx.select({ n: sql<number>`count(*)::int` }).from(products).where(eq(products.tenantId, tenant.id)),
        tx.select({ n: sql<number>`count(*)::int` }).from(customers).where(eq(customers.tenantId, tenant.id)),
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(stockBatches)
          .where(and(eq(stockBatches.tenantId, tenant.id), sql`quantity <= low_stock_threshold`)),
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(returnRequests)
          .where(and(eq(returnRequests.tenantId, tenant.id), sql`status in ('requested','approved')`)),
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(shipments)
          .where(and(eq(shipments.tenantId, tenant.id), sql`status not in ('delivered','cancelled')`)),
      ]);

      // last 30 days of orders for the revenue/orders chart
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const daily = await tx
        .select({
          day: sql<string>`to_char(created_at, 'YYYY-MM-DD')`,
          orders: sql<number>`count(*)::int`,
          revenue: sql<number>`coalesce(sum(total), 0)::float`,
        })
        .from(orders)
        .where(and(t, gte(orders.createdAt, since)))
        .groupBy(sql`1`)
        .orderBy(sql`1`);

      return {
        ...orderStats,
        products: productCount.n,
        customers: customerCount.n,
        lowStockBatches: lowStock.n,
        openReturns: openReturns.n,
        activeShipments: activeShipments.n,
        daily,
      };
    });
  }
}
