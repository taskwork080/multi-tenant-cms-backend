/**
 * Imports the 365 Computer & Gadget catalogue into a `365` tenant.
 *
 *   npm run import:365            create/refresh the tenant and its catalogue
 *   npm run import:365 -- --dry   report what would change, write nothing
 *
 * The source is scripts/fixtures/365-catalog.json, frozen out of the
 * 365-ecommerce repo's lib/data/*.ts before those files were deleted. This is a
 * one-way import of what used to be hard-coded mock data: after it runs, the
 * CMS is the only source of the catalogue and the storefront reads it over
 * /api/public/storefront.
 *
 * Every step is idempotent — categories, brands and products upsert on their
 * natural key, and a product's specs and badges are rewritten from the fixture
 * each run. Re-running converges; a half-finished run is fixed by running it
 * again.
 *
 * Two things it deliberately does NOT do:
 *
 *  - It does not create SKUs or stock. Products are imported with
 *    `stockMode: "always"`, because the fixture has no inventory data and
 *    inventing quantities would make the admin's stock figures fiction. The
 *    storefront therefore shows everything as available. Switching a product to
 *    real stock tracking is a decision for whoever owns the catalogue, made in
 *    the admin.
 *  - It does not touch users. Sign-in accounts come from `npm run db:seed` /
 *    `npm run user:create`, which own the GoTrue+Postgres protocol.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { and, eq } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import type { Db } from "../src/db/db.tokens";
import * as schema from "../src/db/schema";
import { TenantDb } from "../src/db/tenant-db.service";
import { presetFor } from "../src/platform/module-presets";
import { ensureTenantRoles } from "../src/platform/role-provisioning";

const DRY = process.argv.includes("--dry");

/** Matches no row, so a dry run can walk every step without a real tenant. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const TENANT = {
  slug: "365",
  name: "365 Computer & Gadget",
  // The commerce vertical: TYPE_ALLOWED_MODULES.ecommerce is the full ceiling,
  // and presetFor("ecommerce") already includes `storefront` and `cms`.
  type: "ecommerce",
  region: "BD",
  themeBrand: "#0C111D",
  themeBrandFg: "#ffffff",
  defaultLanguage: "en",
  currency: "BDT",
  currencySymbol: "৳",
  strictOrderFlow: false,
  defaultSellerName: "365 Computer & Gadget",
  locationServiceOn: true,
  codEnabled: true,
  allowForceDeleteCategory: false,
} satisfies Partial<typeof schema.tenants.$inferInsert>;

interface Fixture {
  generatedAt: string;
  brands: string[];
  categories: { name: string; slug: string; subcategories: { name: string; slug: string }[] }[];
  products: {
    slug: string;
    name: string;
    brand: string;
    categorySlug: string;
    subCategorySlug: string | null;
    listPrice: number;
    offerPrice: number | null;
    imageUrl: string;
    specs: { label: string; value: string }[];
    badges: string[];
  }[];
}

/**
 * What checkout charges, lifted from the storefront's own constants
 * (365-ecommerce lib/utils/checkout.ts) so nothing about the shop changes —
 * except that these are now rows a shop owner can edit instead of literals in
 * a deployed bundle.
 *
 * `district: null` is the catch-all: everywhere that is not Dhaka.
 */
const DELIVERY_ZONES = [
  { name: "Inside Dhaka", district: "Dhaka", fee: 60, sort: 0 },
  { name: "Outside Dhaka", district: null, fee: 120, sort: 1 },
];

