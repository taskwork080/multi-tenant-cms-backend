import { GET } from "./http";
import { admin } from "./accounts";
import { writeArtifact } from "./env";

/**
 * A snapshot of everything the suite must NOT change.
 *
 * Taken before the run and again after teardown, then diffed. This is the only
 * hard evidence that a QA pass against a shared live database left real tenant
 * data untouched — assertions inside the suite can only prove what they looked
 * at, whereas the diff proves what nobody looked at either.
 */

export type TenantSnapshot = {
  slug: string;
  name: string;
  type: string;
  status: string;
  entitlements: string[];
  warehouses: { id: string; name: string; type: string; status: string }[];
  levels: { skuId: string; warehouseId: string; onHand: number; reserved: number; incoming: number }[];
  counts: Record<string, number>;
};

const RESOURCES = ["products", "skus", "warehouses", "inventory-levels", "inbound-receipts", "stock-transfers", "cycle-counts", "packing-lists", "shipments", "staff", "roles"];

async function total(slug: string, resource: string): Promise<number> {
  const r = await GET(`/api/${slug}/${resource}?pageSize=1`, { as: admin });
  return r.ok ? Number(r.body.total ?? 0) : -1;
}

export async function snapshotTenant(slug: string): Promise<TenantSnapshot> {
  const t = await GET(`/api/tenants/${slug}`, { as: admin });
  const tenant = t.body.data ?? t.body;

  const wh = await GET(`/api/${slug}/warehouses?pageSize=200`, { as: admin });
  const lv = await GET(`/api/${slug}/inventory-levels?pageSize=200`, { as: admin });

  const counts: Record<string, number> = {};
  for (const r of RESOURCES) counts[r] = await total(slug, r);

  return {
    slug,
    name: tenant?.name ?? "",
    type: tenant?.type ?? "",
    status: tenant?.status ?? "",
    entitlements: [...(tenant?.entitlements ?? [])].sort(),
    warehouses: (wh.body.data ?? []).map((w: any) => ({ id: w.id, name: w.name, type: w.type, status: w.status })),
    levels: (lv.body.data ?? [])
      .map((l: any) => ({
        skuId: l.skuId,
        warehouseId: l.warehouseId,
        onHand: Number(l.onHand ?? 0),
        reserved: Number(l.reserved ?? 0),
        incoming: Number(l.incoming ?? 0),
      }))
      .sort((a: any, b: any) => (a.skuId + a.warehouseId).localeCompare(b.skuId + b.warehouseId)),
    counts,
  };
}

export async function snapshotAll(slugs: string[], label: string) {
  const snaps: Record<string, TenantSnapshot> = {};
  for (const s of slugs) snaps[s] = await snapshotTenant(s);
  writeArtifact(`snapshot-${label}.json`, snaps);
  return snaps;
}

/** Diffs two snapshots, ignoring anything named for this run. */
export function diffSnapshots(before: Record<string, TenantSnapshot>, after: Record<string, TenantSnapshot>, runId: string): string[] {
  const drift: string[] = [];
  const isQa = (s: string) => s.includes(runId);

  for (const slug of Object.keys(before)) {
    const b = before[slug];
    const a = after[slug];
    if (!a) {
      drift.push(`${slug}: missing from post-run snapshot`);
      continue;
    }
    if (b.status !== a.status) drift.push(`${slug}: status ${b.status} -> ${a.status}`);
    if (b.entitlements.join(",") !== a.entitlements.join(",")) {
      drift.push(`${slug}: entitlements changed [${b.entitlements}] -> [${a.entitlements}]`);
    }

    const bw = new Map(b.warehouses.map((w) => [w.id, w]));
    for (const w of a.warehouses) {
      if (isQa(w.name)) continue;
      const prev = bw.get(w.id);
      if (!prev) drift.push(`${slug}: unexpected new warehouse ${w.name}`);
      else if (JSON.stringify(prev) !== JSON.stringify(w)) drift.push(`${slug}: warehouse ${w.name} modified`);
      bw.delete(w.id);
    }
    for (const [, w] of bw) if (!isQa(w.name)) drift.push(`${slug}: warehouse ${w.name} disappeared`);

    const key = (l: any) => `${l.skuId}@${l.warehouseId}`;
    const bl = new Map(b.levels.map((l) => [key(l), l]));
    const qaWarehouses = new Set([...b.warehouses, ...a.warehouses].filter((w) => isQa(w.name)).map((w) => w.id));
    for (const l of a.levels) {
      if (qaWarehouses.has(l.warehouseId)) continue;
      const prev = bl.get(key(l));
      if (!prev) continue; // new levels on QA SKUs are expected; QA SKUs are gone by now
      if (prev.onHand !== l.onHand || prev.reserved !== l.reserved || prev.incoming !== l.incoming) {
        drift.push(`${slug}: level ${key(l)} moved ${prev.onHand}/${prev.reserved}/${prev.incoming} -> ${l.onHand}/${l.reserved}/${l.incoming}`);
      }
    }
  }
  return drift;
}
