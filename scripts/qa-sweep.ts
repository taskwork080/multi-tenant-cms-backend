/**
 * Removes every stray `QA-*` artefact this suite has ever left behind.
 *
 * A run against a shared live database must be able to self-heal: if a
 * provision or teardown crashes half-way, the next `npm run qa:sweep` finds the
 * orphans by name rather than by a roster file that may never have been
 * written. Safe to run at any time — it only ever matches the QA namespace.
 */
import { GET, DEL } from "../test/support/http";
import { admin } from "../test/support/accounts";

const TENANTS = ["volt", "nord", "365", "365-gadgets", "agri"];
// Same FK-driven order as the per-run teardown: documents, then products
// (whose cascade clears inventory_levels), then warehouses.
const RESOURCES = ["shipments", "packing-lists", "cycle-counts", "inbound-receipts", "stock-transfers", "products", "warehouses"];

/**
 * Fields that can carry the QA marker, including the DENORMALISED name columns.
 *
 * Matching a document by its own `ref` does not work and quietly breaks the
 * whole sweep: a receipt is `GRN-0001`, a transfer `TRF-0001`, a count
 * `CNT-0001` — assigned by InventoryService.nextRef and never namespaced. The
 * only QA marker such a row carries is the warehouse or supplier name copied
 * onto it at creation.
 *
 * That omission is not cosmetic. cycle_count_items.sku_id is RESTRICT, so an
 * unmatched count pins the SKU, which pins the product, whose cascade is the
 * only thing that clears inventory_levels, which is the RESTRICT pinning the
 * warehouse. One unmatched document therefore strands the entire fixture — the
 * exact "self-heal" case this script exists for.
 */
const MARKED = [
  "name",
  "nameEn",
  "slug",
  "ref",
  "code",
  "skuCode",
  "warehouseName",
  "fromWarehouseName",
  "toWarehouseName",
  "supplierName",
  "countedBy",
];

/**
 * `QA-` / `QA ` prefixed, matching the namespace fixtures.ts and accounts.ts
 * write. Anchored at the start of the field on purpose: a real record whose
 * note happens to mention "QA-something" must never be swept.
 */
const isQa = (o: any) => MARKED.some((k) => typeof o?.[k] === "string" && /^qa[- ]/i.test(o[k]));

async function main() {
  let removed = 0;
  let blocked = 0;

  const users = await GET("/api/admin/users?pageSize=200", { as: admin });
  for (const u of users.body?.data ?? []) {
    if (!/^qa-.*@qa\.invalid$/i.test(u.email ?? "")) continue;
    const r = await DEL(`/api/admin/users/${u.id}?hard=true`, { as: admin });
    console.log(`user  ${u.email} -> ${r.status}`);
    if (r.ok || r.status === 404) removed++;
    else blocked++;
  }

  for (const slug of TENANTS) {
    for (const resource of RESOURCES) {
      const list = await GET(`/api/${slug}/${resource}?pageSize=200`, { as: admin });
      if (!list.ok) continue;
      for (const item of (list.body.data ?? []).filter(isQa)) {
        const r = await DEL(`/api/${slug}/${resource}/${item.id}`, { as: admin });
        const label = item.name ?? item.nameEn ?? item.ref ?? item.code ?? item.id;
        console.log(`${slug}/${resource} ${label} -> ${r.status}`);
        if (r.ok || r.status === 404) removed++;
        else blocked++;
      }
    }
    const roles = await GET(`/api/${slug}/roles?pageSize=200`, { as: admin });
    for (const role of (roles.body?.data ?? []).filter(isQa)) {
      const r = await DEL(`/api/admin/roles/${role.id}`, { as: admin });
      console.log(`${slug}/roles ${role.name} -> ${r.status}`);
      if (r.ok || r.status === 404) removed++;
      else blocked++;
    }
  }

  console.log(`\n[qa] sweep done: ${removed} removed, ${blocked} blocked`);
}

main().catch((e) => {
  console.error("[qa] sweep failed:", e.message);
  process.exit(1);
});
