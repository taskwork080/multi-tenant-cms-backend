import { Body, Controller, NotFoundException, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { orders } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { CurrentTenant } from "../tenant/tenant.decorator";
import { TenantGuard } from "../tenant/tenant.guard";
import type { TenantDto } from "../tenant/tenant.service";
import { FulfilmentService } from "./fulfilment.service";

const reserveSchema = z.object({
  orderId: z.string().uuid(),
  /** Hold what's there and report the rest, instead of rejecting the order. */
  allowPartial: z.boolean().optional(),
});

const releaseSchema = z.object({
  orderId: z.string().uuid(),
  reason: z.enum(["cancel", "return", "expire"]).default("cancel"),
});

const deductSchema = z.object({
  refType: z.enum(["packing_list", "order", "shipment"]),
  refId: z.string().uuid(),
  refCode: z.string().optional(),
  orderId: z.string().uuid().optional(),
  lines: z
    .array(
      z.object({
        skuId: z.string().uuid(),
        qty: z.number().int().positive(),
        warehouseId: z.string().uuid().optional(),
      }),
    )
    .min(1),
});

/**
 * Reserve / release / deduct as explicit endpoints.
 *
 * Order creation and packing confirmation call FulfilmentService directly
 * inside their own transactions — these routes exist for the cases a human
 * drives: freeing a hold from the Outbound queue, re-reserving an order that
 * was placed while a warehouse was empty, or deducting a packing list that
 * predates the reservation model.
 */
@ApiTags("inventory")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@Controller("api/:tenant/inventory")
@UseGuards(TenantGuard)
export class FulfilmentController {
  constructor(
    private readonly tdb: TenantDb,
    private readonly fulfilment: FulfilmentService,
  ) {}

  @Post("reserve")
  @ApiOperation({
    summary: "Hold stock for an order",
    description:
      "409s with a per-line shortfall breakdown when stock is short, unless allowPartial is set. Idempotent per order line.",
  })
  async reserve(@CurrentTenant() tenant: TenantDto, @Body() body: unknown) {
    const input = reserveSchema.parse(body);
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.tenantId, tenant.id), eq(orders.id, input.orderId)))
        .limit(1);
      if (!order) throw new NotFoundException("Order not found");
      return this.fulfilment.reserveOrder(tx, tenant.id, input.orderId, { allowPartial: input.allowPartial });
    });
  }

  @Post("release")
  @ApiOperation({
    summary: "Return an order's holds to available",
    description: "Releases everything still active on the order. Safe to call more than once.",
  })
  async release(@CurrentTenant() tenant: TenantDto, @Body() body: unknown) {
    const input = releaseSchema.parse(body);
    return this.tdb.forTenant(tenant.id, async (tx) => ({
      released: await this.fulfilment.releaseOrder(tx, tenant.id, input.orderId, input.reason),
    }));
  }

  @Post("deduct")
  @ApiOperation({
    summary: "Convert holds into a deduction",
    description:
      "Consumes reservations first, then takes any excess straight off on-hand. Refuses to take stock below zero.",
  })
  async deduct(@CurrentTenant() tenant: TenantDto, @Body() body: unknown) {
    const input = deductSchema.parse(body);
    return this.tdb.forTenant(tenant.id, async (tx) => {
      if (await this.fulfilment.alreadyProcessed(tx, tenant.id, input.refType, input.refId)) {
        return { deducted: 0, warnings: [], alreadyProcessed: true };
      }
      return this.fulfilment.deduct(
        tx,
        tenant.id,
        input.lines,
        { type: input.refType, id: input.refId, code: input.refCode, orderId: input.orderId },
      );
    });
  }
}
