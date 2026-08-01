import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/db.tokens";
import {
  activities,
  inventoryLevels,
  products,
  productVariants,
  skus,
  stockMovements,
  warehouses,
  type MovementKind,
} from "../db/schema";

/** Threshold used when neither the level nor the SKU declares one. */
export const DEFAULT_LOW_STOCK_THRESHOLD = 10;

export interface MovementInput {
  skuId: string;
  warehouseId: string;
  kind: MovementKind;
  /** Signed change to on_hand. Zero for pure reserve/release. */
  qty?: number;
  /** Signed change to reserved. */
  reservedDelta?: number;
  refType?: string;
  refId?: string;
  refCode?: string;
  reason?: string;
  note?: string;
  actor?: string;
}

export interface LevelSnapshot {
  id: string;
  skuId: string;
  warehouseId: string;
  onHand: number;
  reserved: number;
  incoming: number;
  available: number;
}

/**
 * Every read and write of stock goes through here.
 *
 * The invariant this service exists to protect: `inventory_levels` and
 * `stock_movements` always agree. `applyMovement` is the only thing that
 * touches a level, and it appends the matching ledger row in the same
 * statement pair, inside the caller's transaction — so a movement can never
 * be written without its stock change, or vice versa.
 *
 * Callers own the transaction (`TenantDb.forTenant`) so a whole workflow —
 * create an order *and* reserve its lines — commits or rolls back together.
 */
@Injectable()
export class InventoryService {
  // --- SKUs -------------------------------------------------------------------

