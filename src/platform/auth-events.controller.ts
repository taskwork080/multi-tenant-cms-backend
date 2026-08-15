import { Body, Controller, Injectable, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { and, desc, eq, gt } from "drizzle-orm";
import type { AuthUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/decorators";
import { TenantDb } from "../db/tenant-db.service";
import { authEvents, staffUsers } from "../db/schema";
import { authEventSchema } from "./dto";
import { Throttle } from "@nestjs/throttler";

/** Ignore repeat sign-ins inside this window (token refreshes, tab reopens). */
const DEDUPE_MS = 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AuthEventsService {
  constructor(private readonly tdb: TenantDb) {}

  async record(user: AuthUser, event: string, ip?: string, userAgent?: string) {
    // auth_user_id is a uuid column, so a non-uuid subject (notably the
    // AUTH_DEV_BYPASS identity "dev") can never be stored. Skip rather than
    // throw: this runs on every sign-in and must not be able to break login.
    if (!UUID_RE.test(user.id)) return { recorded: false };

    return this.tdb.asPlatform(async (tx) => {
      const [staff] = await tx.select().from(staffUsers).where(eq(staffUsers.authUserId, user.id)).limit(1);

      if (event === "sign_in") {
        const [recent] = await tx
          .select({ id: authEvents.id })
          .from(authEvents)
          .where(
            and(
              eq(authEvents.authUserId, user.id),
              eq(authEvents.event, "sign_in"),
              gt(authEvents.createdAt, new Date(Date.now() - DEDUPE_MS)),
            ),
          )
          .orderBy(desc(authEvents.createdAt))
          .limit(1);
        if (recent) return { recorded: false };
      }

      await tx.insert(authEvents).values({
        authUserId: user.id,
        staffUserId: staff?.id ?? null,
        tenantId: staff?.tenantId ?? user.tenantId ?? null,
        email: user.email ?? staff?.email ?? "",
        event,
        ip: ip ?? null,
        userAgent: userAgent?.slice(0, 512) ?? null,
      });

      // This is what finally makes staff_users.last_active real — nothing
      // populated it before.
      if (staff && event === "sign_in") {
        await tx
          .update(staffUsers)
          .set({
            lastActive: new Date(),
            // Signing in IS accepting the invitation — you cannot get a token
            // without following the invite link and setting a password. Nothing
            // used to make this transition, so every invited user stayed
            // `invited` forever: the staff list showed a pending badge for
            // people who had been working in the app for months, and
            // "resend invite" was offered to users who never needed one.
            // Only ever promotes `invited`; suspended and deactivated are
            // administrative states that a sign-in must not clear.
            ...(staff.status === "invited" ? { status: "active" as const } : {}),
          })
          .where(eq(staffUsers.id, staff.id));
      }
      return { recorded: true };
    });
  }
}

/**
 * Login history. Deliberately NOT under /api/admin: any authenticated user
 * records their own sign-in here.
 *
 * SECURITY: the body carries only an event name. The row is always written for
 * `req.user`, so a caller cannot forge history for somebody else.
 */
@ApiTags("auth")
@ApiBearerAuth()
// Any authenticated user writes their own row here; it is an append-only log,
// so it is the easiest table in the schema to flood.
@Throttle({ default: { ttl: 60_000, limit: 30 } })
@Controller("api/auth/events")
export class AuthEventsController {
  constructor(private readonly svc: AuthEventsService) {}

  @Post()
  @ApiOperation({ summary: "Record a sign-in/sign-out for the calling user" })
  record(@Body() body: unknown, @CurrentUser() user: AuthUser, @Req() req: Request) {
    const { event } = authEventSchema.parse(body);
    const fwd = req.headers["x-forwarded-for"];
    const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim() || req.ip;
    return this.svc.record(user, event, ip, req.headers["user-agent"]);
  }
}
