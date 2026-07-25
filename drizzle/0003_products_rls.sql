-- Row Level Security for the product child tables added in 0002.
--
-- Forced RLS on `products` does NOT cascade to its children: without these
-- policies the new tables are readable across tenants while everything still
-- appears to work. Any future tenant-scoped table needs the same treatment.

do $$
declare
  t text;
begin
  foreach t in array array[
    'product_tags','product_specs','product_pricing_tiers','product_variants'
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
