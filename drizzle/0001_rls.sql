-- Row Level Security: tenant isolation for every tenant-scoped table.
--
-- The API pins the tenant per transaction via
--   select set_config('app.tenant_id', '<uuid>', true);
-- and these policies make rows from other tenants invisible/unwritable —
-- even if application code forgets a WHERE tenant_id clause.
-- FORCE ensures the policies also apply to the table owner (the `postgres`
-- role used by the API connection).
--
-- Supabase clients (anon/authenticated via PostgREST/Realtime) are allowed
-- when the JWT's app_metadata.tenant_id matches, so Realtime subscriptions
-- on these tables stay tenant-scoped too.

create or replace function public.current_tenant_id()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('app.tenant_id', true), ''),
    (auth.jwt() -> 'app_metadata' ->> 'tenant_id')
  )::uuid
$$;
--> statement-breakpoint

do $$
declare
  t text;
begin
  foreach t in array array[
    -- parents
    'categories','brands','manufacturers','badges','products','orders',
    'warehouses','stock_batches','delivery_channels','customers','sellers',
    'promo_codes','reviews','return_requests','tax_rates','roles','staff_users',
    'activities','shipments','conversations','schedule_events','notes',
    'packing_lists','cms_blocks','language_entries',
    -- children
    'product_images','product_badges','order_items','warehouse_coverage_areas',
    'role_permissions','shipment_items','shipment_events','chat_messages',
    'schedule_attendees','note_tags','note_attachments','note_links',
    'note_calc_lines','packing_items','item_cartons','carton_sizes',
    'pack_ship_events'
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

-- A chat message belongs to exactly one thread: a conversation or a shipment.
alter table public.chat_messages
  add constraint chat_messages_one_thread
  check (num_nonnulls(conversation_id, shipment_id) = 1);
--> statement-breakpoint

-- Tenants + entitlements: slug resolution happens before a tenant context
-- exists, so RLS is enabled but NOT forced (the owning API role passes);
-- Supabase clients may only read their own tenant.
alter table public.tenants enable row level security;
--> statement-breakpoint
drop policy if exists tenant_self_read on public.tenants;
--> statement-breakpoint
create policy tenant_self_read on public.tenants
  for select
  using (id = public.current_tenant_id());
--> statement-breakpoint
alter table public.tenant_entitlements enable row level security;
--> statement-breakpoint
drop policy if exists tenant_entitlements_self_read on public.tenant_entitlements;
--> statement-breakpoint
create policy tenant_entitlements_self_read on public.tenant_entitlements
  for select
  using (tenant_id = public.current_tenant_id());
