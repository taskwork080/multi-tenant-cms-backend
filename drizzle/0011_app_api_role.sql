-- Make Row Level Security actually apply to the API connection.
--
-- THE PROBLEM (measured 2026-08-01, recorded in 0008_platform_admin.sql):
--
--   the API's `postgres` role has rolbypassrls = true, so the
--   FORCE ROW LEVEL SECURITY in 0001_rls.sql is presently a no-op for the API
--   connection and isolation rests on application WHERE clauses + TenantGuard.
--
-- That makes tenant isolation single-layer. Every policy in 0001/0003/0007/0009
-- is inert, the README's claim that "forced RLS policies on every table make
-- cross-tenant rows invisible even if a WHERE clause is forgotten" is false as
-- deployed, and one missing `eq(table.tenantId, ...)` is a cross-tenant leak.
--
-- THE FIX: run the API as a role that cannot bypass RLS. Nothing about the
-- policies changes — they finally start applying.
--
-- This migration only CREATES and GRANTS. Switching over is a deploy step,
-- because it needs a password this file must not contain and a DATABASE_URL
-- change:
--
--   1. psql> alter role app_api with password '<strong-password>';
--   2. set DATABASE_URL to postgresql://app_api:<password>@<host>:5432/postgres
--   3. restart the API, then verify:
--        select rolbypassrls from pg_roles where rolname = 'app_api';   -- false
--        select relname, relrowsecurity, relforcerowsecurity
--          from pg_class where relname in ('products','orders','staff_users');
--        -- all true/true
--   4. confirm a query inside forTenant() returns only that tenant's rows.
--
-- Until step 2 happens this migration is inert and the API keeps working
-- exactly as before — deliberately, so applying migrations never takes the
-- service down on its own.

-- NOINHERIT is not used: app_api needs the privileges granted to it directly.
-- NOBYPASSRLS and NOSUPERUSER are the whole point.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_api') then
    create role app_api with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls
      password null;
  else
    alter role app_api with nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $$;
--> statement-breakpoint

grant usage on schema public to app_api;
--> statement-breakpoint

-- DML only. app_api must not be able to alter the schema, drop a policy, or
-- disable RLS on the tables it is being constrained by.
grant select, insert, update, delete on all tables in schema public to app_api;
--> statement-breakpoint
grant usage, select on all sequences in schema public to app_api;
--> statement-breakpoint

-- Tables added by later migrations must be reachable too, or the next feature
-- ships a permission-denied error instead of a bug.
alter default privileges in schema public
  grant select, insert, update, delete on tables to app_api;
--> statement-breakpoint
alter default privileges in schema public
  grant usage, select on sequences to app_api;
--> statement-breakpoint

-- current_tenant_id() reads a GUC and auth.jwt(); is_platform_context() reads a
-- GUC. Both are SQL/stable and referenced by every policy, so app_api must be
-- able to execute them.
grant execute on all functions in schema public to app_api;
--> statement-breakpoint

-- The auth schema is GoTrue's. app_api needs to read auth.users only for the
-- public.platform_admins / platform_admin_count views (0008), which read
-- raw_app_meta_data. Read-only, and only that table.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'auth') then
    execute 'grant usage on schema auth to app_api';
    execute 'grant select on auth.users to app_api';
  end if;
end $$;
