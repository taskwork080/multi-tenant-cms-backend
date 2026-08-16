import { eq } from "drizzle-orm";
import type { Db } from "../db/db.tokens";
import { rolePermissions, roles } from "../db/schema";
import { permissionsFor, templatesFor } from "./role-templates";

/**
 * Give a workspace that has no roles its vertical's full template set.
 *
 * WHY THIS IS SHARED: two callers need exactly this and used to each have their
 * own loop — `scripts/backfill-rbac.ts` pass 2 (existing workspaces that predate
 * the permission model) and `scripts/seed.ts` (fixtures inserted straight into
 * `tenants`, which never provisioned roles at all). A workspace with no roles is
 * not a harmless gap: `resolveMenuAccess` treats "staff row with no role" as
 * unrestricted, so the first person to sign in silently gets the whole sidebar,
 * and there is nothing for a platform admin to assign in order to scope them.
 *
 * NOT shared with TenantProvisioningService.provision(), which keeps its own
 * copy on purpose: that one runs inside the caller's transaction and also writes
 * `tenant_entitlements`, neither of which is right here — this helper must never
 * grant a workspace modules it did not buy.
 *
 * Idempotent. Returns 0 and writes nothing when roles already exist, so it is
 * safe to call over every tenant on every seed.
 *
 * @param entitlements the tenant's modules; templates are narrowed to them, so a
 *                     role never holds a key whose module is locked (that would
 *                     resolve to a module-level 403 and read as a broken
 *                     permission rather than an unbought feature).
 * @returns how many roles were created
 */
export async function ensureTenantRoles(
  db: Db,
  tenant: { id: string; type: string },
  entitlements: readonly string[],
  onRole?: (name: string, capabilities: number) => void,
): Promise<number> {
  const existing = await db.select({ id: roles.id }).from(roles).where(eq(roles.tenantId, tenant.id)).limit(1);
  if (existing.length) return 0;

  const templates = templatesFor(tenant.type);
  for (const template of templates) {
    const permissions = permissionsFor(template, entitlements);
    const [role] = await db
      .insert(roles)
      .values({ tenantId: tenant.id, name: template.name, description: template.description })
      .returning({ id: roles.id });

    if (permissions.length) {
      await db.insert(rolePermissions).values(
        permissions.map((permission, sort) => ({ tenantId: tenant.id, roleId: role.id, permission, sort })),
      );
    }
    onRole?.(template.name, template.capabilities.length);
  }
  return templates.length;
}
