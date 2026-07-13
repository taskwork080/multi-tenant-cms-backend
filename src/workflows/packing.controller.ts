import { Body, Controller, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { packingLists, packShipEvents } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { CurrentTenant } from "../tenant/tenant.decorator";
import { TenantGuard } from "../tenant/tenant.guard";
import type { TenantDto } from "../tenant/tenant.service";

const confirmSchema = z.object({
  signedBy: z.string().optional(),
  thirdPartyCarrier: z.string().optional(),
  thirdPartyNo: z.string().optional(),
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
@Controller("api/:tenant/packing-lists/:id")
@UseGuards(TenantGuard)
export class PackingController {
  constructor(private readonly tdb: TenantDb) {}

  @Post("confirm")
  @ApiOperation({
    summary: "Confirm a packing list",
    description:
      "Assigns the tenant's next sequential shipmentNo, stamps the sign-off, and moves the packing into the courier queue with shipStatus=awaiting. Idempotent.",
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
          updatedAt: new Date(),
        })
        .where(eq(packingLists.id, id))
        .returning();
      return updated;
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
}
