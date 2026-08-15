import { Body, Controller, NotFoundException, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/db.tokens";
import { packingItems, packingLists, packShipEvents } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { FulfilmentService } from "../inventory/fulfilment.service";
import { InventoryService } from "../inventory/inventory.service";
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

/** Packing-list workflow: confirm into the Packing Shipments queue + courier timeline. */
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
  ) {}

  @Post("confirm")
  @ApiOperation({
    summary: "Confirm a packing list",
    description:
      "Assigns the tenant's next sequential shipmentNo, stamps the sign-off, moves the packing into the courier queue, and deducts the packed stock — converting the order's reservations into a real deduction. Idempotent.",
  })
  async confirm(@CurrentTenant() tenant: TenantDto, @Param("id") id: string, @Body() body: unknown) {
    const input = confirmSchema.parse(body ?? {});

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [row] = await tx
        .select()
        .from(packingLists)
        .where(and(eq(packingLists.id, id), eq(packingLists.tenantId, tenant.id)))
        .limit(1);
      if (!row) throw new NotFoundException("Packing list not found");
      if (row.shipmentNo) return row; // already confirmed — idempotent

      const [{ next }] = await tx
        .select({ next: sql<number>`coalesce(max(shipment_no), 0) + 1` })
        .from(packingLists)
        .where(eq(packingLists.tenantId, tenant.id));

      await tx.insert(packShipEvents).values({
        tenantId: tenant.id,
        packingListId: id,
        status: "awaiting",
        note: "Packing confirmed — awaiting courier booking",
      });

      const [updated] = await tx
        .update(packingLists)
        .set({
          status: "packed",
          shipmentNo: next,
          shipStatus: "awaiting",
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

      // Confirming is the moment the goods physically leave the shelf, so it
      // is where reservations become deductions. The shipmentNo gate above
      // already makes this at-most-once.
      const stock = await this.deductPacked(tx, tenant.id, id, updated.orderCode, input.signedBy);

      return { ...updated, ...stock };
    });
  }

  /**
   * Turns a confirmed packing list into stock movements.
   *
   * Quantity has historically lived two levels below a packing item, in
   * carton_sizes, so `packing_items.qty` is only trusted when set and the
   * carton sum is used otherwise — old packing lists still deduct correctly.
   *
   * A list whose items carry no SKU and no quantity deducts nothing and says
   * so, rather than silently confirming as if stock had moved.
   */
  private async deductPacked(
    tx: Db,
    tenantId: string,
    packingListId: string,
    orderCode: string | null,
    actor?: string,
  ): Promise<{ deducted: number; stockWarnings: string[] }> {
    if (await this.fulfilment.alreadyProcessed(tx, tenantId, "packing_list", packingListId)) {
      return { deducted: 0, stockWarnings: [] };
    }

    const rows = await tx.execute(sql`
      select pi.id, pi.sku_id as "skuId", pi.product_id as "productId",
             greatest(
               pi.qty,
               coalesce((
                 select sum(cs.qty * greatest(ic.to_no - ic.from_no + 1, 1))::int
                   from public.item_cartons ic
                   join public.carton_sizes cs on cs.carton_id = ic.id
                  where ic.packing_item_id = pi.id
               ), 0)
             )::int as qty
        from public.packing_items pi
       where pi.packing_list_id = ${packingListId}
    `);

    const items = rows as unknown as { id: string; skuId: string | null; productId: string | null; qty: number }[];

    const lines: { skuId: string; qty: number }[] = [];
    for (const item of items) {
      if (item.qty <= 0) continue;
      const sku = await this.inventory.resolveSku(tx, tenantId, {
        skuId: item.skuId,
        productId: item.productId,
      });
      if (!sku) continue;
      lines.push({ skuId: sku.id, qty: item.qty });
      if (!item.skuId) {
        await tx.update(packingItems).set({ skuId: sku.id }).where(eq(packingItems.id, item.id));
      }
    }

    if (lines.length === 0) return { deducted: 0, stockWarnings: [] };

    const order = orderCode ? await this.fulfilment.orderByCode(tx, tenantId, orderCode) : null;
    const { deducted, warnings } = await this.fulfilment.deduct(
      tx,
      tenantId,
      lines,
      { type: "packing_list", id: packingListId, code: orderCode ?? undefined, orderId: order?.id },
      actor,
    );

    return { deducted, stockWarnings: warnings };
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
}
