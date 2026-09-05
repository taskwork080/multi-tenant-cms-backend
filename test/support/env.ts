import fs from "node:fs";
import path from "node:path";

/**
 * The QA suite talks to the ALREADY-RUNNING server on :4000 over HTTP rather
 * than booting an in-process Nest app. That is deliberate: ZodExceptionFilter,
 * PgExceptionFilter and `app.set("query parser","extended")` are registered in
 * main.ts, not in a module, so an in-process app would turn every 400 into a
 * 500 and silently break the range-filter tests. It also keeps the 30s
 * TenantService/AccessService caches in the process actually serving traffic,
 * which the staleness specs depend on.
 */

const ROOT = path.resolve(__dirname, "../..");

function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const file = readEnvFile(path.join(ROOT, ".env"));
const get = (k: string) => process.env[k] ?? file[k] ?? "";

/** Trailing slashes matter: `${url}/auth/v1/...` would otherwise double up. */
const stripSlash = (u: string) => u.replace(/\/+$/, "");

export const ENV = {
  root: ROOT,
  apiUrl: stripSlash(process.env.QA_API_URL || `http://localhost:${get("PORT") || 4000}`),
  supabaseUrl: stripSlash(get("SUPABASE_URL")),
  anonKey: get("SUPABASE_PUBLISHABLE_KEY"),
  serviceKey: get("SUPABASE_SERVICE_ROLE_KEY"),
  databaseUrl: get("DATABASE_URL"),
  artifacts: path.join(ROOT, "test", ".artifacts"),
};

export function artifactPath(name: string): string {
  fs.mkdirSync(ENV.artifacts, { recursive: true });
  return path.join(ENV.artifacts, name);
}

export function writeArtifact(name: string, data: unknown): string {
  const p = artifactPath(name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

export function readArtifact<T>(name: string): T | null {
  const p = artifactPath(name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}
