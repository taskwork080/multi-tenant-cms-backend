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
const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),

    // --- Required -----------------------------------------------------------
    DATABASE_URL: z.string().url("DATABASE_URL must be a postgres connection URL"),
    SUPABASE_URL: z.string().url(),

    // --- Auth ---------------------------------------------------------------
    SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
    /** Legacy HS256 verification. When unset, tokens are verified via JWKS. */
    SUPABASE_JWT_SECRET: z.string().optional(),
    /** Required by /api/admin/* — warned about at boot by SupabaseAdminService. */
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

    // --- Platform -----------------------------------------------------------
    FRONTEND_URL: z.string().url().default("http://localhost:5000"),
    CORS_ORIGIN: z.string().default("http://localhost:5000"),
    PLATFORM_ALLOW_PASSWORD_SET: z.enum(["true", "false"]).default("false"),
    PLATFORM_IMPERSONATION_ALLOW_WRITES: z.enum(["true", "false"]).default("false"),

    // --- R2 (optional as a group) -------------------------------------------
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: z.string().default("cms-assets"),
    R2_PUBLIC_URL: z.string().url().optional().or(z.literal("")),

    // --- Storefront ---------------------------------------------------------
    STOREFRONT_ROOT_DOMAIN: z.string().optional(),

    // --- Docs / dev ---------------------------------------------------------
    /** Swagger at /docs. Off by default in production — it is unauthenticated. */
    ENABLE_DOCS: z.enum(["true", "false"]).optional(),
    AUTH_DEV_BYPASS: z.enum(["true", "false"]).default("false"),
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
