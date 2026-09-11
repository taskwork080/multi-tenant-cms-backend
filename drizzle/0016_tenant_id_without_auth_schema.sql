-- Hand-written, like 0001/0011: redefines a function, so schema.ts is unchanged.
--
-- current_tenant_id() (0001) read its fallback through auth.jwt(). Every
-- tenant_isolation policy, and tenant_self_read on tenants, calls it. A
-- `language sql` function's body is resolved with the CALLER's privileges, so
-- any role without USAGE on Supabase's auth schema gets "permission denied for
-- schema auth" on every tenant-scoped query — even when app.tenant_id is set
-- and the fallback would never be evaluated.
--
-- That role is app_api (0011), the one the API is meant to run as. 0011 tries
-- `grant usage on schema auth to app_api`, but on current Supabase projects
-- postgres holds no grant option on auth, so the GRANT only warns and the
-- migration commits regardless. The result was a role that could log in and
-- could not read a single tenant row. It went unnoticed because nothing had
-- ever run as app_api: the API connects as postgres, which has rolbypassrls,
-- so the policies were never evaluated at all.
--
-- auth.jwt() is itself only a read of the request.jwt.claim(s) settings that
-- PostgREST and Realtime populate. Reading them directly is identical for
-- those clients and removes the dependency on the auth schema entirely.
-- Granting app_api the schema instead is not available — the grantor lacks
-- the right to.
--
-- `create or replace` with the same signature keeps every policy bound to this
-- function (they reference it by OID) and preserves 0011's EXECUTE grant.
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('app.tenant_id', true), ''),
    (
      coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
      )::jsonb -> 'app_metadata' ->> 'tenant_id'
    )
  )::uuid
$$;
