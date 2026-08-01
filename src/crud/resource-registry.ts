import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import * as s from "../db/schema";

/** Any tenant-scoped table: has at least id + tenant_id columns. */
export type AnyTable = AnyPgTable & { id: AnyPgColumn; tenantId: AnyPgColumn };

/**
 * A child relation composed into the parent's API payload as a nested array,
 * so REST responses keep matching the frontend's src/lib/types.ts while the
 * database stays fully relational.
 */
export interface ChildDef {
  /** Field name in the API payload, e.g. "items", "events", "messages". */
  field: string;
  table: AnyTable;
  /** Property name (camelCase) of the FK column pointing at the parent. */
  fk: string;
  /**
   * When set, the API field is an array of scalars taken from this column
   * (e.g. product images → ["url", …], note tags → ["tag", …]).
   */
  scalar?: string;
  /** Ordering property, defaults to "sort" when present, else "at". */
  orderBy?: string;
  /** Nested children (packing items → cartons → sizes). */
  children?: ChildDef[];
}

export interface ResourceDef {
  table: AnyTable;
  /** Module entitlement key that must be unlocked for the tenant (types.ts ModuleKey). */
  module?: string;
  /** DB column names matched by ?q= search (ILIKE). */
  searchable?: string[];
  /** Default ordering DB column (descending). Falls back to created_at. */
  orderBy?: string;
  children?: ChildDef[];
  /**
   * Named boolean filters that can't be expressed as `?column=value` — most
   * often a comparison between two columns. Enabled with `?<name>=true`.
   * Keeps such predicates declared next to the resource instead of
   * special-cased inside the list query.
   */
  flags?: Record<string, SQL>;
  /**
   * Stock side effects that must commit with the write.
   *
   * `orders` declares `reservesStock`, which makes CrudService reserve every
   * line inside the same transaction the order is created in: a shortfall
   * throws, the transaction rolls back, and an order that can't be fulfilled
   * is never created. Doing it as a second request from the client would
   * leave a window where the order exists unreserved — and an oversell.
   *
   * Deliberately a flag rather than a general hook system: exactly one
   * resource needs this, and a callback registry would invite the generic
   * layer to grow business logic.
   */
  reservesStock?: boolean;
}

/**
 * REST resource slugs → tables. This is the single place to add a new
 * tenant-scoped resource; list/get/create/update/delete come for free at
 * /api/:tenant/:resource, including nested child collections.
 */
