import { Body, ConflictException, Controller, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/db.tokens";
import { stockTransferItems, stockTransfers, warehouses } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { CurrentUser } from "../auth/decorators";
import { actorOf, type AuthUser } from "../auth/auth.types";
import { CurrentTenant } from "../tenant/tenant.decorator";
import { TenantGuard } from "../tenant/tenant.guard";
import type { TenantDto } from "../tenant/tenant.service";
import { InventoryService } from "./inventory.service";

const createSchema = z.object({
  fromWarehouseId: z.string().uuid(),
  toWarehouseId: z.string().uuid(),
  note: z.string().optional(),
  items: z
    .array(z.object({ skuId: z.string().uuid(), qty: z.number().int().positive() }))
    .min(1),
});

const dispatchSchema = z.object({
  carrier: z.string().optional(),
  trackingRef: z.string().optional(),
  note: z.string().optional(),
});

const receiveSchema = z.object({
  lines: z.array(z.object({ itemId: z.string().uuid(), receivedQty: z.number().int().nonnegative() })).optional(),
  note: z.string().optional(),
});

/**
 * Warehouse-to-warehouse stock movement.
 *
 * Stock is deliberately *not* in two places at once while in transit: dispatch
 * removes it from the source and only raises the destination's `incoming`
 * counter. It becomes on-hand at the destination when someone confirms it
 * arrived — which is also the moment shortfalls and damage surface.
 */
@ApiTags("inventory")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@Controller("api/:tenant/stock-transfers")
@UseGuards(TenantGuard)
export class TransfersController {
  constructor(
    private readonly tdb: TenantDb,
    private readonly inventory: InventoryService,
  ) {}

  @Post("new")
  @ApiOperation({
    summary: "Create a draft transfer",
    description: "Assigns the next TRF- reference. Creating a draft moves no stock — dispatch does that.",
  })
  async create(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantDto, @Body() body: unknown) {
    const input = createSchema.parse(body);
    if (input.fromWarehouseId === input.toWarehouseId) {
      throw new ConflictException("Source and destination warehouse must differ");
    }

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [from, to] = await Promise.all([
        this.warehouse(tx, tenant.id, input.fromWarehouseId),
        this.warehouse(tx, tenant.id, input.toWarehouseId),
      ]);

      const ref = await this.inventory.nextRef(tx, tenant.id, "stock_transfers", "TRF");
      const [transfer] = await tx
        .insert(stockTransfers)
        .values({
          tenantId: tenant.id,
          ref,
          fromWarehouseId: from.id,
          toWarehouseId: to.id,
          fromWarehouseName: from.name,
          toWarehouseName: to.name,
          note: input.note,
        })
        .returning();

      for (const [i, item] of input.items.entries()) {
        const sku = await this.inventory.resolveSku(tx, tenant.id, { skuId: item.skuId });
        if (!sku) throw new NotFoundException(`SKU ${item.skuId} not found`);
        await tx.insert(stockTransferItems).values({
          tenantId: tenant.id,
          transferId: transfer.id,
          skuId: sku.id,
          skuCode: sku.code,
          name: sku.name,
          qty: item.qty,
          sort: i,
        });
      }

      await this.inventory.writeActivity(tx, tenant.id, {
        actor: actorOf(user),
        action: "Created stock transfer",
        target: `${ref} · ${from.name} → ${to.name}`,
      });

      return transfer;
    });
  }

  @Post(":id/dispatch")
  @ApiOperation({
    summary: "Send a draft transfer on its way",
    description:
      "Removes stock from the source and raises the destination's incoming count. Idempotent — re-dispatching an already-sent transfer returns it unchanged.",
  })
  async dispatch(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantDto, @Param("id") id: string, @Body() body: unknown) {
    const input = dispatchSchema.parse(body ?? {});

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const transfer = await this.load(tx, tenant.id, id);
      if (transfer.status !== "draft") return transfer; // already dispatched — idempotent

      const items = await this.items(tx, transfer.id);
      if (items.length === 0) throw new ConflictException("Nothing to dispatch — the transfer has no items");

      for (const item of items) {
        // applyMovement rejects an over-draw against the nonneg constraint, so
        // a transfer can never invent stock the source doesn't have.
        await this.inventory.applyMovement(tx, tenant.id, {
          skuId: item.skuId,
          warehouseId: transfer.fromWarehouseId,
          kind: "transfer_out",
          qty: -item.qty,
          refType: "transfer",
          refId: transfer.id,
          refCode: transfer.ref,
          reason: "transfer_dispatch",
        });
        await this.inventory.applyIncoming(tx, tenant.id, item.skuId, transfer.toWarehouseId, item.qty);
      }

      const [updated] = await tx
        .update(stockTransfers)
        .set({
          status: "in_transit",
          dispatchedAt: new Date(),
          carrier: input.carrier ?? transfer.carrier,
          trackingRef: input.trackingRef ?? transfer.trackingRef,
          note: input.note ?? transfer.note,
          updatedAt: new Date(),
        })
        .where(eq(stockTransfers.id, transfer.id))
        .returning();

      await this.inventory.syncProductStock(tx, tenant.id, items.map((i) => i.skuId));
      await this.inventory.writeActivity(tx, tenant.id, {
        actor: actorOf(user),
        action: "Dispatched stock transfer",
        target: transfer.ref,
      });

      return updated;
    });
  }

  @Post(":id/receive")
  @ApiOperation({
    summary: "Confirm arrival at the destination",
    description:
      "Lands the received quantities as on-hand. A partial receipt keeps the transfer in transit so the shortfall stays visible.",
  })
  async receive(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantDto, @Param("id") id: string, @Body() body: unknown) {
    const input = receiveSchema.parse(body ?? {});

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const transfer = await this.load(tx, tenant.id, id);
      if (transfer.status === "received") return transfer; // idempotent
      if (transfer.status !== "in_transit") {
        throw new ConflictException(`Cannot receive a ${transfer.status} transfer`);
      }

      const items = await this.items(tx, transfer.id);
      const declared = new Map(input.lines?.map((l) => [l.itemId, l.receivedQty]) ?? []);

      for (const item of items) {
        // No lines supplied means "everything arrived as sent".
        const arriving = (declared.get(item.id) ?? item.qty) - item.receivedQty;
        if (arriving <= 0) continue;

        await this.inventory.applyMovement(tx, tenant.id, {
          skuId: item.skuId,
          warehouseId: transfer.toWarehouseId,
          kind: "transfer_in",
          qty: arriving,
          refType: "transfer",
          refId: transfer.id,
          refCode: transfer.ref,
          reason: "transfer_receive",
        });
        await this.inventory.applyIncoming(tx, tenant.id, item.skuId, transfer.toWarehouseId, -arriving);

        await tx
          .update(stockTransferItems)
          .set({ receivedQty: item.receivedQty + arriving })
          .where(eq(stockTransferItems.id, item.id));
      }

      const after = await this.items(tx, transfer.id);
      const complete = after.every((i) => i.receivedQty >= i.qty);

      const [updated] = await tx
        .update(stockTransfers)
        .set({
          status: complete ? "received" : "in_transit",
          receivedAt: complete ? new Date() : null,
          note: input.note ?? transfer.note,
          updatedAt: new Date(),
        })
        .where(eq(stockTransfers.id, transfer.id))
        .returning();

      await this.inventory.syncProductStock(tx, tenant.id, items.map((i) => i.skuId));
      await this.inventory.writeActivity(tx, tenant.id, {
        actor: actorOf(user),
        action: complete ? "Received stock transfer" : "Partially received stock transfer",
        target: transfer.ref,
      });

      return updated;
    });
  }

  @Post(":id/cancel")
  @ApiOperation({
    summary: "Cancel a transfer",
    description: "A dispatched transfer is returned to the source; a draft is simply closed.",
  })
  async cancel(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantDto, @Param("id") id: string, @Body() body: unknown) {
    const reason = z.object({ reason: z.string().optional() }).parse(body ?? {}).reason;

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const transfer = await this.load(tx, tenant.id, id);
      if (transfer.status === "cancelled") return transfer;
      if (transfer.status === "received") throw new ConflictException("A received transfer cannot be cancelled");

      const items = await this.items(tx, transfer.id);

      if (transfer.status === "in_transit") {
        // Put back exactly what left, minus anything already landed.
        for (const item of items) {
          const outstanding = item.qty - item.receivedQty;
          if (outstanding <= 0) continue;
          await this.inventory.applyMovement(tx, tenant.id, {
            skuId: item.skuId,
            warehouseId: transfer.fromWarehouseId,
            kind: "transfer_in",
            qty: outstanding,
            refType: "transfer",
            refId: transfer.id,
            refCode: transfer.ref,
            reason: "transfer_cancelled",
            note: reason,
          });
          await this.inventory.applyIncoming(tx, tenant.id, item.skuId, transfer.toWarehouseId, -outstanding);
        }
        await this.inventory.syncProductStock(tx, tenant.id, items.map((i) => i.skuId));
      }

      const [updated] = await tx
        .update(stockTransfers)
        .set({ status: "cancelled", note: reason ?? transfer.note, updatedAt: new Date() })
        .where(eq(stockTransfers.id, transfer.id))
        .returning();

      await this.inventory.writeActivity(tx, tenant.id, {
        actor: actorOf(user),
        action: "Cancelled stock transfer",
        target: transfer.ref,
      });

      return updated;
    });
  }

  private async load(tx: Db, tenantId: string, id: string) {
    const [row] = await tx
      .select()
      .from(stockTransfers)
      .where(and(eq(stockTransfers.tenantId, tenantId), eq(stockTransfers.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException("Transfer not found");
    return row;
  }

  private items(tx: Db, transferId: string) {
    return tx
      .select()
      .from(stockTransferItems)
      .where(eq(stockTransferItems.transferId, transferId))
      .orderBy(asc(stockTransferItems.sort));
  }

  private async warehouse(tx: Db, tenantId: string, id: string) {
    const [row] = await tx
      .select()
      .from(warehouses)
      .where(and(eq(warehouses.tenantId, tenantId), eq(warehouses.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException("Warehouse not found");
    return row;
  }
}
