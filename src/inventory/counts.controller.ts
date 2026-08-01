import { Body, ConflictException, Controller, NotFoundException, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/db.tokens";
import { cycleCountItems, cycleCounts, inventoryLevels, warehouses } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { CurrentTenant } from "../tenant/tenant.decorator";
import { TenantGuard } from "../tenant/tenant.guard";
import type { TenantDto } from "../tenant/tenant.service";
import { InventoryService } from "./inventory.service";

const createSchema = z.object({
  warehouseId: z.string().uuid(),
  scope: z.enum(["full", "category", "abc", "manual"]).default("manual"),
  countedBy: z.string().optional(),
  note: z.string().optional(),
  /** Omitted for a `full` count — every stocked SKU in the warehouse is pulled in. */
  skuIds: z.array(z.string().uuid()).optional(),
});

const countSchema = z.object({
  lines: z.array(z.object({ itemId: z.string().uuid(), countedQty: z.number().int().nonnegative().nullable() })).min(1),
});

/**
 * Stock takes.
 *
 * A count sheet is built from a snapshot of expected quantities, filled in by
 * whoever walks the aisles, then *posted* — which is the only step that
 * touches stock. Keeping the count and the adjustment separate means the
 * variance is recorded as a fact, not inferred afterwards from the ledger.
 */
@ApiTags("inventory")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@Controller("api/:tenant/cycle-counts")
@UseGuards(TenantGuard)
export class CountsController {
  constructor(
    private readonly tdb: TenantDb,
    private readonly inventory: InventoryService,
  ) {}

  @Post("new")
  @ApiOperation({
    summary: "Open a count sheet",
    description: "Snapshots current on-hand as the expected quantity for every SKU in scope.",
  })
  async create(@CurrentTenant() tenant: TenantDto, @Body() body: unknown) {
    const input = createSchema.parse(body);

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [warehouse] = await tx
        .select()
        .from(warehouses)
        .where(and(eq(warehouses.tenantId, tenant.id), eq(warehouses.id, input.warehouseId)))
        .limit(1);
      if (!warehouse) throw new NotFoundException("Warehouse not found");

      const levels = await tx
        .select()
        .from(inventoryLevels)
        .where(
          and(
            eq(inventoryLevels.tenantId, tenant.id),
            eq(inventoryLevels.warehouseId, warehouse.id),
            ...(input.skuIds?.length ? [inArray(inventoryLevels.skuId, input.skuIds)] : []),
          ),
        )
        .orderBy(asc(inventoryLevels.skuCode));

      if (levels.length === 0) {
        throw new ConflictException("Nothing to count — this warehouse holds no stock for the selected SKUs");
      }

      const ref = await this.inventory.nextRef(tx, tenant.id, "cycle_counts", "CNT");
      const [count] = await tx
        .insert(cycleCounts)
        .values({
          tenantId: tenant.id,
          ref,
          warehouseId: warehouse.id,
          warehouseName: warehouse.name,
          status: "counting",
          scope: input.scope,
          countedBy: input.countedBy ?? "",
          note: input.note,
        })
        .returning();

      await tx.insert(cycleCountItems).values(
        levels.map((l, i) => ({
          tenantId: tenant.id,
          countId: count.id,
          skuId: l.skuId,
          skuCode: l.skuCode,
          name: l.skuName,
          expectedQty: l.onHand,
          sort: i,
        })),
      );

      await this.inventory.writeActivity(tx, tenant.id, {
        action: "Opened stock count",
        target: `${ref} · ${warehouse.name}`,
      });

      return count;
    });
  }

  @Patch(":id/lines")
  @ApiOperation({
    summary: "Record counted quantities",
    description: "Saves progress without posting. Null clears a line back to uncounted.",
  })
  async saveLines(@CurrentTenant() tenant: TenantDto, @Param("id") id: string, @Body() body: unknown) {
    const input = countSchema.parse(body);

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const count = await this.load(tx, tenant.id, id);
      if (count.status === "posted") throw new ConflictException("This count has already been posted");

      for (const line of input.lines) {
        const [item] = await tx
          .select()
          .from(cycleCountItems)
          .where(and(eq(cycleCountItems.countId, count.id), eq(cycleCountItems.id, line.itemId)))
          .limit(1);
        if (!item) continue;
        await tx
          .update(cycleCountItems)
          .set({
            countedQty: line.countedQty,
            variance: line.countedQty === null ? 0 : line.countedQty - item.expectedQty,
          })
          .where(eq(cycleCountItems.id, item.id));
      }

      const [updated] = await tx
        .update(cycleCounts)
        .set({ status: count.status === "draft" ? "counting" : count.status, updatedAt: new Date() })
        .where(eq(cycleCounts.id, count.id))
        .returning();
      return updated;
    });
  }

  @Post(":id/post")
  @ApiOperation({
    summary: "Post the count",
    description:
      "Writes one `count` movement per non-zero variance, bringing on-hand in line with what was physically found. Idempotent.",
  })
  async post(@CurrentTenant() tenant: TenantDto, @Param("id") id: string, @Body() body: unknown) {
    const note = z.object({ note: z.string().optional() }).parse(body ?? {}).note;

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const count = await this.load(tx, tenant.id, id);
      if (count.status === "posted") return { adjustments: 0, count }; // idempotent
      if (count.status === "cancelled") throw new ConflictException("This count was cancelled");

      const items = await tx
        .select()
        .from(cycleCountItems)
        .where(eq(cycleCountItems.countId, count.id))
        .orderBy(asc(cycleCountItems.sort));

      // Uncounted lines are left alone — "we didn't get to it" is not "we
      // found zero", and treating it as zero would wipe real stock.
      const counted = items.filter((i) => i.countedQty !== null);
      if (counted.length === 0) throw new ConflictException("No lines have been counted yet");

      let adjustments = 0;
      const touched: string[] = [];

      for (const item of counted) {
        // Re-read the level: stock may have moved since the sheet was opened,
        // so the variance to apply is against *now*, not against the snapshot.
        const [level] = await tx
          .select()
          .from(inventoryLevels)
          .where(
            and(
              eq(inventoryLevels.tenantId, tenant.id),
              eq(inventoryLevels.skuId, item.skuId),
              eq(inventoryLevels.warehouseId, count.warehouseId),
            ),
          )
          .limit(1);

        const current = level?.onHand ?? 0;
        const delta = item.countedQty! - current;
        if (delta === 0) continue;

        await this.inventory.applyMovement(tx, tenant.id, {
          skuId: item.skuId,
          warehouseId: count.warehouseId,
          kind: "count",
          qty: delta,
          refType: "count",
          refId: count.id,
          refCode: count.ref,
          reason: delta > 0 ? "count_surplus" : "count_shortage",
          note,
          actor: count.countedBy || "system",
        });
        adjustments += 1;
        touched.push(item.skuId);
      }

      const [updated] = await tx
        .update(cycleCounts)
        .set({ status: "posted", postedAt: new Date(), note: note ?? count.note, updatedAt: new Date() })
        .where(eq(cycleCounts.id, count.id))
        .returning();

      await this.inventory.syncProductStock(tx, tenant.id, touched);
      await this.inventory.writeActivity(tx, tenant.id, {
        action: "Posted stock count",
        target: `${count.ref} · ${adjustments} adjustment${adjustments === 1 ? "" : "s"}`,
      });

      return { adjustments, count: updated };
    });
  }

  @Post(":id/cancel")
  @ApiOperation({ summary: "Abandon a count without touching stock" })
  async cancel(@CurrentTenant() tenant: TenantDto, @Param("id") id: string) {
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const count = await this.load(tx, tenant.id, id);
      if (count.status === "posted") throw new ConflictException("A posted count cannot be cancelled");
      const [row] = await tx
        .update(cycleCounts)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(cycleCounts.id, id))
        .returning();
      return row;
    });
  }

  private async load(tx: Db, tenantId: string, id: string) {
    const [row] = await tx
      .select()
      .from(cycleCounts)
      .where(and(eq(cycleCounts.tenantId, tenantId), eq(cycleCounts.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException("Count not found");
    return row;
  }
}
