import { createParamDecorator, ExecutionContext, Injectable } from "@nestjs/common";
import type { Db } from "../db/db.tokens";
import { platformAuditLog } from "../db/schema";
import type { AuditAction, AuditTargetType } from "./audit.actions";

export interface AuditCtx {
  actorId: string;
  actorEmail: string;
  ip?: string;
  userAgent?: string;
}

export interface AuditEntry {
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  tenantId?: string | null;
  before?: unknown;
  after?: unknown;
}

/**
 * Writes the super-admin audit trail.
 *
 * Deliberately an explicit call inside the caller's transaction rather than an
 * interceptor: an interceptor runs after the mutation, so it cannot capture a
 * `before` snapshot and cannot be atomic with the write. An audit row that
 * survives a rolled-back mutation (or a mutation that commits without one) is
 * worse than no audit row at all.
 */
@Injectable()
export class AuditService {
  /** Must be passed the *same* tx as the mutation it records. */
  async record(tx: Db, ctx: AuditCtx, entry: AuditEntry): Promise<void> {
    await tx.insert(platformAuditLog).values({
      actorId: isUuid(ctx.actorId) ? ctx.actorId : null,
      actorEmail: ctx.actorEmail,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      tenantId: entry.tenantId ?? null,
      before: (entry.before ?? null) as never,
      after: (entry.after ?? null) as never,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** AUTH_DEV_BYPASS injects the literal id "dev", which is not a uuid. */
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

/**
 * Builds the request context for an audited handler: who, from where.
 *
 * `ip` and `user-agent` are attacker-controlled strings landing in a log table,
 * so only the first x-forwarded-for hop is trusted (the rest is whatever the
 * client sent) and the agent is truncated.
 */
export const Audit = createParamDecorator((_: unknown, c: ExecutionContext): AuditCtx => {
  const req = c.switchToHttp().getRequest();
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return {
    actorId: req.user?.id ?? "",
    actorEmail: req.user?.email ?? "",
    ip: (first || req.ip) ?? undefined,
    userAgent: String(req.headers["user-agent"] ?? "").slice(0, 512) || undefined,
  };
});
