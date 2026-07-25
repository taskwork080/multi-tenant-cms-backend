import {
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Multi-tenant CMS schema — fully relational. Every business table carries
// tenant_id (RLS: drizzle/0001_rls.sql). Aggregates the frontend treats as
// nested arrays (order items, shipment events, chat messages, packing
// cartons…) are child tables with ON DELETE CASCADE foreign keys; the CRUD
// layer composes them back into the API payloads so responses still match
// the frontend's src/lib/types.ts one-to-one.
// ---------------------------------------------------------------------------

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });

// --- Tenants -----------------------------------------------------------------

export const tenants = pgTable("tenants", {
  id: uuid("id").defaultRandom().primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  type: text("type").notNull(), // ecommerce | warehouse | marketplace
  region: text("region").notNull().default(""),
  // theme
  themeBrand: text("theme_brand").notNull().default("#2563eb"),
  themeBrandFg: text("theme_brand_fg").notNull().default("#ffffff"),
  // config (TenantConfig, flattened)
  defaultLanguage: text("default_language").notNull().default("en"), // en | bn
  currency: text("currency").notNull().default("USD"),
  currencySymbol: text("currency_symbol").notNull().default("$"),
  ga4Id: text("ga4_id"),
  pixelId: text("pixel_id"),
  strictOrderFlow: boolean("strict_order_flow").notNull().default(false),
  defaultSellerName: text("default_seller_name").notNull().default(""),
  locationServiceOn: boolean("location_service_on").notNull().default(false),
  codEnabled: boolean("cod_enabled").notNull().default(false),
  allowForceDeleteCategory: boolean("allow_force_delete_category").notNull().default(false),
  cordNo: text("cord_no"),
  ...timestamps,
});

/** Unlocked feature modules per tenant (ModuleKey values). */
export const tenantEntitlements = pgTable(
  "tenant_entitlements",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    module: text("module").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.module] })],
);

// --- Catalog -------------------------------------------------------------------

export const categories = pgTable(
  "categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    nameEn: text("name_en").notNull(),
    nameBn: text("name_bn"),
    slug: text("slug").notNull(),
    parentId: uuid("parent_id"),
    level: integer("level").notNull().default(0),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("categories_tenant_idx").on(t.tenantId), uniqueIndex("categories_tenant_slug").on(t.tenantId, t.slug)],
);

export const brands = pgTable(
  "brands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("brands_tenant_idx").on(t.tenantId)],
);

export const manufacturers = pgTable(
  "manufacturers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    contact: text("contact"),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("manufacturers_tenant_idx").on(t.tenantId)],
);

export const badges = pgTable(
  "badges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    color: text("color"),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("badges_tenant_idx").on(t.tenantId)],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    styleCode: text("style_code"),
    nameEn: text("name_en").notNull(),
    nameBn: text("name_bn"),
    slug: text("slug").notNull(),
    shortDescEn: text("short_desc_en"),
    shortDescBn: text("short_desc_bn"),
    /** Long-form copy shown on the product detail page (wizard step 2). */
    descriptionEn: text("description_en"),
    categoryId: uuid("category_id").references(() => categories.id, { onDelete: "set null" }),
    /** A category whose parent is category_id — sub-categories are nested categories. */
    subCategoryId: uuid("sub_category_id").references((): AnyPgColumn => categories.id, { onDelete: "set null" }),
    brandId: uuid("brand_id").references(() => brands.id, { onDelete: "set null" }),
    // Lazy reference: sellers is declared further down this file.
    sellerId: uuid("seller_id").references((): AnyPgColumn => sellers.id, { onDelete: "set null" }),
    countryOrigin: text("country_origin"),
    /** Regular price. The active price is offer_price when set, else this. */
    price: numeric("price", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),
    offerPrice: numeric("offer_price", { precision: 12, scale: 2, mode: "number" }),
    unit: text("unit").notNull().default("pcs"), // g | kg | ml | l | pcs
    minOrderQty: integer("min_order_qty").notNull().default(1),
    maxOrderQty: integer("max_order_qty"),
    /** always = never out of stock; tracked = `stock` is decremented per order. */
    stockMode: text("stock_mode").notNull().default("tracked"), // always | tracked
    stock: integer("stock").notNull().default(0),
    imageUrl: text("image_url"),
    videoUrl: text("video_url"),
    status: text("status").notNull().default("draft"), // active | draft
    ...timestamps,
  },
  (t) => [
    index("products_tenant_idx").on(t.tenantId),
    index("products_tenant_status_idx").on(t.tenantId, t.status),
    uniqueIndex("products_tenant_slug").on(t.tenantId, t.slug),
  ],
);

