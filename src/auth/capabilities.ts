/**
 * Capability keys — what a tenant role may *do*, as opposed to what it may see.
 *
 * These live in the same `role_permissions.permission` column as the menu keys
 * (`menu:/inventory`, `menu:*`, …). Capability keys contain a "." and never a
 * ":" or "/", so `isMenuKey` already partitions the two families and adding
 * this needed no migration — the same trick menu-access.ts documents.
 *
 * THE DIFFERENCE FROM MENUS: menu keys are UX scoping and deliberately fail
 * *open* (see resolveMenuAccess rules 2 and 4). Capabilities are the real
 * authorization boundary and fail *closed* — once a role has any capability
 * key, anything not listed is denied. The backfill in
 * scripts/backfill-rbac.ts is what makes that safe to switch on.
 *
 * MIRRORED ON THE FRONTEND: the frontend used to hardcode its own list in
 * `src/lib/rbac.ts`. It now fetches GET /api/:tenant/capabilities instead,
 * because this file has to enforce the set regardless and the two drifting
 * silently is exactly how a role editor ends up offering keys nothing reads.
 *
 * WHY EACH KEY NAMES A MODULE: entitlements decide which modules a workspace
 * bought; capabilities decide who inside it may use them. Tying a capability to
 * a module lets the role editor show a warehouse tenant `inventory.receive` and
 * `packing.manage` while never offering `marketing.manage` — the vertical
 * shapes the role vocabulary instead of every tenant seeing an e-commerce list.
 * The two checks stay independent at request time: a locked module is 403 for
 * everyone including the owner, a missing capability is 403 for one user.
 */

import type { ModuleKey } from "../platform/module-presets";

export interface Capability {
  key: string;
  /** Human label — the role editor renders this. */
  label: string;
  /** Grouping header in the role editor. */
  group: string;
  /** Entitlement that must be unlocked for this capability to be offerable. */
  module: ModuleKey;
}

export const CAPABILITIES = [
  // --- Catalog ---------------------------------------------------------------
  { key: "catalog.view", label: "View catalog", group: "Catalog", module: "products" },
  { key: "catalog.manage", label: "Manage products & categories", group: "Catalog", module: "products" },

  // --- Commerce --------------------------------------------------------------
  { key: "orders.view", label: "View orders", group: "Sales", module: "sales" },
  { key: "orders.manage", label: "Manage orders", group: "Sales", module: "sales" },
  { key: "returns.manage", label: "Manage returns", group: "Sales", module: "returns" },
  { key: "customers.view", label: "View customers", group: "Customers", module: "customers" },
  { key: "customers.manage", label: "Manage customers", group: "Customers", module: "customers" },
  { key: "sellers.manage", label: "Manage sellers", group: "Customers", module: "sellers" },
  { key: "marketing.manage", label: "Manage discounts", group: "Marketing", module: "discounts" },
  { key: "reviews.moderate", label: "Moderate reviews", group: "Marketing", module: "reviews" },
  { key: "storefront.manage", label: "Manage the storefront", group: "Marketing", module: "storefront" },

  // --- Inventory / warehouse -------------------------------------------------
  // Absent from the original catalog, which is why a warehouse tenant could not
  // describe an Inbound Clerk or a Picker at all.
  { key: "inventory.view", label: "View stock", group: "Inventory", module: "inventory" },
  { key: "inventory.adjust", label: "Adjust stock", group: "Inventory", module: "inventory" },
  { key: "inventory.receive", label: "Receive inbound goods", group: "Inventory", module: "inventoryInbound" },
  { key: "inventory.ship", label: "Pick & dispatch outbound", group: "Inventory", module: "inventoryOutbound" },
  { key: "inventory.transfer", label: "Move stock between warehouses", group: "Inventory", module: "inventoryTransfers" },
  { key: "inventory.count", label: "Run & post stock counts", group: "Inventory", module: "inventoryCounts" },
  { key: "warehouses.manage", label: "Manage warehouses", group: "Inventory", module: "warehouses" },

  // --- Fulfilment ------------------------------------------------------------
  { key: "packing.manage", label: "Manage packing lists", group: "Fulfilment", module: "packing" },
  { key: "shipments.manage", label: "Manage shipments", group: "Fulfilment", module: "shipments" },
  { key: "delivery.manage", label: "Manage delivery channels", group: "Fulfilment", module: "delivery" },

  // --- Administration --------------------------------------------------------
  { key: "staff.manage", label: "Manage staff & roles", group: "Administration", module: "staff" },
  { key: "settings.manage", label: "Manage settings", group: "Administration", module: "configuration" },
] as const satisfies readonly Capability[];

export type CapabilityKey = (typeof CAPABILITIES)[number]["key"];

export const CAPABILITY_KEYS: readonly CapabilityKey[] = CAPABILITIES.map((c) => c.key);

const BY_KEY = new Map<string, Capability>(CAPABILITIES.map((c) => [c.key, c]));

/**
 * A capability key, as opposed to a `menu:` key, in the shared permission
 * column. Deliberately structural rather than a membership test against
 * CAPABILITY_KEYS: a permission row written by an older release must still read
 * as a capability (and therefore still count as "this role is configured")
 * even after a key is renamed, or the role would silently widen to unrestricted.
 */
export function isCapabilityKey(permission: string): boolean {
  return !permission.includes(":") && permission.includes(".");
}

/** The capabilities offerable to a workspace, given the modules it has bought. */
export function capabilitiesFor(entitlements: readonly string[]): Capability[] {
  const owned = new Set(entitlements);
  return CAPABILITIES.filter((c) => owned.has(c.module));
}

/**
 * Narrows a capability set to what the workspace's modules actually permit.
 *
 * Used when applying a role template and when saving a role: a workspace that
 * loses a module should not keep handing out a key that now resolves to a
 * module-level 403 for everyone anyway.
 */
export function intersectWithEntitlements(
  capabilities: readonly string[],
  entitlements: readonly string[],
): string[] {
  const owned = new Set(entitlements);
  return capabilities.filter((key) => {
    const cap = BY_KEY.get(key);
    return cap ? owned.has(cap.module) : false;
  });
}
