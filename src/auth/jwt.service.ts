import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { AuthUser } from "./auth.types";

/**
 * Verifies Supabase Auth access tokens.
 * - Preferred: asymmetric keys via the project JWKS endpoint.
 * - Fallback: legacy HS256 shared secret (SUPABASE_JWT_SECRET).
 */
@Injectable()
export class JwtVerifier {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private readonly hsSecret?: Uint8Array;

  constructor(private readonly config: ConfigService) {
    const url = this.config.getOrThrow<string>("SUPABASE_URL");
    this.jwks = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
    const secret = this.config.get<string>("SUPABASE_JWT_SECRET");
    if (secret) this.hsSecret = new TextEncoder().encode(secret);
  }

  async verify(token: string): Promise<AuthUser> {
    let payload: JWTPayload;
    try {
      if (this.hsSecret) {
        ({ payload } = await jwtVerify(token, this.hsSecret));
      } else {
        ({ payload } = await jwtVerify(token, this.jwks!));
      }
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }

    const appMeta = (payload as Record<string, any>).app_metadata ?? {};
    return {
      id: String(payload.sub ?? ""),
      email: (payload as Record<string, any>).email,
      role: appMeta.role ?? "viewer",
      tenantId: appMeta.tenant_id,
    };
  }
}
