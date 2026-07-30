import { Body, Controller, Get, NotFoundException, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { products, stockBatches, warehouses } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { CurrentTenant } from "../tenant/tenant.decorator";
import { TenantGuard } from "../tenant/tenant.guard";
import type { TenantDto } from "../tenant/tenant.service";

const adjustSchema = z.object({
  changes: z
    .array(
      z.object({
        productId: z.string().uuid(),
        /** Positive consumes stock (shipping out); negative returns it. */
        delta: z.number().int(),
      }),
    )
    .min(1),
});

const receiveSchema = z.object({
  /** Top up this specific batch; otherwise the (product, warehouse) one. */
  batchId: z.string().uuid().optional(),
  productId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  quantity: z.number().int().positive(),
  expiryDate: z.string().optional(),
  lowStockThreshold: z.number().int().nonnegative().optional(),
  photoUrl: z.string().optional(),
  note: z.string().optional(),
});

const DEFAULT_LOW_STOCK_THRESHOLD = 10;

/**
 * Stock movement for shipment dispatch / cancellation.
 *
 * Replaces a client-side `adjustInventory` that (a) needed every product and
 * batch loaded in the browser, (b) was a read-modify-write over that local copy
 * so two concurrent dispatches could both write the same result, and (c)
 * decremented *every* batch of a product by the full shipped quantity —
 * over-deducting once a product sat in more than one batch.
 *
 * Here the whole adjustment runs in one tenant transaction and batches are
 * consumed FIFO (soonest expiry first, then oldest) until the quantity is used
 * up, so the total removed equals exactly what shipped.
 */
@ApiTags("inventory")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@Controller("api/:tenant/inventory")
@UseGuards(TenantGuard)
export class InventoryController {
  constructor(private readonly tdb: TenantDb) {}

  @Post("adjust")
  @ApiOperation({
    summary: "Apply stock deltas across products and their batches (FIFO)",
    description:
      "Positive delta consumes stock, negative returns it. Returns low-stock warnings for the affected products.",
  })
  async adjust(@CurrentTenant() tenant: TenantDto, @Body() body: unknown): Promise<{ warnings: string[] }> {
    const { changes } = adjustSchema.parse(body);

    // Collapse duplicate product ids and drop no-ops.
    const deltaById = new Map<string, number>();
    for (const c of changes) {
      if (c.delta === 0) continue;
      deltaById.set(c.productId, (deltaById.get(c.productId) ?? 0) + c.delta);
    }
    if (deltaById.size === 0) return { warnings: [] };

    const ids = [...deltaById.keys()];

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const rows = await tx
        .select()
        .from(products)
        .where(and(eq(products.tenantId, tenant.id), inArray(products.id, ids)));

      const batches = await tx
        .select()
        .from(stockBatches)
        .where(and(eq(stockBatches.tenantId, tenant.id), inArray(stockBatches.productId, ids)))
        // FIFO: soonest expiry first (nulls last), then oldest received.
        .orderBy(sql`${stockBatches.expiryDate} asc nulls last`, asc(stockBatches.createdAt));

      const warnings: string[] = [];

      for (const product of rows) {
        const delta = deltaById.get(product.id);
        if (!delta) continue;

        const nextStock = Math.max(0, product.stock - delta);
        await tx
          .update(products)
          .set({ stock: nextStock, updatedAt: new Date() })
          .where(eq(products.id, product.id));

        const productBatches = batches.filter((b) => b.productId === product.id);

        if (delta > 0) {
          // Consume FIFO until the shipped quantity is exhausted.
          let remaining = delta;
          for (const b of productBatches) {
            if (remaining <= 0) break;
            const take = Math.min(b.quantity, remaining);
            if (take <= 0) continue;
            await tx
              .update(stockBatches)
              .set({ quantity: b.quantity - take, updatedAt: new Date() })
              .where(eq(stockBatches.id, b.id));
            remaining -= take;
          }
        } else if (productBatches.length > 0) {
          // Returning stock (cancelled shipment) goes back on the oldest batch.
          const target = productBatches[0];
          await tx
            .update(stockBatches)
            .set({ quantity: target.quantity + Math.abs(delta), updatedAt: new Date() })
            .where(eq(stockBatches.id, target.id));
        }

        if (delta > 0) {
          const threshold = productBatches[0]?.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
          if (nextStock <= threshold) {
            warnings.push(
              nextStock === 0
                ? `${product.nameEn} is out of stock`
                : `${product.nameEn}: only ${nextStock} ${product.unit} left`,
            );
          }
        }
      }

      return { warnings };
    });
  }

  @Post("receive")
  @ApiOperation({
    summary: "Receive stock into a batch",
    description:
      "Tops up the matching batch (or creates one) and mirrors the increase onto products.stock, in one transaction.",
  })
  async receive(@CurrentTenant() tenant: TenantDto, @Body() body: unknown) {
    const input = receiveSchema.parse(body);

    return this.tdb.forTenant(tenant.id, async (tx) => {
      // The batch carries denormalized product/warehouse names, so both rows
      // have to be resolved server-side — this is why receiving can't just be
      // a PATCH from the client.
      const [product] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, input.productId), eq(products.tenantId, tenant.id)))
        .limit(1);
      if (!product) throw new NotFoundException("Product not found");

      const [warehouse] = await tx
        .select()
        .from(warehouses)
        .where(and(eq(warehouses.id, input.warehouseId), eq(warehouses.tenantId, tenant.id)))
        .limit(1);
      if (!warehouse) throw new NotFoundException("Warehouse not found");

      const [target] = await tx
        .select()
        .from(stockBatches)
        .where(
          and(
            eq(stockBatches.tenantId, tenant.id),
            input.batchId
              ? eq(stockBatches.id, input.batchId)
              : and(
                  eq(stockBatches.productId, input.productId),
                  eq(stockBatches.warehouseId, input.warehouseId),
                )!,
          ),
        )
        .limit(1);

      // Only overwrite the optional fields the caller actually sent.
      const extra = {
        ...(input.expiryDate !== undefined ? { expiryDate: input.expiryDate } : {}),
        ...(input.lowStockThreshold !== undefined ? { lowStockThreshold: input.lowStockThreshold } : {}),
        ...(input.photoUrl !== undefined ? { photoUrl: input.photoUrl } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      };

      const [batch] = target
        ? await tx
            .update(stockBatches)
            .set({ quantity: target.quantity + input.quantity, updatedAt: new Date(), ...extra })
            .where(eq(stockBatches.id, target.id))
            .returning()
        : await tx
            .insert(stockBatches)
            .values({
              tenantId: tenant.id,
              productId: input.productId,
              productName: product.nameEn,
              warehouseId: input.warehouseId,
              warehouseName: warehouse.name,
              quantity: input.quantity,
              unit: product.unit,
              lowStockThreshold: input.lowStockThreshold ?? DEFAULT_LOW_STOCK_THRESHOLD,
              ...extra,
            })
            .returning();

      const [updatedProduct] = await tx
        .update(products)
        .set({ stock: product.stock + input.quantity, updatedAt: new Date() })
        .where(eq(products.id, input.productId))
        .returning();

      return { batch, product: updatedProduct };
    });
  }

  @Get("stats")
  @ApiOperation({
    summary: "Inventory KPI tiles",
    description: "Product count, total units on hand, and low/out-of-stock batch counts.",
  })
  async stats(@CurrentTenant() tenant: TenantDto) {
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [[productCount], [batchStats]] = await Promise.all([
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(products)
          .where(eq(products.tenantId, tenant.id)),
        tx
          .select({
            totalUnits: sql<number>`coalesce(sum(quantity), 0)::int`,
            // "low" excludes zero so the tiles don't double-count.
            low: sql<number>`count(*) filter (where quantity <= low_stock_threshold and quantity > 0)::int`,
            out: sql<number>`count(*) filter (where quantity = 0)::int`,
          })
          .from(stockBatches)
          .where(eq(stockBatches.tenantId, tenant.id)),
      ]);

      return {
        products: productCount.n,
        totalUnits: batchStats.totalUnits,
        low: batchStats.low,
        out: batchStats.out,
      };
    });
  }
}
