/**
 * The roles a new workspace opens with, per vertical.
 *
 * WHY THIS EXISTS: workspace creation used to write a tenant row and its
 * entitlement rows and stop. A brand-new workspace had *zero* roles, and
 * because resolveMenuAccess treats "staff row with no role" as unrestricted,
 * the first user silently got everything. The vertical the platform admin
 * picked decided which nav items rendered and nothing about who could do what.
 *
 * These templates are what make the vertical reach the permission model: a
 * warehouse workspace opens with Inbound Clerk / Picker-Packer / Stock
 * Controller, an e-commerce one with Catalog Editor / Order Desk / Customer
 * Support. Least privilege from minute one, without an admin hand-building five
 * roles before anyone can log in.
 *
 * Templates are a STARTING POINT, not a fixed catalog — every role here is an
 * ordinary tenant-owned row the workspace can rename, edit or delete. Nothing
 * downstream matches on these names.
 *
 * The capability lists are intersected with the tenant's actual entitlements
 * when applied (see applyTemplate), so a template never grants a key whose
 * module the workspace does not have.
 */

import { CAPABILITIES, intersectWithEntitlements } from "../auth/capabilities";
import { MENU_ALL } from "../auth/menu-access";
import type { TenantType } from "./module-presets";

export interface RoleTemplate {
  name: string;
  description: string;
  capabilities: string[];
  /**
   * Nav hrefs this role may see, as `menu:` keys are stored. `[MENU_ALL]` means
   * the full sidebar — still filtered by entitlements on the client, so a
   * warehouse manager with MENU_ALL never sees a storefront item.
   */
  menu: string[];
}

const ALL_CAPABILITIES = CAPABILITIES.map((c) => c.key);

/** Every vertical gets a read-only role; it is the safest thing to hand a new hire. */
const VIEWER: RoleTemplate = {
  name: "Viewer",
  description: "Read-only access to everything this workspace has.",
  capabilities: CAPABILITIES.filter((c) => c.key.endsWith(".view")).map((c) => c.key),
  menu: [MENU_ALL],
};

/**
 * The workspace's own top role. Deliberately NOT the same thing as the `owner`
 * app role: owner bypasses capability checks entirely (there is no in-app
 * recovery from an owner locking themselves out), whereas this is an ordinary
 * role that happens to hold every key — so revoking one from it actually bites.
 */
function manager(name: string, description: string): RoleTemplate {
  return { name, description, capabilities: [...ALL_CAPABILITIES], menu: [MENU_ALL] };
}

const ECOMMERCE: RoleTemplate[] = [
  manager("Store Manager", "Full access to the storefront, catalog, orders and staff."),
  {
    name: "Catalog Editor",
    description: "Maintains products, categories, brands and the storefront.",
    capabilities: ["catalog.view", "catalog.manage", "reviews.moderate", "storefront.manage"],
    menu: ["menu:/products", "menu:/products/new", "menu:/products/categories", "menu:/products/brands", "menu:/products/manufacturers", "menu:/products/badges", "menu:/reviews", "menu:/cms"],
  },
  {
    name: "Order Desk",
    description: "Processes orders, returns and shipments.",
    capabilities: ["catalog.view", "orders.view", "orders.manage", "returns.manage", "customers.view", "shipments.manage", "packing.manage"],
    menu: ["menu:/sales/orders", "menu:/sales/place-order", "menu:/sales/admin-orders", "menu:/sales/invoices", "menu:/returns", "menu:/shipments", "menu:/packing"],
  },
  {
    name: "Customer Support",
    description: "Answers customers; can read orders but not change them.",
    capabilities: ["orders.view", "customers.view", "customers.manage", "reviews.moderate"],
    menu: ["menu:/customers", "menu:/customers/new", "menu:/sales/orders", "menu:/reviews", "menu:/messages"],
  },
  VIEWER,
];

/**
 * The warehouse roles are the ones the old catalog could not express at all —
 * it had no receive, ship, transfer or count capability, so every warehouse
 * staff member was necessarily either an admin or a viewer.
 */
const WAREHOUSE: RoleTemplate[] = [
  manager("Warehouse Manager", "Full access to inventory, fulfilment and staff."),
  {
    name: "Inbound Clerk",
    description: "Books goods in against a receipt, and can add an item that isn't on file yet. Cannot adjust or count stock.",
    // catalog.manage because unknown goods turn up on the dock: in a warehouse
    // an item IS an inventory record, so the person receiving it is the person
    // who has to be able to create it. In a shop the same key would let them
    // edit storefront copy, which is why only the warehouse templates hold it.
    capabilities: ["catalog.view", "catalog.manage", "inventory.view", "inventory.receive"],
    menu: ["menu:/inventory", "menu:/inventory/stock", "menu:/inventory/inbound", "menu:/inventory/movements", "menu:/products", "menu:/products/new"],
  },
  {
    name: "Picker / Packer",
    description: "Picks, packs and dispatches outbound work.",
    capabilities: ["catalog.view", "inventory.view", "inventory.ship", "packing.manage", "shipments.manage"],
    menu: ["menu:/inventory", "menu:/inventory/stock", "menu:/inventory/outbound", "menu:/packing", "menu:/packing-shipments", "menu:/shipments"],
  },
  {
    name: "Stock Controller",
    description: "Owns stock accuracy: the item master, adjustments, transfers and cycle counts.",
    capabilities: ["catalog.view", "catalog.manage", "inventory.view", "inventory.adjust", "inventory.transfer", "inventory.count", "warehouses.manage"],
    menu: ["menu:/inventory", "menu:/inventory/stock", "menu:/inventory/transfers", "menu:/inventory/counts", "menu:/inventory/movements", "menu:/warehouses", "menu:/location", "menu:/products", "menu:/products/new"],
  },
  VIEWER,
];

const MARKETPLACE: RoleTemplate[] = [
  manager("Marketplace Manager", "Full access to sellers, catalog, orders and staff."),
  ...ECOMMERCE.slice(1, -1),
  {
    name: "Seller Manager",
    description: "Onboards and manages sellers and their catalog.",
    capabilities: ["catalog.view", "sellers.manage", "orders.view"],
    menu: ["menu:/seller-management/sellers", "menu:/seller-management/sellers/new", "menu:/products", "menu:/sales/orders"],
  },
  VIEWER,
];

export const ROLE_TEMPLATES: Record<TenantType, RoleTemplate[]> = {
  ecommerce: ECOMMERCE,
  warehouse: WAREHOUSE,
  marketplace: MARKETPLACE,
};

export function templatesFor(type: string): RoleTemplate[] {
  return ROLE_TEMPLATES[type as TenantType] ?? ROLE_TEMPLATES.ecommerce;
}

/**
 * The permission rows a template produces for a workspace, in the order they
 * should be stored (`role_permissions.sort`).
 *
 * Capabilities are narrowed to the tenant's entitlements; menu keys are not,
 * because the client already hides nav items for locked modules and a menu key
 * for a module the workspace later buys should start working immediately.
 */
export function permissionsFor(template: RoleTemplate, entitlements: readonly string[]): string[] {
  return [...intersectWithEntitlements(template.capabilities, entitlements), ...template.menu];
}

/** The template a pre-existing role should inherit when it has no capabilities yet. */
export function managerTemplateFor(type: string): RoleTemplate {
  return templatesFor(type)[0];
}
