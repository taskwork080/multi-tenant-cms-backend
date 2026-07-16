/**
 * Creates (or fixes up) a Supabase Auth user for this CMS.
 *
 *   npm run user:create -- <email> <password> <tenant-slug|platform_admin> [role]
 *
 * Examples:
 *   npm run user:create -- owner@volt.test Passw0rd! volt owner
 *   npm run user:create -- root@cms.test Passw0rd! platform_admin
 *
 * Signs the user up through the public auth API, then (via the direct DB
 * connection) confirms the email and stamps app_metadata.role/tenant_id —
 * the claims the backend's AuthGuard + TenantGuard read from the JWT.
 */
import "dotenv/config";
import postgres from "postgres";

async function main() {
  const [email, password, target, roleArg] = process.argv.slice(2);
  if (!email || !password || !target) {
    console.error("Usage: npm run user:create -- <email> <password> <tenant-slug|platform_admin> [role]");
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const dbUrl = process.env.DATABASE_URL;
  if (!supabaseUrl || !anonKey || !dbUrl) {
    console.error("SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and DATABASE_URL must be set in .env");
    process.exit(1);
  }

  const sql = postgres(dbUrl, { prepare: false, max: 1 });
  try {
    // 1. Resolve the tenant (unless creating a platform admin).
    let appMeta: Record<string, string>;
    if (target === "platform_admin") {
      appMeta = { role: "platform_admin" };
    } else {
      const rows = await sql`select id from tenants where slug = ${target} limit 1`;
      if (rows.length === 0) {
        console.error(`Tenant with slug "${target}" not found.`);
        process.exit(1);
      }
      appMeta = { role: roleArg ?? "owner", tenant_id: rows[0].id as string };
    }

    // 2. Sign the user up (no-op with a clear message if they already exist).
    const res = await fetch(`${supabaseUrl}/auth/v1/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anonKey },
      body: JSON.stringify({ email, password }),
    });
    const body = (await res.json()) as { id?: string; msg?: string; message?: string; error_description?: string };
    if (!res.ok) {
      const msg = body.msg ?? body.message ?? body.error_description ?? `HTTP ${res.status}`;
      if (/already|exists/i.test(String(msg))) {
        console.log(`User ${email} already exists — updating metadata only.`);
      } else {
        console.error(`Signup failed: ${msg}`);
        process.exit(1);
      }
    }

    // 3. Confirm the email + stamp app_metadata (JWT claims) directly in auth.users.
    const updated = await sql`
      update auth.users
      set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || ${sql.json(appMeta)},
          email_confirmed_at = coalesce(email_confirmed_at, now())
      where email = ${email}
      returning id
    `;
    if (updated.length === 0) {
      console.error(`No auth.users row found for ${email} — signup may not have completed.`);
      process.exit(1);
    }

    console.log(`✔ ${email} ready (user ${updated[0].id})`);
    console.log(`  app_metadata: ${JSON.stringify(appMeta)}`);
  } finally {
    await sql.end();
  }
}

void main();
