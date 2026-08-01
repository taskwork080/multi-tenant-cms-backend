import { ConflictException, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/db.tokens";
import { inventoryReservations, orderItems, orders, products, skus } from "../db/schema";
import { InventoryService } from "./inventory.service";

export interface Shortfall {
  orderItemId: string;
  skuId: string | null;
  name: string;
  requested: number;
  available: number;
}

/**
 * The order half of the stock lifecycle: reserve on placement, deduct on
 * packing, release on cancellation.
 *
 * The distinction that makes this worth its own service: placing an order
 * *holds* stock, it does not consume it. Until the goods are physically picked
 * and packed they are still on the shelf — they just can't be promised to
 * anyone else. Deducting at placement (what the app did before) meant a
 * cancelled order had already destroyed the stock record, and a dispatch
 * deducted a second time.
 */
@Injectable()
export class FulfilmentService {
  constructor(private readonly inventory: InventoryService) {}

  /**
   * Places holds for every line of an order.
   *
   * Runs inside the caller's transaction, so a shortfall throwing here rolls
   * the order back with it — an order that cannot be fulfilled is never
   * created, which is the oversell guard.
   */
  async reserveOrder(
    tx: Db,
    tenantId: string,
    orderId: string,
    opts: { allowPartial?: boolean; actor?: string } = {},
  ): Promise<{ reserved: number; shortfalls: Shortfall[] }> {
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
      .limit(1);
    if (!order) return { reserved: 0, shortfalls: [] };

    const lines = await tx.select().from(orderItems).where(eq(orderItems.orderId, orderId));

    const shortfalls: Shortfall[] = [];
    let reserved = 0;

    for (const line of lines) {
      if (line.qty <= 0) continue;

      // `stockMode: "always"` products are never out of stock by definition,
      // so they carry no hold and never block an order.
      if (line.productId) {
        const [product] = await tx
          .select({ stockMode: products.stockMode })
          .from(products)
          .where(eq(products.id, line.productId))
          .limit(1);
        if (product?.stockMode === "always") continue;
      }

      const sku = await this.inventory.resolveSku(tx, tenantId, {
        skuId: line.skuId,
        productId: line.productId,
      });
      if (!sku) continue;

      const warehouseId =
        line.warehouseId ??
        (await this.inventory.pickWarehouse(tx, tenantId, sku.id, line.qty)) ??
        (await this.inventory.defaultWarehouse(tx, tenantId));

      if (!warehouseId) {
        shortfalls.push({
          orderItemId: line.id,
          skuId: sku.id,
          name: line.name || sku.name,
          requested: line.qty,
          available: 0,
        });
        continue;
      }

      const availability = await this.inventory.availability(tx, tenantId, sku.id);
      const here = availability.byWarehouse.find((w) => w.warehouseId === warehouseId);
      if ((here?.available ?? 0) < line.qty) {
        shortfalls.push({
          orderItemId: line.id,
          skuId: sku.id,
          name: line.name || sku.name,
          requested: line.qty,
          available: here?.available ?? 0,
        });
        if (!opts.allowPartial) continue;
      }

      const takeable = opts.allowPartial ? Math.min(line.qty, here?.available ?? 0) : line.qty;
      if (takeable <= 0) continue;

      // Idempotent: a retried order create hits the unique on
      // (order_item_id, warehouse_id) and no-ops instead of double-holding.
      const [existing] = await tx
        .select()
        .from(inventoryReservations)
        .where(
          and(eq(inventoryReservations.orderItemId, line.id), eq(inventoryReservations.warehouseId, warehouseId)),
        )
        .limit(1);
      if (existing) continue;

      await this.inventory.applyMovement(tx, tenantId, {
        skuId: sku.id,
        warehouseId,
        kind: "reserve",
        qty: 0,
        reservedDelta: takeable,
        refType: "order",
        refId: order.id,
        refCode: order.code,
        reason: "order_placed",
        actor: opts.actor,
      });

      await tx.insert(inventoryReservations).values({
        tenantId,
        skuId: sku.id,
        warehouseId,
        orderId: order.id,
        orderItemId: line.id,
        orderCode: order.code,
        skuCode: sku.code,
        skuName: sku.name,
        warehouseName: here?.warehouseName ?? "",
        qty: takeable,
      });

      // Remember where the line was reserved so packing deducts from the
      // same shelf it was promised from.
      await tx
        .update(orderItems)
        .set({ skuId: sku.id, warehouseId })
        .where(eq(orderItems.id, line.id));

      reserved += takeable;
    }

    if (shortfalls.length > 0 && !opts.allowPartial) {
      throw new ConflictException({
        message: "Not enough stock to place this order",
        shortfalls,
      });
    }

    return { reserved, shortfalls };
  }

  /**
   * Returns an order's outstanding holds to available. Naturally idempotent:
   * only `active` reservations are touched, and each records what it released.
   */
  async releaseOrder(
    tx: Db,
    tenantId: string,
    orderId: string,
    reason: "cancel" | "return" | "expire",
    actor?: string,
  ): Promise<number> {
    const held = await tx
      .select()
      .from(inventoryReservations)
      .where(
        and(
          eq(inventoryReservations.tenantId, tenantId),
          eq(inventoryReservations.orderId, orderId),
          eq(inventoryReservations.status, "active"),
        ),
      );

    let released = 0;
    const touched: string[] = [];

    for (const r of held) {
      const outstanding = r.qty - r.fulfilledQty - r.releasedQty;
      if (outstanding <= 0) continue;

      await this.inventory.applyMovement(tx, tenantId, {
        skuId: r.skuId,
        warehouseId: r.warehouseId,
        kind: "release",
        qty: 0,
        reservedDelta: -outstanding,
        refType: "order",
        refId: orderId,
        refCode: r.orderCode,
        reason: `order_${reason}`,
        actor,
      });

      await tx
        .update(inventoryReservations)
        .set({ releasedQty: r.releasedQty + outstanding, status: "released", updatedAt: new Date() })
        .where(eq(inventoryReservations.id, r.id));

      released += outstanding;
      touched.push(r.skuId);
    }

    await this.inventory.syncProductStock(tx, tenantId, touched);
    return released;
  }

  /**
   * Converts holds into an actual deduction — the goods have been picked.
   *
   * Any quantity beyond what was reserved (a packing sheet that ships more
   * than the order, or a packing list with no order behind it at all) comes
   * straight off on-hand, where the non-negative constraint stops it going
   * below zero.
   */
  async deduct(
    tx: Db,
    tenantId: string,
    lines: { skuId: string; qty: number; warehouseId?: string | null }[],
    ref: { type: string; id: string; code?: string; orderId?: string | null },
    actor?: string,
  ): Promise<{ deducted: number; warnings: string[] }> {
    let deducted = 0;
    const touched: string[] = [];

    for (const line of lines) {
      if (line.qty <= 0) continue;

      const open = ref.orderId
        ? await tx
            .select()
            .from(inventoryReservations)
            .where(
              and(
                eq(inventoryReservations.tenantId, tenantId),
                eq(inventoryReservations.orderId, ref.orderId),
                eq(inventoryReservations.skuId, line.skuId),
                eq(inventoryReservations.status, "active"),
              ),
            )
        : [];

      let remaining = line.qty;

      for (const r of open) {
        if (remaining <= 0) break;
        const outstanding = r.qty - r.fulfilledQty - r.releasedQty;
        if (outstanding <= 0) continue;
        const take = Math.min(outstanding, remaining);

        await this.inventory.applyMovement(tx, tenantId, {
          skuId: r.skuId,
          warehouseId: r.warehouseId,
          kind: "deduct",
          qty: -take,
          reservedDelta: -take,
          refType: ref.type,
          refId: ref.id,
          refCode: ref.code,
          reason: "packed",
          actor,
        });

        const fulfilled = r.fulfilledQty + take;
        await tx
          .update(inventoryReservations)
          .set({
            fulfilledQty: fulfilled,
            status: fulfilled + r.releasedQty >= r.qty ? "fulfilled" : "active",
            updatedAt: new Date(),
          })
          .where(eq(inventoryReservations.id, r.id));

        remaining -= take;
        deducted += take;
        touched.push(r.skuId);
      }

      if (remaining > 0) {
        const warehouseId =
          line.warehouseId ??
          (await this.inventory.pickWarehouse(tx, tenantId, line.skuId, remaining)) ??
          (await this.inventory.defaultWarehouse(tx, tenantId));
        if (!warehouseId) continue;

        await this.inventory.applyMovement(tx, tenantId, {
          skuId: line.skuId,
          warehouseId,
          kind: "deduct",
          qty: -remaining,
          refType: ref.type,
          refId: ref.id,
          refCode: ref.code,
          reason: "packed_unreserved",
          actor,
        });
        deducted += remaining;
        touched.push(line.skuId);
      }
    }

    await this.inventory.syncProductStock(tx, tenantId, touched);
    return { deducted, warnings: await this.inventory.lowStockWarnings(tx, tenantId, touched) };
  }

  /** Puts returned goods back on the shelf. */
  async returnToStock(
    tx: Db,
    tenantId: string,
    lines: { skuId: string; qty: number; warehouseId?: string | null }[],
    ref: { type: string; id: string; code?: string },
    actor?: string,
  ) {
    const touched: string[] = [];
    for (const line of lines) {
      if (line.qty <= 0) continue;
      const warehouseId = line.warehouseId ?? (await this.inventory.defaultWarehouse(tx, tenantId));
      if (!warehouseId) continue;
      await this.inventory.applyMovement(tx, tenantId, {
        skuId: line.skuId,
        warehouseId,
        kind: "return_in",
        qty: line.qty,
        refType: ref.type,
        refId: ref.id,
        refCode: ref.code,
        reason: "customer_return",
        actor,
      });
      touched.push(line.skuId);
    }
    await this.inventory.syncProductStock(tx, tenantId, touched);
  }

  /** Has any movement already been written for this document? */
  async alreadyProcessed(tx: Db, tenantId: string, refType: string, refId: string): Promise<boolean> {
    const rows = await tx.execute(sql`
      select 1 from public.stock_movements
       where tenant_id = ${tenantId} and ref_type = ${refType} and ref_id = ${refId}
         and kind = 'deduct' limit 1
    `);
    return (rows as unknown as unknown[]).length > 0;
  }

  /** Resolves an order code to its id — packing lists reference orders by code. */
  async orderByCode(tx: Db, tenantId: string, code: string) {
    const [row] = await tx
      .select({ id: orders.id, code: orders.code })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.code, code)))
      .limit(1);
    return row ?? null;
  }

  /** Bulk SKU lookup used when resolving packing lines. */
  async skusByIds(tx: Db, tenantId: string, ids: string[]) {
    if (ids.length === 0) return [];
    return tx
      .select()
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, ids)));
  }
}
