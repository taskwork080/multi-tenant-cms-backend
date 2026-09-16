-- storefront_configs could not be written by anyone.
--
-- 0009_storefront_rls.sql enabled RLS on the table and created exactly one
-- policy, `storefront_configs_self_read`, which is FOR SELECT. A table with RLS
-- enabled and no policy covering INSERT/UPDATE denies every write, so the row
-- could only ever be created by a role that bypasses RLS.
--
-- Until the deploy in 0011_app_api_role.sql that role was `postgres`
-- (rolbypassrls = true), so nothing failed and the gap stayed invisible. The
-- moment DATABASE_URL was repointed at `app_api` (NOBYPASSRLS — the entire
-- point of that migration), every write to the table started returning 42501:
--
--   ERROR [PgExceptionFilter] Unhandled database error (42501): Failed query:
--   insert into "storefront_configs" (...) on conflict do nothing
--
-- That insert is TenantProvisioningService.provision(), which runs inside the
-- tenants INSERT's own transaction. Deliberately so — "either the whole
-- workspace exists or none of it does" — which means creating ANY commerce
-- workspace rolled back. Measured on production 2026-09-12: zero rows in
-- `tenants`, five failed creates in the log. StorefrontService.getConfig() and
-- updateConfig() were dead for the same reason.
--
-- The fix is the two policies the table should have had in 0009: the platform
-- escape hatch every other cross-tenant table got in 0008_platform_admin.sql,
-- and a tenant write policy matching the SELECT one that is already there.
--
-- RLS stays ENABLED but NOT FORCED, and storefront_configs_self_read is left
-- untouched. 0009's reasoning for that still holds: resolving a custom domain
-- (Host header -> tenant) necessarily runs before any tenant context exists.
-- Note that "not forced" only ever helped the *owner* — app_api is not the
-- owner, so the contextless reads in StorefrontService.resolveHost() and
-- assertLive() were returning zero rows too. That half is fixed in the
-- application, by running those lookups through TenantDb.asPlatform() instead
-- of the unscoped handle, rather than by widening a policy here.
--
-- Verify after applying:
--   select policyname, cmd from pg_policies
--    where schemaname = 'public' and tablename = 'storefront_configs';
--   -- expect storefront_configs_self_read [SELECT], platform_admin_all [ALL],
--   --        tenant_isolation [ALL]
--   select relrowsecurity, relforcerowsecurity from pg_class
--    where oid = 'public.storefront_configs'::regclass;  -- true, false

-- Matches the loop in 0008_platform_admin.sql. Additive: policies are OR-ed, so
-- this only ever widens access for a transaction that opted in via asPlatform().
drop policy if exists platform_admin_all on public.storefront_configs;
--> statement-breakpoint
create policy platform_admin_all on public.storefront_configs
  using (public.is_platform_context())
  with check (public.is_platform_context());
--> statement-breakpoint

-- The write half of storefront_configs_self_read. Named `tenant_isolation` to
-- match every other tenant-scoped table; the SELECT-only policy keeps its own
-- name so 0009 remains legible against the live database.
drop policy if exists tenant_isolation on public.storefront_configs;
--> statement-breakpoint
create policy tenant_isolation on public.storefront_configs
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());
--> statement-breakpoint

-- 0011 granted DML on all tables in schema public and set default privileges,
-- and a production check on 2026-09-12 found no table missing them. Re-asserted
-- anyway because it costs nothing and this migration exists precisely because a
-- silent permission gap survived two deploys. Guarded: app_api is optional by
-- design (0011 stays inert until someone sets a password and repoints
-- DATABASE_URL), and an unguarded GRANT fails on a database without the role.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    execute 'grant select, insert, update, delete on public.storefront_configs to app_api';
  end if;
end $$;