/** Gallery images (max 5 in the UI), ordered. */
export const productImages = pgTable(
  "product_images",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("product_images_product_idx").on(t.productId)],
);

/** Badge labels applied to a product. */
export const productBadges = pgTable(
  "product_badges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    badge: text("badge").notNull(),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("product_badges_product_idx").on(t.productId)],
);

/** Search keywords entered as chips in wizard step 2. */
export const productTags = pgTable(
  "product_tags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("product_tags_product_idx").on(t.productId)],
);

/** Key/value technical details rendered as a table on the product page. */
export const productSpecs = pgTable(
  "product_specs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    value: text("value").notNull().default(""),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("product_specs_product_idx").on(t.productId)],
);

/** Bulk-order pricing: the highest qualifying tier wins. */
export const productPricingTiers = pgTable(
  "product_pricing_tiers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    minQty: integer("min_qty").notNull().default(1),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("product_pricing_tiers_product_idx").on(t.productId)],
);

/** Selectable size/pack options; when present they replace the qty-pricing cards. */
export const productVariants = pgTable(
  "product_variants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    type: text("type").notNull().default("single"),
    price: numeric("price", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),
    originalPrice: numeric("original_price", { precision: 12, scale: 2, mode: "number" }),
    badge: text("badge"),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("product_variants_product_idx").on(t.productId)],
);

// --- Sales ---------------------------------------------------------------------

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    code: text("code").notNull(), // ORD-XXXX
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    customerName: text("customer_name").notNull().default(""),
    placedBy: text("placed_by").notNull().default("admin"), // customer | admin | seller
    deliveryStatus: text("delivery_status").notNull().default("pending"),
    paymentStatus: text("payment_status").notNull().default("unpaid"),
    paymentMethod: text("payment_method").notNull().default("cod"),
    total: numeric("total", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
    area: text("area").notNull().default(""),
    ...timestamps,
  },
  (t) => [index("orders_tenant_idx").on(t.tenantId), uniqueIndex("orders_tenant_code").on(t.tenantId, t.code)],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    name: text("name").notNull().default(""),
    qty: integer("qty").notNull().default(1),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("order_items_order_idx").on(t.orderId)],
);

// --- Inventory -------------------------------------------------------------------

export const warehouses = pgTable(
  "warehouses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    type: text("type").notNull().default("central"), // central | regional | fulfilment
    status: text("status").notNull().default("active"),
    ...timestamps,
  },
  (t) => [index("warehouses_tenant_idx").on(t.tenantId)],
);

export const warehouseCoverageAreas = pgTable(
  "warehouse_coverage_areas",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "cascade" }),
    area: text("area").notNull(),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("warehouse_coverage_warehouse_idx").on(t.warehouseId)],
);

export const stockBatches = pgTable(
  "stock_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    productName: text("product_name").notNull().default(""),
    warehouseId: uuid("warehouse_id").references(() => warehouses.id, { onDelete: "set null" }),
    warehouseName: text("warehouse_name").notNull().default(""),
    quantity: integer("quantity").notNull().default(0),
    unit: text("unit").notNull().default("pcs"),
    expiryDate: text("expiry_date"), // yyyy-mm-dd
    lowStockThreshold: integer("low_stock_threshold").notNull().default(0),
    photoUrl: text("photo_url"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [index("stock_batches_tenant_idx").on(t.tenantId)],
);

export const deliveryChannels = pgTable(
  "delivery_channels",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    type: text("type").notNull().default("owned"), // owned | 3pl | pickup
    status: text("status").notNull().default("active"),
    notes: text("notes").notNull().default(""),
    ...timestamps,
  },
  (t) => [index("delivery_channels_tenant_idx").on(t.tenantId)],
);

// --- People -----------------------------------------------------------------------

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    phone: text("phone").notNull().default(""),
    email: text("email"),
    customerGroup: text("customer_group").notNull().default("regular"),
    customerType: text("customer_type").notNull().default("individual"), // individual | business
    company: text("company"),
    orders: integer("orders").notNull().default(0),
    totalSpent: numeric("total_spent", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
    ...timestamps,
  },
  (t) => [index("customers_tenant_idx").on(t.tenantId)],
);

