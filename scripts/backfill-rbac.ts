import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import { isCapabilityKey, intersectWithEntitlements, CAPABILITIES } from "../src/auth/capabilities";
import { ensureTenantRoles } from "../src/platform/role-provisioning";
import { managerTemplateFor, templatesFor } from "../src/platform/role-templates";

/**
 * Gives every existing workspace a working permission model, so capability
 * enforcement can be switched on without locking anyone out.
 *
 * Until this runs, tenant roles are decorative: role_permissions was written by
 * the role editor and read by nobody, so a `viewer` could DELETE anything.
 * CapabilityGuard therefore treats "no role, or a role with no capability keys"
 * as *unconfigured* and lets it through — which means shipping the code without
 * this script degrades to the old behaviour instead of breaking a workspace.
 * Running it is what makes enforcement real.
 *
 * Three passes, all idempotent — safe to re-run, and safe to run before or
 * after the code deploy:
 *
 *   1. Roles that hold no capability key inherit their vertical's manager
 *      template (everything the workspace is entitled to). Nobody LOSES access;
 *      the role simply stops being ambiguous.
 *   2. Workspaces with no roles at all get the full template set for their
 *      type, so there is something to assign.
 *   3. Staff rows with no role get that workspace's Viewer role. A staff row
 *      with role_id NULL resolves to unrestricted today and to
 *      "unconfigured, allow" after — neither is a decision anyone made.
 *
 * Deliberately a script and not a SQL migration: the role templates and the
 * capability→module map live in TypeScript, and hand-copying them into SQL
 * would create exactly the drift this file exists to remove.
 *
 *   npm run db:backfill            apply
 *   npm run db:backfill -- --dry   report what it would do and exit
 */

const DRY = process.argv.includes("--dry");

async function main() {
  const client = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const db = drizzle(client, { schema });

  // The whole backfill crosses every tenant, so it needs the platform escape
  // hatch that drizzle/0008_platform_admin.sql's policies key off.
  await db.execute(sql`select set_config('app.platform', 'on', false)`);

  const tenants = await db
    .select({ id: schema.tenants.id, slug: schema.tenants.slug, type: schema.tenants.type })
    .from(schema.tenants);

  const entitlementRows = await db.select().from(schema.tenantEntitlements);
  const entitlementsByTenant = new Map<string, string[]>();
  for (const row of entitlementRows) {
    entitlementsByTenant.set(row.tenantId, [...(entitlementsByTenant.get(row.tenantId) ?? []), row.module]);
  }

  let rolesSeeded = 0;
  let rolesUpgraded = 0;
  let staffAssigned = 0;

  for (const tenant of tenants) {
    const entitlements = entitlementsByTenant.get(tenant.id) ?? [];

    const existing = await db
      .select({ id: schema.roles.id, name: schema.roles.name })
      .from(schema.roles)
      .where(eq(schema.roles.tenantId, tenant.id));

    // --- Pass 2 (first, so pass 3 has a Viewer to point at) ------------------
    if (existing.length === 0) {
      if (DRY) {
        for (const template of templatesFor(tenant.type)) {
          console.log(`[${tenant.slug}] + role "${template.name}"`);
        }
      } else {
        // Shared with scripts/seed.ts — see src/platform/role-provisioning.ts.
        rolesSeeded += await ensureTenantRoles(db, tenant, entitlements, (name) =>
          console.log(`[${tenant.slug}] + role "${name}"`),
        );
        // Re-read so pass 3 below has real ids to point its orphans at.
        existing.push(
          ...(await db
            .select({ id: schema.roles.id, name: schema.roles.name })
            .from(schema.roles)
            .where(eq(schema.roles.tenantId, tenant.id))),
        );
      }
    } else {
      // --- Pass 1 ------------------------------------------------------------
      const perms = await db
        .select({ roleId: schema.rolePermissions.roleId, permission: schema.rolePermissions.permission })
        .from(schema.rolePermissions)
        .where(
          inArray(
            schema.rolePermissions.roleId,
            existing.map((r) => r.id),
          ),
        );

      const capsByRole = new Map<string, number>();
      const maxSortByRole = new Map<string, number>();
      for (const p of perms) {
        if (isCapabilityKey(p.permission)) capsByRole.set(p.roleId, (capsByRole.get(p.roleId) ?? 0) + 1);
        maxSortByRole.set(p.roleId, (maxSortByRole.get(p.roleId) ?? -1) + 1);
      }

      const template = managerTemplateFor(tenant.type);
      const grant = intersectWithEntitlements(template.capabilities, entitlements);

      for (const role of existing) {
        if ((capsByRole.get(role.id) ?? 0) > 0) continue; // already configured
        console.log(`[${tenant.slug}] ~ role "${role.name}" += ${grant.length} capabilities`);
        if (DRY) continue;

        const base = (maxSortByRole.get(role.id) ?? -1) + 1;
        await db
          .insert(schema.rolePermissions)
          .values(grant.map((permission, i) => ({ tenantId: tenant.id, roleId: role.id, permission, sort: base + i })));
        rolesUpgraded++;
      }
    }

    // --- Pass 3 --------------------------------------------------------------
    const viewer = existing.find((r) => r.name === "Viewer") ?? existing[existing.length - 1];
    if (!viewer) continue;

    const orphans = await db
      .select({ id: schema.staffUsers.id, email: schema.staffUsers.email })
      .from(schema.staffUsers)
      .where(and(eq(schema.staffUsers.tenantId, tenant.id), isNull(schema.staffUsers.roleId)));

    for (const staff of orphans) {
      console.log(`[${tenant.slug}] ~ staff ${staff.email} -> role "${viewer.name}"`);
      if (DRY) continue;
      await db.update(schema.staffUsers).set({ roleId: viewer.id }).where(eq(schema.staffUsers.id, staff.id));
      staffAssigned++;
    }
  }

  console.log(
    DRY
      ? "\nDry run — nothing written."
      : `\nDone. ${rolesSeeded} roles seeded, ${rolesUpgraded} roles upgraded, ${staffAssigned} staff assigned. ` +
        `Catalog has ${CAPABILITIES.length} capabilities.`,
  );

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
