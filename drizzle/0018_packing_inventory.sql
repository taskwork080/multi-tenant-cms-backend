-- Connect the packing line to inventory.
--
-- THE PROBLEM
--
-- Confirming a packing list is the moment goods physically leave the shelf, and
-- `POST /packing-lists/:id/confirm` has always tried to deduct them. In practice
-- it almost never did:
--
--   * the builder only ever set `product_id` on a line, never `sku_id`, and
--     linking a product is optional — so on an ordinary free-text garment line
--     `resolveSku` returned nothing, the line was silently skipped, and the list
--     confirmed reporting `deducted: 0` behind a success message;
--   * when a product WAS linked, every size on the line deducted against that
--     product's single default SKU, so size-level stock drifted immediately;
--   * `packing_lists` had no warehouse, so the deduction guessed one and
--     skipped the line when it could not.
--
-- WHAT THIS ADDS
--
--   1. `packing_lists.warehouse_id` — where the goods leave from.
--   2. `packing_lists.stock_state`  — none | held | deducted. The stock guard,
--      deliberately separate from `shipment_no`: that number is a business
--      reference which must survive a reopen, and using it to gate the ledger is
--      what made a reopened list impossible to re-confirm.
--   3. `packing_sku_map`            — which SKU a packed (product, colour, size)
--      actually is. Keyed on the style rather than on a packing row, because a
--      PATCH replaces a list's children wholesale and would destroy a mapping
--      stored there — and because the mapping belongs to the style, so it is
--      worth exactly once per style forever.
--   4. `inventory_reservations.packing_list_id` — lets a draft packing list hold
--      stock the same way an order does.
--
-- Every column added here is nullable or defaulted, so existing rows stay valid.
--
-- Verify after applying:
--   select relname, relrowsecurity, relforcerowsecurity from pg_class
--    where relname = 'packing_sku_map';
--   -- must be true/true

-- --- packing_lists ------------------------------------------------------------

alter table public.packing_lists
  add column if not exists "warehouse_id" uuid references "warehouses"("id") on delete restrict;
--> statement-breakpoint

alter table public.packing_lists
  add column if not exists "stock_state" text default 'none' not null;
--> statement-breakpoint

create index if not exists "packing_lists_warehouse_idx"
  on "packing_lists" ("tenant_id", "warehouse_id");
--> statement-breakpoint

-- Lists that already deducted must say so, or the new reopen path would hand
-- their stock back a second time. Detected from the ledger rather than from
-- `shipment_no`: a list can carry that number without ever having moved stock,
-- which is precisely the bug being fixed.
update public.packing_lists pl
   set "stock_state" = 'deducted'
 where pl."stock_state" = 'none'
   and exists (
     select 1 from public.stock_movements sm
      where sm.tenant_id = pl.tenant_id
        and sm.ref_type = 'packing_list'
        and sm.ref_id = pl.id
        and sm.kind = 'deduct'
   );
--> statement-breakpoint

-- --- packing_sku_map ----------------------------------------------------------

create table if not exists "packing_sku_map" (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null references "tenants"("id") on delete cascade,
  "product_id" uuid not null references "products"("id") on delete cascade,
  -- '' matches any colour, for styles whose only stocked dimension is size.
  "color" text default '' not null,
  "size_label" text not null,
  "sku_id" uuid not null references "skus"("id") on delete cascade,
  -- auto = guessed from the variant label, manual = chosen by a person.
  "source" text default 'auto' not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);
--> statement-breakpoint

create index if not exists "packing_sku_map_tenant_idx" on "packing_sku_map" ("tenant_id");
--> statement-breakpoint

create unique index if not exists "packing_sku_map_key"
  on "packing_sku_map" ("tenant_id", "product_id", "color", "size_label");
--> statement-breakpoint

-- --- inventory_reservations ---------------------------------------------------

alter table public.inventory_reservations
  add column if not exists "packing_list_id" uuid references "packing_lists"("id") on delete cascade;
--> statement-breakpoint

-- Partial, so order-held rows (packing_list_id null) are untouched by it and the
-- existing inventory_reservations_item index is untouched by packing rows.
create unique index if not exists "inventory_reservations_packing"
  on "inventory_reservations" ("packing_list_id", "sku_id", "warehouse_id")
  where "packing_list_id" is not null;
--> statement-breakpoint

-- --- RLS ----------------------------------------------------------------------
--
-- RLS does not cascade to new tables. Without this, one tenant's style-to-SKU
-- mapping — which names their products and stock codes — is readable by every
-- other tenant.
do $$
begin
  execute 'alter table public.packing_sku_map enable row level security';
  execute 'alter table public.packing_sku_map force row level security';
  execute 'drop policy if exists tenant_isolation on public.packing_sku_map';
  execute
    'create policy tenant_isolation on public.packing_sku_map
       using (tenant_id = public.current_tenant_id())
       with check (tenant_id = public.current_tenant_id())';
  execute 'drop policy if exists platform_admin_all on public.packing_sku_map';
  execute
    'create policy platform_admin_all on public.packing_sku_map
       using (public.is_platform_context())
       with check (public.is_platform_context())';
end $$;
--> statement-breakpoint

-- Guarded because `app_api` is optional by design (0011 stays inert until
-- someone sets a password and repoints DATABASE_URL); an unguarded GRANT on a
-- database where that never happened fails the whole migration.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select, insert, update, delete on public.packing_sku_map to app_api;
  else
    raise notice 'app_api role absent — skipping grant (see 0011_app_api_role.sql)';
  end if;
end $$;
