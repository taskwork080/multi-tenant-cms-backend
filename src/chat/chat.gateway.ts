import { Logger } from "@nestjs/common";
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import { and, eq, sql } from "drizzle-orm";
import { Server, Socket } from "socket.io";
import { z } from "zod";
import { JwtVerifier } from "../auth/jwt.service";
import { PLATFORM_ADMIN, type AuthUser } from "../auth/auth.types";
import { chatMessages, conversations } from "../db/schema";
import { TenantDb } from "../db/tenant-db.service";
import { TenantService } from "../tenant/tenant.service";
import { ConfigService } from "@nestjs/config";

const sendSchema = z.object({
  conversationId: z.string().uuid(),
  sender: z.enum(["customer", "support"]).default("support"),
  author: z.string().min(1),
  text: z.string().default(""),
  attachment: z.string().optional(),
  attachmentUrl: z.string().optional(),
  attachmentType: z.enum(["image", "file"]).optional(),
});

/**
 * Realtime messenger (Phase 1: self-hosted WebSocket, matching the plan to
 * use websockets for chat; Supabase Realtime / Ably can replace fan-out later).
 *
 * Client contract:
 *   connect:  io(URL, { auth: { token, tenant: "<slug>" } })
 *   emit "chat:join"  { conversationId }         → joins that room
 *   emit "chat:send"  { conversationId, author, text, ... } → persists + broadcasts
 *   on   "chat:message" { conversationId, message }
 *   on   "shipment:update" { shipmentId, ... }   (rooms joined via "shipment:join")
 */
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class ChatGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly jwt: JwtVerifier,
    private readonly tenants: TenantService,
    private readonly tdb: TenantDb,
    private readonly config: ConfigService,
  ) {}

  async handleConnection(socket: Socket) {
    try {
      const { token, tenant: slug } = socket.handshake.auth as { token?: string; tenant?: string };
      let user: AuthUser;
      if (!token && this.config.get("AUTH_DEV_BYPASS") === "true") {
        user = { id: "dev", role: PLATFORM_ADMIN };
      } else if (token) {
        user = await this.jwt.verify(token);
      } else {
        throw new Error("missing token");
      }
      if (!slug) throw new Error("missing tenant");
      const tenant = await this.tenants.bySlug(slug);
      if (user.role !== PLATFORM_ADMIN && user.tenantId !== tenant.id) throw new Error("wrong tenant");

      socket.data.user = user;
      socket.data.tenant = tenant;
      socket.join(`tenant:${tenant.slug}`);
    } catch (err) {
      this.logger.warn(`WS rejected: ${(err as Error).message}`);
      socket.disconnect(true);
    }
  }

  @SubscribeMessage("chat:join")
  onJoin(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId: string }) {
    socket.join(`conv:${socket.data.tenant.slug}:${body.conversationId}`);
    return { joined: body.conversationId };
  }

  @SubscribeMessage("shipment:join")
  onJoinShipment(@ConnectedSocket() socket: Socket, @MessageBody() body: { shipmentId: string }) {
    socket.join(`ship:${socket.data.tenant.slug}:${body.shipmentId}`);
    return { joined: body.shipmentId };
  }

  @SubscribeMessage("chat:send")
  async onSend(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const tenant = socket.data.tenant;
    const input = sendSchema.parse(body);
    const { conversationId, ...messageInput } = input;

    const result = await this.tdb.forTenant(tenant.id, async (tx) => {
      const [row] = await tx
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenant.id)))
        .limit(1);
      if (!row) return null;
      const [message] = await tx
        .insert(chatMessages)
        .values({ tenantId: tenant.id, conversationId, ...messageInput })
        .returning();
      const [updated] = await tx
        .update(conversations)
        .set({
          lastMessageAt: new Date(),
          unread: input.sender === "customer" ? sql`${conversations.unread} + 1` : 0,
          updatedAt: new Date(),
        } as never)
        .where(eq(conversations.id, conversationId))
        .returning();
      return { message, updated };
    });
    if (!result) return { error: "conversation not found" };
    const { message, updated } = result;

    this.server
      .to(`conv:${tenant.slug}:${input.conversationId}`)
      .emit("chat:message", { conversationId: input.conversationId, message });
    // list views (unread badges, ordering) listen at tenant level
    this.server.to(`tenant:${tenant.slug}`).emit("chat:conversation", {
      conversationId: input.conversationId,
      lastMessageAt: updated.lastMessageAt,
      unread: updated.unread,
    });
    return { ok: true, message };
  }

  /** Called from REST controllers to push shipment timeline/chat updates. */
  emitShipmentUpdate(tenantSlug: string, shipmentId: string, payload: Record<string, unknown>) {
    this.server?.to(`ship:${tenantSlug}:${shipmentId}`).emit("shipment:update", { shipmentId, ...payload });
    this.server?.to(`tenant:${tenantSlug}`).emit("shipment:update", { shipmentId, ...payload });
  }
}
