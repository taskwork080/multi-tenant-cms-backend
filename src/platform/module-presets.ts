/**
 * Feature modules and the per-tenant-type defaults.
 *
 * MIRRORED on the frontend: MODULE_KEYS below is the `ModuleKey` union in
 * `src/lib/types.ts` (multi-tenant-cms repo), and the nav in `src/lib/navigation.ts`
 * is keyed off the same values. There is no shared package between the repos.
 *
 * Why the list is duplicated here rather than left as a free `string`: a typo'd
 * module currently becomes a silently dead `tenant_entitlements` row that no
 * nav item and no CrudService lookup will ever match. Validating against a
 * closed set turns that into a 400 at the edge.
 *
 * The presets are the *source of truth* and the frontend fetches them over the
 * wire (GET /api/admin/tenants/module-presets) rather than mirroring them,
 * because the backend has to apply them on create regardless.
 */

export const MODULE_KEYS = [
  "dashboard",
  "schedule",
  "products",
  "categories",
  "brands",
  "manufacturers",
  "badges",
  "sales",
  "inventory",
  "inventoryInbound",
  "inventoryOutbound",
  "inventoryTransfers",
  "inventoryCounts",
  "warehouses",
  "delivery",
  "location",
  "customers",
  "sellers",
  "cms",
  "discounts",
  "reviews",
  "returns",
  "shipments",
  "tax",
  "staff",
  "roles",
  "activity",
  "configuration",
  "language",
  "notes",
  "messages",
  "packing",
  "packingShipments",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export const TENANT_TYPES = ["ecommerce", "warehouse", "marketplace"] as const;
export type TenantType = (typeof TENANT_TYPES)[number];

/** Every workspace gets these regardless of type: the shell, staff and settings. */
const BASE: ModuleKey[] = [
  "dashboard",
  "schedule",
  "notes",
  "messages",
  "staff",
  "roles",
  "activity",
  "configuration",
  "language",
];

/**
 * Selling to consumers: the full catalog, storefront and marketing surface, but
 * only basic stock tracking — the inventory sub-modules stay locked.
 */
const ECOMMERCE: ModuleKey[] = [
  ...BASE,
  "products",
  "categories",
  "brands",
  "manufacturers",
  "badges",
  "reviews",
  "sales",
  "returns",
  "customers",
  "discounts",
  "tax",
  "cms",
  "inventory",
  "shipments",
  "delivery",
];

/**
 * Moving goods: the full inventory sub-modules, packing and locations, and none
 * of the storefront/marketing surface (sales, customers, cms, discounts, tax,
 * reviews, badges, brands).
 */
const WAREHOUSE: ModuleKey[] = [
  ...BASE,
  "products",
  "categories",
  "manufacturers",
  "inventory",
  "inventoryInbound",
  "inventoryOutbound",
  "inventoryTransfers",
  "inventoryCounts",
  "warehouses",
  "packing",
  "packingShipments",
  "shipments",
  "delivery",
  "location",
  "returns",
];

/** E-commerce plus multi-seller and multi-location. */
const MARKETPLACE: ModuleKey[] = [...ECOMMERCE, "sellers", "warehouses", "location"];

export const MODULE_PRESETS: Record<TenantType, ModuleKey[]> = {
  ecommerce: ECOMMERCE,
  warehouse: WAREHOUSE,
  marketplace: MARKETPLACE,
};

/** Default modules for a tenant type. Returns a fresh sorted array. */
export function presetFor(type: string): ModuleKey[] {
  const preset = MODULE_PRESETS[type as TenantType] ?? MODULE_PRESETS.ecommerce;
  return [...preset].sort();
}