/** feePct is a fraction: 0.025 is 2.5%. */
const PAYMENT_METHODS = [
  {
    code: "cod",
    label: "Cash On Delivery",
    description: "Pay with cash upon product delivery.",
    feePct: 0,
    skipsDelivery: false,
    payOnDelivery: true,
    sort: 0,
  },
  {
    code: "pickup",
    label: "Cash On Store Pickup",
    description: "Pay with cash upon collecting product from our store.",
    feePct: 0,
    skipsDelivery: true,
    payOnDelivery: true,
    sort: 1,
  },
  {
    code: "online",
    label: "Online Payment",
    description:
      "Pay via credit/debit card or any MFS through SSLCommerz (fees 2–3.5%). For foreign cards, " +
      "Bangladesh Bank requires verification documents; otherwise, the payment may be held.",
    feePct: 0.025,
    skipsDelivery: false,
    payOnDelivery: false,
    sort: 2,
  },
  {
    code: "bkash",
    label: "Bkash Mobile Banking",
    description: "Manual payment to our merchant number and its charge 1.5%.",
    feePct: 0.015,
    skipsDelivery: false,
    payOnDelivery: false,
    sort: 3,
  },
  {
    code: "bank",
    label: "Bank Transfer",
    description: "Make your payment directly into our bank account by NPSB/BEFTN.",
    feePct: 0,
    skipsDelivery: false,
    payOnDelivery: false,
    sort: 4,
  },
];

/** Counters, so the run reports what it actually did rather than "ok". */
const stats = { created: 0, updated: 0, skipped: 0 };

async function main() {
  Logger.overrideLogger(["error", "warn"]);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });

  try {
    const fixture: Fixture = JSON.parse(
      readFileSync(join(__dirname, "fixtures", "365-catalog.json"), "utf8"),
    );
    console.log(
      `fixture: ${fixture.products.length} products, ${fixture.categories.length} categories, ` +
        `${fixture.brands.length} brands (frozen ${fixture.generatedAt.slice(0, 10)})`,
    );
    if (DRY) console.log("--dry: nothing will be written\n");

    const tdb = app.get(TenantDb);

    // Cross-tenant writes, so every step runs inside asPlatform() — the
    // sanctioned escape hatch drizzle/0008_platform_admin.sql's policies key
    // off. Separate transactions per step, matching db:seed.
    // On a dry run against a workspace that does not exist yet there is no id
    // to look anything up by. The nil uuid matches nothing, so every later step
    // reports "would create" — which is exactly the truth, and more useful than
    // stopping after the first line.
    const tenantId = (await tdb.asPlatform((db) => ensureTenant(db))) ?? NIL_UUID;

    await tdb.asPlatform((db) => ensureStorefront(db, tenantId));
    await tdb.asPlatform((db) => importCommerce(db, tenantId));
    const categoryIds = await tdb.asPlatform((db) => importCategories(db, tenantId, fixture));
    const brandIds = await tdb.asPlatform((db) => importBrands(db, tenantId, fixture));
    await tdb.asPlatform((db) => importProducts(db, tenantId, fixture, categoryIds, brandIds));

    console.log(
      `\n${stats.created} created, ${stats.updated} updated, ${stats.skipped} unchanged.` +
        (DRY ? " (dry run)" : ""),
    );
    console.log(`\nStorefront: /api/public/storefront/${TENANT.slug}/site\n`);
  } finally {
    await app.close();
  }
}

// --- Step 1: the tenant ------------------------------------------------------

async function ensureTenant(db: Db): Promise<string | null> {
  const [existing] = await db
    .select({ id: schema.tenants.id })
    .from(schema.tenants)
    .where(eq(schema.tenants.slug, TENANT.slug))
    .limit(1);

  if (existing) {
    console.log(`tenant ${TENANT.slug} already exists (${existing.id})`);
    return existing.id;
  }
  if (DRY) {
    console.log(`would create tenant ${TENANT.slug}`);
    return null;
  }

  const [created] = await db
    .insert(schema.tenants)
    .values(TENANT as typeof schema.tenants.$inferInsert)
    .returning({ id: schema.tenants.id, type: schema.tenants.type });

  const entitlements = presetFor(TENANT.type);
  await db
    .insert(schema.tenantEntitlements)
    .values(entitlements.map((module) => ({ tenantId: created.id, module })))
    .onConflictDoNothing();

  // Without roles a staff row resolves to an unrestricted menu, so a workspace
  // created outside TenantProvisioningService still needs them.
  await ensureTenantRoles(db, created, entitlements);

  console.log(`created tenant ${TENANT.slug} (${created.id}) with ${entitlements.length} modules`);
  return created.id;
}

// --- Step 2: the storefront switch -------------------------------------------

