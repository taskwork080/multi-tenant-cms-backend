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
/**
 * CORS mirrors the HTTP allowlist. It used to be `origin: true`, i.e. any
 * origin — so a page on any domain could open a socket with a stolen token
 * while the REST API on the same server refused the same origin outright.
 */
const WS_ORIGINS = (process.env.CORS_ORIGIN ?? "http://localhost:5000").split(",").map((o) => o.trim());

@WebSocketGateway({ cors: { origin: WS_ORIGINS, credentials: true } })
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
      // Same double gate as AuthGuard: the flag alone is not enough, because
      // this branch hands out platform_admin to an anonymous socket.
      if (!token && process.env.NODE_ENV !== "production" && this.config.get("AUTH_DEV_BYPASS") === "true") {
        user = { id: "dev", role: PLATFORM_ADMIN };
      } else if (token) {
        user = await this.jwt.verify(token);
      } else {
        throw new Error("missing token");
      }
      if (!slug) throw new Error("missing tenant");
      const tenant = await this.tenants.bySlug(slug);
      if (user.role !== PLATFORM_ADMIN) {
        if (user.tenantId !== tenant.id) throw new Error("wrong tenant");
        // TenantGuard closes a suspended workspace to its own members on the
        // HTTP side; a long-lived socket must not be the way back in.
        if (tenant.status !== "active") throw new Error(`workspace ${tenant.status}`);
      }

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
    const { conversationId, ...messageInput } = sendSchema.parse(body);
    const result = await this.postMessage(tenant, conversationId, messageInput);
    if (!result) return { error: "conversation not found" };
    return { ok: true, message: result.message };
  }

  /**
   * Persists one message on a conversation and broadcasts it. Shared by the
   * `chat:send` socket event above and `POST /conversations/:id/messages`, so
   * the two paths can't drift on unread semantics or room names. Returns null
   * if the conversation doesn't belong to this tenant.
   */
  async postMessage(
    tenant: { id: string; slug: string },
    conversationId: string,
    input: Omit<z.infer<typeof sendSchema>, "conversationId">,
  ) {
    const result = await this.tdb.forTenant(tenant.id, async (tx) => {
      const [row] = await tx
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenant.id)))
        .limit(1);
      if (!row) return null;
      const [message] = await tx
        .insert(chatMessages)
        .values({ tenantId: tenant.id, conversationId, ...input })
        .returning();
      const [updated] = await tx
        .update(conversations)
        .set({
          lastMessageAt: new Date(),
          // A customer's message adds to the badge; ours means we're reading it.
          unread: input.sender === "customer" ? sql`${conversations.unread} + 1` : 0,
          updatedAt: new Date(),
        } as never)
        .where(eq(conversations.id, conversationId))
        .returning();
      return { message, updated };
    });
    if (!result) return null;

    this.emitConversation(tenant.slug, conversationId, result.updated);
    this.server?.to(`conv:${tenant.slug}:${conversationId}`).emit("chat:message", {
      conversationId,
      message: result.message,
    });
    return result;
  }

  /** List views (unread badges, ordering) listen at tenant level. */
  emitConversation(
    tenantSlug: string,
    conversationId: string,
    row: { lastMessageAt: Date; unread: number },
  ) {
    this.server?.to(`tenant:${tenantSlug}`).emit("chat:conversation", {
      conversationId,
      lastMessageAt: row.lastMessageAt,
      unread: row.unread,
    });
  }

  /** Called from REST controllers to push shipment timeline/chat updates. */
  emitShipmentUpdate(tenantSlug: string, shipmentId: string, payload: Record<string, unknown>) {
    this.server?.to(`ship:${tenantSlug}:${shipmentId}`).emit("shipment:update", { shipmentId, ...payload });
    this.server?.to(`tenant:${tenantSlug}`).emit("shipment:update", { shipmentId, ...payload });
  }
}
