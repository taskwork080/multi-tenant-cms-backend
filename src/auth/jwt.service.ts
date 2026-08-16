import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { AuthUser } from "./auth.types";
import { normalizeAppRole } from "./roles";

/**
 * Verifies Supabase Auth access tokens.
 * - Preferred: asymmetric keys via the project JWKS endpoint.
 * - Fallback: legacy HS256 shared secret (SUPABASE_JWT_SECRET).
 */
@Injectable()
export class JwtVerifier {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private readonly hsSecret?: Uint8Array;
  private readonly issuer: string;

  constructor(private readonly config: ConfigService) {
    const url = this.config.getOrThrow<string>("SUPABASE_URL");
    this.jwks = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
    // GoTrue stamps `iss` as <project>/auth/v1 and `aud` as "authenticated".
    this.issuer = `${url.replace(/\/+$/, "")}/auth/v1`;
    const secret = this.config.get<string>("SUPABASE_JWT_SECRET");
    if (secret) this.hsSecret = new TextEncoder().encode(secret);
  }

  async verify(token: string): Promise<AuthUser> {
    let payload: JWTPayload;
    try {
      // Pinning issuer and audience matters most on the HS256 path: without
      // them ANY token signed with the shared secret verifies, whoever minted
      // it and whatever it was minted for. On the JWKS path the key already
      // implies the project, but checking costs nothing and keeps the two
      // branches honest about accepting the same thing.
      const options = { issuer: this.issuer, audience: "authenticated" };
      if (this.hsSecret) {
        ({ payload } = await jwtVerify(token, this.hsSecret, options));
      } else {
        ({ payload } = await jwtVerify(token, this.jwks!, options));
      }
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }

    const appMeta = (payload as Record<string, any>).app_metadata ?? {};
    return {
      id: String(payload.sub ?? ""),
      email: (payload as Record<string, any>).email,
      // Normalised, not passed through: a token minted before the role collapse
      // still says "admin" or "viewer", and every guard downstream compares
      // against the three-role model. Unknown/absent degrades to "staff".
      role: normalizeAppRole(appMeta.role),
      tenantId: appMeta.tenant_id,
    };
  }
}
