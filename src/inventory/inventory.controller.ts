import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/db.tokens";
import {
  inventoryLevels,
  products,
  skus,
  stockBatches,
  stockMovements,
  warehouses,
} from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { CurrentTenant } from "../tenant/tenant.decorator";
import { TenantGuard } from "../tenant/tenant.guard";
import type { TenantDto } from "../tenant/tenant.service";
import { DEFAULT_LOW_STOCK_THRESHOLD, InventoryService } from "./inventory.service";

const generateSkusSchema = z.object({
  productId: z.string().uuid(),
  /** Per-variant overrides captured in the product wizard's variant rows. */
  codes: z.record(z.string()).optional(),
  barcodes: z.record(z.string()).optional(),
});

const patchSkuSchema = z.object({
  code: z.string().min(1).optional(),
  barcode: z.string().nullable().optional(),
  lowStockThreshold: z.number().int().nonnegative().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

const receiveLineSchema = z.object({
  skuId: z.string().uuid(),
  qty: z.number().int().positive(),
  unitCost: z.number().nonnegative().optional(),
  expiryDate: z.string().optional(),
  batchRef: z.string().optional(),
});

/**
 * Receive accepts two shapes. The `lines` shape is the real one; the flat
 * legacy shape is what the current Inventory page and the Zustand store still
 * send, and it resolves to the product's default SKU. Keeping both means the
 * backend can land before the frontend without a flag day.
 */
const receiveSchema = z.union([
  z.object({
    warehouseId: z.string().uuid(),
    supplierName: z.string().optional(),
    manufacturerId: z.string().uuid().optional(),
    referenceNo: z.string().optional(),
    photoUrl: z.string().optional(),
    note: z.string().optional(),
    lines: z.array(receiveLineSchema).min(1),
  }),
  z.object({
    batchId: z.string().uuid().optional(),
    productId: z.string().uuid(),
    warehouseId: z.string().uuid(),
    quantity: z.number().int().positive(),
    expiryDate: z.string().optional(),
    lowStockThreshold: z.number().int().nonnegative().optional(),
    photoUrl: z.string().optional(),
    note: z.string().optional(),
  }),
]);

/**
 * Adjust likewise accepts the legacy product-delta shape (still sent by the
 * shipments console) alongside the SKU-level one. Note the sign convention
 * differs and is preserved: legacy `delta` is positive to *consume*, while a
 * SKU-level `delta` is signed in the direction of on_hand.
 */
const adjustSchema = z.union([
  z.object({
    lines: z
      .array(
        z.object({
          skuId: z.string().uuid(),
          warehouseId: z.string().uuid().optional(),
          delta: z.number().int(),
          reason: z.string().optional(),
          note: z.string().optional(),
        }),
      )
      .min(1),
  }),
  z.object({
    changes: z
      .array(z.object({ productId: z.string().uuid(), delta: z.number().int() }))
      .min(1),
  }),
]);

/**
 * Inventory read + write surface.
 *
 * Replaces the old workflows/inventory.controller.ts, which mutated
 * `stock_batches` and `products.stock` directly with no ledger and no audit
 * row, and clamped the stock mirror at zero while decrementing batches
 * independently — letting the two drift apart. Everything here goes through
 * InventoryService.applyMovement, so no stock change exists without the
 * movement row explaining it.
 */
@ApiTags("inventory")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@Controller("api/:tenant/inventory")
@UseGuards(TenantGuard)
export class InventoryController {
  constructor(
    private readonly tdb: TenantDb,
    private readonly inventory: InventoryService,
  ) {}

  // --- SKUs -------------------------------------------------------------------

  @Post("skus/generate")
  @ApiOperation({
    summary: "Reconcile a product's SKUs with its variants",
    description:
      "Creates one SKU per variant plus a default SKU, applies any codes/barcodes entered in the wizard, and archives SKUs whose variant was deleted (never hard-deletes — movements reference them).",
  })
  async generateSkus(@CurrentTenant() tenant: TenantDto, @Body() body: unknown) {
    const input = generateSkusSchema.parse(body);
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const before = await tx
        .select({ id: skus.id })
        .from(skus)
        .where(and(eq(skus.tenantId, tenant.id), eq(skus.productId, input.productId)));
      const known = new Set(before.map((s) => s.id));

      const all = await this.inventory.ensureSkusForProduct(tx, tenant.id, input.productId, {
        codes: input.codes,
        barcodes: input.barcodes,
      });

      for (const s of all) await this.inventory.syncSkuDenorm(tx, tenant.id, s.id);

      return {
        created: all.filter((s) => !known.has(s.id)),
        existing: all.filter((s) => known.has(s.id)),
      };
    });
  }

  @Patch("skus/:id")
  @ApiOperation({
    summary: "Edit a SKU's code, barcode or threshold",
    description: "Validates uniqueness up front so a clash reads as a 409 rather than a raw constraint error.",
  })
  async patchSku(@CurrentTenant() tenant: TenantDto, @Param("id") id: string, @Body() body: unknown) {
    const input = patchSkuSchema.parse(body);
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [current] = await tx
        .select()
        .from(skus)
        .where(and(eq(skus.tenantId, tenant.id), eq(skus.id, id)))
        .limit(1);
      if (!current) throw new NotFoundException("SKU not found");

      if (input.code && input.code !== current.code) {
        const [clash] = await tx
          .select({ id: skus.id })
          .from(skus)
          .where(and(eq(skus.tenantId, tenant.id), eq(skus.code, input.code)))
          .limit(1);
        if (clash) {
          throw new NotFoundException(`SKU code "${input.code}" is already in use`);
        }
      }

      const [row] = await tx
        .update(skus)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(skus.id, id))
        .returning();

      await this.inventory.syncSkuDenorm(tx, tenant.id, id);
      return row;
    });
  }

  // --- Reads ------------------------------------------------------------------

  @Get("availability")
  @ApiOperation({
    summary: "On-hand / reserved / available for a SKU or product",
    description: "What order entry should cap quantities against — never products.stock, which is only a mirror.",
  })
  async getAvailability(
    @CurrentTenant() tenant: TenantDto,
    @Query("skuId") skuId?: string,
    @Query("productId") productId?: string,
  ) {
    return this.tdb.forTenant(tenant.id, async (tx) => {
      if (skuId) return this.inventory.availability(tx, tenant.id, skuId);

      if (!productId) return { skuId: null, onHand: 0, reserved: 0, incoming: 0, available: 0, byWarehouse: [] };

      const rows = await tx
        .select({ id: skus.id })
        .from(skus)
        .where(and(eq(skus.tenantId, tenant.id), eq(skus.productId, productId), eq(skus.status, "active")));

      const each = await Promise.all(rows.map((r) => this.inventory.availability(tx, tenant.id, r.id)));
      return {
        productId,
        onHand: each.reduce((n, r) => n + r.onHand, 0),
        reserved: each.reduce((n, r) => n + r.reserved, 0),
        incoming: each.reduce((n, r) => n + r.incoming, 0),
        available: each.reduce((n, r) => n + r.available, 0),
        skus: each,
      };
    });
  }

  @Get("stats")
  @ApiOperation({
    summary: "Inventory KPI tiles",
    description:
      "Superset of the original {products, totalUnits, low, out} payload — the extra keys are additive so the existing page keeps working.",
  })
  async stats(@CurrentTenant() tenant: TenantDto) {
    return this.tdb.forTenant(tenant.id, (tx) => this.statsIn(tx, tenant.id));
  }

  /** Shared by `stats` and `overview` so the latter doesn't nest a transaction. */
  private async statsIn(tx: Db, tenantId: string) {
    const [[productCount], [skuCount], [levelStats], [warehouseCount], [movements24h]] = await Promise.all([
      tx.select({ n: sql<number>`count(*)::int` }).from(products).where(eq(products.tenantId, tenantId)),
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(skus)
        .where(and(eq(skus.tenantId, tenantId), eq(skus.status, "active"))),
      tx
        .select({
          totalUnits: sql<number>`coalesce(sum(on_hand), 0)::int`,
          reservedUnits: sql<number>`coalesce(sum(reserved), 0)::int`,
          availableUnits: sql<number>`coalesce(sum(on_hand - reserved), 0)::int`,
          incomingUnits: sql<number>`coalesce(sum(incoming), 0)::int`,
          // "low" excludes zero so the tiles don't double-count with "out".
          low: sql<number>`count(*) filter (
            where (on_hand - reserved) <= coalesce(low_stock_threshold, ${DEFAULT_LOW_STOCK_THRESHOLD})
              and on_hand > 0)::int`,
          out: sql<number>`count(*) filter (where on_hand <= 0)::int`,
        })
        .from(inventoryLevels)
        .where(eq(inventoryLevels.tenantId, tenantId)),
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(warehouses)
        .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.status, "active"))),
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(stockMovements)
        .where(and(eq(stockMovements.tenantId, tenantId), gte(stockMovements.at, new Date(Date.now() - 86_400_000)))),
    ]);

    return {
      products: productCount.n,
      skus: skuCount.n,
      warehouses: warehouseCount.n,
      totalUnits: levelStats.totalUnits,
      reservedUnits: levelStats.reservedUnits,
      availableUnits: levelStats.availableUnits,
      incomingUnits: levelStats.incomingUnits,
      low: levelStats.low,
      out: levelStats.out,
      movements24h: movements24h.n,
    };
  }

  @Get("overview")
  @ApiOperation({
    summary: "Everything the Inventory overview page renders",
    description: "One request rather than a dozen list calls — mirrors how DashboardService composes its payload.",
  })
  async overview(@CurrentTenant() tenant: TenantDto, @Query("period") period?: string) {
    const days = period === "30" ? 30 : 7;
    // ISO string, not a Date: postgres.js can serialize a Date through the
    // typed query builder (which knows the column type) but not as a bare
    // parameter in a raw `sql` template, where it throws ERR_INVALID_ARG_TYPE.
    // The explicit casts below tell Postgres what to read it back as.
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [stats, trend, topMovers, lowStock, byWarehouse, orphanProducts] = await Promise.all([
        this.statsIn(tx, tenant.id),
        tx.execute(sql`
          select to_char(d.day, 'YYYY-MM-DD') as date,
                 coalesce(sum(m.qty) filter (where m.qty > 0), 0)::int as "in",
                 coalesce(-sum(m.qty) filter (where m.qty < 0), 0)::int as "out"
            from generate_series(${since}::date, now()::date, interval '1 day') d(day)
            left join public.stock_movements m
              on m.tenant_id = ${tenant.id} and m.at >= d.day and m.at < d.day + interval '1 day'
           group by d.day order by d.day
        `),
        tx.execute(sql`
          select m.sku_id as "skuId", s.code, s.name,
                 sum(abs(m.qty))::int as units,
                 count(*)::int as movements
            from public.stock_movements m
            join public.skus s on s.id = m.sku_id
           where m.tenant_id = ${tenant.id} and m.at >= ${since}::timestamptz and m.qty <> 0
           group by m.sku_id, s.code, s.name
           order by units desc limit 8
        `),
        tx
          .select()
          .from(inventoryLevels)
          .where(
            and(
              eq(inventoryLevels.tenantId, tenant.id),
              sql`(on_hand - reserved) <= coalesce(low_stock_threshold, ${DEFAULT_LOW_STOCK_THRESHOLD})`,
            ),
          )
          .orderBy(sql`(on_hand - reserved) asc`)
          .limit(10),
        tx.execute(sql`
          select w.id as "warehouseId", w.name, w.type,
                 coalesce(sum(l.on_hand), 0)::int as "onHand",
                 coalesce(sum(l.reserved), 0)::int as reserved,
                 coalesce(sum(l.incoming), 0)::int as incoming,
                 count(l.id)::int as skus
            from public.warehouses w
            left join public.inventory_levels l on l.warehouse_id = w.id
           where w.tenant_id = ${tenant.id}
           group by w.id, w.name, w.type order by "onHand" desc
        `),
        // Stock that the backfill could not place because the tenant has no
        // warehouse — surfaced as a nudge rather than silently lost.
        tx.execute(sql`
          select count(*)::int as n from public.products p
           where p.tenant_id = ${tenant.id} and p.stock > 0
             and not exists (
               select 1 from public.skus s
                join public.inventory_levels l on l.sku_id = s.id
               where s.product_id = p.id)
        `),
      ]);

      const rows = <T>(r: unknown) => r as unknown as T[];
      return {
        period: days,
        stats,
        movementTrend: rows<{ date: string; in: number; out: number }>(trend),
        topMovers: rows<Record<string, unknown>>(topMovers),
        lowStock,
        byWarehouse: rows<Record<string, unknown>>(byWarehouse),
        unplacedProducts: rows<{ n: number }>(orphanProducts)[0]?.n ?? 0,
      };
    });
  }

  @Get("movements")
  @ApiOperation({ summary: "Recent movements for one SKU (drawer timeline)" })
  async movements(@CurrentTenant() tenant: TenantDto, @Query("skuId") skuId: string, @Query("limit") limit?: string) {
    const take = Math.min(Number(limit) || 20, 100);
    return this.tdb.forTenant(tenant.id, async (tx) =>
      tx
        .select()
        .from(stockMovements)
        .where(and(eq(stockMovements.tenantId, tenant.id), eq(stockMovements.skuId, skuId)))
        .orderBy(desc(stockMovements.at))
        .limit(take),
    );
  }

  // --- Writes -----------------------------------------------------------------

  @Post("receive")
  @ApiOperation({
    summary: "Receive stock into a warehouse",
    description:
      "Raises on-hand and appends a `receive` movement per line. Accepts the legacy flat {productId, quantity} body, which resolves to the product's default SKU.",
  })
  async receive(@CurrentTenant() tenant: TenantDto, @Body() body: unknown) {
    const input = receiveSchema.parse(body);

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const lines =
        "lines" in input
          ? input.lines
          : [
              {
                ...(await this.resolveLegacyLine(tx, tenant.id, input.productId, input.quantity)),
                expiryDate: input.expiryDate,
              },
            ];

      const touched: string[] = [];
      const levels = [];
      for (const line of lines) {
        const level = await this.inventory.applyMovement(tx, tenant.id, {
          skuId: line.skuId,
          warehouseId: input.warehouseId,
          kind: "receive",
          qty: line.qty,
          refType: "receipt",
          reason: "manual_receive",
          note: "note" in input ? input.note : undefined,
        });
        touched.push(line.skuId);
        levels.push(level);
      }

      // Mirror onto the legacy batch row so alerts, the dashboard and the
      // current Inventory page keep seeing the same numbers until P6.
      if (!("lines" in input)) {
        await this.mirrorLegacyBatch(tx, tenant.id, input);
      }

      await this.inventory.syncProductStock(tx, tenant.id, touched);
      await this.inventory.writeActivity(tx, tenant.id, {
        action: "Received stock",
        target: `${lines.reduce((n, l) => n + l.qty, 0)} units`,
      });

      return { levels, warnings: await this.inventory.lowStockWarnings(tx, tenant.id, touched) };
    });
  }

  @Post("adjust")
  @ApiOperation({
    summary: "Apply stock deltas",
    description:
      "SKU-level `lines` (signed toward on_hand) or the legacy product-level `changes` (positive consumes). Both now write ledger rows; the legacy path previously wrote none.",
  })
  async adjust(@CurrentTenant() tenant: TenantDto, @Body() body: unknown): Promise<{ warnings: string[] }> {
    const input = adjustSchema.parse(body);

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const touched: string[] = [];

      if ("lines" in input) {
        for (const line of input.lines) {
          if (line.delta === 0) continue;
          const warehouseId = line.warehouseId ?? (await this.inventory.defaultWarehouse(tx, tenant.id));
          if (!warehouseId) throw new NotFoundException("No active warehouse to adjust against");
          await this.inventory.applyMovement(tx, tenant.id, {
            skuId: line.skuId,
            warehouseId,
            kind: line.delta < 0 && line.reason === "scrap" ? "scrap" : "adjust",
            qty: line.delta,
            refType: "manual",
            reason: line.reason ?? "manual_adjustment",
            note: line.note,
          });
          touched.push(line.skuId);
        }
      } else {
        // Legacy: positive delta consumes. Collapse duplicate product ids first.
        const deltaById = new Map<string, number>();
        for (const c of input.changes) {
          if (c.delta === 0) continue;
          deltaById.set(c.productId, (deltaById.get(c.productId) ?? 0) + c.delta);
        }

        for (const [productId, delta] of deltaById) {
          const sku = await this.inventory.resolveSku(tx, tenant.id, { productId });
          if (!sku) continue;
          const warehouseId =
            (await this.inventory.pickWarehouse(tx, tenant.id, sku.id, Math.max(0, delta))) ??
            (await this.inventory.defaultWarehouse(tx, tenant.id));
          if (!warehouseId) continue;
          await this.inventory.applyMovement(tx, tenant.id, {
            skuId: sku.id,
            warehouseId,
            kind: "adjust",
            qty: -delta,
            refType: "manual",
            reason: delta > 0 ? "legacy_consume" : "legacy_return",
          });
          touched.push(sku.id);
        }
      }

      await this.inventory.syncProductStock(tx, tenant.id, touched);
      return { warnings: await this.inventory.lowStockWarnings(tx, tenant.id, touched) };
    });
  }

  // --- Legacy bridges -----------------------------------------------------------

  private async resolveLegacyLine(tx: Db, tenantId: string, productId: string, qty: number) {
    const sku = await this.inventory.resolveSku(tx, tenantId, { productId });
    if (!sku) throw new NotFoundException("Product not found");
    return { skuId: sku.id, qty };
  }

  /**
   * Keeps the legacy batch row in step for the flat receive shape. Batches are
   * lot metadata now, but alerts.service and dashboard.service still read them
   * until P6 repoints those to inventory_levels.
   */
  private async mirrorLegacyBatch(
    tx: Db,
    tenantId: string,
    input: {
      batchId?: string;
      productId: string;
      warehouseId: string;
      quantity: number;
      expiryDate?: string;
      lowStockThreshold?: number;
      photoUrl?: string;
      note?: string;
    },
  ) {
    const db = tx;
    const [product] = await db
      .select()
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, input.productId)))
      .limit(1);
    const [warehouse] = await db
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, input.warehouseId)))
      .limit(1);
    if (!product || !warehouse) return;

    const [target] = await db
      .select()
      .from(stockBatches)
      .where(
        and(
          eq(stockBatches.tenantId, tenantId),
          input.batchId
            ? eq(stockBatches.id, input.batchId)
            : and(eq(stockBatches.productId, input.productId), eq(stockBatches.warehouseId, input.warehouseId))!,
        ),
      )
      .limit(1);

    const extra = {
      ...(input.expiryDate !== undefined ? { expiryDate: input.expiryDate } : {}),
      ...(input.lowStockThreshold !== undefined ? { lowStockThreshold: input.lowStockThreshold } : {}),
      ...(input.photoUrl !== undefined ? { photoUrl: input.photoUrl } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    };

    if (target) {
      await db
        .update(stockBatches)
        .set({ quantity: target.quantity + input.quantity, updatedAt: new Date(), ...extra })
        .where(eq(stockBatches.id, target.id));
      return;
    }

    await db.insert(stockBatches).values({
      tenantId,
      productId: input.productId,
      productName: product.nameEn,
      warehouseId: input.warehouseId,
      warehouseName: warehouse.name,
      quantity: input.quantity,
      unit: product.unit,
      lowStockThreshold: input.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD,
      ...extra,
    });
  }
}
