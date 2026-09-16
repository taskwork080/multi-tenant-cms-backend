-- The other bills on a delivery, and what the goods therefore actually cost.
--
-- THE PROBLEM
--
-- A receipt records what the supplier charged for the goods. On an import that
-- is rarely what the goods cost to have standing in the warehouse: freight,
-- customs duty, the clearing agent, inland transport and loading can add a
-- large fraction of the invoice again. None of it was capturable, so the
-- purchase price log reported an invoice price and called it the cost.
--
-- WHAT THIS ADDS
--
--   1. `inbound_receipt_charges` — one row per extra bill. A child table rather
--      than a fixed freight/duty/other trio, because the set is not knowable:
--      every trade and route has its own charges, and a fixed few would push
--      the rest into "other" and lose the detail worth recording.
--   2. `inbound_receipts.charges_total` / `charge_basis` — the sum, and how it
--      is spread (by line value, or by quantity).
--   3. `inbound_receipt_items.allocated_charge` / `landed_total` /
--      `landed_unit_cost` — this line's share, and the resulting true cost.
--
-- `line_total` is deliberately left alone. The supplier billed that figure and
-- it has to keep reconciling against their invoice; the landed columns sit
-- beside it rather than replacing it.
--
-- Every column added here is nullable or defaults to 0, so existing receipts
-- stay valid and simply report no extra charges — which is what they had.
--
-- Verify after applying:
--   select relname, relrowsecurity, relforcerowsecurity from pg_class
--    where relname = 'inbound_receipt_charges';
--   -- must be true/true

-- --- the charges ---------------------------------------------------------------

create table if not exists "inbound_receipt_charges" (
  "id" uuid primary key default gen_random_uuid() not null,
  "tenant_id" uuid not null references "tenants"("id") on delete cascade,
  "receipt_id" uuid not null references "inbound_receipts"("id") on delete cascade,
  "label" text default '' not null,
  "amount" numeric(14, 2) default 0 not null,
  "note" text,
  "sort" integer default 0 not null
);
--> statement-breakpoint

create index if not exists "inbound_receipt_charges_receipt_idx"
  on "inbound_receipt_charges" ("receipt_id");
--> statement-breakpoint

-- --- the receipt totals --------------------------------------------------------

alter table public.inbound_receipts
  add column if not exists "charges_total" numeric(14, 2) default 0 not null;
--> statement-breakpoint

-- value = in proportion to what each line cost (duty, insurance).
-- qty   = in proportion to pieces (freight, handling).
alter table public.inbound_receipts
  add column if not exists "charge_basis" text default 'value' not null;
--> statement-breakpoint

-- --- the per-line landed cost --------------------------------------------------

alter table public.inbound_receipt_items
  add column if not exists "allocated_charge" numeric(14, 2) default 0 not null;
--> statement-breakpoint

alter table public.inbound_receipt_items
  add column if not exists "landed_total" numeric(14, 2);
--> statement-breakpoint

alter table public.inbound_receipt_items
  add column if not exists "landed_unit_cost" numeric(12, 2);
--> statement-breakpoint

-- Existing lines carried no extra charges, so their landed cost is simply what
-- was billed. Only fills lines that actually have a price — a line with no cost
-- recorded keeps having none, rather than gaining a fabricated 0.00.
update public.inbound_receipt_items
   set "landed_total" = "line_total",
       "landed_unit_cost" = "unit_cost"
 where "line_total" is not null
   and "landed_total" is null;
--> statement-breakpoint

-- --- RLS ------------------------------------------------------------------------
--
-- RLS does not cascade to new tables. Without this, one tenant's freight and
-- duty figures — which reveal their margins — are readable by every other.
do $$
begin
  execute 'alter table public.inbound_receipt_charges enable row level security';
  execute 'alter table public.inbound_receipt_charges force row level security';
  execute 'drop policy if exists tenant_isolation on public.inbound_receipt_charges';
  execute
    'create policy tenant_isolation on public.inbound_receipt_charges
       using (tenant_id = public.current_tenant_id())
       with check (tenant_id = public.current_tenant_id())';
  execute 'drop policy if exists platform_admin_all on public.inbound_receipt_charges';
  execute
    'create policy platform_admin_all on public.inbound_receipt_charges
       using (public.is_platform_context())
       with check (public.is_platform_context())';
end $$;
--> statement-breakpoint

-- Guarded because `app_api` is optional by design (0011 stays inert until
-- someone sets a password and repoints DATABASE_URL).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select, insert, update, delete on public.inbound_receipt_charges to app_api;
  else
    raise notice 'app_api role absent — skipping grant (see 0011_app_api_role.sql)';
  end if;
end $$;
