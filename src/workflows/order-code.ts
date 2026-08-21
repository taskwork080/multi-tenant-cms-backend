import { ConflictException } from "@nestjs/common";
import { and, desc, eq, like, sql } from "drizzle-orm";
import type { Db } from "../db/db.tokens";
import { orders } from "../db/schema";

/**
 * Allocates the next `ORD-NNNN` for a tenant.
 *
 * This used to happen in the browser, as
 * `ORD-${Math.floor(1000 + Math.random() * 9000)}` — 9000 possible values
 * against a `(tenant_id, code)` unique index. By the birthday bound a workspace
 * hits its first collision at roughly a hundred orders, and the failure lands
 * on the operator as an opaque constraint error at the moment they press
 * "Place order". With a public storefront placing orders too, that stops being
 * a nuisance and becomes lost sales.
 *
 * Sequential rather than random: an order code is read aloud down a phone, and
 * "the next number" is what every shop already expects. It is per-tenant, so
 * two workspaces both start at ORD-1000 and neither can infer the other's
 * volume.
 *
 * Must run inside the same transaction as the insert. The `for update` lock on
 * the highest existing row is what serialises two concurrent checkouts: the
 * second waits, then reads the first one's code. Without the lock both would
 * read the same maximum and pick the same next number.
 */
export async function nextOrderCode(tx: Db, tenantId: string, prefix = "ORD-"): Promise<string> {
  const [highest] = await tx
    .select({ code: orders.code })
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), like(orders.code, `${prefix}%`)))
    // Ordered by the numeric tail, not the string: "ORD-10000" sorts before
    // "ORD-9999" lexically, which would hand out a duplicate forever after.
    .orderBy(desc(sql`nullif(regexp_replace(${orders.code}, '\\D', '', 'g'), '')::bigint`))
    .limit(1)
    .for("update");

  const current = highest ? parseInt(highest.code.replace(/\D/g, ""), 10) : 0;
  const next = Number.isFinite(current) && current >= 1000 ? current + 1 : 1000;
  return `${prefix}${next}`;
}

/**
 * Retries once on a code collision.
 *
 * The lock above makes a clash almost impossible, but "almost" is doing real
 * work: a code typed by hand in the admin, or a legacy random one, can occupy
 * the number this would pick next. One retry turns that into a slower order
 * rather than a failed one; a second failure is a real problem and should
 * surface.
 */
export async function withOrderCode<T>(
  tx: Db,
  tenantId: string,
  write: (code: string) => Promise<T>,
): Promise<T> {
  try {
    return await write(await nextOrderCode(tx, tenantId));
  } catch (error) {
    if (!isDuplicateCode(error)) throw error;
    try {
      return await write(await nextOrderCode(tx, tenantId));
    } catch (retryError) {
      if (!isDuplicateCode(retryError)) throw retryError;
      throw new ConflictException("Could not allocate an order number — please try again");
    }
  }
}

function isDuplicateCode(error: unknown): boolean {
  const e = error as { code?: string; constraint_name?: string; constraint?: string };
  const constraint = e?.constraint_name ?? e?.constraint ?? "";
  return e?.code === "23505" && constraint.includes("orders_tenant_code");
}