/**
 * The public API 404s "Store unavailable" unless a config row exists AND is
 * active — see StorefrontService.assertLive. getConfig() creates it inactive on
 * first read, deliberately, so turning a storefront on is an explicit act. This
 * import IS that act.
 */
async function ensureStorefront(db: Db, tenantId: string) {
  const [existing] = await db
    .select({ id: schema.storefrontConfigs.id, isActive: schema.storefrontConfigs.isActive })
    .from(schema.storefrontConfigs)
    .where(eq(schema.storefrontConfigs.tenantId, tenantId))
    .limit(1);

  if (existing?.isActive) {
    console.log("storefront already live");
    return;
  }
  if (DRY) {
    console.log(existing ? "would activate the storefront" : "would create an active storefront config");
    return;
  }

  if (existing) {
    await db
      .update(schema.storefrontConfigs)
      .set({ isActive: true, updatedAt: new Date() })
      .where(eq(schema.storefrontConfigs.id, existing.id));
    console.log("storefront activated");
    return;
  }
  await db.insert(schema.storefrontConfigs).values({ tenantId, isActive: true });
  console.log("storefront created and activated");
}

// --- Step 3: what checkout charges -------------------------------------------

/**
 * Seeds delivery zones and payment methods, without overwriting them.
 *
 * Existing rows are left alone on purpose: unlike the catalogue, these are
 * figures a shop owner tunes in the admin, and a re-import that silently reset
 * a delivery fee to whatever the storefront shipped with would be a way to
 * lose money quietly.
 */
async function importCommerce(db: Db, tenantId: string) {
  const zones = await db
    .select({ district: schema.storefrontDeliveryZones.district })
    .from(schema.storefrontDeliveryZones)
    .where(eq(schema.storefrontDeliveryZones.tenantId, tenantId));
  const haveZone = new Set(zones.map((z) => z.district));
  const newZones = DELIVERY_ZONES.filter((z) => !haveZone.has(z.district));

  const methods = await db
    .select({ code: schema.storefrontPaymentMethods.code })
    .from(schema.storefrontPaymentMethods)
    .where(eq(schema.storefrontPaymentMethods.tenantId, tenantId));
  const haveMethod = new Set(methods.map((m) => m.code));
  const newMethods = PAYMENT_METHODS.filter((m) => !haveMethod.has(m.code));

  if (!DRY) {
    if (newZones.length) {
      await db.insert(schema.storefrontDeliveryZones).values(newZones.map((z) => ({ tenantId, ...z })));
    }
    if (newMethods.length) {
      await db.insert(schema.storefrontPaymentMethods).values(newMethods.map((m) => ({ tenantId, ...m })));
    }
  }
  stats.created += newZones.length + newMethods.length;
  stats.skipped += DELIVERY_ZONES.length + PAYMENT_METHODS.length - newZones.length - newMethods.length;

  console.log(
    `commerce: ${newZones.length}/${DELIVERY_ZONES.length} delivery zones, ` +
      `${newMethods.length}/${PAYMENT_METHODS.length} payment methods added`,
  );
}

// --- Step 4: categories ------------------------------------------------------

/**
 * Parents at level 0, their subcategories at level 1.
 *
 * Four subcategory names appear under two different parents ("Power Strip" is
 * both an Accessory and a Power product; likewise CCTV Camera, VR Headset,
 * Workstation). `categories_tenant_slug` is unique, so they collapse to one row
 * attached to the first parent that claims them — which is what a shopper
 * browsing either parent would expect to find anyway.
 */
async function importCategories(db: Db, tenantId: string, fixture: Fixture): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  const upsert = async (name: string, slug: string, level: number, parentId: string | null) => {
    const [existing] = await db
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(and(eq(schema.categories.tenantId, tenantId), eq(schema.categories.slug, slug)))
      .limit(1);
    if (existing) {
      ids.set(slug, existing.id);
      stats.skipped++;
      return existing.id;
    }
    if (DRY) {
      // Recorded even though nothing is written, so the duplicate-slug dedupe
      // below still fires and the preview counts what a real run would create.
      ids.set(slug, NIL_UUID);
      stats.created++;
      return null;
    }
    const [row] = await db
      .insert(schema.categories)
      .values({ tenantId, nameEn: name, slug, level, parentId, active: true })
      .returning({ id: schema.categories.id });
    ids.set(slug, row.id);
    stats.created++;
    return row.id;
  };

  for (const category of fixture.categories) {
    const parentId = await upsert(category.name, category.slug, 0, null);
    for (const sub of category.subcategories) {
      if (ids.has(sub.slug)) continue; // claimed by an earlier parent
      await upsert(sub.name, sub.slug, 1, parentId);
    }
  }

  console.log(`categories: ${ids.size} resolved`);
  return ids;
}

