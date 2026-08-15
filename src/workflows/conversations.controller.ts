import { Body, Controller, NotFoundException, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { conversations } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { CurrentTenant } from "../tenant/tenant.decorator";
import type { TenantDto } from "../tenant/tenant.service";
import { ChatGateway } from "../chat/chat.gateway";
import { RequireModule } from "../tenant/module.decorator";

const messageSchema = z.object({
  sender: z.enum(["customer", "support"]).default("support"),
  author: z.string().min(1),
  text: z.string().default(""),
  attachment: z.string().optional(),
  attachmentUrl: z.string().optional(),
  attachmentType: z.enum(["image", "file"]).optional(),
});

/**
 * Append-only writes on a messenger thread.
 *
 * The admin used to PATCH the conversation with its whole `messages` array,
 * which required the client to hold every message and made two people typing
 * at once a last-write-wins race. Both operations here touch one row.
 */
@ApiTags("messages")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@ApiParam({ name: "id", description: "Conversation id (uuid)" })
@RequireModule("messages")
@Controller("api/:tenant/conversations/:id")
export class ConversationsController {
  constructor(
    private readonly tdb: TenantDb,
    private readonly chat: ChatGateway,
  ) {}

  @Post("messages")
  @ApiOperation({
    summary: "Post a message on a conversation",
    description:
      "Persists the message, bumps lastMessageAt, adjusts the unread count and broadcasts over WebSocket.",
  })
  async addMessage(@CurrentTenant() tenant: TenantDto, @Param("id") id: string, @Body() body: unknown) {
    const input = messageSchema.parse(body);
    const result = await this.chat.postMessage(tenant, id, input);
    if (!result) throw new NotFoundException("Conversation not found");
    return result.message;
  }

  @Post("read")
  @ApiOperation({ summary: "Clear a conversation's unread count" })
  async markRead(@CurrentTenant() tenant: TenantDto, @Param("id") id: string) {
    const row = await this.tdb.forTenant(tenant.id, async (tx) => {
      const [updated] = await tx
        .update(conversations)
        .set({ unread: 0, updatedAt: new Date() })
        .where(and(eq(conversations.id, id), eq(conversations.tenantId, tenant.id)))
        .returning();
      return updated;
    });
    if (!row) throw new NotFoundException("Conversation not found");
    this.chat.emitConversation(tenant.slug, id, row);
    return row;
  }
}
