import { Injectable, Logger } from "@nestjs/common";
import type { Db } from "../db/db.tokens";
import { rolePermissions, roles, storefrontConfigs, tenantEntitlements } from "../db/schema";
import { permissionsFor, templatesFor } from "./role-templates";
import type { TenantType } from "./module-presets";

/**
 * Everything a workspace needs to be usable on the day it is created.
 *
 * BEFORE: creating a workspace wrote a tenants row and its tenant_entitlements
 * rows and stopped. It had no roles at all — so the first person to sign in hit
 * resolveMenuAccess's "staff row with no role" branch and silently got
 * everything, and an admin had to hand-build five roles before least privilege
 * was even expressible. The vertical the platform admin chose decided which nav
 * items rendered and nothing about who could do what.
 *
 * All of it runs INSIDE the caller's transaction, for the same reason
 * AuditService does: a workspace that got its entitlements but not its roles,
 * or its roles but not its storefront row, is a half-built workspace that looks
 * exactly like a healthy one. Either the whole thing exists or none of it does.
 */
@Injectable()
export class TenantProvisioningService {
  private readonly log = new Logger(TenantProvisioningService.name);

  /**
   * @param tx    the transaction the tenant row was just inserted in
   * @returns     what was created, for the audit `after` payload
   */
  async provision(
    tx: Db,
    tenantId: string,
    type: string,
    entitlements: string[],
  ): Promise<{ entitlements: number; roles: string[]; storefront: boolean }> {
    if (entitlements.length) {
      await tx.insert(tenantEntitlements).values(entitlements.map((module) => ({ tenantId, module })));
    }

    // Roles come from the vertical's templates, narrowed to the modules this
    // workspace actually has — a template never grants a key whose module is
    // locked, because that would resolve to a module-level 403 for everyone and
    // read as a broken permission rather than an unbought feature.
    const created: string[] = [];
    for (const template of templatesFor(type)) {
      const permissions = permissionsFor(template, entitlements);
      const [role] = await tx
        .insert(roles)
        .values({ tenantId, name: template.name, description: template.description })
        .returning({ id: roles.id });
      if (permissions.length) {
        await tx.insert(rolePermissions).values(
          permissions.map((permission, sort) => ({ tenantId, roleId: role.id, permission, sort })),
        );
      }
      created.push(template.name);
    }

    // A commerce workspace gets its storefront row up front but switched OFF:
    // `is_active` is the "is the site live" switch and the `cms` entitlement is
    // the "can they see the manager" switch (schema.ts documents the split), so
    // pre-creating the row costs nothing and removes a first-run edge case
    // where the manager has no config to edit. A warehouse workspace has no
    // storefront at all and must not get one.
    const wantsStorefront = type !== "warehouse" && entitlements.includes("cms");
    if (wantsStorefront) {
      await tx.insert(storefrontConfigs).values({ tenantId, isActive: false }).onConflictDoNothing();
    }

    this.log.log(`Provisioned ${type} workspace ${tenantId}: ${created.length} roles, ${entitlements.length} modules`);
    return { entitlements: entitlements.length, roles: created, storefront: wantsStorefront };
  }

  /** Type guard kept here so callers don't import TenantType just to narrow. */
  static isKnownType(type: string): type is TenantType {
    return type === "ecommerce" || type === "warehouse" || type === "marketplace";
  }
}
