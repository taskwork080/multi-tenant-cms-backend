-- Row Level Security for the inventory core added in 0005.
--
-- RLS does NOT cascade to new tables: without these policies every inventory
-- table — including the ledger, which records exactly what each tenant holds
-- and sells — is readable across tenants while the app still appears to work.
-- This is the highest-severity file in the inventory migration set.
--
-- Runs after 0006 so the backfill isn't fighting its own forced policies.
--
-- Verify before deploying:
--   select relname, relrowsecurity, relforcerowsecurity from pg_class
--    where relname in ('skus','inventory_levels','stock_movements',
--      'inventory_reservations','stock_transfers','stock_transfer_items',
--      'inbound_receipts','inbound_receipt_items','cycle_counts',
--      'cycle_count_items');
--   -- every row must be true/true

do $$
declare
  t text;
begin
  foreach t in array array[
    'skus','inventory_levels','stock_movements','inventory_reservations',
    'stock_transfers','stock_transfer_items','inbound_receipts',
    'inbound_receipt_items','cycle_counts','cycle_count_items'
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
