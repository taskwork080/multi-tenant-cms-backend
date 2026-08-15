import { Body, ConflictException, Controller, NotFoundException, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/db.tokens";
import { inboundReceiptItems, inboundReceipts, warehouses } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { CurrentUser } from "../auth/decorators";
import { actorOf, type AuthUser } from "../auth/auth.types";
import { CurrentTenant } from "../tenant/tenant.decorator";
import type { TenantDto } from "../tenant/tenant.service";
import { InventoryService } from "./inventory.service";
import { RequireModule } from "../tenant/module.decorator";
import { RequireCapability } from "../auth/decorators";

const createSchema = z.object({
  warehouseId: z.string().uuid(),
  supplierName: z.string().optional(),
  manufacturerId: z.string().uuid().optional(),
  referenceNo: z.string().optional(),
  photoUrl: z.string().optional(),
  note: z.string().optional(),
  /** Confirm immediately (the common case — goods are physically here). */
  confirm: z.boolean().optional(),
  items: z
    .array(
      z.object({
        skuId: z.string().uuid(),
        qty: z.number().int().positive(),
        unitCost: z.number().nonnegative().optional(),
        expiryDate: z.string().optional(),
        batchRef: z.string().optional(),
      }),
    )
    .min(1),
});

/**
 * Goods-received notes — the paper trail behind "Inventory Added".
 *
 * A receipt can be drafted before the truck arrives and confirmed when it
 * does; confirming is what actually moves stock. Splitting the two is what
 * makes a discrepancy between what was ordered and what turned up visible
 * rather than silently absorbed.
 */
@ApiTags("inventory")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@RequireModule("inventoryInbound")
@RequireCapability("inventory.receive")
@Controller("api/:tenant/inbound-receipts")
export class ReceiptsController {
  constructor(
    private readonly tdb: TenantDb,
    private readonly inventory: InventoryService,
  ) {}

  @Post("new")
  @ApiOperation({
    summary: "Create a goods-received note",
    description: "Assigns the next GRN- reference. Pass confirm:true to receive the stock in the same call.",
  })
  async create(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantDto, @Body() body: unknown) {
    const input = createSchema.parse(body);

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [warehouse] = await tx
        .select()
        .from(warehouses)
        .where(and(eq(warehouses.tenantId, tenant.id), eq(warehouses.id, input.warehouseId)))
        .limit(1);
      if (!warehouse) throw new NotFoundException("Warehouse not found");

      const ref = await this.inventory.nextRef(tx, tenant.id, "inbound_receipts", "GRN");
      const [receipt] = await tx
        .insert(inboundReceipts)
        .values({
          tenantId: tenant.id,
          ref,
          warehouseId: warehouse.id,
          warehouseName: warehouse.name,
          supplierName: input.supplierName ?? "",
          manufacturerId: input.manufacturerId,
          referenceNo: input.referenceNo,
          photoUrl: input.photoUrl,
          note: input.note,
        })
        .returning();

      for (const [i, item] of input.items.entries()) {
        const sku = await this.inventory.resolveSku(tx, tenant.id, { skuId: item.skuId });
        if (!sku) throw new NotFoundException(`SKU ${item.skuId} not found`);
        await tx.insert(inboundReceiptItems).values({
          tenantId: tenant.id,
          receiptId: receipt.id,
          skuId: sku.id,
          skuCode: sku.code,
          name: sku.name,
          qty: item.qty,
          unitCost: item.unitCost,
          expiryDate: item.expiryDate,
          batchRef: item.batchRef,
          sort: i,
        });
      }

      if (input.confirm) return this.confirmIn(tx, tenant.id, receipt.id, user);

      await this.inventory.writeActivity(tx, tenant.id, { actor: actorOf(user), action: "Drafted receipt", target: ref });
      return { receipt, warnings: [] as string[] };
    });
  }

  @Post(":id/confirm")
  @ApiOperation({
    summary: "Receive a drafted note into stock",
    description: "Raises on-hand and writes one `receive` movement per line. Idempotent once received.",
  })
  async confirm(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantDto, @Param("id") id: string) {
    return this.tdb.forTenant(tenant.id, (tx) => this.confirmIn(tx, tenant.id, id, user));
  }

  @Post(":id/cancel")
  @ApiOperation({ summary: "Cancel a drafted note", description: "Only drafts can be cancelled; received stock is already in the ledger." })
  async cancel(@CurrentUser() user: AuthUser, @CurrentTenant() tenant: TenantDto, @Param("id") id: string) {
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const receipt = await this.load(tx, tenant.id, id);
      if (receipt.status === "received") {
        throw new ConflictException("This receipt is already in stock — adjust it instead");
      }
      const [row] = await tx
        .update(inboundReceipts)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(inboundReceipts.id, id))
        .returning();
      return row;
    });
  }

  private async confirmIn(tx: Db, tenantId: string, id: string, user?: AuthUser) {
    const receipt = await this.load(tx, tenantId, id);
    if (receipt.status === "received") return { receipt, warnings: [] as string[] }; // idempotent
    if (receipt.status === "cancelled") throw new ConflictException("This receipt was cancelled");

    const items = await tx
      .select()
      .from(inboundReceiptItems)
      .where(eq(inboundReceiptItems.receiptId, receipt.id))
      .orderBy(asc(inboundReceiptItems.sort));

    if (items.length === 0) throw new ConflictException("Nothing to receive — the note has no items");

    for (const item of items) {
      const arriving = item.qty - item.receivedQty;
      if (arriving <= 0) continue;
      await this.inventory.applyMovement(tx, tenantId, {
        skuId: item.skuId,
        warehouseId: receipt.warehouseId,
        kind: "receive",
        qty: arriving,
        refType: "receipt",
        refId: receipt.id,
        refCode: receipt.ref,
        reason: "goods_received",
        note: receipt.supplierName || undefined,
      });
      await tx
        .update(inboundReceiptItems)
        .set({ receivedQty: item.qty })
        .where(eq(inboundReceiptItems.id, item.id));
    }

    const [updated] = await tx
      .update(inboundReceipts)
      .set({ status: "received", receivedAt: new Date(), updatedAt: new Date() })
      .where(eq(inboundReceipts.id, receipt.id))
      .returning();

    const skuIds = items.map((i) => i.skuId);
    await this.inventory.syncProductStock(tx, tenantId, skuIds);
    await this.inventory.writeActivity(tx, tenantId, {
      actor: actorOf(user),
      action: "Received stock",
      target: `${receipt.ref} · ${items.reduce((n, i) => n + i.qty, 0)} units`,
    });

    return { receipt: updated, warnings: await this.inventory.lowStockWarnings(tx, tenantId, skuIds) };
  }

  private async load(tx: Db, tenantId: string, id: string) {
    const [row] = await tx
      .select()
      .from(inboundReceipts)
      .where(and(eq(inboundReceipts.tenantId, tenantId), eq(inboundReceipts.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException("Receipt not found");
    return row;
  }
}