export const RESOURCES: Record<string, ResourceDef> = {
  categories: { table: s.categories, module: "categories", searchable: ["name_en", "slug"] },
  brands: { table: s.brands, module: "brands", searchable: ["name"] },
  manufacturers: { table: s.manufacturers, module: "manufacturers", searchable: ["name"] },
  badges: { table: s.badges, module: "badges", searchable: ["name"] },
  products: {
    table: s.products,
    module: "products",
    searchable: ["name_en", "name_bn", "slug", "style_code"],
    // All six child tables carry `sort`, which hydrateMany orders by and
    // writeChildren rewrites from the array index — so array order round-trips
    // and no explicit orderBy is needed.
    children: [
      { field: "images", table: s.productImages, fk: "productId", scalar: "url" },
      { field: "badges", table: s.productBadges, fk: "productId", scalar: "badge" },
      { field: "tags", table: s.productTags, fk: "productId", scalar: "tag" },
      { field: "specs", table: s.productSpecs, fk: "productId" },
      { field: "pricingTiers", table: s.productPricingTiers, fk: "productId" },
      { field: "variants", table: s.productVariants, fk: "productId" },
    ],
  },
  orders: {
    table: s.orders,
    module: "sales",
    searchable: ["code", "customer_name"],
    children: [{ field: "items", table: s.orderItems, fk: "orderId" }],
    // Placing an order holds stock; cancelling it gives the hold back.
    reservesStock: true,
  },
  "stock-batches": {
    table: s.stockBatches,
    module: "inventory",
    searchable: ["product_name", "note"],
    // quantity vs low_stock_threshold is a column-to-column comparison, so it
    // can't be expressed as an ordinary `?column=value` filter.
    flags: {
      lowStock: sql`quantity <= low_stock_threshold and quantity > 0`,
      outOfStock: sql`quantity = 0`,
      /** Low *or* out — what the Topbar's stock alert badge counts. */
      needsAttention: sql`quantity <= low_stock_threshold`,
    },
  },

  // --- Inventory core ---------------------------------------------------------
  // Read/list surface for the tables InventoryService writes. Mutations that
  // move stock go through /api/:tenant/inventory/* instead — a PATCH here can
  // edit a transfer's carrier, but never its quantities.

  skus: {
    table: s.skus,
    module: "inventory",
    searchable: ["code", "name", "barcode"],
    flags: { active: sql`status = 'active'` },
  },
  "inventory-levels": {
    table: s.inventoryLevels,
    module: "inventory",
    searchable: ["sku_code", "sku_name", "warehouse_name"],
    // available (on_hand - reserved) is derived, never stored, so every
    // stock-state filter is a column-to-column comparison.
    flags: {
      inStock: sql`(on_hand - reserved) > coalesce(low_stock_threshold, 10)`,
      lowStock: sql`(on_hand - reserved) <= coalesce(low_stock_threshold, 10) and on_hand > 0`,
      outOfStock: sql`on_hand <= 0`,
      needsAttention: sql`(on_hand - reserved) <= coalesce(low_stock_threshold, 10)`,
      hasReserved: sql`reserved > 0`,
      hasIncoming: sql`incoming > 0`,
    },
  },
  "stock-movements": {
    table: s.stockMovements,
    module: "inventory",
    orderBy: "at",
    searchable: ["ref_code", "reason", "note", "actor"],
    flags: {
      inbound: sql`qty > 0`,
      outbound: sql`qty < 0`,
    },
  },
  "inventory-reservations": {
    table: s.inventoryReservations,
    module: "inventoryOutbound",
    searchable: ["order_code", "sku_code", "sku_name"],
    flags: { open: sql`status = 'active'` },
  },
  "stock-transfers": {
    table: s.stockTransfers,
    module: "inventoryTransfers",
    searchable: ["ref", "carrier", "tracking_ref", "from_warehouse_name", "to_warehouse_name"],
    flags: { open: sql`status in ('draft','in_transit')` },
    children: [{ field: "items", table: s.stockTransferItems, fk: "transferId" }],
  },
  "inbound-receipts": {
    table: s.inboundReceipts,
    module: "inventoryInbound",
    searchable: ["ref", "supplier_name", "reference_no", "warehouse_name"],
    flags: { open: sql`status = 'draft'` },
    children: [{ field: "items", table: s.inboundReceiptItems, fk: "receiptId" }],
  },
  "cycle-counts": {
    table: s.cycleCounts,
    module: "inventoryCounts",
    searchable: ["ref", "counted_by", "warehouse_name"],
    flags: { open: sql`status in ('draft','counting','review')` },
    children: [{ field: "items", table: s.cycleCountItems, fk: "countId" }],
  },
  warehouses: {
    table: s.warehouses,
    module: "warehouses",
    searchable: ["name"],
    children: [{ field: "coverageAreas", table: s.warehouseCoverageAreas, fk: "warehouseId", scalar: "area" }],
  },
  "delivery-channels": { table: s.deliveryChannels, module: "delivery", searchable: ["name"] },
  customers: { table: s.customers, module: "customers", searchable: ["name", "phone", "email", "company"] },
  sellers: { table: s.sellers, module: "sellers", searchable: ["name", "contact"] },
  "promo-codes": { table: s.promoCodes, module: "discounts", searchable: ["code"] },
  reviews: { table: s.reviews, module: "reviews", searchable: ["product_name", "author"] },
  returns: { table: s.returnRequests, module: "returns", searchable: ["code", "order_code", "customer_name"] },
  "tax-rates": { table: s.taxRates, module: "tax", searchable: ["name", "region"] },
  roles: {
    table: s.roles,
    module: "roles",
    searchable: ["name"],
    children: [{ field: "permissions", table: s.rolePermissions, fk: "roleId", scalar: "permission" }],
  },
  staff: { table: s.staffUsers, module: "staff", searchable: ["name", "email"] },
  activities: { table: s.activities, module: "activity", searchable: ["actor", "action", "target"] },
  shipments: {
    table: s.shipments,
    module: "shipments",
    searchable: ["tracking", "order_code", "customer_name"],
    children: [
      { field: "items", table: s.shipmentItems, fk: "shipmentId" },
      { field: "events", table: s.shipmentEvents, fk: "shipmentId", orderBy: "at" },
      { field: "messages", table: s.chatMessages, fk: "shipmentId", orderBy: "at" },
    ],
  },
  conversations: {
    table: s.conversations,
    module: "messages",
    searchable: ["name"],
    orderBy: "last_message_at",
    children: [{ field: "messages", table: s.chatMessages, fk: "conversationId", orderBy: "at" }],
  },
  "schedule-events": {
    table: s.scheduleEvents,
    module: "schedule",
    searchable: ["title", "owner"],
    children: [{ field: "attendees", table: s.scheduleAttendees, fk: "eventId", scalar: "name" }],
  },
  notes: {
    table: s.notes,
    module: "notes",
    searchable: ["title", "body"],
    children: [
      { field: "tags", table: s.noteTags, fk: "noteId", scalar: "tag" },
      { field: "attachments", table: s.noteAttachments, fk: "noteId" },
      { field: "links", table: s.noteLinks, fk: "noteId" },
      { field: "calcLines", table: s.noteCalcLines, fk: "noteId" },
    ],
  },
  "packing-lists": {
    table: s.packingLists,
    module: "packing",
    searchable: ["ref", "order_code", "customer_name"],
    children: [
      {
        field: "items",
        table: s.packingItems,
        fk: "packingListId",
        children: [
          {
            field: "cartons",
            table: s.itemCartons,
            fk: "packingItemId",
            children: [{ field: "sizes", table: s.cartonSizes, fk: "cartonId" }],
          },
        ],
      },
      { field: "shipEvents", table: s.packShipEvents, fk: "packingListId", orderBy: "at" },
    ],
  },
  "cms-blocks": { table: s.cmsBlocks, module: "cms", searchable: ["title", "slug"] },
  "language-entries": { table: s.languageEntries, module: "language", searchable: ["key", "en", "bn"] },
};
