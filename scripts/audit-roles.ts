/**
 * Who holds which app role, platform-wide.
 *
 *   npm run roles:audit
 *
 * This is the diagnostic for the question "can a tenant owner reach the super
 * admin panel?". The /platform gate itself only ever checks
 * app_metadata.role === 'platform_admin', on both the server and the client, so
 * the answer is almost always data rather than code: an account that is
 * *supposed* to be an owner is actually marked platform_admin, usually because
 * it went through POST /api/admin/platform-admins back when that was unbounded.
 *
 * Reads auth.users directly rather than paging GoTrue's admin API: the list
 * endpoint cannot filter on app_metadata, so that route means pulling every
 * identity in the project into Node to keep a handful.
 *
 * Read-only. It changes nothing — fix anything it reports through
 * /platform/admins or Supabase.
 */
import "dotenv/config";
import postgres from "postgres";
import { APP_ROLES, PLATFORM_ADMIN } from "../src/auth/roles";

interface Row {
  id: string;
  email: string | null;
  role: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
  banned_until: Date | null;
  last_sign_in_at: Date | null;
  staff_status: string | null;
}

const KNOWN = new Set<string>([PLATFORM_ADMIN, ...APP_ROLES]);

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  const sql = postgres(dbUrl, { prepare: false, max: 1 });
  try {
    const rows = (await sql<Row[]>`
      select u.id,
             u.email,
             u.raw_app_meta_data ->> 'role'      as role,
             u.raw_app_meta_data ->> 'tenant_id' as tenant_id,
             t.name                              as tenant_name,
             u.banned_until,
             u.last_sign_in_at,
             s.status                            as staff_status
        from auth.users u
        left join public.staff_users s on s.auth_user_id = u.id
        left join public.tenants t
               on t.id = nullif(u.raw_app_meta_data ->> 'tenant_id', '')::uuid
       where u.deleted_at is null
       order by (u.raw_app_meta_data ->> 'role') nulls last, u.email
    `) as unknown as Row[];

    const admins = rows.filter((r) => r.role === PLATFORM_ADMIN);
    const unknown = rows.filter((r) => !r.role || !KNOWN.has(r.role));
    const orphans = rows.filter((r) => r.role !== PLATFORM_ADMIN && !r.tenant_id);

    console.log(`\n${rows.length} active identities\n`);

    // --- The headline ------------------------------------------------------
    console.log(`PLATFORM ADMINS (${admins.length})`);
    if (admins.length === 0) {
      console.log("  none — nobody can open /platform.");
      console.log("  Fix: npm run user:create -- <email> <password> platform_admin");
    }
    for (const a of admins) {
      const home = a.tenant_name ? `  home workspace: ${a.tenant_name}` : "  no home workspace";
      console.log(`  ${a.email ?? a.id}${home}`);
    }
    if (admins.length > 1) {
      console.log(
        `\n  ^^ ${admins.length} platform admins. This platform is meant to have exactly ONE.\n` +
          `     Every one of these accounts can read and write every workspace.\n` +
          `     Demote the extras at /platform/admins, then run db:migrate — the\n` +
          `     platform_admin_singleton index will not apply until only one remains.`,
      );
    }

    // --- Everyone else, by workspace --------------------------------------
    const tenanted = rows.filter((r) => r.role !== PLATFORM_ADMIN && r.tenant_id);
    const byTenant = new Map<string, Row[]>();
    for (const r of tenanted) {
      const key = r.tenant_name ?? `(unknown workspace ${r.tenant_id})`;
      byTenant.set(key, [...(byTenant.get(key) ?? []), r]);
    }

    console.log(`\nWORKSPACES (${byTenant.size})`);
    for (const [name, members] of [...byTenant].sort((a, b) => a[0].localeCompare(b[0]))) {
      const owners = members.filter((m) => m.role === "owner").length;
      console.log(`  ${name} — ${members.length} member(s), ${owners} owner(s)`);
      for (const m of members) {
        const flags = [
          m.staff_status && m.staff_status !== "active" ? m.staff_status : null,
          m.banned_until && new Date(m.banned_until) > new Date() ? "banned" : null,
          m.staff_status === null ? "NO STAFF ROW" : null,
          m.last_sign_in_at ? null : "never signed in",
        ].filter(Boolean);
        console.log(
          `      ${(m.role ?? "—").padEnd(6)} ${m.email ?? m.id}${flags.length ? `  [${flags.join(", ")}]` : ""}`,
        );
      }
    }

    // --- Problems ----------------------------------------------------------
    if (unknown.length) {
      console.log(`\nUNRECOGNISED ROLES (${unknown.length})`);
      console.log("  These predate the three-role model. They behave as `staff` at the JWT");
      console.log("  boundary already; db:migrate rewrites the stored value to match.");
      for (const u of unknown) console.log(`  ${String(u.role ?? "(none)").padEnd(8)} ${u.email ?? u.id}`);
    }

    if (orphans.length) {
      console.log(`\nNO WORKSPACE (${orphans.length})`);
      console.log("  Not platform admins and no tenant_id — they can sign in and reach nothing.");
      for (const o of orphans) console.log(`  ${String(o.role ?? "(none)").padEnd(8)} ${o.email ?? o.id}`);
    }

    const clean = admins.length === 1 && unknown.length === 0 && orphans.length === 0;
    console.log(clean ? "\nOK — one platform admin, every other account scoped to one workspace.\n" : "");
  } finally {
    await sql.end();
  }
}

void main();
