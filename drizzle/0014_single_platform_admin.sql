-- Three-role model: exactly one platform admin, and no legacy app roles.
--
-- Hand-written, like 0001/0003/0007/0008/0009/0011: it touches auth.users,
-- which drizzle-kit cannot express from schema.ts. `npm run db:generate` does
-- not re-emit it — keep drizzle/meta/0015_snapshot.json in step.

-- 1. Collapse the two app roles that no longer exist.
--
-- `admin` and `viewer` sat between owner and staff and carried nothing the
-- tenant Role could not express. Everyone holding one becomes `staff`; what
-- they may actually do keeps coming from their assigned Role, unchanged.
--
-- JwtVerifier.normalizeAppRole does the same mapping at the token boundary, so
-- a browser still holding an un-migrated token behaves correctly before this
-- ever runs. This statement makes the stored state agree with it.
--
-- UPDATE on auth.users is granted to the API role (SELECT/UPDATE yes, DDL no —
-- see the note on statement 3).
update auth.users
   set raw_app_meta_data = jsonb_set(coalesce(raw_app_meta_data, '{}'::jsonb), '{role}', '"staff"')
 where raw_app_meta_data ->> 'role' in ('admin', 'viewer');
--> statement-breakpoint

-- 2. A user with a workspace but no role at all resolves to `staff` in the app
-- anyway; write it down so `roles:audit` and the runbook query show the truth
-- rather than a NULL that has to be interpreted.
update auth.users
   set raw_app_meta_data = jsonb_set(coalesce(raw_app_meta_data, '{}'::jsonb), '{role}', '"staff"')
 where raw_app_meta_data ->> 'tenant_id' is not null
   and raw_app_meta_data ->> 'role' is null;
--> statement-breakpoint

-- 3. BEST EFFORT: at most one platform admin, enforced by Postgres.
--
-- Every row matching the WHERE clause has the same indexed value (the literal
-- 'platform_admin'), so a UNIQUE index over that expression admits exactly one.
--
-- WHY THIS IS WRAPPED, and it matters: on Supabase, auth.users is owned by
-- `supabase_auth_admin`, and the API connects as `postgres`, which is NOT a
-- member of it (verified 2026-08-15: has_table_privilege SELECT/UPDATE = true,
-- has_schema_privilege(auth, CREATE) = false). CREATE INDEX requires ownership,
-- so this statement raises insufficient_privilege there and would abort the
-- whole migration. It is attempted rather than dropped because it DOES apply on
-- self-hosted Postgres and on any deployment where the migration role owns the
-- auth schema, and skipping it silently would be worse than saying so.
--
-- WHAT ACTUALLY GUARANTEES ONE ADMIN when this is skipped: the role is only
-- ever written in two places, and both refuse a second one —
-- PlatformAdminsService.promote (409 while an admin exists) and
-- scripts/create-user.ts (refuses a different address). `npm run roles:audit`
-- reports the truth from auth.users at any time. Someone with Supabase
-- dashboard access can still set app_metadata by hand, and no index this
-- migration could create would stop them, since they hold more privilege than
-- it does.
do $$
begin
  create unique index if not exists platform_admin_singleton
      on auth.users ((raw_app_meta_data ->> 'role'))
   where raw_app_meta_data ->> 'role' = 'platform_admin'
     and deleted_at is null;
exception
  when insufficient_privilege then
    raise warning 'Skipped platform_admin_singleton: % does not own auth.users. One platform admin is still enforced in application code (PlatformAdminsService.promote, scripts/create-user.ts) — verify with: npm run roles:audit', current_user;
  when unique_violation then
    raise exception 'Cannot enforce a single platform admin: more than one account already holds it. Run `npm run roles:audit`, revoke the extras at /platform/admins, then re-run this migration.';
end
$$;