export const sellers = pgTable(
  "sellers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    contact: text("contact").notNull().default(""),
    productCount: integer("product_count").notNull().default(0),
    commission: numeric("commission", { precision: 5, scale: 2, mode: "number" }).notNull().default(0),
    verified: boolean("verified").notNull().default(false),
    shopStatus: text("shop_status").notNull().default("pending"), // active | suspended | pending
    ...timestamps,
  },
  (t) => [index("sellers_tenant_idx").on(t.tenantId)],
);

// --- Growth ------------------------------------------------------------------------

export const promoCodes = pgTable(
  "promo_codes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    code: text("code").notNull(),
    discountType: text("discount_type").notNull().default("percent"), // percent | fixed
    discountValue: numeric("discount_value", { precision: 12, scale: 2, mode: "number" }).notNull().default(0),
    status: text("status").notNull().default("scheduled"), // active | expired | scheduled
    usageLimit: integer("usage_limit").notNull().default(0),
    used: integer("used").notNull().default(0),
    validFrom: text("valid_from"), // yyyy-mm-dd
    validTo: text("valid_to"),
    customerGroup: text("customer_group").notNull().default("all"),
    ...timestamps,
  },
  (t) => [index("promo_codes_tenant_idx").on(t.tenantId), uniqueIndex("promo_codes_tenant_code").on(t.tenantId, t.code)],
);

// --- Reviews / Returns / Tax ----------------------------------------------------------

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    productName: text("product_name").notNull().default(""),
    author: text("author").notNull().default(""),
    rating: integer("rating").notNull().default(5), // 1–5
    comment: text("comment").notNull().default(""),
    status: text("status").notNull().default("pending"), // pending | approved | rejected
    ...timestamps,
  },
  (t) => [index("reviews_tenant_idx").on(t.tenantId)],
);

export const returnRequests = pgTable(
  "return_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    code: text("code").notNull(), // RET-XXXX
    orderCode: text("order_code").notNull().default(""),
    customerName: text("customer_name").notNull().default(""),
    reason: text("reason").notNull().default(""),
    amount: numeric("amount", { precision: 14, scale: 2, mode: "number" }).notNull().default(0),
    status: text("status").notNull().default("requested"), // requested | approved | rejected | refunded
    ...timestamps,
  },
  (t) => [index("return_requests_tenant_idx").on(t.tenantId)],
);

export const taxRates = pgTable(
  "tax_rates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    rate: numeric("rate", { precision: 7, scale: 4, mode: "number" }).notNull().default(0), // percent
    region: text("region").notNull().default(""),
    compound: boolean("compound").notNull().default(false),
    status: text("status").notNull().default("active"),
    ...timestamps,
  },
  (t) => [index("tax_rates_tenant_idx").on(t.tenantId)],
);

// --- Access control (RBAC) --------------------------------------------------------------

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    ...timestamps,
  },
  (t) => [index("roles_tenant_idx").on(t.tenantId)],
);

/** Capability keys granted to a role (see frontend lib/rbac). */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("role_permissions_role_idx").on(t.roleId)],
);

export const staffUsers = pgTable(
  "staff_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    /** Supabase Auth user id, once the invite is accepted. */
    authUserId: uuid("auth_user_id"),
    name: text("name").notNull(),
    email: text("email").notNull(),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "set null" }),
    status: text("status").notNull().default("invited"), // active | invited | suspended
    lastActive: timestamp("last_active", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("staff_users_tenant_idx").on(t.tenantId), uniqueIndex("staff_users_tenant_email").on(t.tenantId, t.email)],
);

// --- Activity / audit ----------------------------------------------------------------------

export const activities = pgTable(
  "activities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    actor: text("actor").notNull().default("system"),
    action: text("action").notNull(),
    target: text("target").notNull().default(""),
    kind: text("kind").notNull().default("setting"), // order | product | customer | setting | auth | discount | shipment
    ...timestamps,
  },
  (t) => [index("activities_tenant_idx").on(t.tenantId), index("activities_tenant_created").on(t.tenantId, t.createdAt)],
);

// --- Shipments & tracking ---------------------------------------------------------------------

