-- Backfill for the inventory core added in 0005, plus the constraints
-- drizzle-kit can't express (partial unique indexes, the non-negative check).
--
-- Runs BEFORE 0007 enables RLS on these tables deliberately: RLS is *forced*,
-- so once the policies exist every statement here would need app.tenant_id set
-- per tenant. Backfilling first keeps this a single set-based migration.
--
-- Idempotent throughout (`on conflict do nothing`, `where not exists`) so it
-- can be re-run against a partially migrated database.
--
-- Hand-written — no snapshot in drizzle/meta, same as 0004_list_indexes.sql.

-- 0. Lift FORCE row level security for the duration of this backfill -----------
--
-- 0001_rls.sql forces RLS onto the table owner — the same `postgres` role
-- scripts/migrate.ts connects as — and this migration sets no app.tenant_id.
-- current_tenant_id() is therefore NULL, every tenant_isolation policy
-- evaluates to false, and every existing row below would be invisible: the
-- migration would report success having created zero SKUs and zero levels,
-- with nothing pointing at the cause. Silence is the dangerous failure here.
--
-- DDL is transactional in Postgres, so if any step below aborts, the rollback
-- restores FORCE with it — there is no window where isolation is weakened
-- after a failure. The mirror-image loop at the end of this file restores it
-- on success. `set local row_security = off` is not an option: it errors for
-- roles without BYPASSRLS rather than bypassing, and `set local role` cannot
-- help because FORCE applies to the owner itself.
do $$
declare
  t text;
begin
  foreach t in array array[
    'products','product_variants','stock_batches','order_items',
    'packing_items','shipment_items','warehouses'
  ]
  loop
    execute format('alter table public.%I no force row level security', t);
  end loop;
end $$;
--> statement-breakpoint

-- A. Collapse duplicate stock_batches ------------------------------------------
-- `receive` has always upserted on (tenant, product, warehouse) but no unique
-- index enforced it, so duplicates may exist. Sum them into the oldest row
-- before the partial unique index below can reject them.
with ranked as (
  select id,
         row_number() over (
           partition by tenant_id, product_id, warehouse_id order by created_at, id
         ) as rn,
         sum(quantity) over (
           partition by tenant_id, product_id, warehouse_id
         ) as total
    from public.stock_batches
   where product_id is not null and warehouse_id is not null
)
update public.stock_batches b
   set quantity = r.total
  from ranked r
 where b.id = r.id and r.rn = 1 and b.quantity <> r.total;
--> statement-breakpoint

delete from public.stock_batches b
 using (
   select id,
          row_number() over (
            partition by tenant_id, product_id, warehouse_id order by created_at, id
          ) as rn
     from public.stock_batches
    where product_id is not null and warehouse_id is not null
 ) r
 where b.id = r.id and r.rn > 1;
--> statement-breakpoint

create unique index if not exists stock_batches_tenant_prod_wh
  on public.stock_batches (tenant_id, product_id, warehouse_id)
  where product_id is not null and warehouse_id is not null;
--> statement-breakpoint

-- SKU constraints. The plain unique on (tenant_id, variant_id) from 0005 does
-- not cover default SKUs: Postgres treats NULLs as distinct, so without this a
-- product could accumulate any number of them.
create unique index if not exists skus_tenant_product_default
  on public.skus (tenant_id, product_id)
  where variant_id is null;
--> statement-breakpoint

create unique index if not exists skus_tenant_barcode_uq
  on public.skus (tenant_id, barcode)
  where barcode is not null;
--> statement-breakpoint

-- B. One SKU per variant --------------------------------------------------------
-- Keyed off variant_id, not label: product_variants has no unique on
-- (product_id, label). The 4-char id suffix guarantees code uniqueness without
-- a collision loop — backfilled codes are a little uglier than generated ones.
insert into public.skus
  (tenant_id, product_id, variant_id, code, name, unit, is_default, low_stock_threshold)
