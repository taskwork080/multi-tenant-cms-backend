import { Injectable } from "@nestjs/common";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { chatMessages, conversations, stockBatches } from "../db/schema";
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
      // quantity <= low_stock_threshold is a column-to-column comparison, so it
      // can't be an ordinary filter — same predicate as the `needsAttention`
      // flag on stock-batches and the dashboard's low-stock widget.
      const lowStock = and(eq(stockBatches.tenantId, tenant.id), sql`quantity <= low_stock_threshold`);
      const unread = and(eq(conversations.tenantId, tenant.id), gt(conversations.unread, 0));

      const [lowStockBatches, lowStockRows, unreadConversations, unreadRows] = await Promise.all([
        tx.select().from(stockBatches).where(lowStock).orderBy(stockBatches.quantity).limit(SAMPLE.batches),

        tx.select({ n: sql<number>`count(*)::int` }).from(stockBatches).where(lowStock),

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