export const shipments = pgTable(
  "shipments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    tracking: text("tracking").notNull(),
    orderCode: text("order_code").notNull().default(""),
    customerName: text("customer_name").notNull().default(""),
    type: text("type").notNull().default("full"), // partial | full
    carrier: text("carrier"),
    status: text("status").notNull().default("processing"), // ShipmentStatus
    eta: text("eta"),
    location: text("location"),
    ...timestamps,
  },
  (t) => [index("shipments_tenant_idx").on(t.tenantId), uniqueIndex("shipments_tenant_tracking").on(t.tenantId, t.tracking)],
);

export const shipmentItems = pgTable(
  "shipment_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    name: text("name").notNull().default(""),
    qty: integer("qty").notNull().default(1),
    unit: text("unit"),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("shipment_items_shipment_idx").on(t.shipmentId)],
);

/** Tracking timeline entries. */
export const shipmentEvents = pgTable(
  "shipment_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    status: text("status").notNull(), // ShipmentStatus
    location: text("location"),
    note: text("note"),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("shipment_events_shipment_idx").on(t.shipmentId)],
);

// --- Messenger ------------------------------------------------------------------------------

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
    name: text("name").notNull().default(""),
    online: boolean("online").notNull().default(false),
    unread: integer("unread").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (t) => [index("conversations_tenant_idx").on(t.tenantId)],
);

/**
 * Chat messages. A message belongs to exactly one thread: either a messenger
 * conversation or a shipment's chat (CHECK constraint in the RLS migration).
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
    shipmentId: uuid("shipment_id").references(() => shipments.id, { onDelete: "cascade" }),
    sender: text("sender").notNull().default("support"), // customer | support
    author: text("author").notNull().default(""),
    text: text("text").notNull().default(""),
    attachment: text("attachment"), // display name
    attachmentUrl: text("attachment_url"),
    attachmentType: text("attachment_type"), // image | file
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("chat_messages_conversation_idx").on(t.conversationId),
    index("chat_messages_shipment_idx").on(t.shipmentId),
  ],
);

// --- Schedule -----------------------------------------------------------------------------------

export const scheduleEvents = pgTable(
  "schedule_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    title: text("title").notNull(),
    type: text("type").notNull().default("event"), // campaign | product | meeting | event
    date: text("date").notNull(), // yyyy-mm-dd
    startTime: text("start_time").notNull().default("09:00"), // HH:mm
    endTime: text("end_time").notNull().default("10:00"),
    location: text("location"),
    description: text("description"),
    owner: text("owner"),
    // ScheduleReminder, flattened
    reminderEnabled: boolean("reminder_enabled").notNull().default(false),
    reminderValue: integer("reminder_value").notNull().default(30),
    reminderUnit: text("reminder_unit").notNull().default("minutes"), // minutes | hours | days
    ...timestamps,
  },
  (t) => [index("schedule_events_tenant_idx").on(t.tenantId)],
);

export const scheduleAttendees = pgTable(
  "schedule_attendees",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => scheduleEvents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("schedule_attendees_event_idx").on(t.eventId)],
);

// --- Notes ----------------------------------------------------------------------------------------

export const notes = pgTable(
  "notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    type: text("type").notNull().default("personal"), // personal | expense | calculation | analysis | linked
    title: text("title").notNull().default(""),
    body: text("body").notNull().default(""),
    pinned: boolean("pinned").notNull().default(false),
    amount: numeric("amount", { precision: 14, scale: 2, mode: "number" }),
    reminderAt: timestamp("reminder_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("notes_tenant_idx").on(t.tenantId)],
);

export const noteTags = pgTable(
  "note_tags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("note_tags_note_idx").on(t.noteId)],
);

export const noteAttachments = pgTable(
  "note_attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    name: text("name").notNull().default(""),
    dataUrl: text("data_url").notNull().default(""),
    kind: text("kind").notNull().default("file"), // image | file
    size: integer("size").notNull().default(0),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("note_attachments_note_idx").on(t.noteId)],
);

/** Links from a note to another entity (order, shipment, batch, product, customer). */
export const noteLinks = pgTable(
  "note_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // order | shipment | batch | product | customer
    refId: text("ref_id").notNull(),
    label: text("label").notNull().default(""),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("note_links_note_idx").on(t.noteId)],
);

