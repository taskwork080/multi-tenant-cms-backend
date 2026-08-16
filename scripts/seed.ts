/**
 * Brings an empty (or reset) database up to a working, sign-in-able state.
 *
 *   npm run db:seed                 tenants + roles + the two default accounts
 *   npm run db:seed -- --users-only skip the tenant and role steps
 *   npm run db:seed -- --fresh --yes wipe every account first, then seed
 *
 * Every step is idempotent, so re-running reports what already exists and
 * changes nothing.
 *
 * It runs under a Nest application context rather than a bare drizzle client
 * because creating a user spans GoTrue *and* Postgres, and
 * PlatformUsersService already owns that two-system protocol — it creates the
 * identity first, uses the DB write as the commit point, and deletes the
 * identity again if the row fails. Reimplementing that here would be a second,
 * subtly wrong copy.
 */
import "dotenv/config";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { asc, eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import { AppModule } from "../src/app.module";
import { isCapabilityKey } from "../src/auth/capabilities";
import { SupabaseAdminService } from "../src/auth/supabase-admin.service";
import type { Db } from "../src/db/db.tokens";
import { TenantDb } from "../src/db/tenant-db.service";
import * as schema from "../src/db/schema";
import type { AuditCtx } from "../src/platform/audit.service";
import { PlatformUsersService } from "../src/platform/platform-users.service";
import { ensureTenantRoles } from "../src/platform/role-provisioning";
import { managerTemplateFor } from "../src/platform/role-templates";
import { ensurePlatformAdmin } from "./lib/platform-admin";
import { assertResetAllowed, resetUsers } from "./reset-users";

/**
 * The two accounts a fresh install needs: the single platform administrator,
 * and one tenant owner to demonstrate a workspace with.
 *
 * The password satisfies adminUserCreateSchema's 8-character minimum. Do not
 * shorten it to make a dev login easier to type — the minimum is a real rule
 * that applies to every user created through /api/admin/users, and weakening it
 * for a fixture weakens it for production.
 */
const SEED_PASSWORD = "12345678";
const SUPERADMIN_EMAIL = "superadmin123@gmail.com";
const DEFAULT_OWNER = { email: "owner@voltcms.com", name: "Volt Owner", tenantSlug: "volt" };

const CLI_CTX: AuditCtx = { actorId: "", actorEmail: "cli:db:seed", userAgent: "npm run db:seed" };

const USERS_ONLY = process.argv.includes("--users-only");
/** Wipe every existing account before seeding. Still requires --yes. */
const FRESH = process.argv.includes("--fresh");

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
  Logger.overrideLogger(["error", "warn"]);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

  try {
    if (FRESH) {
      assertResetAllowed();
      const wiped = await resetUsers(app, process.argv.includes("--yes"));
      if (!wiped) {
        console.log("--fresh needs --yes as well. Nothing was deleted and nothing was seeded.\n");
        return;
      }
    }

    const tdb = app.get(TenantDb);

    // Every DB step below crosses tenants, so each runs inside asPlatform() —
    // the sanctioned escape hatch that drizzle/0008_platform_admin.sql's
    // policies key off. Note the steps are separate transactions rather than
    // one: PlatformUsersService.create opens its own asPlatform transaction
    // internally, and nesting would deadlock against this connection.
    if (!USERS_ONLY) {
      await tdb.asPlatform(seedTenants);
      await tdb.asPlatform(seedRoles);
    }

    await seedSuperadmin(app.get(SupabaseAdminService), sql);
    await seedDefaultOwner(tdb, app.get(PlatformUsersService));

    console.log("\n--- Sign in with -------------------------------------------");
    console.log(`  superadmin  ${SUPERADMIN_EMAIL.padEnd(24)} ${SEED_PASSWORD}`);
    console.log(`  owner       ${DEFAULT_OWNER.email.padEnd(24)} ${SEED_PASSWORD}`);
    console.log("------------------------------------------------------------\n");
  } finally {
    await sql.end();
    await app.close();
  }
}

// --- Step 1: tenants ---------------------------------------------------------

async function seedTenants(db: Db) {
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
}

// --- Step 2: roles -----------------------------------------------------------

/**
 * Every workspace in the database, not just the ones seeded above.
 *
 * The tenant fixtures are inserted straight into `tenants`, bypassing
 * TenantProvisioningService, so before this step a seeded workspace had no roles
 * at all — and a staff row with no role resolves to an unrestricted menu, which
 * makes the whole permission model unobservable.
 */
