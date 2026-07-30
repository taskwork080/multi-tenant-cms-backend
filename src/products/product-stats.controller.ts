import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { and, eq, sql } from "drizzle-orm";
import { orderItems, orders, reviews } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { CurrentTenant } from "../tenant/tenant.decorator";
import { TenantGuard } from "../tenant/tenant.guard";
import type { TenantDto } from "../tenant/tenant.service";

/**
 * Per-product rollups for the product detail page.
 *
 * `sold` used to be computed in the browser by summing line items across every
 * order the client had loaded — impossible once orders are paged.
 *
 * NOTE: registered inside ProductsModule, which precedes CrudModule in
 * app.module.ts, so `products/:id/stats` isn't swallowed by the generic
 * `@Get(":id")` on CrudController.
 */
@ApiTags("products")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@ApiParam({ name: "id", description: "Product id (uuid)" })
@Controller("api/:tenant/products/:id")
@UseGuards(TenantGuard)
export class ProductStatsController {
  constructor(private readonly tdb: TenantDb) {}

  @Get("stats")
  @ApiOperation({ summary: "Units sold and review rating summary for one product" })
  async stats(@CurrentTenant() tenant: TenantDto, @Param("id") id: string) {
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [[sold], ratingRows] = await Promise.all([
        tx
          .select({ units: sql<number>`coalesce(sum(${orderItems.qty}), 0)::int` })
          .from(orderItems)
          .innerJoin(orders, eq(orderItems.orderId, orders.id))
          .where(and(eq(orders.tenantId, tenant.id), eq(orderItems.productId, id))),
        // Rating histogram for the approved reviews of this product.
        tx
          .select({
            star: sql<number>`round(${reviews.rating})::int`,
            count: sql<number>`count(*)::int`,
          })
          .from(reviews)
          .where(and(eq(reviews.tenantId, tenant.id), eq(reviews.productId, id), eq(reviews.status, "approved")))
          .groupBy(sql`1`),
      ]);

      const totalReviews = ratingRows.reduce((n, r) => n + r.count, 0);
      const weighted = ratingRows.reduce((n, r) => n + r.star * r.count, 0);

      return {
        sold: sold?.units ?? 0,
        reviewCount: totalReviews,
        averageRating: totalReviews ? weighted / totalReviews : 0,
        // Always all five buckets so the UI doesn't have to fill gaps.
        distribution: [5, 4, 3, 2, 1].map((star) => ({
          star,
          count: ratingRows.find((r) => r.star === star)?.count ?? 0,
        })),
      };
    });
  }
}
