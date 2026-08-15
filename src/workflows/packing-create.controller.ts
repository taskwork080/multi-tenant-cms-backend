import { Controller, Get, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { eq, sql } from "drizzle-orm";
import { packingLists } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { CurrentTenant } from "../tenant/tenant.decorator";
import type { TenantDto } from "../tenant/tenant.service";
import { RequireModule } from "../tenant/module.decorator";
import { RequireCapability } from "../auth/decorators";

/**
 * Creates an empty packing list with a server-assigned sequential ref.
 *
 * The ref used to be derived in the browser by taking `max()` over every
 * packing list the client had loaded (`nextPackingRef` in the frontend's
 * lib/packing-ship.ts). That was already racy — two admins creating a list at
 * the same time both computed the same ref — and it breaks outright once the
 * client only holds one page of rows. Same reasoning as `shipmentNo`, which
 * this module has always assigned server-side in `confirm`.
 *
 * Numbering matches the old client format (PKG-01 … PKG-99, then PKG-100) but
 * is computed from the numeric suffix rather than lexicographic order, so it
 * stays correct past 99.
 *
 * NOTE: must be registered before CrudModule, or the generic
 * `/api/:tenant/:resource` catch-all swallows it.
 */
@ApiTags("packing")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@RequireModule("packing")
@RequireCapability("packing.manage")
@Controller("api/:tenant/packing-lists")
export class PackingCreateController {
  constructor(private readonly tdb: TenantDb) {}

  @Post("new")
  @ApiOperation({
    summary: "Create an empty packing list with the next sequential ref",
    description: "Assigns PKG-NN from the highest existing numeric suffix for this tenant.",
  })
  async create(@CurrentTenant() tenant: TenantDto) {
    return this.tdb.forTenant(tenant.id, async (tx) => {
      // Parse the numeric suffix in SQL so PKG-100 sorts above PKG-99.
      const [{ next }] = await tx
        .select({
          next: sql<number>`coalesce(max((substring(ref from '^PKG-(\\d+)$'))::int), 0) + 1`,
        })
        .from(packingLists)
        .where(eq(packingLists.tenantId, tenant.id));

      const ref = `PKG-${next < 10 ? `0${next}` : next}`;

      const [row] = await tx
        .insert(packingLists)
        .values({ tenantId: tenant.id, ref, status: "draft" })
        .returning();
      return row;
    });
  }

  @Get("stats")
  @ApiOperation({
    summary: "Packing KPI tiles",
    description: "List counts by status plus total pieces across every carton.",
  })
  async stats(@CurrentTenant() tenant: TenantDto) {
    return this.tdb.forTenant(tenant.id, async (tx) => {
      const [counts] = await tx
        .select({
          lists: sql<number>`count(*)::int`,
          draft: sql<number>`count(*) filter (where status = 'draft')::int`,
          packed: sql<number>`count(*) filter (where status <> 'draft')::int`,
        })
        .from(packingLists)
        .where(eq(packingLists.tenantId, tenant.id));

      // Mirrors the client's itemPieces(): each carton sub-range holds
      // (to_no - from_no + 1) identical boxes, and each box contains the sum of
      // its size quantities.
      const [pieces] = await tx.execute<{ pieces: number }>(sql`
        select coalesce(sum(cs.qty * greatest(1, ic.to_no - ic.from_no + 1)), 0)::int as pieces
        from carton_sizes cs
        join item_cartons ic on ic.id = cs.carton_id
        join packing_items pi on pi.id = ic.packing_item_id
        join packing_lists pl on pl.id = pi.packing_list_id
        where pl.tenant_id = ${tenant.id}
      `);

      return { ...counts, pieces: Number(pieces?.pieces ?? 0) };
    });
  }
}
