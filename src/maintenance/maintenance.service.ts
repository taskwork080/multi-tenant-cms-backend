import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import { inventoryReservations, promoCodes, tenants } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { FulfilmentService } from "../inventory/fulfilment.service";

/**
 * The jobs that make time-based state actually change.
 *
 * The schema has carried two time-dependent statuses since it was written —
 * `inventory_reservations.status = 'expired'` (with an `expires_at` column) and
 * `promo_codes.status` cycling scheduled → active → expired — and there was no
 * scheduler in the application at all. Nothing ever set either. So:
 *
 *   - a stuck or abandoned order held its stock forever. `available` is
 *     `on_hand - reserved`, so the hold silently understated availability and
 *     the only way out was a manual release nobody knew to do.
 *   - a promo code with a future validFrom stayed `scheduled` past its start
 *     and an ended one stayed `active` past its end, so `status` described
 *     what someone typed rather than what was true.
 *
 * Both jobs are idempotent and re-entrant: they select the rows that are wrong
 * and fix those, so a missed run self-heals on the next tick and two instances
 * racing produce the same end state.
 *
 * Cross-tenant by necessity, so both use asPlatform — the alternative is a
 * per-tenant transaction storm every few minutes.
 */
@Injectable()
export class MaintenanceService {
  private readonly log = new Logger(MaintenanceService.name);

  constructor(
    private readonly tdb: TenantDb,
    private readonly fulfilment: FulfilmentService,
  ) {}

  /**
   * Return the stock held by reservations whose hold has lapsed.
   *
   * Goes through FulfilmentService.releaseOrder rather than UPDATEing the rows,
   * because releasing is a stock movement: `applyMovement` is the only thing
   * allowed to touch inventory_levels, and it writes the ledger row that
   * explains the change. Flipping status here would leave `reserved` overstated
   * with nothing recording why. `releaseOrder` already accepts an "expire"
   * reason — this is the caller that never existed.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: "expire-reservations" })
  async expireReservations(): Promise<number> {
    const due = await this.tdb.asPlatform((tx) =>
      tx
        .selectDistinct({ tenantId: inventoryReservations.tenantId, orderId: inventoryReservations.orderId })
        .from(inventoryReservations)
        .where(
          and(
            eq(inventoryReservations.status, "active"),
            isNotNull(inventoryReservations.expiresAt),
            lt(inventoryReservations.expiresAt, new Date()),
            isNotNull(inventoryReservations.orderId),
          ),
        )
        .limit(500),
    );
    if (!due.length) return 0;

    let released = 0;
    for (const row of due) {
      if (!row.orderId) continue;
      try {
        // One transaction per order: a single poisoned order must not block
        // every other tenant's expiries behind it.
        released += await this.tdb.forTenant(row.tenantId, (tx) =>
          this.fulfilment.releaseOrder(tx, row.tenantId, row.orderId!, "expire", "system:expiry"),
        );
      } catch (err) {
        this.log.error(`Failed to expire reservations for order ${row.orderId}: ${(err as Error).message}`);
      }
    }

    if (released) this.log.log(`Expired reservations across ${due.length} orders, released ${released} units`);
    return released;
  }

  /**
   * Bring promo code status in line with its own validity window.
   *
   * valid_from / valid_to are `yyyy-mm-dd` text, so the comparison is done as
   * text against current_date — no timezone conversion, and it matches how the
   * dates were entered. A null bound means "open ended" in that direction.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: "promo-code-status" })
  async syncPromoCodeStatus(): Promise<{ activated: number; expired: number }> {
    return this.tdb.asPlatform(async (tx) => {
      const expired = await tx
        .update(promoCodes)
        .set({ status: "expired", updatedAt: new Date() })
        .where(
          and(
            sql`${promoCodes.status} <> 'expired'`,
            isNotNull(promoCodes.validTo),
            sql`${promoCodes.validTo} < to_char(current_date, 'YYYY-MM-DD')`,
          ),
        )
        .returning({ id: promoCodes.id });

      const activated = await tx
        .update(promoCodes)
        .set({ status: "active", updatedAt: new Date() })
        .where(
          and(
            eq(promoCodes.status, "scheduled"),
            sql`(${promoCodes.validFrom} is null or ${promoCodes.validFrom} <= to_char(current_date, 'YYYY-MM-DD'))`,
            sql`(${promoCodes.validTo} is null or ${promoCodes.validTo} >= to_char(current_date, 'YYYY-MM-DD'))`,
          ),
        )
        .returning({ id: promoCodes.id });

      if (expired.length || activated.length) {
        this.log.log(`Promo codes: ${activated.length} activated, ${expired.length} expired`);
      }
      return { activated: activated.length, expired: expired.length };
    });
  }

  /** Count of workspaces, used by the health probe to prove the job wiring is live. */
  async tenantCount(): Promise<number> {
    const [row] = await this.tdb.asPlatform((tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(tenants),
    );
    return row?.n ?? 0;
  }
}