async function seedRoles(db: Db) {
  const tenants = await db
    .select({ id: schema.tenants.id, slug: schema.tenants.slug, type: schema.tenants.type })
    .from(schema.tenants);

  const entitlementRows = await db.select().from(schema.tenantEntitlements);
  const byTenant = new Map<string, string[]>();
  for (const row of entitlementRows) {
    byTenant.set(row.tenantId, [...(byTenant.get(row.tenantId) ?? []), row.module]);
  }

  for (const tenant of tenants) {
    const created = await ensureTenantRoles(db, tenant, byTenant.get(tenant.id) ?? [], (name) =>
      console.log(`[${tenant.slug}] + role "${name}"`),
    );
    if (created === 0) console.log(`[${tenant.slug}] roles already present`);
  }
}

// --- Step 3: the one superadmin ----------------------------------------------

async function seedSuperadmin(supabase: SupabaseAdminService, sql: ReturnType<typeof postgres>) {
  const { id, created } = await ensurePlatformAdmin(supabase, sql, SUPERADMIN_EMAIL, SEED_PASSWORD);
  console.log(
    created
      ? `✔ superadmin ${SUPERADMIN_EMAIL} created (auth ${id})`
      : `✔ superadmin ${SUPERADMIN_EMAIL} already existed — password reset (auth ${id})`,
  );
}

// --- Step 4: the default tenant owner ----------------------------------------

async function seedDefaultOwner(tdb: TenantDb, users: PlatformUsersService) {
  // Reads first, in their own transaction. users.create() opens its own
  // asPlatform transaction, so it must not run inside one.
  const prepared = await tdb.asPlatform(async (db) => {
    const [tenant] = await db
      .select()
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, DEFAULT_OWNER.tenantSlug))
      .limit(1);

    if (!tenant) {
      throw new Error(
        `Cannot seed the default owner: no workspace with slug "${DEFAULT_OWNER.tenantSlug}". ` +
          `Run without --users-only first.`,
      );
    }

    const [existing] = await db
      .select({ id: schema.staffUsers.id })
      .from(schema.staffUsers)
      .where(eq(schema.staffUsers.email, DEFAULT_OWNER.email))
      .limit(1);

    if (existing) return { tenant, existingStaffId: existing.id, roleId: null };
    return { tenant, existingStaffId: null, roleId: await pickOwnerRole(db, tenant.id, tenant.type) };
  });

  if (prepared.existingStaffId) {
    console.log(
      `✔ owner ${DEFAULT_OWNER.email} already exists in a workspace (staff ${prepared.existingStaffId}) — left alone`,
    );
    return;
  }

  const { tenant, roleId } = prepared;
  const { user } = await users.create(
    {
      tenantId: tenant.id,
      name: DEFAULT_OWNER.name,
      email: DEFAULT_OWNER.email,
      roleId,
      appRole: "owner",
      // No invite link to click: GoTrue confirms the address and the staff row
      // lands `active`, so the account works the moment this finishes.
      sendInvite: false,
      password: SEED_PASSWORD,
      // A fixture account whose password is printed in the console has nothing
      // to protect; forcing a change would just break every seeded dev login.
      mustChangePassword: false,
    },
    CLI_CTX,
  );

  console.log(`✔ owner ${DEFAULT_OWNER.email} created in ${tenant.name} (staff ${user.id}, auth ${user.authUserId})`);
}

/**
 * Which Role the seeded owner gets.
 *
 * Order matters and each fallback is deliberate:
 *   1. a role that actually holds capability keys — a configured role is the
 *      only one whose `menu:` keys mean anything to look at;
 *   2. the vertical's manager template by name, for a freshly provisioned
 *      workspace where every role is equally configured;
 *   3. any role at all.
 *
 * Throws rather than passing roleId: null. An owner with no role resolves to an
 * unrestricted menu and cannot be scoped by the platform admin — precisely the
 * broken state this seeder exists to stop reproducing.
 */
async function pickOwnerRole(db: Db, tenantId: string, type: string): Promise<string> {
  const roles = await db
    .select({ id: schema.roles.id, name: schema.roles.name })
    .from(schema.roles)
    .where(eq(schema.roles.tenantId, tenantId))
    .orderBy(asc(schema.roles.name));

  if (!roles.length) {
    throw new Error(`Workspace ${tenantId} has no roles. Run \`npm run db:seed\` without --users-only.`);
  }

  const permissions = await db
    .select({ roleId: schema.rolePermissions.roleId, permission: schema.rolePermissions.permission })
    .from(schema.rolePermissions)
    .where(
      inArray(
        schema.rolePermissions.roleId,
        roles.map((r) => r.id),
      ),
    );

  const configured = new Set(permissions.filter((p) => isCapabilityKey(p.permission)).map((p) => p.roleId));
  const chosen =
    roles.find((r) => configured.has(r.id)) ??
    roles.find((r) => r.name === managerTemplateFor(type).name) ??
    roles[0];

  console.log(`  role for the owner: "${chosen.name}"`);
  return chosen.id;
}

// Explicit exit: AppModule pulls in the schedule module and the chat gateway,
// which hold the event loop open, so the process never returns on its own once
// app.close() resolves.
main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