select v.tenant_id,
       v.product_id,
       v.id,
       upper(
         trim(both '-' from regexp_replace(
           left(coalesce(nullif(p.style_code, ''), p.slug), 12), '[^A-Za-z0-9]+', '-', 'g'))
       )
       || '-' ||
       upper(
         trim(both '-' from regexp_replace(left(v.label, 12), '[^A-Za-z0-9]+', '-', 'g'))
       )
       || '-' || left(replace(v.id::text, '-', ''), 4),
       p.name_en || ' — ' || v.label,
       p.unit,
       false,
       10
  from public.product_variants v
  join public.products p on p.id = v.product_id
on conflict do nothing;
--> statement-breakpoint

-- C. Default SKU for every product ---------------------------------------------
-- Created for products *with* variants too, so an order line that names no
-- variant always resolves to something.
insert into public.skus
  (tenant_id, product_id, variant_id, code, name, unit, is_default, low_stock_threshold)
select p.tenant_id,
       p.id,
       null,
       upper(
         trim(both '-' from regexp_replace(
           left(coalesce(nullif(p.style_code, ''), p.slug), 12), '[^A-Za-z0-9]+', '-', 'g'))
       )
       || '-STD-' || left(replace(p.id::text, '-', ''), 4),
       p.name_en,
       p.unit,
       true,
       10
  from public.products p
on conflict do nothing;
--> statement-breakpoint

-- D. inventory_levels from stock_batches ---------------------------------------
-- Into the product's default SKU: variant-level stock has never existed, so
-- there is nothing to split.
insert into public.inventory_levels
  (tenant_id, sku_id, warehouse_id, on_hand, reserved, low_stock_threshold,
   sku_code, sku_name, warehouse_name)
select b.tenant_id, s.id, b.warehouse_id, b.quantity, 0,
       nullif(b.low_stock_threshold, 0), s.code, s.name, w.name
  from public.stock_batches b
  join public.skus s
    on s.tenant_id = b.tenant_id and s.product_id = b.product_id and s.variant_id is null
  join public.warehouses w on w.id = b.warehouse_id
 where b.product_id is not null and b.warehouse_id is not null
on conflict (tenant_id, sku_id, warehouse_id) do nothing;
--> statement-breakpoint

-- Link the legacy batch rows to what they became.
update public.stock_batches b
   set sku_id = s.id,
       inventory_level_id = l.id
  from public.skus s
  join public.inventory_levels l on l.sku_id = s.id
 where s.tenant_id = b.tenant_id
   and s.product_id = b.product_id
   and s.variant_id is null
   and l.warehouse_id = b.warehouse_id
   and b.sku_id is null;
--> statement-breakpoint

-- E. Orphan stock ---------------------------------------------------------------
-- `receive` is the only writer of stock_batches, but bulk import writes
-- products.stock directly — so a product can carry stock with no batch row.
-- Land the residual in the tenant's primary warehouse. Tenants with no
-- warehouse are skipped; the Overview page surfaces them as a nudge.
insert into public.inventory_levels
  (tenant_id, sku_id, warehouse_id, on_hand, reserved, sku_code, sku_name, warehouse_name)
select p.tenant_id, s.id, w.id, p.stock - coalesce(b.batched, 0), 0, s.code, s.name, w.name
  from public.products p
  join public.skus s
    on s.tenant_id = p.tenant_id and s.product_id = p.id and s.variant_id is null
  join lateral (
    select w2.id, w2.name
      from public.warehouses w2
     where w2.tenant_id = p.tenant_id and w2.status = 'active'
     order by (w2.type = 'central') desc, w2.created_at
     limit 1
  ) w on true
  left join lateral (
    select sum(b2.quantity) as batched
      from public.stock_batches b2
     where b2.tenant_id = p.tenant_id and b2.product_id = p.id
  ) b on true
 where p.stock - coalesce(b.batched, 0) > 0
