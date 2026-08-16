/**
 * Bootstrapping THE platform administrator, from a script.
 *
 * Shared by `scripts/create-user.ts` and `scripts/seed.ts` so the singleton rule
 * has one implementation. Two copies of "refuse a second admin" is one copy away
 * from a platform with two people who can read every workspace.
 *
 * This path deliberately talks to GoTrue directly rather than going through
 * PlatformUsersService: a platform admin belongs to no tenant, so there is no
 * `staff_users` row to create, and at first boot there is no admin to authorise
 * the call anyway.
 */
import type postgres from "postgres";
import type { SupabaseAdminService } from "../../src/auth/supabase-admin.service";
import { PLATFORM_ADMIN } from "../../src/auth/roles";

type Sql = ReturnType<typeof postgres>;

export interface PlatformAdminIdentity {
  id: string;
  email: string;
}

/**
 * The incumbent, read straight from auth.users.
 *
 * GoTrue's admin list endpoint cannot filter on app_metadata, so asking it this
 * question means paging every identity in the project.
 */
export async function currentPlatformAdmin(sql: Sql): Promise<PlatformAdminIdentity | null> {
  const rows = await sql<{ id: string; email: string | null }[]>`
    select id, email from auth.users
     where raw_app_meta_data ->> 'role' = ${PLATFORM_ADMIN} and deleted_at is null
     limit 1
  `;
  const row = rows[0];
  return row ? { id: row.id, email: row.email ?? "" } : null;
}

/**
 * Create the platform admin, or repair the one that already exists.
 *
 * THERE IS ONLY EVER ONE. Re-running for the SAME address is idempotent — that
 * is how a lost password is fixed — but a second, different address is refused.
 * Postgres refuses it too where the migration role owns `auth.users`
 * (`platform_admin_singleton`, drizzle/0014); this check exists so the failure
 * names the incumbent instead of surfacing as a unique violation, and because on
 * Supabase that index cannot be created at all.
 *
 * @returns the auth user id
 */
export async function ensurePlatformAdmin(
  supabase: SupabaseAdminService,
  sql: Sql,
  email: string,
  password: string,
  opts: { force?: boolean } = {},
): Promise<{ id: string; created: boolean }> {
  const incumbent = await currentPlatformAdmin(sql);
  if (incumbent && incumbent.email.toLowerCase() !== email.toLowerCase() && !opts.force) {
    throw new Error(
      `This platform already has its administrator: ${incumbent.email}\n` +
        `  A platform admin can read and write every workspace, so there is exactly one.\n` +
        `  To hand the role over, demote ${incumbent.email} at /platform/admins first.\n` +
        `  To repair a lost password, re-run with that same address.`,
    );
  }

  const appMetadata = { role: PLATFORM_ADMIN };
  let id: string;
  let created = true;

  try {
    id = (await supabase.createUser({ email, password, emailConfirm: true, appMetadata })).id;
  } catch {
    const existing = await supabase.findByEmail(email);
    if (!existing) throw new Error(`Could not create or find an auth user for ${email}.`);
    await supabase.updateUserById(existing.id, { password, app_metadata: appMetadata, email_confirm: true });
    id = existing.id;
    created = false;
  }

  // GoTrue's admin API confirms the email above; this is a belt-and-braces fixup
  // for accounts that were originally created through the public signup
  // endpoint, which leaves email_confirmed_at null.
  await sql`update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = ${id}::uuid`;

  return { id, created };
}
