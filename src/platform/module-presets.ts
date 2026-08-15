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
  "storefront",
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
  "storefront",
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

// -----------------------------------------------------------------------------
// Ceilings
// -----------------------------------------------------------------------------

/**
 * The widest set of modules a workspace of each type may hold — as opposed to
 * MODULE_PRESETS, which is only what it *starts* with.
 *
 * Without this, "type" was a suggestion: the preset chose an opening sidebar
 * and nothing afterwards stopped a warehouse workspace being handed `cms` and
 * `sales`. The seed itself did exactly that (volt is a warehouse tenant seeded
 * with cms/sales/discounts/reviews), which is the clearest evidence the vertical
 * was never enforced.
 *
 * A ceiling is deliberately wider than a preset. Presets are the sensible
 * default; ceilings are the line that makes the vertical mean something. A
 * warehouse can be given `warehouses` and `sellers` on request — it can never
 * be given a storefront, a marketing surface or a consumer sales funnel,
 * because that is a different product and a different support burden.
 *
 * Escape hatch: a platform admin can still cross the line explicitly with
 * `allowOutsideType: true`, which is recorded in the audit row. The point is
 * that it becomes a decision someone made rather than a default nobody noticed.
 */
const WAREHOUSE_CEILING: ModuleKey[] = [
  ...BASE,
  "products",
  "categories",
  "manufacturers",
  "brands",
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
  "sellers",
];

/** Commerce verticals may hold anything: they are the superset product. */
const COMMERCE_CEILING: ModuleKey[] = [...MODULE_KEYS];

export const TYPE_ALLOWED_MODULES: Record<TenantType, ModuleKey[]> = {
  ecommerce: COMMERCE_CEILING,
  warehouse: WAREHOUSE_CEILING,
  marketplace: COMMERCE_CEILING,
};

export function allowedFor(type: string): ModuleKey[] {
  const allowed = TYPE_ALLOWED_MODULES[type as TenantType] ?? TYPE_ALLOWED_MODULES.ecommerce;
  return [...allowed].sort();
}

/** Modules in `entitlements` that this tenant type may not hold. Empty means OK. */
export function modulesOutsideType(type: string, entitlements: readonly string[]): string[] {
  const allowed = new Set<string>(TYPE_ALLOWED_MODULES[type as TenantType] ?? TYPE_ALLOWED_MODULES.ecommerce);
  return entitlements.filter((m) => !allowed.has(m));
}

// -----------------------------------------------------------------------------
// Config fields per vertical
// -----------------------------------------------------------------------------

/**
 * `tenants` flattens one TenantConfig for every workspace, but half of it only
 * means anything to a shop: cash on delivery, a GA4 measurement id, a Meta
 * pixel, the default seller shown on a storefront listing. A warehouse
 * workspace was offered all of them in Settings, which is how a settings page
 * teaches people not to trust it.
 *
 * Universal fields are listed once and shared; the commerce set is additive.
 */
const UNIVERSAL_CONFIG = [
  "defaultLanguage",
  "currency",
  "currencySymbol",
  "locationServiceOn",
  "cordNo",
] as const;

const COMMERCE_CONFIG = [
  "ga4Id",
  "pixelId",
  "strictOrderFlow",
  "defaultSellerName",
  "codEnabled",
  "allowForceDeleteCategory",
] as const;

export type TenantConfigField = (typeof UNIVERSAL_CONFIG)[number] | (typeof COMMERCE_CONFIG)[number];

export const TYPE_CONFIG_FIELDS: Record<TenantType, TenantConfigField[]> = {
  ecommerce: [...UNIVERSAL_CONFIG, ...COMMERCE_CONFIG],
  marketplace: [...UNIVERSAL_CONFIG, ...COMMERCE_CONFIG],
  warehouse: [...UNIVERSAL_CONFIG],
};

export function configFieldsFor(type: string): TenantConfigField[] {
  return TYPE_CONFIG_FIELDS[type as TenantType] ?? TYPE_CONFIG_FIELDS.ecommerce;
}

/** Config keys in `config` that this tenant type has no use for. */
export function configFieldsOutsideType(type: string, config: Record<string, unknown>): string[] {
  const allowed = new Set<string>(configFieldsFor(type));
  return Object.keys(config).filter((k) => !allowed.has(k));
}
