/**
 * Deletes EVERY user account on the platform, and the history that names them.
 *
 *   npm run db:reset-users          report what would be deleted, change nothing
 *   npm run db:reset-users -- --yes actually do it
 *
 * WHAT IT REMOVES: every Supabase Auth identity, every `staff_users` row, and
 * the three tables whose rows are only meaningful as "who did this" —
 * `auth_events`, `platform_audit_log`, `activities`.
 *
 * WHAT IT KEEPS: tenants, roles, role_permissions, entitlements, and all
 * business data. This resets *who can sign in*, not the platform.
 *
 * IRREVERSIBLE, and DATABASE_URL usually points at a hosted Supabase project
 * rather than a local database — which is why the default invocation is a dry
 * run and `--yes` is required to write anything. Refuses outright under
 * NODE_ENV=production.
 *
 * Run `npm run db:seed` afterwards to recreate the superadmin and the default
 * tenant owner.
 */
import "dotenv/config";
import { Logger, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { sql } from "drizzle-orm";
import { AppModule } from "../src/app.module";
import { SupabaseAdminService } from "../src/auth/supabase-admin.service";
import { TenantDb } from "../src/db/tenant-db.service";
import { activities, authEvents, platformAuditLog, staffUsers } from "../src/db/schema";

interface Identity {
  id: string;
  email: string | null;
  role: string | null;
}

/** Shared with `scripts/seed.ts --fresh`, so there is one wipe implementation. */
export function assertResetAllowed() {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run against NODE_ENV=production. This deletes every account on the platform.");
    process.exit(1);
  }
}

/**
 * Reports what would be deleted and, when `confirmed`, deletes it.
 *
 * @returns true when it actually wrote anything
 */
export async function resetUsers(app: INestApplicationContext, confirmed: boolean): Promise<boolean> {
  {
    const tdb = app.get(TenantDb);
    const supabase = app.get(SupabaseAdminService);

    const identities = (await tdb.raw.execute(sql`
      select id, email, raw_app_meta_data ->> 'role' as role
        from auth.users
       where deleted_at is null
       order by email
    `)) as unknown as Identity[];

    const [counts] = (await tdb.raw.execute(sql`
      select (select count(*)::int from public.staff_users)        as staff,
             (select count(*)::int from public.auth_events)        as auth_events,
             (select count(*)::int from public.platform_audit_log) as audit_log,
             (select count(*)::int from public.activities)         as activities
    `)) as unknown as { staff: number; auth_events: number; audit_log: number; activities: number }[];

    // Name the target before doing anything. DATABASE_URL is usually a hosted
    // project, and "which database did I just wipe" is not a question anyone
    // should have to answer after the fact.
    console.log(`\nDatabase: ${describeTarget()}\n`);
    console.log("WILL DELETE");
    console.log(`  ${identities.length} Supabase identities:`);
    for (const u of identities) console.log(`      ${String(u.role ?? "—").padEnd(15)} ${u.email ?? u.id}`);
    console.log(`  ${counts.staff} staff_users rows`);
    console.log(`  ${counts.auth_events} auth_events, ${counts.audit_log} audit-log, ${counts.activities} activity rows`);
    console.log("\nWILL KEEP");
    console.log("  tenants, roles, role_permissions, entitlements, and all business data\n");

    if (!confirmed) {
      console.log("Dry run — nothing was deleted. Re-run with --yes to proceed:");
      console.log("  npm run db:reset-users -- --yes\n");
      return false;
    }

    // GoTrue first, Postgres second. A failure between the two leaves staff rows
    // whose identity is gone, which PlatformUsersService.get already reports as
    // `orphaned` and which re-running this script cleans up. The other order
    // would leave logins that nothing in the app can see or manage.
    let deleted = 0;
    for (const u of identities) {
      try {
        await supabase.deleteUser(u.id);
        deleted++;
      } catch (err) {
        console.error(`  ! could not delete ${u.email ?? u.id}: ${(err as Error).message}`);
      }
    }
    console.log(`Deleted ${deleted}/${identities.length} Supabase identities.`);

    // asPlatform: staff_users has RLS enabled AND forced, and platform_audit_log
    // / auth_events have no tenant_isolation policy at all — only the platform
    // one. Without the sentinel these deletes would silently affect zero rows.
    await tdb.asPlatform(async (tx) => {
      await tx.delete(authEvents);
      await tx.delete(platformAuditLog);
      await tx.delete(activities);
      await tx.delete(staffUsers);
    });
    console.log("Cleared staff_users, auth_events, platform_audit_log and activities.");
    return true;
  }
}

/** Host + database name only — never the credentials in DATABASE_URL. */
function describeTarget(): string {
  try {
    const u = new URL(process.env.DATABASE_URL ?? "");
    return `${u.hostname}${u.pathname}`;
  } catch {
    return "(DATABASE_URL not set or unparseable)";
  }
}

async function main() {
  assertResetAllowed();
  Logger.overrideLogger(["error", "warn"]);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  try {
    const wiped = await resetUsers(app, process.argv.includes("--yes"));
    if (wiped) {
      console.log("\nDone. Run `npm run db:seed` to recreate the superadmin and the default tenant owner.\n");
    }
  } finally {
    await app.close();
  }
}

// Only run as a CLI. `scripts/seed.ts --fresh` imports resetUsers() instead.
//
// The explicit process.exit is not optional: AppModule pulls in the schedule
// module and the chat gateway, which hold the event loop open, so the process
// runs forever after app.close() resolves and the script never returns.
if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