// --- Step 5: brands ----------------------------------------------------------

/** No unique index on brand name, so this reads before it writes. */
async function importBrands(db: Db, tenantId: string, fixture: Fixture): Promise<Map<string, string>> {
  const existing = await db
    .select({ id: schema.brands.id, name: schema.brands.name })
    .from(schema.brands)
    .where(eq(schema.brands.tenantId, tenantId));

  // Keyed upper-case: the fixture's marquee list shouts ("APPLE") where the
  // products use title case, and two rows for one brand would split its facet.
  const ids = new Map(existing.map((b) => [b.name.toUpperCase(), b.id]));
  const missing = fixture.brands.filter((name) => !ids.has(name.toUpperCase()));

  if (missing.length && !DRY) {
    const rows = await db
      .insert(schema.brands)
      .values(missing.map((name) => ({ tenantId, name, active: true })))
      .returning({ id: schema.brands.id, name: schema.brands.name });
    for (const row of rows) ids.set(row.name.toUpperCase(), row.id);
  }
  stats.created += missing.length;
  stats.skipped += fixture.brands.length - missing.length;

  console.log(`brands: ${missing.length} new, ${fixture.brands.length - missing.length} existing`);
  return ids;
}

// --- Step 6: products --------------------------------------------------------

async function importProducts(
  db: Db,
  tenantId: string,
  fixture: Fixture,
  categoryIds: Map<string, string>,
  brandIds: Map<string, string>,
) {
  for (const product of fixture.products) {
    const values = {
      tenantId,
      nameEn: product.name,
      slug: product.slug,
      categoryId: categoryIds.get(product.categorySlug) ?? null,
      // Inferred at export time from the product's name and specs, the way the
      // old client-side filter did it. A best guess on fixture data, and
      // reassignable in the admin — roughly half the catalogue has none.
      subCategoryId: product.subCategorySlug ? (categoryIds.get(product.subCategorySlug) ?? null) : null,
      brandId: brandIds.get(product.brand.toUpperCase()) ?? null,
      price: product.listPrice,
      offerPrice: product.offerPrice,
      imageUrl: product.imageUrl,
      status: "active",
      // See the header: no inventory data in the fixture, so nothing is
      // tracked rather than tracked with invented numbers.
      stockMode: "always",
    };

    const [existing] = await db
      .select({ id: schema.products.id })
      .from(schema.products)
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.slug, product.slug)))
      .limit(1);

    if (DRY) {
      existing ? stats.updated++ : stats.created++;
      continue;
    }

    let productId: string;
    if (existing) {
      await db.update(schema.products).set({ ...values, updatedAt: new Date() }).where(eq(schema.products.id, existing.id));
      productId = existing.id;
      stats.updated++;
    } else {
      const [row] = await db.insert(schema.products).values(values).returning({ id: schema.products.id });
      productId = row.id;
      stats.created++;
    }

    // Rewritten rather than merged: the fixture is the whole truth for these,
    // and merging would leave a spec behind after it was removed upstream.
    await db.delete(schema.productSpecs).where(eq(schema.productSpecs.productId, productId));
    if (product.specs.length) {
      await db.insert(schema.productSpecs).values(
        product.specs.map((s, sort) => ({ tenantId, productId, label: s.label, value: s.value, sort })),
      );
    }

    await db.delete(schema.productBadges).where(eq(schema.productBadges.productId, productId));
    if (product.badges.length) {
      await db.insert(schema.productBadges).values(
        product.badges.map((badge, sort) => ({ tenantId, productId, badge, sort })),
      );
    }
  }

  console.log(`products: ${fixture.products.length} imported`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
