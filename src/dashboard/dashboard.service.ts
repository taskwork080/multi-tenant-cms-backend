import { Injectable } from "@nestjs/common";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
  categories,
  customers,
  inventoryLevels,
  orderItems,
  orders,
  products,
  returnRequests,
  shipments,
} from "../db/schema";
import { previousWindow, type DateWindow } from "../common/date-window";
import { TenantDb } from "../db/tenant-db.service";
import type { TenantDto } from "../tenant/tenant.service";

export type Period = "7" | "30" | "all";

const DAY_MS = 86_400_000;
const LOW_STOCK = 10;

/**
 * Low stock means low *available* — stock already held by an open order can't
 * fill the next one, so counting it would hide the shortage until someone
 * tried to sell it. A level's own threshold wins over the global default.
 */
const LOW_STOCK_PREDICATE = sql`(on_hand - reserved) <= coalesce(low_stock_threshold, ${LOW_STOCK})`;

/** Revenue/volume totals for one time window. */
export interface WindowStats {
  revenue: number;
  orders: number;
  aov: number;
  activeCustomers: number;
}

/**
 * Everything the dashboard renders, as SQL aggregates.
 *
 * Replaces a page that pulled every order, product, shipment, batch and
 * customer into the browser to compute these in JavaScript.
 *
 * NOTE: there is deliberately no `profit` here. The old client-side figure came
 * from `cogsRatio()` — a hash of the product id, not cost data, which does not
 * exist in the schema. Reporting a fabricated margin from the API would give it
 * false authority; the metric returns when a real cost column does.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly tdb: TenantDb) {}

  async stats(tenant: TenantDto, period: Period = "30", window: DateWindow = { from: null, to: null }) {
    const days = period === "all" ? null : Number(period);
    const now = new Date();

    // An explicit from/to wins; otherwise fall back to the trailing preset.
    // NOTE: "all" (days === null) leaves both windows open-ended, so `previous`
    // equals `current` and every delta renders 0%. That is pre-existing
    // behaviour — the deltas are simply not meaningful for "all time".
    const cur: DateWindow =
      window.from || window.to
        ? window
        : { from: days ? new Date(now.getTime() - days * DAY_MS) : null, to: null };
    const prev = previousWindow(cur, now);

    // Bucket by month once a window is long enough that a daily series would be
    // unreadable. 'YYYY-MM-DD' rather than 'MM-DD' because arbitrary ranges can
    // now span a year boundary, where 'MM-DD' silently folds the two together.
    const spanDays = cur.from ? ((cur.to ?? now).getTime() - cur.from.getTime()) / DAY_MS : Infinity;
    const granularity: "day" | "month" = spanDays > 92 ? "month" : "day";

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const t = eq(orders.tenantId, tenant.id);
      /** Tenant scope + the current window, for the queries that report on it. */
      const inWindow = and(
        t,
        ...(cur.from ? [gte(orders.createdAt, cur.from)] : []),
        ...(cur.to ? [lt(orders.createdAt, cur.to)] : []),
      );

      /**
       * Revenue is summed from line items so it matches the old client math.
       * `to` is exclusive, which is what keeps the current and previous windows
       * from both counting the row that sits exactly on their shared boundary.
       */
      const windowStats = async (from: Date | null, to: Date | null): Promise<WindowStats> => {
        const range = [t];
        if (from) range.push(gte(orders.createdAt, from));
        if (to) range.push(lt(orders.createdAt, to));
        const where = and(...range);

        const [[totals], [lines]] = await Promise.all([
          tx
            .select({
              orders: sql<number>`count(*)::int`,
              activeCustomers: sql<number>`count(distinct ${orders.customerId})::int`,
            })
            .from(orders)
            .where(where),
          tx
            .select({ revenue: sql<number>`coalesce(sum(${orderItems.qty} * ${orderItems.unitPrice}), 0)::float` })
            .from(orderItems)
            .innerJoin(orders, eq(orderItems.orderId, orders.id))
            .where(where),
        ]);

        const count = totals?.orders ?? 0;
        const revenue = lines?.revenue ?? 0;
        return {
          revenue,
          orders: count,
          aov: count ? revenue / count : 0,
          activeCustomers: totals?.activeCustomers ?? 0,
        };
      };

      const [current, previous] = await Promise.all([
        windowStats(cur.from, cur.to),
        windowStats(prev.from, prev.to),
      ]);

      const [
        daily,
        statusBreakdown,
        carriers,
        byCategory,
        stockHealth,
        lowStockBatches,
        lowStockCountRows,
        onTimeRows,
        inTransit,
        counts,
      ] = await Promise.all([
        // Daily revenue/orders for the chart.
        tx
          .select({
            date:
              granularity === "month"
                ? sql<string>`to_char(${orders.createdAt}, 'YYYY-MM')`
                : sql<string>`to_char(${orders.createdAt}, 'YYYY-MM-DD')`,
            orders: sql<number>`count(distinct ${orders.id})::int`,
            revenue: sql<number>`coalesce(sum(${orderItems.qty} * ${orderItems.unitPrice}), 0)::float`,
          })
          .from(orders)
          .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
          .where(inWindow)
          .groupBy(sql`1`)
          .orderBy(sql`1`),

        tx
          .select({ status: shipments.status, value: sql<number>`count(*)::int` })
          .from(shipments)
          .where(eq(shipments.tenantId, tenant.id))
          .groupBy(shipments.status),

        // Carrier performance. avgDays is created_at → last tracking event, for
        // delivered shipments only — the same definition the page used.
        tx
          .select({
            carrier: sql<string>`coalesce(${shipments.carrier}, 'Unassigned')`,
            shipments: sql<number>`count(*)::int`,
            delivered: sql<number>`count(*) filter (where ${shipments.status} = 'delivered')::int`,
            avgDays: sql<number>`coalesce(avg(
              extract(epoch from (last_event.at - ${shipments.createdAt})) / 86400
            ) filter (where ${shipments.status} = 'delivered'), 0)::float`,
          })
          .from(shipments)
          .leftJoin(
            sql`(select shipment_id, max(at) as at from shipment_events group by shipment_id) as last_event`,
            sql`last_event.shipment_id = ${shipments.id}`,
          )
          .where(eq(shipments.tenantId, tenant.id))
          .groupBy(sql`1`)
          .orderBy(sql`2 desc`),

        // Product mix by category, top 6.
        tx
          .select({
            categoryId: products.categoryId,
            name: sql<string>`coalesce(${categories.nameEn}, '—')`,
            count: sql<number>`count(*)::int`,
          })
          .from(products)
          .leftJoin(categories, eq(products.categoryId, categories.id))
          .where(eq(products.tenantId, tenant.id))
          .groupBy(products.categoryId, categories.nameEn)
          .orderBy(sql`3 desc`)
          .limit(6),

        tx
          .select({
            inStock: sql<number>`count(*) filter (where ${products.stock} > ${LOW_STOCK})::int`,
            low: sql<number>`count(*) filter (where ${products.stock} > 0 and ${products.stock} <= ${LOW_STOCK})::int`,
            out: sql<number>`count(*) filter (where ${products.stock} = 0)::int`,
          })
          .from(products)
          .where(eq(products.tenantId, tenant.id)),

        // Reads inventory_levels — the stock truth — rather than the legacy
        // stock_batches rows, which only the old flat receive path maintains.
        // Field names are kept so the dashboard widget renders unchanged;
        // `quantity` now carries available (on hand minus reserved).
        tx
          .select({
            id: inventoryLevels.id,
            productId: inventoryLevels.skuId,
            productName: inventoryLevels.skuName,
            warehouseId: inventoryLevels.warehouseId,
            warehouseName: inventoryLevels.warehouseName,
            quantity: sql<number>`(on_hand - reserved)::int`,
            lowStockThreshold: sql<number>`coalesce(low_stock_threshold, ${LOW_STOCK})::int`,
          })
          .from(inventoryLevels)
          .where(and(eq(inventoryLevels.tenantId, tenant.id), LOW_STOCK_PREDICATE))
          .orderBy(sql`(on_hand - reserved) asc`)
          .limit(5),

        // Count as well as the top-5 rows — the notes "business snapshot" wants
        // the total, not a sample.
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(inventoryLevels)
          .where(and(eq(inventoryLevels.tenantId, tenant.id), LOW_STOCK_PREDICATE)),

        // On-time delivery: of delivered shipments that had an ETA, how many
        // had their last tracking event on or before it. `eta` is stored as an
        // ISO string, so the cast is safe.
        tx.execute<{ base: number; ontime: number }>(sql`
          select
            count(*)::int as base,
            count(*) filter (where last_event.at <= s.eta::timestamptz)::int as ontime
          from shipments s
          left join (select shipment_id, max(at) as at from shipment_events group by shipment_id) last_event
            on last_event.shipment_id = s.id
          where s.tenant_id = ${tenant.id}
            and s.status = 'delivered'
            and s.eta is not null
            and last_event.at is not null
        `),

        // Feeds the "In-Transit" widget — the moving statuses only.
        tx
          .select()
          .from(shipments)
          .where(
            and(
              eq(shipments.tenantId, tenant.id),
              sql`${shipments.status} in ('dispatched','in_transit','out_for_delivery')`,
            ),
          )
          .orderBy(sql`${shipments.createdAt} desc`)
          .limit(5),

        Promise.all([
          tx.select({ n: sql<number>`count(*)::int` }).from(products).where(eq(products.tenantId, tenant.id)),
          tx.select({ n: sql<number>`count(*)::int` }).from(customers).where(eq(customers.tenantId, tenant.id)),
          tx
            .select({ n: sql<number>`count(*)::int` })
            .from(returnRequests)
            .where(and(eq(returnRequests.tenantId, tenant.id), sql`status in ('requested','approved')`)),
          tx
            .select({ n: sql<number>`count(*)::int` })
            .from(shipments)
            .where(and(eq(shipments.tenantId, tenant.id), sql`status not in ('delivered','cancelled')`)),
        ]),
      ]);

      // Top products by revenue in the window — from order lines, so it
      // reflects what actually sold rather than catalog data.
      const topProducts = await tx
        .select({
          productId: orderItems.productId,
          name: sql<string>`max(${orderItems.name})`,
          units: sql<number>`coalesce(sum(${orderItems.qty}), 0)::int`,
          revenue: sql<number>`coalesce(sum(${orderItems.qty} * ${orderItems.unitPrice}), 0)::float`,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .where(inWindow)
        .groupBy(orderItems.productId)
        .orderBy(sql`4 desc`)
        .limit(5);

      const [[productCount], [customerCount], [openReturns], [activeShipments]] = counts;
      const onTimeBase = Number(onTimeRows[0]?.base ?? 0);
      const onTimeHit = Number(onTimeRows[0]?.ontime ?? 0);

      return {
        period,
        from: cur.from?.toISOString() ?? null,
        to: cur.to?.toISOString() ?? null,
        granularity,
        current,
        previous,
        daily,
        shipments: {
          total: statusBreakdown.reduce((n, r) => n + r.value, 0),
          breakdown: statusBreakdown,
          carriers: carriers.map((c) => ({
            ...c,
            deliveryRate: c.shipments ? (c.delivered / c.shipments) * 100 : 0,
          })),
          inTransit,
          onTimeRate: onTimeBase ? Math.round((onTimeHit / onTimeBase) * 100) : 0,
        },
        products: {
          total: productCount.n,
          byCategory,
          stockHealth: stockHealth[0] ?? { inStock: 0, low: 0, out: 0 },
          top: topProducts,
        },
        customers: customerCount.n,
        openReturns: openReturns.n,
        activeShipments: activeShipments.n,
        lowStockBatches,
        lowStockCount: lowStockCountRows[0]?.n ?? 0,
      };
    });
  }
}

export type DashboardStats = Awaited<ReturnType<DashboardService["stats"]>>;
