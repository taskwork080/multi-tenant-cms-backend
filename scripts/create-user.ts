/**
 * Creates a user for this CMS from the command line.
 *
 *   npm run user:create -- <email> <password> <tenant-slug|platform_admin> [role]
 *
 * Examples:
 *   npm run user:create -- owner@volt.test Passw0rd! volt owner
 *   npm run user:create -- root@cms.test Passw0rd! platform_admin
 *
 * Two modes:
 *
 *  - Tenant user: goes through PlatformUsersService, the same code path as
 *    POST /api/admin/users, so it creates the Supabase identity AND the
 *    staff_users row with auth_user_id populated. (The previous version of
 *    this script only did the former, which is where "ghost" CMS accounts
 *    that can never sign in came from.)
 *
 *  - Bootstrap platform admin: there is no admin yet to authorise the call,
 *    and a platform admin has no tenant, so no staff_users row applies. This
 *    path talks to Supabase Admin + auth.users directly.
 */
import "dotenv/config";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import postgres from "postgres";
import { AppModule } from "../src/app.module";
import { SupabaseAdminService } from "../src/auth/supabase-admin.service";
import { TenantDb } from "../src/db/tenant-db.service";
import { tenants } from "../src/db/schema";
import { PlatformUsersService } from "../src/platform/platform-users.service";
import type { AuditCtx } from "../src/platform/audit.service";
import { eq } from "drizzle-orm";

const CLI_CTX: AuditCtx = { actorId: "", actorEmail: "cli:user:create", userAgent: "npm run user:create" };

async function main() {
  const [email, password, target, roleArg] = process.argv.slice(2);
  if (!email || !password || !target) {
    console.error("Usage: npm run user:create -- <email> <password> <tenant-slug|platform_admin> [role]");
    process.exit(1);
  }

  Logger.overrideLogger(["error", "warn"]);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });

  try {
    if (target === "platform_admin") {
      await bootstrapPlatformAdmin(app.get(SupabaseAdminService), email, password);
      return;
    }

    const tdb = app.get(TenantDb);
    const [tenant] = await tdb.raw.select().from(tenants).where(eq(tenants.slug, target)).limit(1);
    if (!tenant) {
      console.error(`Tenant with slug "${target}" not found.`);
      process.exit(1);
    }

    const users = app.get(PlatformUsersService);
    const { user } = await users.create(
      {
        tenantId: tenant.id,
        name: email.split("@")[0],
        email,
        appRole: roleArg ?? "owner",
        sendInvite: false,
        password,
      },
      CLI_CTX,
    );

    console.log(`✔ ${email} ready (staff ${user.id}, auth ${user.authUserId})`);
    console.log(`  workspace: ${tenant.name} (${tenant.slug}) · app role: ${roleArg ?? "owner"}`);
  } finally {
    await app.close();
  }
}

/**
 * First-boot only: no platform admin exists to authorise this, so it bypasses
 * the normal service. A platform admin belongs to no tenant, so there is no
 * staff_users row to create.
 */
async function bootstrapPlatformAdmin(supabase: SupabaseAdminService, email: string, password: string) {
  const appMetadata = { role: "platform_admin" };
  let id: string;
  try {
    const created = await supabase.createUser({ email, password, emailConfirm: true, appMetadata });
    id = created.id;
  } catch {
    const existing = await supabase.findByEmail(email);
    if (!existing) {
      console.error(`Could not create or find an auth user for ${email}.`);
      process.exit(1);
    }
    await supabase.updateUserById(existing.id, { password, app_metadata: appMetadata, email_confirm: true });
    id = existing.id;
    console.log(`User ${email} already existed — promoted to platform_admin.`);
  }

  // GoTrue's admin API confirms the email for us above; this is a belt-and-
  // braces fixup for accounts created through the public signup endpoint.
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) {
    const sql = postgres(dbUrl, { prepare: false, max: 1 });
    try {
      await sql`update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = ${id}::uuid`;
    } finally {
      await sql.end();
    }
  }

  console.log(`✔ ${email} ready (auth ${id})`);
  console.log(`  app_metadata: ${JSON.stringify(appMetadata)}`);
}

void main();
