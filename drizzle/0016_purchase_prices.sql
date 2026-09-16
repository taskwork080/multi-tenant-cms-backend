-- Purchase price history: a real supplier domain, and what each line cost.
--
-- THE PROBLEM
--
-- `inbound_receipt_items.unit_cost` has existed since the inventory core, and
-- the Receive Stock drawer has always collected it — but POST
-- /api/:tenant/inventory/receive (the endpoint that drawer calls) parsed
-- `supplierName`, `referenceNo` and every line's `unitCost` and then wrote only
-- the stock movement. No `inbound_receipts` row was created, so every price and
-- supplier a user typed was discarded at the door. There is consequently no
-- purchase history to report on, and no way to answer "what did I pay for this
-- last time, and to whom".
--
-- This migration adds the columns that answer it. The controller change that
-- starts writing them ships alongside.
--
-- WHAT CHANGES
--
--   1. `suppliers` — a real entity. The comment above inbound_receipts reserved
--      room for one; free-text supplier_name cannot group a price history,
--      because "ACME", "Acme Ltd" and "acme" are three suppliers to a GROUP BY.
--   2. `inbound_receipts.supplier_id` — the FK. supplier_name stays beside it,
--      denormalized, so exports need no join and a receipt keeps naming its
--      supplier after that supplier row is deleted.
--   3. `inbound_receipt_items.line_total` + `cost_mode` — bulk pricing. A lot
--      price does not divide evenly (7 boxes for 100.00 is 14.285714… each),
--      so storing only a rounded unit cost and recomputing the total yields
--      99.99, a figure matching no invoice. Both are stored, and `cost_mode`
--      records which one was typed.
--
-- Every column added here is nullable or defaulted, so existing rows stay
-- valid. Existing receipts simply have no supplier_id and cost_mode 'unit',
-- which is exactly what they were.
--
-- Verify after applying:
--   select relname, relrowsecurity, relforcerowsecurity from pg_class
--    where relname = 'suppliers';
--   -- must be true/true

-- --- suppliers ----------------------------------------------------------------

create table if not exists "suppliers" (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null references "tenants"("id") on delete cascade,
  "name" text not null,
  "code" text,
  "contact_name" text,
  "phone" text,
  "email" text,
  "address" text,
  "tax_id" text,
  "payment_terms" text,
  "notes" text,
  "active" boolean default true not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);
--> statement-breakpoint

create index if not exists "suppliers_tenant_idx" on "suppliers" ("tenant_id");
--> statement-breakpoint

-- Names are what people type and what the purchase log groups by, so
-- duplicates are prevented here rather than deduplicated in every report.
create unique index if not exists "suppliers_tenant_name" on "suppliers" ("tenant_id", "name");
--> statement-breakpoint

-- --- inbound_receipts: the supplier link --------------------------------------

-- SET NULL, not CASCADE: deleting a supplier must not erase the purchase
-- history that proves what was bought from them.
alter table public.inbound_receipts
  add column if not exists "supplier_id" uuid references "suppliers"("id") on delete set null;
--> statement-breakpoint

create index if not exists "inbound_receipts_supplier_idx"
  on "inbound_receipts" ("tenant_id", "supplier_id");
--> statement-breakpoint

-- --- inbound_receipt_items: bulk pricing --------------------------------------

alter table public.inbound_receipt_items
  add column if not exists "line_total" numeric(14, 2);
--> statement-breakpoint

alter table public.inbound_receipt_items
  add column if not exists "cost_mode" text default 'unit' not null;
--> statement-breakpoint

-- Existing rows were priced per unit, so their line total is the product. Only
-- fills rows that actually carry a cost — a line with no price recorded keeps
-- having no price, rather than gaining a fabricated 0.00.
update public.inbound_receipt_items
   set "line_total" = round("unit_cost" * "qty", 2)
 where "unit_cost" is not null
   and "line_total" is null;
--> statement-breakpoint

-- The purchase-price log reads "every line for this SKU, newest first".
create index if not exists "inbound_receipt_items_sku_idx"
  on "inbound_receipt_items" ("tenant_id", "sku_id");
--> statement-breakpoint

-- --- RLS ----------------------------------------------------------------------
--
-- RLS does not cascade to new tables. Without this, one tenant's supplier list
-- — names, contacts, payment terms — is readable by every other tenant.
do $$
begin
  execute 'alter table public.suppliers enable row level security';
  execute 'alter table public.suppliers force row level security';
  execute 'drop policy if exists tenant_isolation on public.suppliers';
  execute
    'create policy tenant_isolation on public.suppliers
       using (tenant_id = public.current_tenant_id())
       with check (tenant_id = public.current_tenant_id())';
  execute 'drop policy if exists platform_admin_all on public.suppliers';
  execute
    'create policy platform_admin_all on public.suppliers
       using (public.is_platform_context())
       with check (public.is_platform_context())';
end $$;
--> statement-breakpoint

-- 0011_app_api_role.sql set default privileges for future tables, but only for
-- objects created by the role that ran it. Granting explicitly costs nothing.
--
-- Guarded because `app_api` is optional by design (0011 stays inert until
-- someone sets a password and repoints DATABASE_URL); an unguarded GRANT on a
-- database where that never happened fails the whole migration.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select, insert, update, delete on public.suppliers to app_api;
  else
    raise notice 'app_api role absent — skipping grant (see 0011_app_api_role.sql)';
  end if;
end $$;