  /**
   * The SKU a line item refers to, falling back to the product's default SKU.
   * Creates SKUs on demand so products that predate the backfill (or were
   * imported since) still resolve instead of failing the whole order.
   */
  async resolveSku(
    tx: Db,
    tenantId: string,
    ref: { skuId?: string | null; productId?: string | null; variantId?: string | null },
  ) {
    if (ref.skuId) {
      const [row] = await tx
        .select()
        .from(skus)
        .where(and(eq(skus.tenantId, tenantId), eq(skus.id, ref.skuId)))
        .limit(1);
      if (row) return row;
    }

    if (!ref.productId) return null;

    if (ref.variantId) {
      const [row] = await tx
        .select()
        .from(skus)
        .where(and(eq(skus.tenantId, tenantId), eq(skus.variantId, ref.variantId)))
        .limit(1);
      if (row) return row;
    }

    const [fallback] = await tx
      .select()
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), eq(skus.productId, ref.productId), isNull(skus.variantId)))
      .limit(1);
    if (fallback) return fallback;

    const created = await this.ensureSkusForProduct(tx, tenantId, ref.productId);
    return created.find((s) => (ref.variantId ? s.variantId === ref.variantId : s.isDefault)) ?? created[0] ?? null;
  }

  /**
   * Reconciles a product's SKUs with its variants: one per variant plus one
   * default. Variants that were deleted leave their SKU behind as `archived` —
   * movements reference it, and a stock history that can vanish is not a
   * stock history.
   */
  async ensureSkusForProduct(
    tx: Db,
    tenantId: string,
    productId: string,
    opts: { codes?: Record<string, string | undefined>; barcodes?: Record<string, string | undefined> } = {},
  ) {
    const [product] = await tx
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, productId)))
      .limit(1);
    if (!product) throw new NotFoundException("Product not found");

    const variants = await tx
      .select()
      .from(productVariants)
      .where(and(eq(productVariants.tenantId, tenantId), eq(productVariants.productId, productId)))
      .orderBy(asc(productVariants.sort));

    const existing = await tx
      .select()
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), eq(skus.productId, productId)));

    const byVariant = new Map(existing.filter((s) => s.variantId).map((s) => [s.variantId!, s]));
    const base = slugSegment(product.styleCode || product.slug, 12);

    // Default SKU — the catch-all a variant-less line resolves to.
    if (!existing.some((s) => !s.variantId)) {
      const code = await this.uniqueCode(tx, tenantId, `${base}-STD`);
      await tx.insert(skus).values({
        tenantId,
        productId,
        variantId: null,
        code,
        name: product.nameEn,
        unit: product.unit,
        isDefault: true,
      });
    }

    for (const v of variants) {
      const current = byVariant.get(v.id);
      const name = `${product.nameEn} — ${v.label}`;
      if (current) {
        const patch: Record<string, unknown> = {};
        if (current.name !== name) patch.name = name;
        if (current.status === "archived") patch.status = "active";
        const wantedCode = opts.codes?.[v.id]?.trim();
        if (wantedCode && wantedCode !== current.code) patch.code = wantedCode;
        const wantedBarcode = opts.barcodes?.[v.id]?.trim();
        if (wantedBarcode !== undefined && wantedBarcode !== (current.barcode ?? "")) {
          patch.barcode = wantedBarcode || null;
        }
        if (Object.keys(patch).length > 0) {
          patch.updatedAt = new Date();
          await tx.update(skus).set(patch).where(eq(skus.id, current.id));
        }
        continue;
      }

      const code = opts.codes?.[v.id]?.trim() || (await this.uniqueCode(tx, tenantId, `${base}-${slugSegment(v.label, 12)}`));
      await tx.insert(skus).values({
        tenantId,
        productId,
        variantId: v.id,
        code,
        barcode: opts.barcodes?.[v.id]?.trim() || null,
        name,
        unit: product.unit,
        isDefault: false,
      });
    }

    // Archive SKUs whose variant is gone.
    const liveVariantIds = new Set(variants.map((v) => v.id));
    const orphans = existing.filter((s) => s.variantId && !liveVariantIds.has(s.variantId) && s.status === "active");
    if (orphans.length > 0) {
      await tx
        .update(skus)
        .set({ status: "archived", updatedAt: new Date() })
        .where(
          inArray(
            skus.id,
            orphans.map((s) => s.id),
          ),
        );
    }

    return tx
      .select()
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), eq(skus.productId, productId)))
      .orderBy(asc(skus.isDefault), asc(skus.createdAt));
  }

  /**
   * Appends `-2`, `-3`… until the code is free for this tenant. Bounded, then
   * falls back to a random suffix — the same no-sequence approach the packing
   * module uses for PKG- refs.
   */
  private async uniqueCode(tx: Db, tenantId: string, base: string): Promise<string> {
    const root = base.replace(/-+$/, "") || "SKU";
    for (let n = 1; n <= 50; n += 1) {
      const candidate = n === 1 ? root : `${root}-${n}`;
      const [clash] = await tx
        .select({ id: skus.id })
        .from(skus)
        .where(and(eq(skus.tenantId, tenantId), eq(skus.code, candidate)))
        .limit(1);
      if (!clash) return candidate;
    }
    return `${root}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  }

  /** Next `PREFIX-0001` for a tenant, matching the packing module's idiom. */
  async nextRef(tx: Db, tenantId: string, table: string, prefix: string): Promise<string> {
    const rows = await tx.execute(
      sql`select coalesce(max((substring(ref from ${`^${prefix}-(\\d+)$`}))::int), 0) + 1 as n
            from ${sql.raw(`public.${table}`)}
           where tenant_id = ${tenantId}`,
    );
    const next = Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 1);
    return `${prefix}-${String(next).padStart(4, "0")}`;
  }

  // --- Levels -----------------------------------------------------------------

  /**
   * Loads a level FOR UPDATE, creating it if absent. The row lock is what
   * serializes concurrent reservations for the same SKU: two orders racing for
   * the last unit queue here, so the second one sees the first one's hold.
   */
  private async lockLevel(
    tx: Db,
    tenantId: string,
    skuId: string,
    warehouseId: string,
  ): Promise<{ id: string; onHand: number; reserved: number; incoming: number }> {
    const locked = await tx.execute(
      sql`select * from public.inventory_levels
           where tenant_id = ${tenantId} and sku_id = ${skuId} and warehouse_id = ${warehouseId}
           for update`,
    );
    const row = (locked as unknown as Array<Record<string, unknown>>)[0];
    if (row) {
      return {
        id: row.id as string,
        onHand: Number(row.on_hand),
        reserved: Number(row.reserved),
        incoming: Number(row.incoming),
      };
    }

    const [sku] = await tx
      .select()
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), eq(skus.id, skuId)))
      .limit(1);
    if (!sku) throw new NotFoundException("SKU not found");

    const [warehouse] = await tx
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, warehouseId)))
      .limit(1);
    if (!warehouse) throw new NotFoundException("Warehouse not found");

    const [created] = await tx
      .insert(inventoryLevels)
      .values({
        tenantId,
        skuId,
        warehouseId,
        skuCode: sku.code,
        skuName: sku.name,
        warehouseName: warehouse.name,
      })
      .onConflictDoNothing()
      .returning();

    if (created) return { id: created.id, onHand: 0, reserved: 0, incoming: 0 };

    // Lost the insert race — the winner's row is committed, so re-lock it.
    return this.lockLevel(tx, tenantId, skuId, warehouseId);
  }

  /**
   * The only writer of `inventory_levels`. Applies the deltas and appends the
   * ledger row carrying the resulting balances, so the movement log is
   * auditable without replaying history.
   *
   * Negative results are rejected by the `inventory_levels_nonneg` check
   * constraint rather than clamped — silently absorbing an over-deduction is
   * how the old adjust endpoint let the stock mirror drift.
   */
  async applyMovement(tx: Db, tenantId: string, input: MovementInput): Promise<LevelSnapshot> {
    const qty = input.qty ?? 0;
    const reservedDelta = input.reservedDelta ?? 0;
    const level = await this.lockLevel(tx, tenantId, input.skuId, input.warehouseId);

    const onHand = level.onHand + qty;
    const reserved = level.reserved + reservedDelta;

    if (onHand < 0) {
      throw new ConflictException(
        `Not enough stock: ${level.onHand} on hand, tried to remove ${Math.abs(qty)}`,
      );
    }
    if (reserved < 0) {
      throw new ConflictException(
        `Cannot release more than is reserved: ${level.reserved} reserved, tried to release ${Math.abs(reservedDelta)}`,
      );
    }
    if (reserved > onHand) {
      throw new ConflictException(
        `Not enough available stock: ${onHand - level.reserved} available, tried to reserve ${reservedDelta}`,
      );
    }

    await tx
      .update(inventoryLevels)
      .set({ onHand, reserved, updatedAt: new Date() })
      .where(eq(inventoryLevels.id, level.id));

    await tx.insert(stockMovements).values({
      tenantId,
      skuId: input.skuId,
      warehouseId: input.warehouseId,
      kind: input.kind,
      qty,
      reservedDelta,
      onHandAfter: onHand,
      reservedAfter: reserved,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      refCode: input.refCode ?? null,
      reason: input.reason ?? null,
      note: input.note ?? null,
      actor: input.actor ?? "system",
    });

    return {
      id: level.id,
      skuId: input.skuId,
      warehouseId: input.warehouseId,
      onHand,
      reserved,
      incoming: level.incoming,
      available: onHand - reserved,
    };
  }

  /** Adjusts the `incoming` counter (dispatched transfers heading here). */
  async applyIncoming(tx: Db, tenantId: string, skuId: string, warehouseId: string, delta: number) {
    const level = await this.lockLevel(tx, tenantId, skuId, warehouseId);
    await tx
      .update(inventoryLevels)
      .set({ incoming: Math.max(0, level.incoming + delta), updatedAt: new Date() })
      .where(eq(inventoryLevels.id, level.id));
  }

  /** `on_hand - reserved` for a SKU, per warehouse and in total. */
  async availability(tx: Db, tenantId: string, skuId: string) {
    const rows = await tx
      .select()
      .from(inventoryLevels)
      .where(and(eq(inventoryLevels.tenantId, tenantId), eq(inventoryLevels.skuId, skuId)))
      .orderBy(desc(inventoryLevels.onHand));

    const byWarehouse = rows.map((r) => ({
      warehouseId: r.warehouseId,
      warehouseName: r.warehouseName,
      onHand: r.onHand,
      reserved: r.reserved,
      incoming: r.incoming,
      available: r.onHand - r.reserved,
      binLocation: r.binLocation,
    }));

    return {
      skuId,
      onHand: byWarehouse.reduce((n, r) => n + r.onHand, 0),
      reserved: byWarehouse.reduce((n, r) => n + r.reserved, 0),
      incoming: byWarehouse.reduce((n, r) => n + r.incoming, 0),
      available: byWarehouse.reduce((n, r) => n + r.available, 0),
      byWarehouse,
    };
  }

  /**
   * Picks the warehouse a line should be reserved against: the one that can
   * cover it outright, preferring central stock, then deepest availability.
   * Returns null when no single warehouse can — the caller decides whether
   * that's a shortfall or a split.
   */
  async pickWarehouse(tx: Db, tenantId: string, skuId: string, qty: number): Promise<string | null> {
    const rows = await tx
      .select({
        warehouseId: inventoryLevels.warehouseId,
        available: sql<number>`(${inventoryLevels.onHand} - ${inventoryLevels.reserved})::int`,
        type: warehouses.type,
      })
      .from(inventoryLevels)
      .innerJoin(warehouses, eq(warehouses.id, inventoryLevels.warehouseId))
      .where(
        and(
          eq(inventoryLevels.tenantId, tenantId),
          eq(inventoryLevels.skuId, skuId),
          eq(warehouses.status, "active"),
        ),
      )
      .orderBy(sql`(warehouses.type = 'central') desc`, desc(sql`(on_hand - reserved)`));

    return rows.find((r) => r.available >= qty)?.warehouseId ?? null;
  }

  /** The tenant's primary warehouse, used when nothing else is specified. */
  async defaultWarehouse(tx: Db, tenantId: string): Promise<string | null> {
    const [row] = await tx
      .select({ id: warehouses.id })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.status, "active")))
      .orderBy(sql`(type = 'central') desc`, asc(warehouses.createdAt))
      .limit(1);
    return row?.id ?? null;
  }

  // --- Derived state ------------------------------------------------------------

  /**
   * Recomputes `products.stock` as the sum of on-hand across the products'
   * SKUs. The column survives only as a mirror for the dashboard, the
   * storefront visibility check and the product list — nothing writes it
   * directly any more, which is what keeps it from drifting.
   */
  async syncProductStock(tx: Db, tenantId: string, skuIds: string[]) {
    if (skuIds.length === 0) return;
    const ids = sql.join(
      skuIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    await tx.execute(sql`
      update public.products p
         set stock = coalesce(agg.total, 0), updated_at = now()
        from (
          select s.product_id, coalesce(sum(l.on_hand), 0)::int as total
            from public.skus s
            left join public.inventory_levels l on l.sku_id = s.id
           where s.product_id in (
             select product_id from public.skus
              where tenant_id = ${tenantId} and id in (${ids})
           )
           group by s.product_id
        ) agg
       where p.id = agg.product_id
         and p.tenant_id = ${tenantId}
         and p.stock_mode = 'tracked'
         and p.stock is distinct from agg.total
    `);
  }

  /** Keeps the denormalized names on levels in step with a renamed SKU. */
  async syncSkuDenorm(tx: Db, tenantId: string, skuId: string) {
    await tx.execute(sql`
      update public.inventory_levels l
         set sku_code = s.code, sku_name = s.name, updated_at = now()
        from public.skus s
       where s.id = l.sku_id and l.sku_id = ${skuId} and l.tenant_id = ${tenantId}
         and (l.sku_code is distinct from s.code or l.sku_name is distinct from s.name)
    `);
  }

  /**
   * Audit trail. The old adjust endpoint wrote none, so a stock change had no
   * "who" — every inventory mutation records one now.
   */
  async writeActivity(
    tx: Db,
    tenantId: string,
    entry: { actor?: string; action: string; target: string; kind?: string },
  ) {
    await tx.insert(activities).values({
      tenantId,
      actor: entry.actor ?? "system",
      action: entry.action,
      target: entry.target,
      kind: entry.kind ?? "inventory",
    });
  }

  /** Low-stock warnings for the affected SKUs, in the shape the UI toasts. */
  async lowStockWarnings(tx: Db, tenantId: string, skuIds: string[]): Promise<string[]> {
    if (skuIds.length === 0) return [];
    const rows = await tx
      .select({
        name: skus.name,
        code: skus.code,
        unit: skus.unit,
        onHand: sql<number>`coalesce(sum(${inventoryLevels.onHand}), 0)::int`,
        reserved: sql<number>`coalesce(sum(${inventoryLevels.reserved}), 0)::int`,
        threshold: sql<number>`max(coalesce(${inventoryLevels.lowStockThreshold}, ${skus.lowStockThreshold}))::int`,
      })
      .from(skus)
      .leftJoin(inventoryLevels, eq(inventoryLevels.skuId, skus.id))
      .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, skuIds)))
      .groupBy(skus.id, skus.name, skus.code, skus.unit);

    const warnings: string[] = [];
    for (const r of rows) {
      const available = r.onHand - r.reserved;
      const threshold = r.threshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
      if (available <= 0) warnings.push(`${r.name || r.code} is out of stock`);
      else if (available <= threshold) warnings.push(`${r.name || r.code}: only ${available} ${r.unit} left`);
    }
    return warnings;
  }
}

/** Uppercase, hyphen-separated, alphanumeric-only fragment for SKU codes. */
function slugSegment(input: string, max: number): string {
  return (
    input
      .slice(0, max)
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toUpperCase() || "SKU"
  );
}
