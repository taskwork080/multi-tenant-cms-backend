import { Body, Controller, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { chatMessages, shipmentEvents, shipments } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { CurrentTenant } from "../tenant/tenant.decorator";
import { TenantGuard } from "../tenant/tenant.guard";
import type { TenantDto } from "../tenant/tenant.service";
import { ChatGateway } from "../chat/chat.gateway";

const eventSchema = z.object({
  status: z.enum(["processing", "dispatched", "in_transit", "out_for_delivery", "delivered", "cancelled"]),
  location: z.string().optional(),
  note: z.string().optional(),
});

const messageSchema = z.object({
  sender: z.enum(["customer", "support"]),
  author: z.string().min(1),
  text: z.string().default(""),
  attachment: z.string().optional(),
  attachmentUrl: z.string().optional(),
  attachmentType: z.enum(["image", "file"]).optional(),
});

/** Tracking timeline + shipment chat thread (append-only sub-resources). */
@ApiTags("shipments")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@ApiParam({ name: "id", description: "Shipment id (uuid)" })
@Controller("api/:tenant/shipments/:id")
@UseGuards(TenantGuard)
export class ShipmentsController {
  constructor(
    private readonly tdb: TenantDb,
    private readonly chat: ChatGateway,
  ) {}

  private async assertShipment(tx: Parameters<Parameters<TenantDb["forTenant"]>[1]>[0], tenantId: string, id: string) {
    const [row] = await tx
      .select()
      .from(shipments)
      .where(and(eq(shipments.id, id), eq(shipments.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new NotFoundException("Shipment not found");
    return row;
  }

  @Post("events")
  @ApiOperation({
    summary: "Append a tracking event",
    description: "Adds a ShipmentEvent to the timeline and advances the shipment's status/location.",
  })
  async addEvent(@CurrentTenant() tenant: TenantDto, @Param("id") id: string, @Body() body: unknown) {
    const input = eventSchema.parse(body);

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const row = await this.assertShipment(tx, tenant.id, id);
      const [event] = await tx
        .insert(shipmentEvents)
        .values({ tenantId: tenant.id, shipmentId: id, ...input })
        .returning();
      const [updated] = await tx
        .update(shipments)
        .set({ status: input.status, location: input.location ?? row.location, updatedAt: new Date() })
        .where(eq(shipments.id, id))
        .returning();
      this.chat.emitShipmentUpdate(tenant.slug, id, { kind: "event", event, status: input.status });
      return { ...updated, event };
    });
  }

  @Post("messages")
  @ApiOperation({
    summary: "Post a chat message on the shipment thread",
    description: "Persists a ChatMessage linked to this shipment and broadcasts it over WebSocket.",
  })
  async addMessage(@CurrentTenant() tenant: TenantDto, @Param("id") id: string, @Body() body: unknown) {
    const input = messageSchema.parse(body);

    return this.tdb.forTenant(tenant.id, async (tx) => {
      await this.assertShipment(tx, tenant.id, id);
      const [message] = await tx
        .insert(chatMessages)
        .values({ tenantId: tenant.id, shipmentId: id, ...input })
        .returning();
      await tx.update(shipments).set({ updatedAt: new Date() }).where(eq(shipments.id, id));
      this.chat.emitShipmentUpdate(tenant.slug, id, { kind: "message", message });
      return message;
    });
  }
}
