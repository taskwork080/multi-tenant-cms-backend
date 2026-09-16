import { Controller, Get, Header, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiTags } from "@nestjs/swagger";
import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/db.tokens";
import { inboundReceiptItems, inboundReceipts, skus, suppliers } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { parseDateWindow } from "../common/date-window";
import { RequireCapability } from "../auth/decorators";
import { RequireModule } from "../tenant/module.decorator";
import { CurrentTenant } from "../tenant/tenant.decorator";
import type { TenantDto } from "../tenant/tenant.service";

/**
 * Rows are capped rather than unbounded: the log is one row per purchased line
 * and grows without limit. The CSV export uses its own, larger cap so a full
 * year of purchasing still lands in one file.
 */
const MAX_PAGE_SIZE = 200;
const MAX_EXPORT_ROWS = 50_000;

/**
 * The purchase timestamp, rendered as strict ISO 8601 in UTC.
 *
 * Postgres hands `coalesce(timestamptz, timestamptz)` back as
 * "2026-09-12 12:50:02.567+00" — a space separator and a two-digit offset.
 * Node parses that, but `Date` in Safari and strict `dayjs` do not, so the
 * column is formatted in SQL rather than left to whichever parser sees it.
 */
const PURCHASED_AT = sql<string>`to_char(coalesce(${inboundReceipts.receivedAt}, ${inboundReceipts.createdAt}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** The same expression untyped, for WHERE and ORDER BY where the raw value is wanted. */
const PURCHASED_AT_RAW = sql`coalesce(${inboundReceipts.receivedAt}, ${inboundReceipts.createdAt})`;

const querySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(50),
  skuId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  /** Free text over SKU code/name, supplier, GRN ref and invoice number. */
  q: z.string().trim().min(1).optional(),
  /**
   * Which notes count as a purchase. Received is the default because a draft
   * is a quote, not a spend; `all` includes drafts for someone reconciling
   * what is still on order. Cancelled is never included — it did not happen.
   */
  status: z.enum(["received", "all"]).default("received"),
  /** Only lines that actually carry a price. */
  pricedOnly: z.coerce.boolean().default(false),
  /**
   * `purchasedAt` is accepted alongside `date` because the table column sorts
   * by its own dataIndex, and mapping the two in the client would put the
   * vocabulary in two places.
   */
  sort: z
    .enum([
      "date",
      "-date",
      "purchasedAt",
      "-purchasedAt",
      "unitCost",
      "-unitCost",
      "lineTotal",
      "-lineTotal",
      "qty",
      "-qty",
    ])
    .default("-date"),
});

/**
 * The purchase price log: what was bought, when, from whom, and for how much.
 *
 * A read model over `inbound_receipt_items` joined to its note — not a new
 * table. A separate "price log" would be a second copy of facts the goods-
 * received note already owns, and the two would drift the first time a receipt
 * was corrected.
 *
 * `purchased_at` is the note's `received_at` and falls back to `created_at`:
 * a draft has not been received yet but was still raised on a date, and
 * sorting a mixed list on a null would bury every draft.
 */
@ApiTags("inventory")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@RequireModule("inventoryInbound")
@RequireCapability("inventory.view")
@Controller("api/:tenant/inventory/purchases")
export class PurchasesController {
  constructor(private readonly tdb: TenantDb) {}

  @Get()
  @ApiOperation({
    summary: "Purchase price log — one row per purchased line",
    description:
      "Every receipt line with its date, supplier, quantity, unit price and lot total. Filterable by SKU, supplier, warehouse and date window. When `skuId` is given the response also carries a price series for that SKU.",
  })
  @ApiQuery({ name: "from", required: false, description: "ISO start of the purchase window" })
  @ApiQuery({ name: "to", required: false, description: "ISO end of the purchase window (inclusive)" })
  @ApiQuery({ name: "skuId", required: false })
  @ApiQuery({ name: "supplierId", required: false })
  @ApiQuery({ name: "warehouseId", required: false })
  @ApiQuery({ name: "q", required: false, description: "Search SKU code/name, supplier, GRN ref or invoice no." })
  @ApiQuery({ name: "status", required: false, enum: ["received", "all"] })
  @ApiQuery({ name: "pricedOnly", required: false, type: Boolean })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "pageSize", required: false })
  @ApiQuery({ name: "sort", required: false })
  async list(
    @CurrentTenant() tenant: TenantDto,
    @Query() query: Record<string, string>,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const input = querySchema.parse(query);
    const window = parseDateWindow(from, to);

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const where = this.filters(tenant.id, input, window);

      const [rows, [totals], [count], series] = await Promise.all([
        tx
          .select(this.columns())
          .from(inboundReceiptItems)
          .innerJoin(inboundReceipts, eq(inboundReceipts.id, inboundReceiptItems.receiptId))
          .leftJoin(suppliers, eq(suppliers.id, inboundReceipts.supplierId))
          .leftJoin(skus, eq(skus.id, inboundReceiptItems.skuId))
          .where(where)
          .orderBy(...this.ordering(input.sort))
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize),

        // Spend and the price band, over the whole filtered set rather than
        // the visible page — a page average would change as you paged.
        tx
          .select({
            units: sql<number>`coalesce(sum(${inboundReceiptItems.qty}), 0)::int`,
            // Weighted by quantity: the mean of the unit prices would let a
            // one-unit line count as much as a thousand-unit pallet.
            pricedUnits: sql<number>`coalesce(sum(${inboundReceiptItems.qty}) filter (where ${inboundReceiptItems.lineTotal} is not null), 0)::int`,
            // ::float8 — a bare numeric aggregate comes back from the driver as
            // a string ("8.50"), which then loses to a number in every
            // comparison the client makes with it.
            minUnitCost: sql<number | null>`min(${inboundReceiptItems.unitCost})::float8`,
            maxUnitCost: sql<number | null>`max(${inboundReceiptItems.unitCost})::float8`,
            spendRaw: sql<number>`coalesce(sum(${inboundReceiptItems.lineTotal}), 0)::float8`,
            // Spend including the extra bills, and the charges on their own —
            // the gap between the two is what the goods cost to get here.
            landedSpendRaw: sql<number>`coalesce(sum(coalesce(${inboundReceiptItems.landedTotal}, ${inboundReceiptItems.lineTotal})), 0)::float8`,
            chargesRaw: sql<number>`coalesce(sum(${inboundReceiptItems.allocatedCharge}), 0)::float8`,
            suppliers: sql<number>`count(distinct ${inboundReceipts.supplierName}) filter (where ${inboundReceipts.supplierName} <> '')::int`,
            skus: sql<number>`count(distinct ${inboundReceiptItems.skuId})::int`,
            firstAt: sql<string | null>`to_char(min(coalesce(${inboundReceipts.receivedAt}, ${inboundReceipts.createdAt})) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
            lastAt: sql<string | null>`to_char(max(coalesce(${inboundReceipts.receivedAt}, ${inboundReceipts.createdAt})) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
          })
          .from(inboundReceiptItems)
          .innerJoin(inboundReceipts, eq(inboundReceipts.id, inboundReceiptItems.receiptId))
          .leftJoin(suppliers, eq(suppliers.id, inboundReceipts.supplierId))
          .leftJoin(skus, eq(skus.id, inboundReceiptItems.skuId))
          .where(where),

        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(inboundReceiptItems)
          .innerJoin(inboundReceipts, eq(inboundReceipts.id, inboundReceiptItems.receiptId))
          .leftJoin(suppliers, eq(suppliers.id, inboundReceipts.supplierId))
          .leftJoin(skus, eq(skus.id, inboundReceiptItems.skuId))
          .where(where),

        // Only meaningful for a single SKU — a series mixing SKUs would plot
        // the price of nothing in particular.
        input.skuId ? this.priceSeries(tx, tenant.id, input, window) : Promise.resolve([]),
      ]);

      const spend = Number(totals?.spendRaw ?? 0);
      const landedSpend = Number(totals?.landedSpendRaw ?? 0);
      const charges = Number(totals?.chargesRaw ?? 0);
      const pricedUnits = totals?.pricedUnits ?? 0;

      return {
        rows,
        page: input.page,
        pageSize: input.pageSize,
        total: count?.n ?? 0,
        summary: {
          lines: count?.n ?? 0,
          units: totals?.units ?? 0,
          spend,
          /** Spend including freight, duty and the other delivery bills. */
          landedSpend,
          /** Those bills on their own. */
          charges,
          /** Quantity-weighted, and null when nothing in the set carries a price. */
          avgUnitCost: pricedUnits ? Math.round((spend / pricedUnits) * 100) / 100 : null,
          /** The same, with the extra bills included. */
          avgLandedUnitCost: pricedUnits ? Math.round((landedSpend / pricedUnits) * 100) / 100 : null,
          minUnitCost: totals?.minUnitCost ?? null,
          maxUnitCost: totals?.maxUnitCost ?? null,
          suppliers: totals?.suppliers ?? 0,
          skus: totals?.skus ?? 0,
          firstAt: totals?.firstAt ?? null,
          lastAt: totals?.lastAt ?? null,
        },
        series,
      };
    });
  }

  @Get("export.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="purchase-prices.csv"')
  @ApiOperation({
    summary: "The filtered purchase log as CSV",
    description:
      "Same filters as the list endpoint, but the whole matching set rather than one page. Supplier contact details are included so the file stands alone.",
  })
  async exportCsv(
    @CurrentTenant() tenant: TenantDto,
    @Query() query: Record<string, string>,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    // The page/pageSize a viewer happened to be on must not truncate an export.
    const input = { ...querySchema.parse(query), page: 1, pageSize: MAX_PAGE_SIZE };
    const window = parseDateWindow(from, to);

    return this.tdb.forTenant(tenant.id, async (tx) => {
      const rows = await tx
        .select(this.columns())
        .from(inboundReceiptItems)
        .innerJoin(inboundReceipts, eq(inboundReceipts.id, inboundReceiptItems.receiptId))
        .leftJoin(suppliers, eq(suppliers.id, inboundReceipts.supplierId))
        .leftJoin(skus, eq(skus.id, inboundReceiptItems.skuId))
        .where(this.filters(tenant.id, input, window))
        .orderBy(...this.ordering(input.sort))
        .limit(MAX_EXPORT_ROWS);

      const header = [
        "Purchased at",
        "GRN ref",
        "Status",
        "SKU code",
        "Item",
        "Quantity",
        "Unit",
        "Unit cost",
        "Lot total",
        "Priced as",
        "Other costs share",
        "Landed total",
        "Landed unit cost",
        "Currency",
        "Supplier",
        "Supplier contact",
        "Supplier phone",
        "Supplier email",
        "Supplier tax id",
        "Invoice / PO no.",
        "Warehouse",
        "Batch ref",
        "Expiry",
        "Note",
      ];

      const body = rows.map((r) => [
        // ISO 8601: unambiguous in every spreadsheet locale, unlike a
        // localised date string which Excel reads as text or reinterprets.
        r.purchasedAt ? new Date(r.purchasedAt).toISOString() : "",
        r.ref,
        r.status,
        r.skuCode,
        r.name,
        r.qty,
        r.unit ?? "",
        r.unitCost ?? "",
        r.lineTotal ?? "",
        r.costMode === "total" ? "lot total" : "per unit",
        r.allocatedCharge ?? 0,
        r.landedTotal ?? "",
        r.landedUnitCost ?? "",
        tenant.config?.currency ?? "",
        r.supplierName,
        r.supplierContact ?? "",
        r.supplierPhone ?? "",
        r.supplierEmail ?? "",
        r.supplierTaxId ?? "",
        r.referenceNo ?? "",
        r.warehouseName,
        r.batchRef ?? "",
        r.expiryDate ?? "",
        r.note ?? "",
      ]);

      return toCsv([header, ...body]);
    });
  }

  /* ------------------------------------------------------------- internals */

  /** The projection both the list and the export read. */
  private columns() {
    return {
      id: inboundReceiptItems.id,
      receiptId: inboundReceipts.id,
      ref: inboundReceipts.ref,
      status: inboundReceipts.status,
      /** A draft has no receivedAt but was still raised on a date. */
      purchasedAt: PURCHASED_AT,
      skuId: inboundReceiptItems.skuId,
      skuCode: inboundReceiptItems.skuCode,
      name: inboundReceiptItems.name,
      unit: skus.unit,
      productId: skus.productId,
      qty: inboundReceiptItems.qty,
      receivedQty: inboundReceiptItems.receivedQty,
      unitCost: inboundReceiptItems.unitCost,
      lineTotal: inboundReceiptItems.lineTotal,
      costMode: inboundReceiptItems.costMode,
      // What the goods actually cost to get here: the line plus its share of
      // the delivery's freight, duty and clearing.
      allocatedCharge: inboundReceiptItems.allocatedCharge,
      landedTotal: inboundReceiptItems.landedTotal,
      landedUnitCost: inboundReceiptItems.landedUnitCost,
      supplierId: inboundReceipts.supplierId,
      supplierName: inboundReceipts.supplierName,
      // Left-joined: a receipt whose supplier was free text, or whose supplier
      // row has since been deleted, still reports the name it was filed under.
      supplierContact: suppliers.contactName,
      supplierPhone: suppliers.phone,
      supplierEmail: suppliers.email,
      supplierTaxId: suppliers.taxId,
      referenceNo: inboundReceipts.referenceNo,
      warehouseId: inboundReceipts.warehouseId,
      warehouseName: inboundReceipts.warehouseName,
      batchRef: inboundReceiptItems.batchRef,
      expiryDate: inboundReceiptItems.expiryDate,
      note: inboundReceipts.note,
    };
  }

  private filters(
    tenantId: string,
    input: z.infer<typeof querySchema>,
    window: { from: Date | null; to: Date | null },
  ): SQL | undefined {
    const purchasedAt = PURCHASED_AT_RAW;
    return and(
      eq(inboundReceiptItems.tenantId, tenantId),
      // A cancelled note records a purchase that did not happen; including it
      // would inflate spend and drag the average price toward a phantom.
      input.status === "received"
        ? eq(inboundReceipts.status, "received")
        : sql`${inboundReceipts.status} <> 'cancelled'`,
      ...(input.skuId ? [eq(inboundReceiptItems.skuId, input.skuId)] : []),
      ...(input.supplierId ? [eq(inboundReceipts.supplierId, input.supplierId)] : []),
      ...(input.warehouseId ? [eq(inboundReceipts.warehouseId, input.warehouseId)] : []),
      ...(input.pricedOnly ? [sql`${inboundReceiptItems.lineTotal} is not null`] : []),
      ...(window.from ? [gte(purchasedAt, window.from)] : []),
      ...(window.to ? [lt(purchasedAt, window.to)] : []),
      ...(input.q
        ? [
            or(
              ilike(inboundReceiptItems.skuCode, `%${input.q}%`),
              ilike(inboundReceiptItems.name, `%${input.q}%`),
              ilike(inboundReceipts.supplierName, `%${input.q}%`),
              ilike(inboundReceipts.ref, `%${input.q}%`),
              ilike(inboundReceipts.referenceNo, `%${input.q}%`),
            )!,
          ]
        : []),
    );
  }

  private ordering(sort: z.infer<typeof querySchema>["sort"]) {
    const purchasedAt = PURCHASED_AT_RAW;
    const dir = sort.startsWith("-") ? desc : asc;
    const key = sort.replace(/^-/, "");
    const column =
      key === "unitCost"
        ? inboundReceiptItems.unitCost
        : key === "lineTotal"
          ? inboundReceiptItems.lineTotal
          : key === "qty"
            ? inboundReceiptItems.qty
            : purchasedAt;
    // Tie-break on the line id so paging is stable: two lines on the same note
    // share a timestamp exactly, and an unstable sort repeats or drops rows
    // across page boundaries.
    return [dir(column), desc(inboundReceiptItems.id)];
  }

  /**
   * What one SKU has cost over time, newest last so a chart reads left to
   * right. Priced lines only — an unpriced receipt is not a data point at zero.
   */
  private async priceSeries(
    tx: Db,
    tenantId: string,
    input: z.infer<typeof querySchema>,
    window: { from: Date | null; to: Date | null },
  ) {
    return tx
      .select({
        at: PURCHASED_AT,
        unitCost: inboundReceiptItems.unitCost,
        qty: inboundReceiptItems.qty,
        supplierName: inboundReceipts.supplierName,
        ref: inboundReceipts.ref,
      })
      .from(inboundReceiptItems)
      .innerJoin(inboundReceipts, eq(inboundReceipts.id, inboundReceiptItems.receiptId))
      .leftJoin(suppliers, eq(suppliers.id, inboundReceipts.supplierId))
      .leftJoin(skus, eq(skus.id, inboundReceiptItems.skuId))
      .where(and(this.filters(tenantId, input, window), sql`${inboundReceiptItems.unitCost} is not null`))
      .orderBy(asc(PURCHASED_AT_RAW))
      .limit(500);
  }
}

/**
 * RFC 4180 CSV.
 *
 * Quotes every field rather than only the ones that need it: the alternative
 * is deciding per value, and a supplier name with a comma or a note with a
 * newline in it silently corrupts the column alignment of the whole file when
 * that decision is wrong. A leading BOM makes Excel read it as UTF-8 instead of
 * the local codepage, which is what mangles non-Latin supplier names.
 */
function toCsv(rows: (string | number | null)[][]): string {
  const cell = (v: string | number | null) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
