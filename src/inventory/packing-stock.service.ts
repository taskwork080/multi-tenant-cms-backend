import { Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/db.tokens";
import {
  inventoryLevels,
  inventoryReservations,
  packingLists,
  packingSkuMap,
  productVariants,
  products,
  skus,
  stockMovements,
} from "../db/schema";
import { InventoryService } from "./inventory.service";
import { matchVariant, normalizeColor, normalizeSize, type VariantLike } from "./size-match";

/** One packed (product, colour, size) that resolved to a real SKU. */
export interface PackedLine {
  skuId: string;
  skuCode: string;
  skuName: string;
  qty: number;
  /** How the SKU was found — surfaced so a guess is visible before sign-off. */
  via: "mapping" | "auto" | "product-default";
}

/** One packed group that did not resolve, and why. */
export interface UnlinkedLine {
  itemId: string;
  brand: string;
  name: string;
  color: string;
  size: string;
  qty: number;
  reason: string;
  /** Variants that matched the size, when the problem was ambiguity. */
  candidates: VariantLike[];
}

export interface PackingPlan {
  warehouseId: string | null;
  /** Aggregated per SKU — a style packed across five carton ranges is one line. */
  lines: PackedLine[];
  unlinked: UnlinkedLine[];
  pieces: { total: number; linked: number; unlinked: number };
}

/** A raw (item, carton range, size) row straight out of the packing tables. */
interface PackedCell {
  itemId: string;
  brand: string;
  name: string;
  productId: string | null;
  itemSkuId: string | null;
  color: string;
  size: string;
  qty: number;
}

/**
 * Turns a packing list into the stock it moves.
 *
 * This is the piece that was missing. Confirming a packing list always tried to
 * deduct, but it resolved ONE SKU per line from an optional `product_id` — so a
 * free-text garment line deducted nothing at all, and a linked one put every
 * size onto the product's default SKU. Neither is what was packed.
 *
 * Here a packed quantity is a (product, colour, size) triple, because that is
 * what a SKU is. Resolution is deliberately layered so a human decision always
 * outranks a guess, and a guess is always visible as one.
 */
@Injectable()
export class PackingStockService {
  constructor(private readonly inventory: InventoryService) {}

  /* ------------------------------------------------------------------ plan */

  /**
   * What this list would move, without moving it.
   *
   * Read-only by design: the builder calls this on every edit to show
   * availability, and a read that writes would make that unsafe to cache. The
   * auto-matches it discovers are persisted only by `rememberAutoMatches`,
   * which the hold and confirm paths call.
   */
  async plan(tx: Db, tenantId: string, packingListId: string): Promise<PackingPlan> {
    const [list] = await tx
      .select()
      .from(packingLists)
      .where(and(eq(packingLists.tenantId, tenantId), eq(packingLists.id, packingListId)))
      .limit(1);
    if (!list) return { warehouseId: null, lines: [], unlinked: [], pieces: { total: 0, linked: 0, unlinked: 0 } };

    const cells = await this.cells(tx, packingListId);
    const productIds = [...new Set(cells.map((c) => c.productId).filter((id): id is string => !!id))];

    const [mappings, variantsByProduct, variantCount] = await Promise.all([
      this.mappings(tx, tenantId, productIds),
      this.variants(tx, tenantId, productIds),
      this.variantCounts(tx, tenantId, productIds),
    ]);

    const bySku = new Map<string, PackedLine>();
    const unlinked: UnlinkedLine[] = [];
    let total = 0;

    for (const cell of cells) {
      total += cell.qty;
      const resolved = await this.resolveCell(tx, tenantId, cell, mappings, variantsByProduct, variantCount);

      if (!resolved.skuId) {
        unlinked.push({
          itemId: cell.itemId,
          brand: cell.brand,
          name: cell.name,
          color: cell.color,
          size: cell.size,
          qty: cell.qty,
          reason: resolved.reason,
          candidates: resolved.candidates,
        });
        continue;
      }

      const existing = bySku.get(resolved.skuId);
      if (existing) existing.qty += cell.qty;
      else
        bySku.set(resolved.skuId, {
          skuId: resolved.skuId,
          skuCode: resolved.skuCode,
          skuName: resolved.skuName,
          qty: cell.qty,
          via: resolved.via,
        });
    }

    const lines = [...bySku.values()];
    const linked = lines.reduce((n, l) => n + l.qty, 0);

    return {
      warehouseId: list.warehouseId,
      lines,
      unlinked,
      pieces: { total, linked, unlinked: total - linked },
    };
  }

  /**
   * Writes the auto-matches a plan discovered into `packing_sku_map`.
   *
   * Only ever inserts, never updates: a row already there was either a person's
   * decision or an identical earlier guess, and an auto-match must not overwrite
   * a correction someone made by hand.
   */
  async rememberAutoMatches(tx: Db, tenantId: string, packingListId: string): Promise<void> {
    const cells = await this.cells(tx, packingListId);
    const productIds = [...new Set(cells.map((c) => c.productId).filter((id): id is string => !!id))];
    if (productIds.length === 0) return;

    const [mappings, variantsByProduct] = await Promise.all([
      this.mappings(tx, tenantId, productIds),
      this.variants(tx, tenantId, productIds),
    ]);

    for (const cell of cells) {
      if (!cell.productId || cell.qty <= 0) continue;
      const sizeNorm = normalizeSize(cell.size);
      const colorNorm = normalizeColor(cell.color);
      if (!sizeNorm) continue;
      // Already answered, by a person or by an earlier run.
      if (mappings.get(this.key(cell.productId, colorNorm, sizeNorm)) ?? mappings.get(this.key(cell.productId, "", sizeNorm))) {
        continue;
      }

      const match = matchVariant(variantsByProduct.get(cell.productId) ?? [], cell.color, cell.size);
      if (match.reason !== "matched" || !match.variantId) continue;

      const sku = await this.inventory.resolveSku(tx, tenantId, {
        productId: cell.productId,
        variantId: match.variantId,
      });
      if (!sku) continue;

      await tx
        .insert(packingSkuMap)
        .values({
          tenantId,
          productId: cell.productId,
          color: colorNorm,
          sizeLabel: cell.size,
          skuId: sku.id,
          source: "auto",
        })
        .onConflictDoNothing();
    }
  }

  /** Records a person's decision, overriding any guess. */
  async setMapping(
    tx: Db,
    tenantId: string,
    input: { productId: string; color?: string | null; size: string; skuId: string },
  ) {
    const colorNorm = normalizeColor(input.color);
    const [row] = await tx
      .insert(packingSkuMap)
      .values({
        tenantId,
        productId: input.productId,
        color: colorNorm,
        sizeLabel: input.size,
        skuId: input.skuId,
        source: "manual",
      })
      .onConflictDoUpdate({
        target: [packingSkuMap.tenantId, packingSkuMap.productId, packingSkuMap.color, packingSkuMap.sizeLabel],
        set: { skuId: input.skuId, source: "manual", updatedAt: new Date() },
      })
      .returning();
    return row;
  }

  /* -------------------------------------------------------------- resolution */

  private key(productId: string, colorNorm: string, sizeNorm: string) {
    return `${productId}|${colorNorm}|${sizeNorm}`;
  }

  /**
   * The SKU for one packed cell, in priority order:
   *
   *   1. an exact (product, colour, size) mapping — a person's decision
   *   2. a colour-agnostic (product, size) mapping
   *   3. an unambiguous match against the product's variant labels
   *   4. the product's default SKU, but ONLY when the product has no variants
   *
   * Step 4 is fenced deliberately. Falling back to the default SKU for a product
   * that *does* have variants is the original bug: it lumps every size onto one
   * stock record and the size-level figures drift from that moment on.
   */
  private async resolveCell(
    tx: Db,
    tenantId: string,
    cell: PackedCell,
    mappings: Map<string, { skuId: string; skuCode: string; skuName: string }>,
    variantsByProduct: Map<string, VariantLike[]>,
    variantCount: Map<string, number>,
  ): Promise<{
    skuId: string | null;
    skuCode: string;
    skuName: string;
    via: PackedLine["via"];
    reason: string;
    candidates: VariantLike[];
  }> {
    const miss = (reason: string, candidates: VariantLike[] = []) => ({
      skuId: null,
      skuCode: "",
      skuName: "",
      via: "auto" as const,
      reason,
      candidates,
    });

    if (cell.qty <= 0) return miss("no quantity");

    // A line that names its own SKU outright is already answered.
    if (cell.itemSkuId) {
      const sku = await this.skuById(tx, tenantId, cell.itemSkuId);
      if (sku) return { skuId: sku.id, skuCode: sku.code, skuName: sku.name, via: "mapping", reason: "", candidates: [] };
    }

    if (!cell.productId) return miss("no product linked");

    const sizeNorm = normalizeSize(cell.size);
    const colorNorm = normalizeColor(cell.color);
    if (!sizeNorm) return miss("no size on the carton");

    const mapped =
      mappings.get(this.key(cell.productId, colorNorm, sizeNorm)) ??
      mappings.get(this.key(cell.productId, "", sizeNorm));
    if (mapped) {
      return { skuId: mapped.skuId, skuCode: mapped.skuCode, skuName: mapped.skuName, via: "mapping", reason: "", candidates: [] };
    }

    const variants = variantsByProduct.get(cell.productId) ?? [];
    const match = matchVariant(variants, cell.color, cell.size);
    if (match.reason === "matched" && match.variantId) {
      const sku = await this.inventory.resolveSku(tx, tenantId, {
        productId: cell.productId,
        variantId: match.variantId,
      });
      if (sku) return { skuId: sku.id, skuCode: sku.code, skuName: sku.name, via: "auto", reason: "", candidates: [] };
    }
    if (match.reason === "ambiguous") {
      return miss(`${match.candidates.length} variants match "${cell.size}"`, match.candidates);
    }

    // Only when the catalogue models no sizes at all for this product.
    if ((variantCount.get(cell.productId) ?? 0) === 0) {
      const sku = await this.inventory.resolveSku(tx, tenantId, { productId: cell.productId });
      if (sku) {
        return { skuId: sku.id, skuCode: sku.code, skuName: sku.name, via: "product-default", reason: "", candidates: [] };
      }
    }

    return miss(`no stock item for size "${cell.size}"`, variants);
  }

  /* ------------------------------------------------------------------ reads */

  /**
   * Every (item, carton range, size) with its piece count.
   *
   * A carton range `1–5` holding 20 of a size is 100 pieces, hence the
   * `to_no - from_no + 1` multiplier — the same expression the old
   * `deductPacked` used, kept so historical lists total identically.
   */
  private async cells(tx: Db, packingListId: string): Promise<PackedCell[]> {
    const rows = await tx.execute(sql`
      select pi.id              as "itemId",
             pi.brand           as "brand",
             pi.name            as "name",
             pi.product_id      as "productId",
             pi.sku_id          as "itemSkuId",
             ic.color           as "color",
             cs.size            as "size",
             (cs.qty * greatest(ic.to_no - ic.from_no + 1, 1))::int as "qty"
        from public.packing_items pi
        join public.item_cartons ic on ic.packing_item_id = pi.id
        join public.carton_sizes cs on cs.carton_id = ic.id
       where pi.packing_list_id = ${packingListId}
         and cs.qty > 0
    `);
    return rows as unknown as PackedCell[];
  }

  private async mappings(tx: Db, tenantId: string, productIds: string[]) {
    const out = new Map<string, { skuId: string; skuCode: string; skuName: string }>();
    if (productIds.length === 0) return out;
    const rows = await tx
      .select({
        productId: packingSkuMap.productId,
        color: packingSkuMap.color,
        sizeLabel: packingSkuMap.sizeLabel,
        skuId: packingSkuMap.skuId,
        skuCode: skus.code,
        skuName: skus.name,
      })
      .from(packingSkuMap)
      .innerJoin(skus, eq(skus.id, packingSkuMap.skuId))
      .where(and(eq(packingSkuMap.tenantId, tenantId), inArray(packingSkuMap.productId, productIds)));
    for (const r of rows) {
      out.set(this.key(r.productId, normalizeColor(r.color), normalizeSize(r.sizeLabel)), {
        skuId: r.skuId,
        skuCode: r.skuCode,
        skuName: r.skuName,
      });
    }
    return out;
  }

  private async variants(tx: Db, tenantId: string, productIds: string[]) {
    const out = new Map<string, VariantLike[]>();
    if (productIds.length === 0) return out;
    const rows = await tx
      .select({ id: productVariants.id, productId: productVariants.productId, label: productVariants.label })
      .from(productVariants)
      .where(and(eq(productVariants.tenantId, tenantId), inArray(productVariants.productId, productIds)));
    for (const r of rows) {
      const list = out.get(r.productId) ?? [];
      list.push({ id: r.id, label: r.label });
      out.set(r.productId, list);
    }
    return out;
  }

  private async variantCounts(tx: Db, tenantId: string, productIds: string[]) {
    const out = new Map<string, number>();
    if (productIds.length === 0) return out;
    const rows = await tx
      .select({ productId: productVariants.productId, n: sql<number>`count(*)::int` })
      .from(productVariants)
      .where(and(eq(productVariants.tenantId, tenantId), inArray(productVariants.productId, productIds)))
      .groupBy(productVariants.productId);
    for (const r of rows) out.set(r.productId, r.n);
    return out;
  }

  private async skuById(tx: Db, tenantId: string, skuId: string) {
    const [row] = await tx
      .select()
      .from(skus)
      .where(and(eq(skus.tenantId, tenantId), eq(skus.id, skuId)))
      .limit(1);
    return row ?? null;
  }

  /** Free-to-take stock for a SKU at one warehouse. */
  async availableAt(tx: Db, tenantId: string, skuId: string, warehouseId: string): Promise<number> {
    const [row] = await tx
      .select({ available: sql<number>`(${inventoryLevels.onHand} - ${inventoryLevels.reserved})::int` })
      .from(inventoryLevels)
      .where(
        and(
          eq(inventoryLevels.tenantId, tenantId),
          eq(inventoryLevels.skuId, skuId),
          eq(inventoryLevels.warehouseId, warehouseId),
        ),
      )
      .limit(1);
    return row?.available ?? 0;
  }

  /** On-hand for a SKU at one warehouse — the ceiling on what a deduct may take. */
  async onHandAt(tx: Db, tenantId: string, skuId: string, warehouseId: string): Promise<number> {
    const [row] = await tx
      .select({ onHand: inventoryLevels.onHand })
      .from(inventoryLevels)
      .where(
        and(
          eq(inventoryLevels.tenantId, tenantId),
          eq(inventoryLevels.skuId, skuId),
          eq(inventoryLevels.warehouseId, warehouseId),
        ),
      )
      .limit(1);
    return row?.onHand ?? 0;
  }

  /** Products whose stock is not tracked — they never hold and never deduct. */
  async untrackedProducts(tx: Db, tenantId: string, skuIds: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (skuIds.length === 0) return out;
    const rows = await tx
      .select({ skuId: skus.id, mode: products.stockMode })
      .from(skus)
      .innerJoin(products, eq(products.id, skus.productId))
      .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, skuIds)));
    for (const r of rows) if (r.mode === "always") out.add(r.skuId);
    return out;
  }

  /** Packing holds this list currently owns, keyed by SKU. */
  async holdsFor(tx: Db, tenantId: string, packingListId: string) {
    const rows = await tx
      .select()
      .from(inventoryReservations)
      .where(
        and(
          eq(inventoryReservations.tenantId, tenantId),
          eq(inventoryReservations.packingListId, packingListId),
          eq(inventoryReservations.status, "active"),
        ),
      );
    return new Map(rows.map((r) => [r.skuId, r]));
  }

  /**
   * What this list has already taken off the shelf, per SKU.
   *
   * Read back from the ledger rather than kept in a column, so a reversal
   * returns exactly what was taken even if the document changed since. `qty` is
   * signed, so summing deducts (negative) and any earlier reversal (positive)
   * yields the outstanding amount in one number.
   */
  async deductedFor(tx: Db, tenantId: string, packingListId: string) {
    const rows = await tx
      .select({
        skuId: stockMovements.skuId,
        warehouseId: stockMovements.warehouseId,
        net: sql<number>`sum(${stockMovements.qty})::int`,
      })
      .from(stockMovements)
      .where(
        and(
          eq(stockMovements.tenantId, tenantId),
          eq(stockMovements.refType, "packing_list"),
          eq(stockMovements.refId, packingListId),
          inArray(stockMovements.kind, ["deduct", "adjust"]),
        ),
      )
      .groupBy(stockMovements.skuId, stockMovements.warehouseId);
    // Negative net = still off the shelf. Positive or zero = already returned.
    return rows
      .filter((r) => r.net < 0 && r.warehouseId)
      .map((r) => ({ skuId: r.skuId, warehouseId: r.warehouseId as string, qty: -r.net }));
  }
}
