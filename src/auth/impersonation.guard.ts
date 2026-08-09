import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import { AuthUser, PLATFORM_ADMIN } from "./auth.types";

export const IMPERSONATE_HEADER = "x-impersonate";
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Blocks writes while a super admin is viewing a workspace as its tenant.
 *
 * WHAT THIS IS: a guardrail against accidental writes during a support session,
 * plus an honest audit trail of who entered which workspace and when.
 *
 * WHAT THIS IS NOT: a sandbox. The header is sent by the client, so an admin
 * who simply omits it reaches every tenant route with full write access —
 * TenantGuard authorises cross-tenant access from the JWT role alone, before
 * impersonation is even a concept. That is the correct threat model here: a
 * platform admin can grant themselves anything through /api/admin/* regardless,
 * so this constrains mistakes, not intent.
 *
 * Real enforcement would mean an impersonation_sessions table and requiring an
 * active session in TenantGuard rather than merely the role. That removes
 * today's implicit access and needs its own rollout.
 *
 * /api/admin/* is exempt: the admin surface is where a session is ended, and
 * the client attaches the header globally.
 */
@Injectable()
export class ImpersonationGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser; impersonating?: boolean }>();
    const header = req.headers[IMPERSONATE_HEADER];
    if (!header || req.user?.role !== PLATFORM_ADMIN) return true;

    req.impersonating = true;
    if (READ_METHODS.has(req.method)) return true;
    if (req.path.startsWith("/api/admin/")) return true;
    if (this.config.get<string>("PLATFORM_IMPERSONATION_ALLOW_WRITES") === "true") return true;

    throw new ForbiddenException({
      message: "You are viewing this workspace as a platform admin. Exit the session to make changes.",
      code: "IMPERSONATION_READ_ONLY",
    });
  }
}
