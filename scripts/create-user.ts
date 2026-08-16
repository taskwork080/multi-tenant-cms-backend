/**
 * Creates a user for this CMS from the command line.
 *
 *   npm run user:create -- <email> <password> <tenant-slug|platform_admin> [role]
 *
 * Examples:
 *   npm run user:create -- owner@volt.test Passw0rd! volt owner
 *   npm run user:create -- root@cms.test Passw0rd! platform_admin
 *
 * Tenant roles are `owner` and `staff`. Defaults to `owner`, because appointing
 * the workspace owner is what this script is for from the platform side —
 * staff are invited by their owner through the app.
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
import { APP_ROLES } from "../src/auth/roles";
import { SupabaseAdminService } from "../src/auth/supabase-admin.service";
import { TenantDb } from "../src/db/tenant-db.service";
import { tenants } from "../src/db/schema";
import { PlatformUsersService } from "../src/platform/platform-users.service";
import type { AuditCtx } from "../src/platform/audit.service";
import { ensurePlatformAdmin } from "./lib/platform-admin";
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

    const appRole = roleArg ?? "owner";
    if (!(APP_ROLES as readonly string[]).includes(appRole)) {
      console.error(`Unknown role "${appRole}". Tenant roles are: ${APP_ROLES.join(", ")}.`);
      console.error(`To create the platform administrator, pass "platform_admin" as the target instead.`);
      process.exit(1);
    }

    const users = app.get(PlatformUsersService);
    const { user } = await users.create(
      {
        tenantId: tenant.id,
        name: email.split("@")[0],
        email,
        appRole,
        sendInvite: false,
        password,
      },
      CLI_CTX,
    );

    console.log(`✔ ${email} ready (staff ${user.id}, auth ${user.authUserId})`);
    console.log(`  workspace: ${tenant.name} (${tenant.slug}) · app role: ${appRole}`);
  } finally {
    await app.close();
  }
}

/**
 * First-boot only: no platform admin exists to authorise this, so it bypasses
 * the normal service. A platform admin belongs to no tenant, so there is no
 * staff_users row to create.
 *
 * The singleton rule and the create-or-repair protocol live in
 * scripts/lib/platform-admin.ts, shared with the seeder — see there for why
 * re-running with the SAME address is deliberately idempotent.
 */
async function bootstrapPlatformAdmin(supabase: SupabaseAdminService, email: string, password: string) {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set — cannot verify how many platform admins already exist.");
    process.exit(1);
  }

  const sql = postgres(dbUrl, { prepare: false, max: 1 });
  try {
    const { id, created } = await ensurePlatformAdmin(supabase, sql, email, password, {
      force: process.argv.includes("--force"),
    });
    if (!created) console.log(`User ${email} already existed — password reset and role confirmed.`);
    console.log(`✔ ${email} ready (auth ${id})`);
    console.log(`  app_metadata: {"role":"platform_admin"}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

// Explicit exit: AppModule pulls in the schedule module and the chat gateway,
// which hold the event loop open, so the process hangs after app.close() unless
// it is told to stop.
main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
