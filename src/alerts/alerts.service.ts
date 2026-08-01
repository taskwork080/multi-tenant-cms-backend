import { Injectable } from "@nestjs/common";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { chatMessages, conversations, inventoryLevels } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import type { TenantDto } from "../tenant/tenant.service";

/** How many rows each dropdown renders before it stops listing them. */
const SAMPLE = { batches: 5, conversations: 8 } as const;

/**
 * The two badges in the app chrome, as SQL aggregates.
 *
 * These used to be the last reason bootstrap pulled whole collections: the
 * Topbar filtered every stock batch and every conversation in the browser to
 * render two counts. Both are now one request that returns the counts plus a
 * short sample for the dropdowns.
 */
@Injectable()
export class AlertsService {
  constructor(private readonly tdb: TenantDb) {}

  async alerts(tenant: TenantDto) {
    return this.tdb.forTenant(tenant.id, async (tx) => {
      // Reads inventory_levels, the stock truth, rather than the legacy
      // stock_batches rows (which only the old flat receive path still
      // maintains). The badge alerts on *available* — stock already held by an
      // open order can't fill the next one, so counting it as on-hand would
      // hide the shortage until someone tried to sell it.
      //
      // Column-to-column comparisons, so they can't be ordinary filters; same
      // predicate as the `needsAttention` flag on inventory-levels.
      const lowStock = and(
        eq(inventoryLevels.tenantId, tenant.id),
        sql`(on_hand - reserved) <= coalesce(low_stock_threshold, 10)`,
      );
      const unread = and(eq(conversations.tenantId, tenant.id), gt(conversations.unread, 0));

      const [lowStockBatches, lowStockRows, unreadConversations, unreadRows] = await Promise.all([
        tx
          .select({
            id: inventoryLevels.id,
            productId: inventoryLevels.skuId,
            productName: inventoryLevels.skuName,
            warehouseId: inventoryLevels.warehouseId,
            warehouseName: inventoryLevels.warehouseName,
            // Named `quantity` so the existing Topbar dropdown keeps rendering
            // without a frontend change; it now carries *available*, not on-hand.
            quantity: sql<number>`(on_hand - reserved)::int`,
            lowStockThreshold: sql<number>`coalesce(low_stock_threshold, 10)::int`,
          })
          .from(inventoryLevels)
          .where(lowStock)
          .orderBy(sql`(on_hand - reserved) asc`)
          .limit(SAMPLE.batches),

        tx.select({ n: sql<number>`count(*)::int` }).from(inventoryLevels).where(lowStock),

        // The dropdown previews each thread's latest message, so pull it with a
        // lateral join rather than making the client fetch every conversation.
        tx
          .select({
            id: conversations.id,
            name: conversations.name,
            online: conversations.online,
            unread: conversations.unread,
            lastMessageAt: conversations.lastMessageAt,
            lastMessageText: sql<string | null>`last_message.text`,
            lastMessageAttachment: sql<string | null>`last_message.attachment`,
          })
          .from(conversations)
          .leftJoin(
            sql`lateral (
              select m.text, m.attachment
              from ${chatMessages} m
              where m.conversation_id = ${conversations.id}
              order by m.at desc
              limit 1
            ) as last_message`,
            sql`true`,
          )
          .where(unread)
          .orderBy(desc(conversations.lastMessageAt))
          .limit(SAMPLE.conversations),

        // Total unread *messages*, not threads — the badge counts messages.
        tx.select({ n: sql<number>`coalesce(sum(unread), 0)::int` }).from(conversations).where(unread),
      ]);

      return {
        lowStockBatches,
        lowStockCount: lowStockRows[0]?.n ?? 0,
        unreadConversations,
        totalUnread: unreadRows[0]?.n ?? 0,
      };
    });
  }
}

export type AlertsResponse = Awaited<ReturnType<AlertsService["alerts"]>>;
