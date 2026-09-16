import { Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/db.tokens";
import { inventoryReservations, packingLists, packShipEvents, skus, warehouses } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { FulfilmentService } from "../inventory/fulfilment.service";
import { InventoryService } from "../inventory/inventory.service";
import { PackingStockService, type PackingPlan } from "../inventory/packing-stock.service";
import { CurrentTenant } from "../tenant/tenant.decorator";
import type { TenantDto } from "../tenant/tenant.service";
import { RequireModule } from "../tenant/module.decorator";
import { RequireCapability } from "../auth/decorators";

const confirmSchema = z.object({
  signedBy: z.string().optional(),
  thirdPartyCarrier: z.string().optional(),
  thirdPartyNo: z.string().optional(),
  /** Buyer details captured when adding straight into the shipment queue. */
  customerName: z.string().optional(),
  orderCode: z.string().optional(),
});

const shipEventSchema = z.object({
  status: z.enum(["awaiting", "booked", "in_transit", "delivered"]),
  note: z.string().optional(),
  attachmentUrl: z.string().optional(),
  attachmentName: z.string().optional(),
});

const mappingSchema = z.object({
  productId: z.string().uuid(),
  color: z.string().optional(),
  size: z.string().min(1),
  skuId: z.string().uuid(),
});

/**
 * Packing-list workflow: the courier timeline, and everything this document
 * does to stock.
 *
 * Packing is the outbound half of the warehouse lifecycle and is treated like
 * its inbound counterparts (receipts, transfers, counts): the document names
 * the warehouse it works against, a draft may hold stock, sign-off moves it,
 * and reopening gives it back. Every stock change goes through
 * `InventoryService.applyMovement` carrying `refType: "packing_list"`, so the
 * ledger can always explain itself.
 *
 * `stock_state` — not `shipmentNo` — is the stock gate. That number is the
 * courier's packing-shipment reference and must survive a reopen; using it to
 * guard the ledger is what made a reopened list impossible to re-confirm.
 */
@ApiTags("packing")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@ApiParam({ name: "id", description: "Packing list id (uuid)" })
@RequireModule("packing")
@RequireCapability("packing.manage")
@Controller("api/:tenant/packing-lists/:id")
export class PackingController {
  constructor(
    private readonly tdb: TenantDb,
    private readonly fulfilment: FulfilmentService,
    private readonly inventory: InventoryService,
    private readonly packingStock: PackingStockService,
  ) {}

  /* ---------------------------------------------------------------- reads */

  @Get("allocation")
  @ApiOperation({
    summary: "What this packing list would move, without moving it",
    description:
      "Resolves every packed (product, colour, size) to a SKU and reports availability at the list's warehouse, plus the pieces that could not be linked and why. Read-only — the builder calls it on every edit.",
  })
  async allocation(@CurrentTenant() tenant: TenantDto, @Param("id") id: string) {
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const plan = await this.packingStock.plan(tx, tenant.id, id);
      const held = await this.packingStock.holdsFor(tx, tenant.id, id);

      // Availability is per SKU at the chosen warehouse; without a warehouse
      // there is nothing to measure against, and the UI says so instead.
      const lines = await Promise.all(
        plan.lines.map(async (l) => ({
          ...l,
          available: plan.warehouseId
            ? await this.packingStock.availableAt(tx, tenant.id, l.skuId, plan.warehouseId)
            : null,
          heldQty: held.get(l.skuId)?.qty ?? 0,
        })),
      );

      const [list] = await tx
        .select({ stockState: packingLists.stockState, status: packingLists.status })
        .from(packingLists)
        .where(and(eq(packingLists.tenantId, tenant.id), eq(packingLists.id, id)))
        .limit(1);

      return { ...plan, lines, stockState: list?.stockState ?? "none", status: list?.status ?? "draft" };
    });
  }

  /* ---------------------------------------------------------------- holds */

  @Post("hold")
  @ApiOperation({
    summary: "Reserve the packed stock while the list is being built",
    description:
      "Converges this list's holds on what the document currently says — emitting only the net change — so nothing else can promise the same goods. Held stock stays on hand; it stops being available. Re-runnable.",
  })
  async hold(@CurrentTenant() tenant: TenantDto, @Param("id") id: string) {
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const list = await this.lock(tx, tenant.id, id);
      if (list.status !== "draft") {
        throw new ConflictException("Only a draft packing list can hold stock");
      }
      if (!list.warehouseId) {
        throw new ConflictException("Choose the warehouse this packing list ships from first");
      }
      await this.packingStock.rememberAutoMatches(tx, tenant.id, id);
      const result = await this.syncHold(tx, tenant.id, list);
      return { ...result, listId: id };
    });
  }

  @Post("release-hold")
  @ApiOperation({
    summary: "Give back everything this draft is holding",
    description: "Releases the list's holds without deleting it. The document is untouched.",
  })
  async releaseHold(@CurrentTenant() tenant: TenantDto, @Param("id") id: string) {
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const list = await this.lock(tx, tenant.id, id);
      const released = await this.releaseAll(tx, tenant.id, list);
      await tx
        .update(packingLists)
        .set({ stockState: "none", updatedAt: new Date() })
        .where(eq(packingLists.id, id));
      return { released };
    });
  }

  @Post("size-mapping")
  @ApiOperation({
    summary: "Say which stock item a packed size is",
    description:
      "Records a person's decision for (product, colour, size). It outranks any automatic match and is reused by every future packing list for that style.",
  })
  async setMapping(@CurrentTenant() tenant: TenantDto, @Body() body: unknown) {
    const input = mappingSchema.parse(body);
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [sku] = await tx
        .select({ id: skus.id })
        .from(skus)
        .where(and(eq(skus.tenantId, tenant.id), eq(skus.id, input.skuId)))
        .limit(1);
      if (!sku) throw new NotFoundException("Stock item not found");
      return this.packingStock.setMapping(tx, tenant.id, input);
    });
  }

  /* -------------------------------------------------------------- confirm */

  @Post("confirm")
  @ApiOperation({
    summary: "Confirm a packing list",
    description:
      "Assigns the tenant's next sequential shipmentNo, stamps the sign-off, moves the packing into the courier queue, and takes the packed stock off the shelf per size. Never blocked by unlinked lines or short stock — both are reported instead. Idempotent.",
  })
  async confirm(@CurrentTenant() tenant: TenantDto, @Param("id") id: string, @Body() body: unknown) {
    const input = confirmSchema.parse(body ?? {});

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const row = await this.lock(tx, tenant.id, id);
      // The stock gate, and only the stock gate. A list can be re-signed to
      // correct courier details without moving stock twice.
      const alreadyDeducted = row.stockState === "deducted";

      const [{ next }] = await tx
        .select({ next: sql<number>`coalesce(max(shipment_no), 0) + 1` })
        .from(packingLists)
        .where(eq(packingLists.tenantId, tenant.id));

      if (!row.shipmentNo) {
        await tx.insert(packShipEvents).values({
          tenantId: tenant.id,
          packingListId: id,
          status: "awaiting",
          note: "Packing confirmed — awaiting courier booking",
        });
      }

      const stock = alreadyDeducted
        ? {
            deducted: 0,
            settledForOrder: 0,
            unlinked: [],
            shortfalls: [],
            pieces: { total: 0, linked: 0, unlinked: 0 },
            stockWarnings: [],
          }
        : await this.deductPacked(tx, tenant.id, row, input.signedBy);

      const [updated] = await tx
        .update(packingLists)
        .set({
          status: "packed",
          // Kept across a reopen, so the courier's number never changes.
          shipmentNo: row.shipmentNo ?? next,
          shipStatus: row.shipStatus ?? "awaiting",
          stockState: alreadyDeducted ? row.stockState : "deducted",
          signedBy: input.signedBy ?? row.signedBy,
          signedAt: input.signedBy ? new Date() : row.signedAt,
          thirdPartyCarrier: input.thirdPartyCarrier ?? row.thirdPartyCarrier,
          thirdPartyNo: input.thirdPartyNo ?? row.thirdPartyNo,
          customerName: input.customerName ?? row.customerName,
          orderCode: input.orderCode ?? row.orderCode,
          updatedAt: new Date(),
        })
        .where(eq(packingLists.id, id))
        .returning();

      return { ...updated, ...stock };
    });
  }

  @Post("reopen")
  @ApiOperation({
    summary: "Reopen a confirmed packing list for editing",
    description:
      "Puts the deducted stock back on the shelf and re-holds it, so the list can be corrected and re-confirmed against the amended quantities. Refused once the courier has the goods. The packing-shipment number is kept.",
  })
  async reopen(@CurrentTenant() tenant: TenantDto, @Param("id") id: string) {
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const list = await this.lock(tx, tenant.id, id);

      // Reversing stock for goods that physically left would be a lie about
      // where they are. Correct those with a return or an adjustment instead.
      if (list.shipStatus && list.shipStatus !== "awaiting") {
        throw new ConflictException(
          "This shipment is already with the courier — adjust stock directly rather than reopening",
        );
      }

      let returned = 0;
      if (list.stockState === "deducted") {
        const outstanding = await this.packingStock.deductedFor(tx, tenant.id, id);
        for (const line of outstanding) {
          await this.inventory.applyMovement(tx, tenant.id, {
            skuId: line.skuId,
            warehouseId: line.warehouseId,
            // `adjust` is the generic correction kind. `return_in` means a
            // customer sent goods back, which is a different event.
            kind: "adjust",
            qty: line.qty,
            refType: "packing_list",
            refId: id,
            refCode: list.ref,
            reason: "packing_reopened",
          });
          returned += line.qty;
        }
        await this.inventory.syncProductStock(tx, tenant.id, outstanding.map((l) => l.skuId));
      }

      // The deduction has been reversed, so the holds it settled are unsettled.
      // Without this the row keeps its old `fulfilledQty`, the re-hold has no
      // outstanding quantity left to consume, and a re-confirm takes the stock
      // off the shelf without ever dropping `reserved` — leaving the goods
      // shipped and reserved at the same time.
      await tx
        .update(inventoryReservations)
        .set({ qty: 0, fulfilledQty: 0, releasedQty: 0, status: "active", updatedAt: new Date() })
        .where(
          and(
            eq(inventoryReservations.tenantId, tenant.id),
            eq(inventoryReservations.packingListId, id),
          ),
        );

      const [reopened] = await tx
        .update(packingLists)
        .set({ status: "draft", stockState: "none", updatedAt: new Date() })
        .where(eq(packingLists.id, id))
        .returning();

      // Put the hold straight back, so reopening does not silently make the
      // goods available to something else while the list is being corrected.
      const held = reopened.warehouseId ? await this.syncHold(tx, tenant.id, reopened) : null;

      // Re-read: syncHold is what moves the row to `held`, and the caller needs
      // the state it actually ended in, not the one set on the way past.
      const [settled] = await tx
        .select()
        .from(packingLists)
        .where(eq(packingLists.id, id))
        .limit(1);

      await this.inventory.writeActivity(tx, tenant.id, {
        actor: "system",
        action: "Reopened packing list",
        target: `${list.ref} · ${returned} pieces returned to stock`,
      });

      return { ...(settled ?? reopened), returned, held };
    });
  }

  @Delete()
  @ApiOperation({
    summary: "Delete a packing list",
    description:
      "Releases anything the list is holding, and returns anything it deducted, before deleting it — a generic delete would leave the stock held by a document that no longer exists.",
  })
  async remove(@CurrentTenant() tenant: TenantDto, @Param("id") id: string) {
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const list = await this.lock(tx, tenant.id, id);

      if (list.stockState === "deducted") {
        const outstanding = await this.packingStock.deductedFor(tx, tenant.id, id);
        for (const line of outstanding) {
          await this.inventory.applyMovement(tx, tenant.id, {
            skuId: line.skuId,
            warehouseId: line.warehouseId,
            kind: "adjust",
            qty: line.qty,
            refType: "packing_list",
            refId: id,
            refCode: list.ref,
            reason: "packing_deleted",
          });
        }
        await this.inventory.syncProductStock(tx, tenant.id, outstanding.map((l) => l.skuId));
      } else {
        await this.releaseAll(tx, tenant.id, list);
      }

      await tx.delete(packingLists).where(eq(packingLists.id, id));
      await this.inventory.writeActivity(tx, tenant.id, {
        actor: "system",
        action: "Deleted packing list",
        target: list.ref,
      });
      return { deleted: true };
    });
  }

  @Post("ship-events")
  @ApiOperation({
    summary: "Append a courier tracking event",
    description: "Adds a PackShipEvent to the courier timeline and advances shipStatus (delivered also marks the packing shipped).",
  })
  async addShipEvent(@CurrentTenant() tenant: TenantDto, @Param("id") id: string, @Body() body: unknown) {
    const input = shipEventSchema.parse(body);

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [row] = await tx
        .select()
        .from(packingLists)
        .where(and(eq(packingLists.id, id), eq(packingLists.tenantId, tenant.id)))
        .limit(1);
      if (!row) throw new NotFoundException("Packing list not found");

      const [event] = await tx
        .insert(packShipEvents)
        .values({ tenantId: tenant.id, packingListId: id, ...input })
        .returning();

      const [updated] = await tx
        .update(packingLists)
        .set({
          shipStatus: input.status,
          status: input.status === "delivered" ? "shipped" : row.status,
          updatedAt: new Date(),
        })
        .where(eq(packingLists.id, id))
        .returning();
      return { ...updated, event };
    });
  }

  /* ------------------------------------------------------------ internals */

  /**
   * Loads the list and locks the row for the rest of the transaction.
   *
   * Two operators double-clicking Confirm is the realistic race, and
   * `applyMovement`'s row lock only serialises per SKU — not per document, which
   * is the thing whose state machine must not run twice.
   */
  private async lock(tx: Db, tenantId: string, id: string) {
    const [row] = await tx
      .select()
      .from(packingLists)
      .where(and(eq(packingLists.id, id), eq(packingLists.tenantId, tenantId)))
      .limit(1)
      .for("update");
    if (!row) throw new NotFoundException("Packing list not found");
    return row;
  }

  /**
   * Converges this list's holds on what the document currently says.
   *
   * Emits only the net change per SKU, so re-running after an edit that altered
   * nothing writes no ledger rows — important because the builder saves
   * constantly and a hold per keystroke would bury the movement log.
   *
   * A shortfall never throws. `applyMovement` refuses to reserve more than is on
   * hand, so the amount is clamped to what exists and the remainder is reported
   * — signing is never blocked by stock the warehouse does not have.
   */
  private async syncHold(tx: Db, tenantId: string, list: typeof packingLists.$inferSelect) {
    const warehouseId = list.warehouseId;
    if (!warehouseId) return { held: 0, released: 0, shortfalls: [] as { skuId: string; short: number }[] };

    const plan = await this.packingStock.plan(tx, tenantId, list.id);
    const untracked = await this.packingStock.untrackedProducts(
      tx,
      tenantId,
      plan.lines.map((l) => l.skuId),
    );
    const existing = await this.packingStock.holdsFor(tx, tenantId, list.id);
    // Denormalized onto the hold row so the outbound queue needs no join.
    const [warehouse] = await tx
      .select({ name: warehouses.name })
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, warehouseId)))
      .limit(1);
    const warehouseName = warehouse?.name ?? "";

    // An order behind this list already holds the goods; holding them again
    // would count the same pieces twice in `reserved`.
    const order = list.orderCode ? await this.fulfilment.orderByCode(tx, tenantId, list.orderCode) : null;
    const orderHeld = order ? await this.orderHolds(tx, tenantId, order.id) : new Map<string, number>();

    let held = 0;
    let released = 0;
    const shortfalls: { skuId: string; short: number }[] = [];
    const touched: string[] = [];

    for (const line of plan.lines) {
      if (untracked.has(line.skuId)) continue;
      const covered = Math.min(line.qty, orderHeld.get(line.skuId) ?? 0);
      const want = line.qty - covered;
      const have = existing.get(line.skuId)?.qty ?? 0;
      let delta = want - have;

      if (delta > 0) {
        const available = await this.packingStock.availableAt(tx, tenantId, line.skuId, warehouseId);
        if (available < delta) {
          shortfalls.push({ skuId: line.skuId, short: delta - Math.max(0, available) });
          delta = Math.max(0, available);
        }
      }
      if (delta === 0) continue;

      await this.inventory.applyMovement(tx, tenantId, {
        skuId: line.skuId,
        warehouseId,
        kind: delta > 0 ? "reserve" : "release",
        qty: 0,
        reservedDelta: delta,
        refType: "packing_list",
        refId: list.id,
        refCode: list.ref,
        reason: delta > 0 ? "packing_hold" : "packing_hold_reduced",
      });
      touched.push(line.skuId);
      if (delta > 0) held += delta;
      else released += -delta;

      await this.upsertHold(tx, tenantId, list, line.skuId, warehouseId, have + delta, line.skuCode, line.skuName, warehouseName);
    }

    // Anything the document no longer packs gives its hold back.
    for (const [skuId, row] of existing) {
      if (plan.lines.some((l) => l.skuId === skuId)) continue;
      const outstanding = row.qty - row.fulfilledQty - row.releasedQty;
      if (outstanding <= 0) continue;
      await this.inventory.applyMovement(tx, tenantId, {
        skuId,
        warehouseId: row.warehouseId,
        kind: "release",
        qty: 0,
        reservedDelta: -outstanding,
        refType: "packing_list",
        refId: list.id,
        refCode: list.ref,
        reason: "packing_hold_removed",
      });
      await tx
        .update(inventoryReservations)
        .set({ releasedQty: row.releasedQty + outstanding, status: "released", updatedAt: new Date() })
        .where(eq(inventoryReservations.id, row.id));
      released += outstanding;
      touched.push(skuId);
    }

    if (held > 0 || released > 0) {
      await tx
        .update(packingLists)
        .set({ stockState: "held", updatedAt: new Date() })
        .where(eq(packingLists.id, list.id));
    }

    return { held, released, shortfalls, warnings: await this.inventory.lowStockWarnings(tx, tenantId, touched) };
  }

  /** Outstanding order-held quantity per SKU, so packing does not re-hold it. */
  private async orderHolds(tx: Db, tenantId: string, orderId: string) {
    const rows = await tx
      .select({
        skuId: inventoryReservations.skuId,
        outstanding: sql<number>`sum(${inventoryReservations.qty} - ${inventoryReservations.fulfilledQty} - ${inventoryReservations.releasedQty})::int`,
      })
      .from(inventoryReservations)
      .where(
        and(
          eq(inventoryReservations.tenantId, tenantId),
          eq(inventoryReservations.orderId, orderId),
          eq(inventoryReservations.status, "active"),
        ),
      )
      .groupBy(inventoryReservations.skuId);
    return new Map(rows.map((r) => [r.skuId, r.outstanding]));
  }

  /** The reservation ROWS an order still holds, per SKU — settled at confirm. */
  private async orderHoldRows(tx: Db, tenantId: string, orderId: string) {
    const rows = await tx
      .select()
      .from(inventoryReservations)
      .where(
        and(
          eq(inventoryReservations.tenantId, tenantId),
          eq(inventoryReservations.orderId, orderId),
          eq(inventoryReservations.status, "active"),
        ),
      );
    const out = new Map<string, (typeof inventoryReservations.$inferSelect)[]>();
    for (const r of rows) {
      const list = out.get(r.skuId) ?? [];
      list.push(r);
      out.set(r.skuId, list);
    }
    return out;
  }

  private async upsertHold(
    tx: Db,
    tenantId: string,
    list: typeof packingLists.$inferSelect,
    skuId: string,
    warehouseId: string,
    qty: number,
    skuCode: string,
    skuName: string,
    warehouseName: string,
  ) {
    await tx
      .insert(inventoryReservations)
      .values({
        tenantId,
        skuId,
        warehouseId,
        packingListId: list.id,
        // The outbound queue reads this column to label a hold. A packing hold
        // has no order, so it carries the packing reference instead.
        orderCode: list.ref,
        skuCode,
        skuName,
        warehouseName,
        qty,
        status: "active",
      })
      .onConflictDoUpdate({
        target: [inventoryReservations.packingListId, inventoryReservations.skuId, inventoryReservations.warehouseId],
        // The unique index is partial (`where packing_list_id is not null`), so
        // the predicate has to be repeated here — Postgres will not match a
        // partial index from the column list alone.
        targetWhere: sql`${inventoryReservations.packingListId} is not null`,
        set: { qty, status: "active", updatedAt: new Date() },
      });
  }

  /** Gives back every outstanding hold this list owns. */
  private async releaseAll(tx: Db, tenantId: string, list: typeof packingLists.$inferSelect) {
    const holds = await this.packingStock.holdsFor(tx, tenantId, list.id);
    let released = 0;
    const touched: string[] = [];
    for (const [skuId, row] of holds) {
      const outstanding = row.qty - row.fulfilledQty - row.releasedQty;
      if (outstanding <= 0) continue;
      await this.inventory.applyMovement(tx, tenantId, {
        skuId,
        warehouseId: row.warehouseId,
        kind: "release",
        qty: 0,
        reservedDelta: -outstanding,
        refType: "packing_list",
        refId: list.id,
        refCode: list.ref,
        reason: "packing_hold_released",
      });
      await tx
        .update(inventoryReservations)
        .set({ releasedQty: row.releasedQty + outstanding, status: "released", updatedAt: new Date() })
        .where(eq(inventoryReservations.id, row.id));
      released += outstanding;
      touched.push(skuId);
    }
    if (touched.length) await this.inventory.syncProductStock(tx, tenantId, touched);
    return released;
  }

  /**
   * Takes the packed stock off the shelf, per size.
   *
   * Replaces a version that resolved ONE SKU per line from an optional
   * `product_id` — so a free-text garment line deducted nothing at all and the
   * list confirmed reporting success. Quantities now come from the carton size
   * ratios and each (colour, size) resolves to its own SKU.
   *
   * Nothing here throws on a shortage. Signing is never blocked (an unlinked or
   * short line is reported, not refused), which means the deduction has to be
   * clamped to what is actually on hand — `applyMovement` would otherwise abort
   * the whole confirm over one line.
   */
  private async deductPacked(
    tx: Db,
    tenantId: string,
    list: typeof packingLists.$inferSelect,
    actor?: string,
  ) {
    await this.packingStock.rememberAutoMatches(tx, tenantId, list.id);
    const plan: PackingPlan = await this.packingStock.plan(tx, tenantId, list.id);

    const warehouseId = list.warehouseId;
    if (!warehouseId) {
      // Without a warehouse there is no shelf to take them off. Say so rather
      // than guessing a site and quietly moving someone else's stock.
      return {
        deducted: 0,
        settledForOrder: 0,
        unlinked: plan.unlinked,
        shortfalls: [] as { skuCode: string; short: number }[],
        pieces: plan.pieces,
        stockWarnings: ["No warehouse set on this packing list — no stock was moved."],
      };
    }

    const untracked = await this.packingStock.untrackedProducts(tx, tenantId, plan.lines.map((l) => l.skuId));
    const holds = await this.packingStock.holdsFor(tx, tenantId, list.id);
    // The order behind this list, if the free-text code resolves to one. Its
    // reservations must be settled here or they keep promising shipped goods.
    const order = list.orderCode ? await this.fulfilment.orderByCode(tx, tenantId, list.orderCode) : null;
    const orderHolds = order
      ? await this.orderHoldRows(tx, tenantId, order.id)
      : new Map<string, (typeof inventoryReservations.$inferSelect)[]>();

    let deducted = 0;
    let settledForOrder = 0;
    const shortfalls: { skuCode: string; short: number }[] = [];
    const touched: string[] = [];

    for (const line of plan.lines) {
      if (untracked.has(line.skuId)) continue;

      const onHand = await this.packingStock.onHandAt(tx, tenantId, line.skuId, warehouseId);
      const take = Math.min(line.qty, Math.max(0, onHand));
      if (take < line.qty) shortfalls.push({ skuCode: line.skuCode, short: line.qty - take });
      if (take <= 0) continue;

      // Consume this list's own hold first; anything beyond it comes straight
      // off on-hand. Dropping `reserved` alongside `onHand` is what keeps
      // "available" unchanged by packing — only the shelf count falls.
      const hold = holds.get(line.skuId);
      const heldOutstanding = hold ? Math.max(0, hold.qty - hold.fulfilledQty - hold.releasedQty) : 0;
      const fromHold = Math.min(take, heldOutstanding);

      if (fromHold > 0) {
        await this.inventory.applyMovement(tx, tenantId, {
          skuId: line.skuId,
          warehouseId,
          kind: "deduct",
          qty: -fromHold,
          reservedDelta: -fromHold,
          refType: "packing_list",
          refId: list.id,
          refCode: list.ref,
          reason: "packed",
          actor,
        });
        await tx
          .update(inventoryReservations)
          .set({
            fulfilledQty: hold!.fulfilledQty + fromHold,
            status: hold!.fulfilledQty + fromHold + hold!.releasedQty >= hold!.qty ? "fulfilled" : "active",
            updatedAt: new Date(),
          })
          .where(eq(inventoryReservations.id, hold!.id));
      }

      // Then the order's own hold, when this list is packing an order.
      //
      // This is the double-count fix. Taking the remainder straight off on-hand
      // would leave the order still reserving goods that have physically gone —
      // the same pieces counted twice, once as shipped and once as promised.
      let fromOrder = 0;
      let remaining = take - fromHold;
      for (const res of orderHolds.get(line.skuId) ?? []) {
        if (remaining <= 0) break;
        const outstanding = Math.max(0, res.qty - res.fulfilledQty - res.releasedQty);
        const settle = Math.min(remaining, outstanding);
        if (settle <= 0) continue;

        await this.inventory.applyMovement(tx, tenantId, {
          skuId: line.skuId,
          warehouseId,
          kind: "deduct",
          qty: -settle,
          reservedDelta: -settle,
          refType: "packing_list",
          refId: list.id,
          refCode: list.ref,
          reason: "packed",
          actor,
        });
        await tx
          .update(inventoryReservations)
          .set({
            fulfilledQty: res.fulfilledQty + settle,
            status: res.fulfilledQty + settle + res.releasedQty >= res.qty ? "fulfilled" : "active",
            updatedAt: new Date(),
          })
          .where(eq(inventoryReservations.id, res.id));

        res.fulfilledQty += settle;
        fromOrder += settle;
        remaining -= settle;
      }

      // Anything still unaccounted for was never promised to anyone — it comes
      // straight off the shelf.
      if (remaining > 0) {
        await this.inventory.applyMovement(tx, tenantId, {
          skuId: line.skuId,
          warehouseId,
          kind: "deduct",
          qty: -remaining,
          refType: "packing_list",
          refId: list.id,
          refCode: list.ref,
          reason: "packed_unreserved",
          actor,
        });
      }

      if (fromOrder > 0) settledForOrder += fromOrder;
      deducted += take;
      touched.push(line.skuId);
    }

    if (touched.length) await this.inventory.syncProductStock(tx, tenantId, touched);
    await this.inventory.writeActivity(tx, tenantId, {
      actor: actor ?? "system",
      action: "Confirmed packing list",
      target: `${list.ref} · ${deducted} pieces off stock${plan.pieces.unlinked ? ` · ${plan.pieces.unlinked} not linked` : ""}`,
    });

    return {
      deducted,
      settledForOrder,
      unlinked: plan.unlinked,
      shortfalls,
      pieces: plan.pieces,
      stockWarnings: await this.inventory.lowStockWarnings(tx, tenantId, touched),
    };
  }
}
