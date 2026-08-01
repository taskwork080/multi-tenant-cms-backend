import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Thin wrapper over Supabase's GoTrue admin API (/auth/v1/admin/*), the only
 * way to create auth identities, reset passwords and disable accounts.
 *
 * Deliberately `fetch` rather than @supabase/supabase-js: the repo has no such
 * dependency, scripts/create-user.ts already speaks GoTrue over HTTP, and a
 * browser-shaped SDK has no business in a server process holding a key that
 * bypasses every RLS policy in the database.
 *
 * SECURITY: SUPABASE_SERVICE_ROLE_KEY must never be logged, never returned in a
 * response, and never mirrored into a NEXT_PUBLIC_* variable. GoTrue error
 * bodies are mapped to Nest exceptions rather than forwarded, because some
 * shapes echo request headers back.
 */

/** GoTrue's idiom for an indefinite ban (100 years). */
export const BAN_FOREVER = "876000h";
export const BAN_NONE = "none";

export interface AdminAuthUser {
  id: string;
  email?: string;
  created_at?: string;
  last_sign_in_at?: string | null;
  email_confirmed_at?: string | null;
  banned_until?: string | null;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
  identities?: { provider: string }[];
}

export interface CreateAuthUserInput {
  email: string;
  password?: string;
  /** Skip the confirmation email — used when an invite link is sent instead. */
  emailConfirm?: boolean;
  appMetadata?: Record<string, unknown>;
}

export interface UpdateAuthUserInput {
  email?: string;
  password?: string;
  app_metadata?: Record<string, unknown>;
  /** BAN_FOREVER to disable, BAN_NONE to restore. */
  ban_duration?: string;
  email_confirm?: boolean;
}

export interface GenerateLinkInput {
  type: "invite" | "recovery" | "magiclink";
  email: string;
  redirectTo?: string;
  password?: string;
}

@Injectable()
export class SupabaseAdminService implements OnModuleInit {
  private readonly log = new Logger(SupabaseAdminService.name);
  private url = "";
  private key = "";

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.url = (this.config.get<string>("SUPABASE_URL") ?? "").replace(/\/+$/, "");
    this.key = this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    // Warn loudly but do not refuse to boot: this service is in a @Global
    // module, so throwing here would take down the whole API for deployments
    // that never touch /api/admin/*. Configuration is checked at first use
    // instead, where the failure names the exact missing variable.
    if (!this.key) {
      this.log.warn(
        "SUPABASE_SERVICE_ROLE_KEY is not set — /api/admin/* user management (create, reset password, suspend) will fail until it is.",
      );
    }
  }

  /** Fail with an operator-readable message rather than a confusing 401. */
  private assertConfigured() {
    if (!this.url || !this.key) {
      throw new ServiceUnavailableException(
        "User administration is not configured on this server: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.",
      );
    }
  }

  /** Whether direct password setting is permitted (PLATFORM_ALLOW_PASSWORD_SET). */
  get allowPasswordSet(): boolean {
    return this.config.get("PLATFORM_ALLOW_PASSWORD_SET") === "true";
  }

  async createUser(input: CreateAuthUserInput): Promise<AdminAuthUser> {
    return this.req<AdminAuthUser>("POST", "/auth/v1/admin/users", {
      email: input.email,
      password: input.password,
      email_confirm: input.emailConfirm ?? false,
      app_metadata: input.appMetadata ?? {},
    });
  }

  /** Null rather than throwing: a staff row may reference a deleted identity. */
  async getUserById(id: string): Promise<AdminAuthUser | null> {
    try {
      return await this.req<AdminAuthUser>("GET", `/auth/v1/admin/users/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof NotFoundException) return null;
      throw err;
    }
  }

  async findByEmail(email: string): Promise<AdminAuthUser | null> {
    const res = await this.req<{ users?: AdminAuthUser[] }>(
      "GET",
      `/auth/v1/admin/users?page=1&per_page=1&filter=${encodeURIComponent(email)}`,
    );
    const match = (res.users ?? []).find((u) => u.email?.toLowerCase() === email.toLowerCase());
    return match ?? null;
  }

  async updateUserById(id: string, patch: UpdateAuthUserInput): Promise<AdminAuthUser> {
    return this.req<AdminAuthUser>("PUT", `/auth/v1/admin/users/${encodeURIComponent(id)}`, patch);
  }

  async deleteUser(id: string): Promise<void> {
    await this.req("DELETE", `/auth/v1/admin/users/${encodeURIComponent(id)}`);
  }

  /**
   * Returns a single-use action link. NEVER persist, log, or include this in a
   * list response — it is a bearer credential for the target account.
   */
  async generateLink(input: GenerateLinkInput): Promise<{ actionLink: string }> {
    const res = await this.req<{ action_link?: string; properties?: { action_link?: string } }>(
      "POST",
      "/auth/v1/admin/generate_link",
      {
        type: input.type,
        email: input.email,
        password: input.password,
        ...(input.redirectTo ? { redirect_to: input.redirectTo } : {}),
      },
    );
    const link = res.action_link ?? res.properties?.action_link;
    if (!link) throw new ServiceUnavailableException("Supabase Auth returned no action link");
    return { actionLink: link };
  }

  // -------------------------------------------------------------------------

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.assertConfigured();
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, {
        method,
        headers: {
          apikey: this.key,
          Authorization: `Bearer ${this.key}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // Network-level failure: the key is in scope here, so log the message only.
      this.log.error(`GoTrue ${method} ${path} unreachable: ${(err as Error).message}`);
      throw new ServiceUnavailableException("Supabase Auth is unreachable");
    }

    const text = await res.text();
    const parsed: unknown = text ? safeJson(text) : null;

    if (!res.ok) throw this.mapError(res.status, parsed, method, path);
    return (parsed ?? {}) as T;
  }

  private mapError(status: number, body: unknown, method: string, path: string): Error {
    const b = (body ?? {}) as { msg?: string; message?: string; error_description?: string; error?: string };
    const raw = b.msg ?? b.message ?? b.error_description ?? b.error ?? "";
    // Log for operators; return a sanitised message to the caller.
    this.log.warn(`GoTrue ${method} ${path} -> ${status}: ${raw}`);

    if (/already (been )?registered|already exists/i.test(raw)) {
      return new ConflictException("An account with that email already exists");
    }
    if (status === 404) return new NotFoundException("Auth user not found");
    if (status === 400 || status === 422) {
      return new BadRequestException(raw || "Supabase Auth rejected the request");
    }
    if (status === 401 || status === 403) {
      // Almost always a bad/missing service-role key — an operator problem.
      return new ServiceUnavailableException("Supabase Auth rejected the service credentials");
    }
    return new ServiceUnavailableException("Supabase Auth request failed");
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}
