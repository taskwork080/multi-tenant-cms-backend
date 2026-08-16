import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { IS_PUBLIC } from "./decorators";
import { JwtVerifier } from "./jwt.service";
import { PLATFORM_ADMIN } from "./auth.types";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtVerifier,
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }

    const req = context.switchToHttp().getRequest<Request & { user?: unknown }>();
    const header = req.headers.authorization;

    if (!header?.startsWith("Bearer ")) {
      // Local development convenience: run without Supabase Auth wired up.
      // This hands out a platform_admin identity to any unauthenticated caller,
      // which since /api/admin/* exists is a full platform takeover — so it is
      // hard-gated on NODE_ENV as well as the flag, and main.ts refuses to boot
      // if both are set in production.
      if (process.env.NODE_ENV !== "production" && this.config.get("AUTH_DEV_BYPASS") === "true") {
        req.user = { id: "dev", email: "dev@local", role: PLATFORM_ADMIN, mustChangePassword: false };
        return true;
      }
      throw new UnauthorizedException("Missing Bearer token");
    }

    req.user = await this.jwt.verify(header.slice("Bearer ".length));
    return true;
  }
}
