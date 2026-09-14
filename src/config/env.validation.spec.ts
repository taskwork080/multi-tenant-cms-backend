import { describe, expect, it } from "vitest";
import { validateEnv } from "./env.validation";

/**
 * The blank-value cases exist because a deploy actually failed on them: an
 * env file (and Render's dashboard) writes `ENABLE_DOCS=` as the empty STRING,
 * which is not an absent key — `.optional()` never fires and the enum rejects
 * it. Every variable that carries a default or an enum has to treat blank as
 * "not configured", or a commented-out-looking line takes the API down at boot.
 */
const base = {
  DATABASE_URL: "postgresql://user:pw@host:5432/postgres",
  SUPABASE_URL: "https://project.supabase.co",
};

describe("validateEnv", () => {
  it("treats a blank value as unset, for enums, numbers and defaults alike", () => {
    const env = validateEnv({
      ...base,
      ENABLE_DOCS: "",
      AUTH_DEV_BYPASS: "",
      PORT: "",
      R2_BUCKET: "",
      R2_PUBLIC_URL: "",
      MIGRATE_DATABASE_URL: "",
      FRONTEND_URL: "",
    });

    expect(env.ENABLE_DOCS).toBeUndefined();
    expect(env.AUTH_DEV_BYPASS).toBe("false");
    expect(env.PORT).toBe(4000);
    expect(env.R2_BUCKET).toBe("cms-assets");
    expect(env.R2_PUBLIC_URL).toBeUndefined();
    expect(env.MIGRATE_DATABASE_URL).toBeUndefined();
    expect(env.FRONTEND_URL).toBe("http://localhost:5000");
  });

  it("still rejects a value that is present and wrong", () => {
    expect(() => validateEnv({ ...base, ENABLE_DOCS: "maybe" })).toThrow(/ENABLE_DOCS/);
    expect(() => validateEnv({ ...base, PORT: "0" })).toThrow(/PORT/);
    expect(() => validateEnv({ ...base, R2_PUBLIC_URL: "not-a-url" })).toThrow(/R2_PUBLIC_URL/);
  });

  it("requires the two variables nothing can run without", () => {
    expect(() => validateEnv({ SUPABASE_URL: base.SUPABASE_URL })).toThrow(/DATABASE_URL/);
    expect(() => validateEnv({ DATABASE_URL: base.DATABASE_URL })).toThrow(/SUPABASE_URL/);
  });

  it("keeps R2 all-or-nothing, counting blanks as omitted", () => {
    expect(() => validateEnv({ ...base, R2_ACCOUNT_ID: "acc", R2_ACCESS_KEY_ID: "key" })).toThrow(/together/);
    expect(() =>
      validateEnv({ ...base, R2_ACCOUNT_ID: "acc", R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret" }),
    ).not.toThrow();
    expect(() => validateEnv({ ...base, R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "" })).not.toThrow();
  });

  it("refuses the dev auth bypass in production", () => {
    expect(() => validateEnv({ ...base, NODE_ENV: "production", AUTH_DEV_BYPASS: "true" })).toThrow(/AUTH_DEV_BYPASS/);
    expect(() => validateEnv({ ...base, NODE_ENV: "production", AUTH_DEV_BYPASS: "" })).not.toThrow();
  });

  it("passes through variables it does not know about", () => {
    // ConfigModule receives the whole process environment; stripping PATH or the
    // ts-node flags would break the process it is validating.
    expect(validateEnv({ ...base, PATH: "/usr/bin" }).PATH).toBe("/usr/bin");
  });
});
