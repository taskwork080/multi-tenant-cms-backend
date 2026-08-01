-- Platform administration: cross-tenant super-admin access + audit trail.
--
-- Two new tables (platform_audit_log, auth_events) and the RLS mechanism that
-- lets /api/admin/* read across tenants while keeping tenant connections
-- exactly as isolated as they are today.
--
-- The mechanism is a server-side GUC sentinel, `app.platform`, set only inside
-- TenantDb.asPlatform(). It is not derivable from a JWT, so Supabase clients
-- (anon/authenticated via PostgREST/Realtime) can never satisfy it — unlike
-- app.tenant_id, which falls back to a JWT claim in current_tenant_id().
--
-- NOTE (measured 2026-08-01): the API's `postgres` role has rolbypassrls = true,
-- so the FORCE ROW LEVEL SECURITY in 0001_rls.sql is presently a no-op for the
-- API connection and isolation rests on application WHERE clauses + TenantGuard.
-- The policies below are written to be correct if that role is ever downgraded.

create table if not exists "platform_audit_log" (
  "id" uuid primary key default gen_random_uuid() not null,
  "actor_id" uuid,
  "actor_email" text default '' not null,
  "action" text not null,
  "target_type" text not null,
  "target_id" text,
  -- SET NULL, not CASCADE: deleting a tenant must not erase the audit trail
  -- proving it was deleted.
  "tenant_id" uuid references "tenants"("id") on delete set null,
  "before" jsonb,
  "after" jsonb,
  "ip" text,
  "user_agent" text,
  "created_at" timestamp with time zone default now() not null
);
--> statement-breakpoint

create table if not exists "auth_events" (
  "id" uuid primary key default gen_random_uuid() not null,
  "auth_user_id" uuid not null,
  "staff_user_id" uuid references "staff_users"("id") on delete set null,
  "tenant_id" uuid references "tenants"("id") on delete set null,
  "email" text default '' not null,
  "event" text not null,
  "ip" text,
  "user_agent" text,
  "created_at" timestamp with time zone default now() not null
);
--> statement-breakpoint

create index if not exists "platform_audit_created_idx" on "platform_audit_log" ("created_at" desc);
--> statement-breakpoint
create index if not exists "platform_audit_actor_idx" on "platform_audit_log" ("actor_id","created_at" desc);
--> statement-breakpoint
create index if not exists "platform_audit_target_idx" on "platform_audit_log" ("target_type","target_id");
--> statement-breakpoint
create index if not exists "platform_audit_tenant_idx" on "platform_audit_log" ("tenant_id","created_at" desc);
--> statement-breakpoint
create index if not exists "auth_events_user_idx" on "auth_events" ("auth_user_id","created_at" desc);
--> statement-breakpoint
create index if not exists "auth_events_created_idx" on "auth_events" ("created_at" desc);
--> statement-breakpoint

-- One staff row per Supabase identity. NULLs are distinct in Postgres, so rows
-- still awaiting an auth user do not collide.
create unique index if not exists "staff_users_auth_user_id_key" on "staff_users" ("auth_user_id");
--> statement-breakpoint

-- Global email uniqueness is what makes "one user = one tenant" enforceable:
-- without it the same address could hold a staff row in two workspaces while
-- the JWT can only ever name one.
create unique index if not exists "staff_users_email_lower_key" on "staff_users" (lower("email"));
--> statement-breakpoint

-- The platform user list filters and sorts across tenants, so the existing
-- tenant-prefixed index cannot serve it.
create index if not exists "staff_users_status_idx" on "staff_users" ("status");
--> statement-breakpoint
create index if not exists "staff_users_created_idx" on "staff_users" ("created_at" desc);
--> statement-breakpoint

create or replace function public.is_platform_context()
returns boolean
language sql
stable
as $$
  select coalesce(current_setting('app.platform', true), '') = 'on'
$$;
--> statement-breakpoint

-- Additive policy on the tenant-scoped tables the super admin must read across.
-- Policies are OR-ed, so tenant_isolation keeps working untouched; this one
-- only ever widens access for a transaction that has opted in via asPlatform().
do $$
declare
  t text;
begin
  foreach t in array array[
    'staff_users','roles','role_permissions','activities','tenants','tenant_entitlements'
  ]
  loop
    execute format('drop policy if exists platform_admin_all on public.%I', t);
    execute format(
      'create policy platform_admin_all on public.%I
         using (public.is_platform_context())
         with check (public.is_platform_context())',
      t
    );
  end loop;
end $$;
--> statement-breakpoint

-- The new tables get RLS enabled AND forced with ONLY the platform policy.
-- There is deliberately no tenant_isolation policy: a tenant-scoped connection
-- sees nothing here by construction, not by omission.
alter table public.platform_audit_log enable row level security;
--> statement-breakpoint
alter table public.platform_audit_log force row level security;
--> statement-breakpoint
drop policy if exists platform_only on public.platform_audit_log;
--> statement-breakpoint
create policy platform_only on public.platform_audit_log
  using (public.is_platform_context())
  with check (public.is_platform_context());
--> statement-breakpoint

alter table public.auth_events enable row level security;
--> statement-breakpoint
alter table public.auth_events force row level security;
--> statement-breakpoint
drop policy if exists platform_only on public.auth_events;
--> statement-breakpoint
create policy platform_only on public.auth_events
  using (public.is_platform_context())
  with check (public.is_platform_context());
--> statement-breakpoint

-- Defence in depth: even if a policy is later added by mistake, PostgREST and
-- Realtime have no grant to reach these tables at all.
revoke all on public.platform_audit_log from anon, authenticated;
--> statement-breakpoint
revoke all on public.auth_events from anon, authenticated;
--> statement-breakpoint

-- Exact count of platform admins, for the last-admin guard. Platform admins
-- live only in auth.users.raw_app_meta_data, and GoTrue's admin list endpoint
-- cannot filter on it, so read it here instead.
create or replace view public.platform_admin_count as
  select count(*)::int as n
    from auth.users
   where raw_app_meta_data ->> 'role' = 'platform_admin'
     and deleted_at is null;
--> statement-breakpoint
revoke all on public.platform_admin_count from anon, authenticated;
