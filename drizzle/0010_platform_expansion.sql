-- Platform expansion: workspace lifecycle + a platform-admin roster.
--
-- Hand-written, like 0004/0006/0007/0009/0008_platform_admin. Do NOT regenerate
-- this with drizzle-kit: drizzle/meta/ has no snapshots for the hand-written
-- migrations since 0005, so the diff baseline is stale and generate would emit
-- a destructive re-creation.
--
-- NOTE ON ORDERING: the migrator applies by the `when` value in
-- meta/_journal.json, not by filename. This file's entry must sit above
-- 0008_platform_admin's 1785600000000 or it is silently skipped.

-- Workspace lifecycle. Enforced in TenantGuard, which rejects any non-active
-- tenant for everyone except a platform admin (repair work is why the state
-- exists). Defaults to 'active' so every existing row keeps working.
alter table "tenants" add column if not exists "status" text not null default 'active';
--> statement-breakpoint
create index if not exists "tenants_status_idx" on "tenants" ("status");
--> statement-breakpoint

-- The platform-admin roster. Same reasoning as public.platform_admin_count in
-- 0008: platform admins exist only in auth.users.raw_app_meta_data, and
-- GoTrue's admin list endpoint cannot filter on app_metadata, so listing them
-- through the API would mean paging every user in the project into Node.
create or replace view public.platform_admins as
  select u.id,
         u.email,
         u.created_at,
         u.last_sign_in_at,
         u.banned_until,
         u.raw_app_meta_data ->> 'tenant_id' as tenant_id
    from auth.users u
   where u.raw_app_meta_data ->> 'role' = 'platform_admin'
     and u.deleted_at is null;
--> statement-breakpoint
revoke all on public.platform_admins from anon, authenticated;
