import "./lib/env-target";
import postgres from "postgres";

/**
 * Read-only diagnostic for the "Database query failed" 500s on /api/admin/*.
 *
 * PgExceptionFilter collapses every unrecognised SQLSTATE into one opaque
 * message, so the only way to learn what the API is actually hitting is to make
 * the same connection it makes and ask the catalog directly.
 *
 * SELECTs only. Every statement below runs against DATABASE_URL — the role the
 * API runs as, which is the whole question — and anything the catalog refuses
 * it is retried on MIGRATE_DATABASE_URL (the owner) so a permission denial is
 * reported rather than hiding the answer.
 *
 *   npx tsx scripts/probe-prod.ts --env=prod --allow-prod
 */

const APP_URL = process.env.DATABASE_URL;
const OWNER_URL = process.env.MIGRATE_DATABASE_URL;

type Row = Record<string, unknown>;

function heading(n: number, title: string) {
  console.log(`\n${"─".repeat(70)}\n${n}. ${title}\n${"─".repeat(70)}`);
}

function print(rows: Row[]) {
  if (!rows.length) {
    console.log("  (no rows)");
    return;
  }
  console.table(rows);
}

async function main() {
  if (!APP_URL) throw new Error("DATABASE_URL is not set");

  const app = postgres(APP_URL, { prepare: false, max: 1 });
  const owner = OWNER_URL && OWNER_URL !== APP_URL ? postgres(OWNER_URL, { prepare: false, max: 1 }) : null;

  /** Run on the app role; on failure say why, then retry as owner if we can. */
  async function q(n: number, title: string, sql: string) {
    heading(n, title);
    try {
      print((await app.unsafe(sql)) as unknown as Row[]);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      console.log(`  ✖ as app role: ${e.code ?? "?"} ${e.message ?? err}`);
      if (!owner) return;
      try {
        console.log("  ↳ retrying as owner:");
        print((await owner.unsafe(sql)) as unknown as Row[]);
      } catch (err2) {
        const e2 = err2 as { code?: string; message?: string };
        console.log(`  ✖ as owner too: ${e2.code ?? "?"} ${e2.message ?? err2}`);
      }
    }
  }

  await q(1, "Who is the API connecting as?", `select current_user, session_user, current_database()`);

  await q(
    2,
    "Can that role bypass RLS?",
    `select rolname, rolsuper, rolbypassrls, rolcanlogin
       from pg_roles
      where rolname in (current_user, session_user, 'app_api', 'postgres')
      order by rolname`,
  );

  await q(
    3,
    "Which migrations are applied?",
    `select id, hash, to_timestamp(created_at / 1000) as applied_at, created_at
       from drizzle.__drizzle_migrations
      order by created_at`,
  );

  await q(
    4,
    "Does tenants.status exist? (0010_platform_expansion)",
    `select column_name, data_type, column_default
       from information_schema.columns
      where table_schema = 'public' and table_name = 'tenants'
      order by ordinal_position`,
  );

  await q(
    5,
    "RLS enabled / forced per table",
    `select c.relname, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
            pg_get_userbyid(c.relowner) as owner,
            (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
       from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      order by c.relname`,
  );

  await q(
    6,
    "Tables with RLS on but NO platform policy (the 42501 shortlist)",
    `select c.relname,
            bool_or(p.policyname = 'platform_admin_all') as has_platform_policy,
            string_agg(distinct p.policyname || ' [' || p.cmd || ']', ', ') as policies
       from pg_class c
       left join pg_policies p on p.schemaname = 'public' and p.tablename = c.relname
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relrowsecurity
      group by c.relname
     having coalesce(bool_or(p.policyname = 'platform_admin_all'), false) = false
      order by c.relname`,
  );

  await q(
    7,
    "Full policy inventory",
    `select tablename, policyname, cmd, qual, with_check
       from pg_policies
      where schemaname = 'public'
      order by tablename, policyname`,
  );

  await q(
    8,
    "Tables app_api is missing DML on",
    `select t.tablename,
            string_agg(distinct g.privilege_type, ', ' order by g.privilege_type) as granted
       from pg_tables t
       left join information_schema.role_table_grants g
              on g.table_schema = 'public' and g.table_name = t.tablename and g.grantee = 'app_api'
      where t.schemaname = 'public'
      group by t.tablename
     having count(distinct g.privilege_type) filter (
              where g.privilege_type in ('SELECT','INSERT','UPDATE','DELETE')) < 4
      order by t.tablename`,
  );

  await q(
    9,
    "Policy helper functions",
    `select p.proname, pg_get_functiondef(p.oid) as definition,
            has_function_privilege(current_user, p.oid, 'execute') as can_execute
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and p.proname in ('current_tenant_id', 'is_platform_context')`,
  );

  // The actual failing request, reproduced. asPlatform() opens a transaction and
  // sets app.platform locally; PlatformTenantsService.list then runs exactly
  // these four statements. Each is isolated so we learn WHICH one throws.
  heading(10, "Reproducing GET /api/admin/tenants inside asPlatform()");
  const steps: Array<[string, string]> = [
    ["set_config", `select set_config('app.platform', 'on', true) as v`],
    ["is_platform_context()", `select public.is_platform_context() as v`],
    ["select * from tenants", `select * from tenants order by created_at desc limit 1`],
    ["count(*) from tenants", `select count(*)::int as v from tenants`],
    ["staff_users grouped", `select tenant_id, count(*)::int from staff_users group by tenant_id`],
    ["tenant_entitlements grouped", `select tenant_id, count(*)::int from tenant_entitlements group by tenant_id`],
  ];
  try {
    await app.begin(async (tx) => {
      for (const [label, sql] of steps) {
        try {
          const rows = (await tx.unsafe(sql)) as unknown as Row[];
          console.log(`  ✓ ${label} -> ${rows.length} row(s)`);
          if (label === "select * from tenants" && rows.length) console.log("   ", JSON.stringify(rows[0]));
          if (label === "is_platform_context()") console.log("   ", JSON.stringify(rows[0]));
        } catch (err) {
          const e = err as { code?: string; message?: string; detail?: string; hint?: string };
          console.log(`  ✖ ${label}`);
          console.log(`      SQLSTATE: ${e.code ?? "(none)"}`);
          console.log(`      message:  ${e.message}`);
          if (e.detail) console.log(`      detail:   ${e.detail}`);
          if (e.hint) console.log(`      hint:     ${e.hint}`);
          // A failed statement aborts the transaction, so nothing after it can
          // run; bail out and let the caller re-run once this one is fixed.
          throw err;
        }
      }
      // Read-only by construction, but be explicit about it.
      throw new Error("__rollback__");
    });
  } catch (err) {
    if ((err as Error).message !== "__rollback__") {
      console.log("  (transaction aborted at the first failure above)");
    }
  }

  await q(
    11,
    "TenantService.bySlug path (raw, no context) — does it see rows?",
    `select count(*)::int as visible_tenants from tenants`,
  );

  // The write probe reproduces tenant provisioning for real and rolls back, so
  // it is opt-in: a diagnostic that inserts into production tables should never
  // be something you get by running the script without meaning to.
  if (!process.argv.includes("--write-probe")) {
    heading(12, "Write probe (skipped — pass --write-probe to run it)");
    console.log("  Reproduces TenantService.create + provision() in a transaction that is rolled back.");
    await app.end();
    if (owner) await owner.end();
    return;
  }

  heading(12, "Can app_api insert into storefront_configs under asPlatform()?");
  try {
    await app.begin(async (tx) => {
      await tx.unsafe(`select set_config('app.platform', 'on', true)`);
      // The database starts empty (every create rolled back), so make the
      // tenant here: this reproduces TenantService.create + provision() as one
      // transaction, which is exactly the path that was failing.
      try {
        const [t] = (await tx.unsafe(
          `insert into tenants (slug, name, type) values ('probe-rollback', 'Probe', 'ecommerce') returning id`,
        )) as unknown as Row[];
        console.log(`  ✓ insert into tenants -> ${t.id}`);
        await tx.unsafe(`insert into tenant_entitlements (tenant_id, module) values ('${t.id}', 'cms')`);
        console.log("  ✓ insert into tenant_entitlements");
        await tx.unsafe(
          `insert into storefront_configs (tenant_id, is_active) values ('${t.id}', false) on conflict do nothing`,
        );
        console.log("  ✓ insert into storefront_configs");
        const [c] = (await tx.unsafe(
          `select tenant_id, is_active from storefront_configs where tenant_id = '${t.id}'`,
        )) as unknown as Row[];
        console.log(`  ✓ readback: ${JSON.stringify(c)}`);
      } catch (err) {
        const e = err as { code?: string; message?: string; detail?: string };
        console.log(`  ✖ SQLSTATE ${e.code ?? "(none)"}: ${e.message}`);
        if (e.detail) console.log(`      detail: ${e.detail}`);
      }
      throw new Error("__rollback__");
    });
  } catch (err) {
    if ((err as Error).message !== "__rollback__") console.log(`  ✖ ${(err as Error).message}`);
  }

  await app.end();
  if (owner) await owner.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