/** Line items for calculation notes. */
export const noteCalcLines = pgTable(
  "note_calc_lines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    label: text("label").notNull().default(""),
    expression: text("expression"),
    value: numeric("value", { precision: 16, scale: 4, mode: "number" }).notNull().default(0),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("note_calc_lines_note_idx").on(t.noteId)],
);

// --- Packing / cartonization -------------------------------------------------------------------------

export const packingLists = pgTable(
  "packing_lists",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    ref: text("ref").notNull(), // PKG-01, PKG-02 …
    shipmentId: uuid("shipment_id").references(() => shipments.id, { onDelete: "set null" }),
    orderCode: text("order_code"),
    customerName: text("customer_name"),
    status: text("status").notNull().default("draft"), // draft | packed | shipped
    signedBy: text("signed_by"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    notes: text("notes"),
    shipmentNo: integer("shipment_no"), // sequential, assigned on confirm
    thirdPartyNo: text("third_party_no"),
    thirdPartyCarrier: text("third_party_carrier"),
    shipStatus: text("ship_status"), // awaiting | booked | in_transit | delivered
    ...timestamps,
  },
  (t) => [index("packing_lists_tenant_idx").on(t.tenantId), uniqueIndex("packing_lists_tenant_ref").on(t.tenantId, t.ref)],
);

/** A brand/style line on the packing sheet. */
export const packingItems = pgTable(
  "packing_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    packingListId: uuid("packing_list_id")
      .notNull()
      .references(() => packingLists.id, { onDelete: "cascade" }),
    brand: text("brand").notNull().default(""),
    name: text("name").notNull().default(""),
    cordNo: text("cord_no"),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("packing_items_list_idx").on(t.packingListId)],
);

/** Carton sub-range within a packing item (cartons fromNo..toNo, one color/ratio). */
export const itemCartons = pgTable(
  "item_cartons",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    packingItemId: uuid("packing_item_id")
      .notNull()
      .references(() => packingItems.id, { onDelete: "cascade" }),
    fromNo: integer("from_no").notNull().default(1),
    toNo: integer("to_no").notNull().default(1),
    color: text("color").notNull().default(""),
    sizeScale: text("size_scale").notNull().default("INT"), // INT | EU | UK | US
    netWeight: numeric("net_weight", { precision: 10, scale: 3, mode: "number" }),
    grossWeight: numeric("gross_weight", { precision: 10, scale: 3, mode: "number" }),
    dimensions: text("dimensions"), // e.g. "60×40×30 cm"
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("item_cartons_item_idx").on(t.packingItemId)],
);

/** Per-carton size ratio (qty of each size in one carton). */
export const cartonSizes = pgTable(
  "carton_sizes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    cartonId: uuid("carton_id")
      .notNull()
      .references(() => itemCartons.id, { onDelete: "cascade" }),
    size: text("size").notNull(),
    qty: integer("qty").notNull().default(0),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [index("carton_sizes_carton_idx").on(t.cartonId)],
);

/** Courier tracking timeline for confirmed packings (3rd-party shipment). */
export const packShipEvents = pgTable(
  "pack_ship_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    packingListId: uuid("packing_list_id")
      .notNull()
      .references(() => packingLists.id, { onDelete: "cascade" }),
    status: text("status").notNull(), // awaiting | booked | in_transit | delivered
    note: text("note"),
    attachmentUrl: text("attachment_url"),
    attachmentName: text("attachment_name"),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("pack_ship_events_list_idx").on(t.packingListId)],
);

// --- CMS / storefront content ---------------------------------------------------------------------------

export const cmsBlocks = pgTable(
  "cms_blocks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    kind: text("kind").notNull().default("banner"), // banner | page | section
    title: text("title").notNull().default(""),
    slug: text("slug").notNull().default(""),
    body: text("body").notNull().default(""),
    imageUrl: text("image_url"),
    linkUrl: text("link_url"),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("cms_blocks_tenant_idx").on(t.tenantId)],
);

// --- i18n overrides ----------------------------------------------------------------------------------------

export const languageEntries = pgTable(
  "language_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: tenantId(),
    key: text("key").notNull(),
    en: text("en").notNull().default(""),
    bn: text("bn").notNull().default(""),
    ...timestamps,
  },
  (t) => [index("language_entries_tenant_idx").on(t.tenantId), uniqueIndex("language_entries_tenant_key").on(t.tenantId, t.key)],
);
