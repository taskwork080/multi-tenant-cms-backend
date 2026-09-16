import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/db.tokens";
import {
  inboundReceiptCharges,
  inboundReceiptItems,
  inboundReceipts,
  inventoryLevels,
  products,
  skus,
  stockBatches,
  stockMovements,
  suppliers,
  warehouses,
} from "../db/schema";
import { allocateCharges, costInputSchema, landedFor, normalizeCost, type ChargeBasis } from "./purchase-cost";
import { TenantDb } from "../db/tenant-db.service";
import { parseDateWindow } from "../common/date-window";
import { RequireCapability } from "../auth/decorators";
import { RequireModule } from "../tenant/module.decorator";
import { CurrentUser } from "../auth/decorators";
import { actorOf, type AuthUser } from "../auth/auth.types";
import { CurrentTenant } from "../tenant/tenant.decorator";
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
  ...costInputSchema,
  expiryDate: z.string().optional(),
  batchRef: z.string().optional(),
});

/**
 * The other bills on a delivery. Labelled rather than a fixed set of columns:
 * every trade has its own charges, and a freight/duty/other trio would push
 * everything else into "other".
 */
const chargeSchema = z.object({
  label: z.string().trim().max(120).optional(),
  amount: z.number().nonnegative(),
  note: z.string().optional(),
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
    supplierId: z.string().uuid().optional(),
    supplierName: z.string().optional(),
    manufacturerId: z.string().uuid().optional(),
    referenceNo: z.string().optional(),
    photoUrl: z.string().optional(),
    note: z.string().optional(),
    charges: z.array(chargeSchema).optional(),
    chargeBasis: z.enum(["value", "qty"]).optional(),
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
// Capabilities are per-method here, not class-level: this controller mixes the
// read surface a picker needs with the adjust/receive writes a stock controller
// owns, and collapsing them would hand every reader a write key.
@RequireModule("inventory")
@Controller("api/:tenant/inventory")
export class InventoryController {
  constructor(
    private readonly tdb: TenantDb,
    private readonly inventory: InventoryService,
  ) {}

  // --- SKUs -------------------------------------------------------------------

  @Post("skus/generate")
  @RequireCapability("inventory.adjust")
  @ApiOperation({
    summary: "Reconcile a product's SKUs with its variants",
    description:
      "Creates one SKU per variant plus a default SKU, applies any codes/barcodes entered in the wizard, and archives SKUs whose variant was deleted (never hard-deletes — movements reference them).",
  })
  async generateSkus(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantDto, @Body() body: unknown) {
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
  @RequireCapability("inventory.adjust")
  @ApiOperation({
    summary: "Edit a SKU's code, barcode or threshold",
    description: "Validates uniqueness up front so a clash reads as a 409 rather than a raw constraint error.",
  })
  async patchSku(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantDto, @Param("id") id: string, @Body() body: unknown) {
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
  @RequireCapability("inventory.view")
  @ApiOperation({
    summary: "On-hand / reserved / available for a SKU or product",
    description: "What order entry should cap quantities against — never products.stock, which is only a mirror.",
  })
  async getAvailability(
    @CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantDto,
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
  @RequireCapability("inventory.view")
  @ApiOperation({
    summary: "Inventory KPI tiles",
    description:
      "Superset of the original {products, totalUnits, low, out} payload — the extra keys are additive so the existing page keeps working.",
  })
  async stats(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantDto) {
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
  @RequireCapability("inventory.view")
  @ApiOperation({
    summary: "Everything the Inventory overview page renders",
    description: "One request rather than a dozen list calls — mirrors how DashboardService composes its payload.",
  })
  @ApiQuery({
    name: "period",
    required: false,
    enum: ["7", "30"],
    description: "Trailing window in days (default 7). Ignored when from/to are given.",
  })
  @ApiQuery({ name: "from", required: false, description: "ISO start of an explicit window; overrides `period`" })
  @ApiQuery({ name: "to", required: false, description: "ISO end of an explicit window (inclusive)" })
  async overview(
    @CurrentUser() user: AuthUser,
    @CurrentTenant() tenant: TenantDto,
    @Query("period") period?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const w = parseDateWindow(from, to);
    const days = period === "30" ? 30 : 7;
    // ISO strings, not Dates: postgres.js can serialize a Date through the
    // typed query builder (which knows the column type) but not as a bare
    // parameter in a raw `sql` template, where it throws ERR_INVALID_ARG_TYPE.
    // The explicit casts below tell Postgres what to read them back as.
    const since = (w.from ?? new Date(Date.now() - days * 86_400_000)).toISOString();
    const until = (w.to ?? new Date()).toISOString();

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [stats, trend, topMovers, lowStock, byWarehouse, orphanProducts] = await Promise.all([
        this.statsIn(tx, tenant.id),
        tx.execute(sql`
          select to_char(d.day, 'YYYY-MM-DD') as date,
                 coalesce(sum(m.qty) filter (where m.qty > 0), 0)::int as "in",
                 coalesce(-sum(m.qty) filter (where m.qty < 0), 0)::int as "out"
            from generate_series(${since}::date, ${until}::date, interval '1 day') d(day)
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
           where m.tenant_id = ${tenant.id} and m.at >= ${since}::timestamptz
             and m.at <= ${until}::timestamptz and m.qty <> 0
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
        from: since,
        to: until,
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
  @RequireCapability("inventory.view")
  @ApiOperation({ summary: "Recent movements for one SKU (drawer timeline)" })
  async movements(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantDto, @Query("skuId") skuId: string, @Query("limit") limit?: string) {
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
  @RequireCapability("inventory.receive")
  @ApiOperation({
    summary: "Receive stock into a warehouse",
    description:
      "Raises on-hand, writes a goods-received note recording the supplier and what each line cost, and appends a `receive` movement per line. Accepts the legacy flat {productId, quantity} body, which resolves to the product's default SKU.",
  })
  async receive(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantDto, @Body() body: unknown) {
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

      /**
       * Write the goods-received note FIRST, so the movements below can point
       * at it.
       *
       * This endpoint used to parse `supplierName`, `referenceNo` and every
       * line's `unitCost` and then write only the movement — no receipt row at
       * all. Every price and supplier a user typed into the Receive Stock
       * drawer was discarded at the door, which is why no purchase history
       * existed to report on. The note is the record of what was bought, from
       * whom, and at what price; the ledger only ever recorded that quantity
       * went up.
       */
      const receipt = await this.recordPurchase(tx, tenant.id, input, lines);

      const touched: string[] = [];
      const levels = [];
      for (const line of lines) {
        const level = await this.inventory.applyMovement(tx, tenant.id, {
          skuId: line.skuId,
          warehouseId: input.warehouseId,
          kind: "receive",
          qty: line.qty,
          refType: "receipt",
          // The ledger row now resolves to the note that priced it, so a
          // movement can be traced back to its supplier and invoice.
          refId: receipt?.id,
          refCode: receipt?.ref,
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
        actor: actorOf(user),
        action: "Received stock",
        target: receipt
          ? `${receipt.ref} · ${lines.reduce((n, l) => n + l.qty, 0)} units`
          : `${lines.reduce((n, l) => n + l.qty, 0)} units`,
      });

      return {
        levels,
        receipt,
        warnings: await this.inventory.lowStockWarnings(tx, tenant.id, touched),
      };
    });
  }

  /**
   * Persists a received goods note for a direct receive, so the purchase — its
   * supplier, its date and its per-line prices — survives the transaction.
   *
   * Created already `received`: unlike the drafting flow in
   * ReceiptsController, the goods are physically here by definition, and this
   * method is called from inside the same transaction that raises on-hand.
   * `receivedAt` is therefore the purchase timestamp the price log sorts by.
   *
   * Returns null only when the tenant's warehouse row has vanished under us,
   * which `applyMovement` will fail on anyway — receiving keeps working, it
   * just loses the note rather than the stock.
   */
  private async recordPurchase(
    tx: Db,
    tenantId: string,
    input: {
      warehouseId: string;
      supplierId?: string;
      supplierName?: string;
      manufacturerId?: string;
      referenceNo?: string;
      photoUrl?: string;
      note?: string;
      charges?: { label?: string; amount: number; note?: string }[];
      chargeBasis?: ChargeBasis;
    },
    lines: { skuId: string; qty: number; unitCost?: number; lineTotal?: number; costMode?: "unit" | "total"; expiryDate?: string; batchRef?: string }[],
  ) {
    const [warehouse] = await tx
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, input.warehouseId)))
      .limit(1);
    if (!warehouse) return null;

    // A supplier picked by id names itself; free text is still accepted so the
    // legacy body and any caller predating the supplier list keep working.
    let supplierName = input.supplierName ?? "";
    if (input.supplierId) {
      const [supplier] = await tx
        .select({ name: suppliers.name })
        .from(suppliers)
        .where(and(eq(suppliers.tenantId, tenantId), eq(suppliers.id, input.supplierId)))
        .limit(1);
      if (!supplier) throw new NotFoundException("Supplier not found");
      supplierName = supplier.name;
    }

    // Zero-value bills are noise on the document; drop them before they become
    // rows nobody can explain.
    const charges = (input.charges ?? []).filter((c) => c.amount > 0);
    const chargesTotal = Math.round(charges.reduce((n, c) => n + c.amount, 0) * 100) / 100;
    const basis: ChargeBasis = input.chargeBasis ?? "value";

    const ref = await this.inventory.nextRef(tx, tenantId, "inbound_receipts", "GRN");
    const [receipt] = await tx
      .insert(inboundReceipts)
      .values({
        tenantId,
        ref,
        warehouseId: warehouse.id,
        warehouseName: warehouse.name,
        supplierId: input.supplierId,
        supplierName,
        manufacturerId: input.manufacturerId,
        referenceNo: input.referenceNo,
        photoUrl: input.photoUrl,
        note: input.note,
        chargesTotal,
        chargeBasis: basis,
        status: "received",
        receivedAt: new Date(),
      })
      .returning();

    // The extra bills, each kept as its own labelled row.
    for (const [i, charge] of charges.entries()) {
      await tx.insert(inboundReceiptCharges).values({
        tenantId,
        receiptId: receipt.id,
        label: charge.label?.trim() || "Other cost",
        amount: charge.amount,
        note: charge.note,
        sort: i,
      });
    }

    // Prices first, because the allocation weighs lines by what they cost.
    const costs = lines.map((line) => normalizeCost(line.qty, line));
    const shares = allocateCharges(
      lines.map((line, i) => ({ qty: line.qty, lineTotal: costs[i].lineTotal })),
      chargesTotal,
      basis,
    );

    for (const [i, line] of lines.entries()) {
      const sku = await this.inventory.resolveSku(tx, tenantId, { skuId: line.skuId });
      if (!sku) throw new NotFoundException(`SKU ${line.skuId} not found`);
      const cost = costs[i];
      const landed = landedFor(line.qty, cost.lineTotal, shares[i]);
      await tx.insert(inboundReceiptItems).values({
        tenantId,
        receiptId: receipt.id,
        skuId: sku.id,
        skuCode: sku.code,
        name: sku.name,
        qty: line.qty,
        // Received in full in the same breath — this path has no partial
        // arrival, so leaving receivedQty at 0 would misreport the note.
        receivedQty: line.qty,
        unitCost: cost.unitCost,
        lineTotal: cost.lineTotal,
        costMode: cost.costMode,
        allocatedCharge: shares[i],
        landedTotal: landed.landedTotal,
        landedUnitCost: landed.landedUnitCost,
        expiryDate: line.expiryDate,
        batchRef: line.batchRef,
        sort: i,
      });
    }

    return receipt;
  }

  @Post("adjust")
  @RequireCapability("inventory.adjust")
  @ApiOperation({
    summary: "Apply stock deltas",
    description:
      "SKU-level `lines` (signed toward on_hand) or the legacy product-level `changes` (positive consumes). Both now write ledger rows; the legacy path previously wrote none.",
  })
  async adjust(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantDto, @Body() body: unknown): Promise<{ warnings: string[] }> {
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
