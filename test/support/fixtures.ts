import { GET, POST, DEL, type Actor } from "./http";
import { writeArtifact, readArtifact } from "./env";

/**
 * Self-contained warehouse fixtures, namespaced per run.
 *
 * Two rules shape everything here:
 *
 * 1. `inventory_levels` is NEVER created directly. `InventoryService.lockLevel`
 *    creates level rows on first movement, and that table's invariant is "only
 *    applyMovement writes it". Inserting one through the CRUD catch-all would
 *    make the suite a second writer of a single-writer table.
 *
 * 2. Every destructive-ledger test runs against fixture warehouses and fixture
 *    SKUs. Confirming a receipt or posting a count appends stock_movements rows
 *    whose ref_id has no FK back to the document, so they can only be removed as
 *    collateral of the SKU cascade. volt's real Mirpur / Kollanpur 001 and its
 *    four existing SKUs are read-only fixtures — read for list/stats/UI
 *    assertions, never used as a movement target.
 */

export type TenantFixture = {
  tenantSlug: string;
  warehouseA: { id: string; name: string };
  warehouseB: { id: string; name: string };
  product: { id: string; name: string; slug: string };
  sku: { id: string; code: string };
};

const FILE = (slug: string) => `fixture-${slug}.json`;

export const loadFixture = (slug: string) => readArtifact<TenantFixture>(FILE(slug));

export function requireFixture(slug: string): TenantFixture {
  const f = loadFixture(slug);
  if (!f) throw new Error(`No fixture for "${slug}" — run \`npm run qa:provision\` first.`);
  return f;
}

async function create(actor: Actor, slug: string, resource: string, body: unknown) {
  const r = await POST(`/api/${slug}/${resource}`, { as: actor, body });
  if (!r.ok) throw new Error(`Create ${resource} in ${slug} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data ?? r.body;
}

/** Builds warehouses + item + SKU. Stops short of any movement. */
export async function buildFixture(actor: Actor, slug: string, runId: string): Promise<TenantFixture> {
  const aName = `QA-WH-A-${runId}`;
  const bName = `QA-WH-B-${runId}`;

  const warehouseA = await create(actor, slug, "warehouses", {
    name: aName,
    type: "central",
    status: "active",
    coverageAreas: [`QA Zone A ${runId}`],
  });
  // A second warehouse is not optional — every transfer test needs a destination.
  const warehouseB = await create(actor, slug, "warehouses", {
    name: bName,
    type: "regional",
    status: "active",
    coverageAreas: [`QA Zone B ${runId}`],
  });

  // `ensuresSkus: true` on the products resource creates the default SKU in the
  // same transaction, so there is no separate SKU call and no inventory.adjust
  // capability needed — this is the path an Inbound Clerk actually walks.
  const product = await create(actor, slug, "products", {
    nameEn: `QA-ITEM-${runId}`,
    slug: `qa-item-${runId}`,
    stockMode: "tracked",
    unit: "pcs",
    status: "active",
    price: 100,
  });

  const skus = await GET(`/api/${slug}/skus?productId=${product.id}`, { as: actor });
  const sku = (skus.body.data ?? [])[0];
  if (!sku) throw new Error(`Product ${product.id} in ${slug} produced no default SKU (ensuresSkus regression?)`);

  const fixture: TenantFixture = {
    tenantSlug: slug,
    warehouseA: { id: warehouseA.id, name: aName },
    warehouseB: { id: warehouseB.id, name: bName },
    product: { id: product.id, name: product.nameEn, slug: product.slug },
    sku: { id: sku.id, code: sku.code },
  };
  writeArtifact(FILE(slug), fixture);
  return fixture;
}

// --- Stock inspection helpers ---------------------------------------------

export type Level = { warehouseId: string; onHand: number; reserved: number; incoming: number };

/** Reads inventory_levels for a SKU straight from the CRUD surface. */
export async function levels(actor: Actor, slug: string, skuId: string): Promise<Level[]> {
  const r = await GET(`/api/${slug}/inventory-levels?skuId=${skuId}&pageSize=200`, { as: actor });
  if (!r.ok) throw new Error(`Read levels failed: ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body.data ?? []).map((l: any) => ({
    warehouseId: l.warehouseId,
    onHand: Number(l.onHand ?? 0),
    reserved: Number(l.reserved ?? 0),
    incoming: Number(l.incoming ?? 0),
  }));
}

export async function levelAt(actor: Actor, slug: string, skuId: string, warehouseId: string): Promise<Level> {
  const all = await levels(actor, slug, skuId);
  return all.find((l) => l.warehouseId === warehouseId) ?? { warehouseId, onHand: 0, reserved: 0, incoming: 0 };
}

/** Total on-hand across every warehouse — the conservation invariant's subject. */
export async function totalOnHand(actor: Actor, slug: string, skuId: string): Promise<number> {
  return (await levels(actor, slug, skuId)).reduce((s, l) => s + l.onHand, 0);
}

export async function movements(actor: Actor, slug: string, skuId: string) {
  const r = await GET(`/api/${slug}/inventory/movements?skuId=${skuId}&limit=100`, { as: actor });
  return (r.body.data ?? r.body ?? []) as any[];
}

// --- Teardown --------------------------------------------------------------

export type TeardownRow = {
  resource: string;
  id: string;
  ref?: string;
  outcome: "deleted" | "blocked" | "ledger-orphan";
  constraint?: string;
};

/**
 * FK-ordered teardown. The order is not stylistic:
 *
 *  - documents before products, because every *_items.sku_id is RESTRICT;
 *  - products before warehouses, because only the product→sku cascade clears
 *    inventory_levels, and inventory_levels is the RESTRICT pinning a warehouse.
 *
 * stock_movements is deliberately never deleted directly — it is the audit
 * ledger, and it goes only as cascade collateral.
 */
const ORDER = ["shipments", "packing-lists", "cycle-counts", "inbound-receipts", "stock-transfers", "products", "warehouses"];

export async function teardownTenant(actor: Actor, slug: string, runId: string): Promise<TeardownRow[]> {
  const rows: TeardownRow[] = [];

  for (const resource of ORDER) {
    const list = await GET(`/api/${slug}/${resource}?q=${encodeURIComponent(runId)}&pageSize=200`, { as: actor });
    if (!list.ok) {
      rows.push({ resource, id: "-", outcome: "blocked", constraint: `list failed ${list.status}` });
      continue;
    }
    const items: any[] = list.body.data ?? [];
    // The `q` search only covers a resource's `searchable` columns, so fall back
    // to a name/ref scan for anything whose QA marker lives elsewhere.
    const mine = items.filter((i) =>
      JSON.stringify(i).includes(runId),
    );
    for (const item of mine) {
      const r = await DEL(`/api/${slug}/${resource}/${item.id}`, { as: actor });
      rows.push({
        resource,
        id: item.id,
        ref: item.name ?? item.ref ?? item.nameEn ?? item.code,
        outcome: r.ok || r.status === 404 ? "deleted" : "blocked",
        constraint: r.ok || r.status === 404 ? undefined : `${r.status} ${r.message ?? JSON.stringify(r.body)}`,
      });
    }
  }

  return rows;
}
