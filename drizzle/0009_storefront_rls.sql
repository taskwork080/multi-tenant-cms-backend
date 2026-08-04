-- Row Level Security for the storefront tables added in 0008.
--
-- RLS does NOT cascade to new tables. Without these policies a tenant's draft
-- pages, navigation and theme are readable across tenants while the app still
-- appears to work — and unlike most tables here, some of this content is
-- served to anonymous visitors, so a leak is public.
--
-- storefront_pages / storefront_navigation get the standard forced treatment.
--
-- storefront_configs is deliberately NOT forced, mirroring public.tenants in
-- 0001_rls.sql: resolving a custom domain (Host header -> tenant) necessarily
-- runs BEFORE any tenant context exists, so with FORCE on,
-- current_tenant_id() is null and the lookup returns zero rows for the owning
-- API role too — every custom-domain storefront would 404. The policy is still
-- created so Supabase anon/authenticated clients stay tenant-scoped, and the
-- API always filters by tenant_id explicitly (see StorefrontService).
--
-- Verify before deploying:
--   select relname, relrowsecurity, relforcerowsecurity from pg_class
--    where relname in ('storefront_pages','storefront_navigation','storefront_configs');
--   -- pages + navigation must be true/true, configs true/false

do $$
declare
  t text;
begin
  foreach t in array array[
    'storefront_pages','storefront_navigation'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format(
      'create policy tenant_isolation on public.%I
         using (tenant_id = public.current_tenant_id())
         with check (tenant_id = public.current_tenant_id())',
      t
    );
  end loop;
end $$;
--> statement-breakpoint

alter table public.storefront_configs enable row level security;
--> statement-breakpoint
drop policy if exists storefront_configs_self_read on public.storefront_configs;
--> statement-breakpoint
create policy storefront_configs_self_read on public.storefront_configs
  for select
  using (tenant_id = public.current_tenant_id());
