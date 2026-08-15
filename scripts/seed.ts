import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";

/**
 * Seeds the three demo tenants from the frontend (src/lib/tenants.ts).
 * Idempotent — existing slugs are skipped.
 */
const SEED_TENANTS = [
  {
    slug: "volt",
    name: "OPU Bago",
    type: "warehouse",
    region: "BD",
    themeBrand: "#2563eb",
    themeBrandFg: "#ffffff",
    defaultLanguage: "en",
    currency: "USD",
    currencySymbol: "$",
    ga4Id: "G-VOLT123",
    strictOrderFlow: true,
    defaultSellerName: "VoltEdge Direct",
    locationServiceOn: false,
    codEnabled: false,
    allowForceDeleteCategory: false,
    cordNo: "VE-CORD-001",
    // Was seeded with cms/sales/discounts/reviews/customers/tax on a *warehouse*
    // workspace — i.e. a warehouse tenant with a storefront and a marketing
    // surface. That was only possible because the vertical was never enforced;
    // TYPE_ALLOWED_MODULES now rejects it, so the fixture matches the product.
    entitlements: [
      "dashboard", "schedule", "products", "categories", "brands", "inventory",
      "inventoryInbound", "inventoryOutbound", "returns", "shipments", "delivery", "staff",
      "roles", "activity", "configuration", "notes", "messages", "packing", "packingShipments",
    ],
  },
  {
    slug: "nord",
    name: "NordStock Warehousing",
    type: "warehouse",
    region: "EU",
    themeBrand: "#2563eb",
    themeBrandFg: "#ffffff",
    defaultLanguage: "en",
    currency: "EUR",
    currencySymbol: "€",
    strictOrderFlow: true,
    defaultSellerName: "Own Stock",
    locationServiceOn: true,
    codEnabled: false,
    allowForceDeleteCategory: false,
    cordNo: "NS-2026-355",
    // The full warehouse vertical — this is the fixture the entitlement and
    // capability matrices exercise, so it holds every inventory sub-module and
    // none of the commerce surface (`customers` and `tax` were outside the
    // warehouse ceiling and are gone).
    entitlements: [
      "dashboard", "schedule", "products", "categories", "manufacturers", "inventory",
      "inventoryInbound", "inventoryOutbound", "inventoryTransfers", "inventoryCounts",
      "warehouses", "delivery", "location", "shipments", "returns", "staff", "roles",
      "activity", "configuration", "notes", "messages", "packing", "packingShipments",
    ],
  },
  {
    slug: "agri",
    name: "AgriMart Marketplace",
    type: "marketplace",
    region: "BD",
    themeBrand: "#2563eb",
    themeBrandFg: "#ffffff",
    defaultLanguage: "en",
    currency: "BDT",
    currencySymbol: "৳",
    ga4Id: "G-AGRI789",
    pixelId: "FB-AGRI-001",
    strictOrderFlow: false,
    defaultSellerName: "Own Products",
    locationServiceOn: true,
    codEnabled: true,
    allowForceDeleteCategory: true,
    cordNo: "AGRI-CORD-77",
    entitlements: [
      "dashboard", "schedule", "products", "categories", "brands", "manufacturers", "badges",
      "sales", "inventory", "warehouses", "delivery", "location", "customers", "sellers", "cms", "storefront",
      "discounts", "reviews", "returns", "shipments", "tax", "staff", "roles", "activity",
      "configuration", "language", "notes", "messages", "packing", "packingShipments",
    ],
  },
];

async function main() {
  const client = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const db = drizzle(client, { schema });

  for (const { entitlements, ...tenant } of SEED_TENANTS) {
    const inserted = await db
      .insert(schema.tenants)
      .values(tenant as typeof schema.tenants.$inferInsert)
      .onConflictDoNothing({ target: schema.tenants.slug })
      .returning({ id: schema.tenants.id });

    if (!inserted.length) {
      console.log(`tenant ${tenant.slug} already exists`);
      continue;
    }
    const tenantId = inserted[0].id;
    await db
      .insert(schema.tenantEntitlements)
      .values(entitlements.map((module) => ({ tenantId, module })))
      .onConflictDoNothing();
    console.log(`seeded tenant ${tenant.slug} (${tenantId}) with ${entitlements.length} modules`);
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