on conflict (tenant_id, sku_id, warehouse_id) do nothing;
--> statement-breakpoint

-- F. Opening-balance ledger row per created level -------------------------------
insert into public.stock_movements
  (tenant_id, sku_id, warehouse_id, kind, qty, reserved_delta,
   on_hand_after, reserved_after, ref_type, reason, actor, at)
select l.tenant_id, l.sku_id, l.warehouse_id, 'adjust', l.on_hand, 0,
       l.on_hand, 0, 'manual', 'opening_balance', 'migration', now()
  from public.inventory_levels l
 where not exists (
   select 1 from public.stock_movements m
    where m.sku_id = l.sku_id and m.warehouse_id = l.warehouse_id
      and m.reason = 'opening_balance'
 );
--> statement-breakpoint

-- G. Point historical order lines at the product's default SKU -------------------
-- No reservations are created for historical orders: those would be phantom
-- holds against stock that has already physically shipped.
update public.order_items oi
   set sku_id = s.id
  from public.skus s
 where s.tenant_id = oi.tenant_id
   and s.product_id = oi.product_id
   and s.variant_id is null
   and oi.sku_id is null
   and oi.product_id is not null;
--> statement-breakpoint

update public.packing_items pi
   set sku_id = s.id
  from public.skus s
 where s.tenant_id = pi.tenant_id
   and s.product_id = pi.product_id
   and s.variant_id is null
   and pi.sku_id is null
   and pi.product_id is not null;
--> statement-breakpoint

update public.shipment_items si
   set sku_id = s.id
  from public.skus s
 where s.tenant_id = si.tenant_id
   and s.product_id = si.product_id
   and s.variant_id is null
   and si.sku_id is null
   and si.product_id is not null;
--> statement-breakpoint

-- H. Grant the new inventory sub-modules ----------------------------------------
-- CrudService.resolve() 403s a resource whose module is not entitled, so
-- without this every tenant that already had `inventory` would get 403s on the
-- new sub-pages the moment the frontend ships.
insert into public.tenant_entitlements (tenant_id, module)
select te.tenant_id, m
  from public.tenant_entitlements te
 cross join unnest(array[
   'inventoryInbound','inventoryOutbound','inventoryTransfers','inventoryCounts'
 ]) as m
 where te.module = 'inventory'
on conflict do nothing;
--> statement-breakpoint

-- I. Reconcile the products.stock mirror ----------------------------------------
-- From here on products.stock is derived, never written directly. This
-- statement is also the fix for the old adjust endpoint clamping the mirror at
-- zero while decrementing batches independently, which let the two drift.
update public.products p
   set stock = coalesce(agg.total, 0)
  from (
    select s.product_id, sum(l.on_hand) as total
      from public.skus s
      join public.inventory_levels l on l.sku_id = s.id
     group by s.product_id
  ) agg
 where agg.product_id = p.id
   and p.stock_mode = 'tracked'
   and p.stock <> coalesce(agg.total, 0);
--> statement-breakpoint

-- The hard oversell backstop. Added last, after the backfill has settled, so a
-- pre-existing negative can't abort the whole migration silently.
alter table public.inventory_levels
  drop constraint if exists inventory_levels_nonneg;
--> statement-breakpoint
alter table public.inventory_levels
  add constraint inventory_levels_nonneg
  check (on_hand >= 0 and reserved >= 0 and incoming >= 0);
--> statement-breakpoint

-- Z. Restore FORCE row level security -------------------------------------------
-- Mirror of step 0. Must stay the last statement in this file: tenant
-- isolation is not optional, and leaving it lifted would let any query that
-- forgets a WHERE tenant_id read across tenants.
do $$
declare
  t text;
begin
  foreach t in array array[
    'products','product_variants','stock_batches','order_items',
    'packing_items','shipment_items','warehouses'
  ]
  loop
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;
