import { z } from "zod";

/**
 * Boot-time environment contract.
 *
 * Every variable except DATABASE_URL and SUPABASE_URL used to be read with a
 * silent default — a typo'd CORS_ORIGIN or a missing R2 key produced a server
 * that started happily and failed at the first request that needed it, in a
 * different process, hours later. Failing at boot is the correct response to
 * "this deployment is not configured".
 *
 * Optional stays optional: R2 and the storefront root domain genuinely are
 * features you can run without (R2Service already throws a clear 503 when
 * asked to sign without credentials). What this adds is that anything
 * *provided* must be well formed, and anything *required* must be present.
 */
/**
 * A key present in an env file with nothing after the `=` is the empty STRING,
 * not an absent key — so `.optional()` never fires, `.default()` never applies,
 * and any constraint on the value rejects it. `ENABLE_DOCS=` in .env.example is
 * documentation of what *can* be set, and Render's dashboard produces empty
 * strings the same way. Blank means "not configured" for every variable here,
 * so normalise it once rather than remembering per-variable.
 *
 * This is the general form of the `.optional().or(z.literal(""))` idiom used
 * below; prefer this one for anything new, because it also covers enums,
 * coerced numbers and `.default()`.
 */
const blankIsUnset = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema);

const envSchema = z
  .object({
    NODE_ENV: blankIsUnset(z.enum(["development", "test", "production"]).default("development")),
    PORT: blankIsUnset(z.coerce.number().int().min(1).max(65535).default(4000)),

    // --- Required -----------------------------------------------------------
    DATABASE_URL: z.string().url("DATABASE_URL must be a postgres connection URL"),
    SUPABASE_URL: z.string().url(),

    /**
     * Migrations only — scripts/migrate.ts, never the running API.
     *
     * In production DATABASE_URL points at the NOBYPASSRLS `app_api` role, which
     * has no DDL, so migrations need the owner's credentials separately. Declared
     * here so the variable is discoverable beside the one it stands in for;
     * nothing in src/ may read it. Unset locally, where DATABASE_URL is the owner.
     */
    MIGRATE_DATABASE_URL: blankIsUnset(z.string().url().optional()),

    // --- Auth ---------------------------------------------------------------
    SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
    /** Legacy HS256 verification. When unset, tokens are verified via JWKS. */
    SUPABASE_JWT_SECRET: z.string().optional(),
    /** Required by /api/admin/* — warned about at boot by SupabaseAdminService. */
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

    // --- Platform -----------------------------------------------------------
    FRONTEND_URL: blankIsUnset(z.string().url().default("http://localhost:5000")),
    CORS_ORIGIN: blankIsUnset(z.string().default("http://localhost:5000")),
    PLATFORM_ALLOW_PASSWORD_SET: blankIsUnset(z.enum(["true", "false"]).default("false")),
    PLATFORM_IMPERSONATION_ALLOW_WRITES: blankIsUnset(z.enum(["true", "false"]).default("false")),

    // --- R2 (optional as a group) -------------------------------------------
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: blankIsUnset(z.string().default("cms-assets")),
    R2_PUBLIC_URL: blankIsUnset(z.string().url().optional()),

    // --- Storefront ---------------------------------------------------------
    STOREFRONT_ROOT_DOMAIN: z.string().optional(),

    // --- Docs / dev ---------------------------------------------------------
    /** Swagger at /docs. Off by default in production — it is unauthenticated. */
    ENABLE_DOCS: blankIsUnset(z.enum(["true", "false"]).optional()),
    AUTH_DEV_BYPASS: blankIsUnset(z.enum(["true", "false"]).default("false")),
  })
  // R2 is all-or-nothing: two of the three keys is a misconfiguration that only
  // shows up the first time someone uploads.
  .refine(
    (v) => {
      const keys = [v.R2_ACCOUNT_ID, v.R2_ACCESS_KEY_ID, v.R2_SECRET_ACCESS_KEY].filter(Boolean).length;
      return keys === 0 || keys === 3;
    },
    { message: "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY must be set together (or all omitted)" },
  )
  // main.ts refuses to boot on this too; catching it here names the variable.
  .refine((v) => !(v.NODE_ENV === "production" && v.AUTH_DEV_BYPASS === "true"), {
    message: "AUTH_DEV_BYPASS must not be enabled in production — it grants platform_admin to anonymous callers",
  });

export type Env = z.infer<typeof envSchema>;

/** ConfigModule.forRoot({ validate }) hook. Throws with every problem listed. */
export function validateEnv(raw: Record<string, unknown>): Record<string, unknown> {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(env)"}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  // Merge rather than replace: the process has plenty of other env vars (PATH,
  // TZ, the ts-node flags) that nothing here should strip.
  return { ...raw, ...parsed.data };
}

/** Docs are on outside production unless explicitly turned off. */
export function docsEnabled(env: { NODE_ENV: string; ENABLE_DOCS?: string }): boolean {
  if (env.ENABLE_DOCS) return env.ENABLE_DOCS === "true";
  return env.NODE_ENV !== "production";
}
