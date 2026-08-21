-- Everything a shopper-placed order needs to survive being placed.
--
-- Until now `orders` recorded a single `total`. That is enough for an order an
-- admin typed in, where the operator knows what they charged, and nowhere near
-- enough for one a stranger placed on a storefront: it cannot say what the
-- delivery cost, what a promo code took off, what surcharge the payment method
-- added, or where the goods are actually going. Storing only the total means
-- the entire checkout breakdown is lost at the moment of sale, and no admin can
-- answer "why is this figure what it is?".
--
-- Every new column on `orders` is nullable or defaults to 0, so every existing
-- row stays valid and reports what an admin-placed order genuinely had: no
-- delivery fee, no discount, no surcharge, no shipping address.
--
-- The two new tables hold what the storefront charges. They are tables and not
-- a jsonb blob on storefront_configs deliberately: the comment above the
-- storefront block in schema.ts reserves jsonb for tenant-authored content, and
-- list-shaped data with a known shape gets a child table here (note_tags,
-- product_tags). A fee also wants to be a numeric the database can sum, not a
-- string inside a document.

-- --- orders: the money, broken out -------------------------------------------

alter table public.orders add column if not exists subtotal numeric(14,2) not null default 0;
--> statement-breakpoint
alter table public.orders add column if not exists savings numeric(14,2) not null default 0;
--> statement-breakpoint
alter table public.orders add column if not exists discount numeric(14,2) not null default 0;
--> statement-breakpoint
alter table public.orders add column if not exists delivery_fee numeric(14,2) not null default 0;
--> statement-breakpoint
alter table public.orders add column if not exists payment_charge numeric(14,2) not null default 0;
--> statement-breakpoint
alter table public.orders add column if not exists promo_code text;
--> statement-breakpoint

-- --- orders: where it goes ---------------------------------------------------

alter table public.orders add column if not exists shipping_name text;
--> statement-breakpoint
alter table public.orders add column if not exists shipping_phone text;
--> statement-breakpoint
alter table public.orders add column if not exists shipping_address text;
--> statement-breakpoint
alter table public.orders add column if not exists shipping_district text;
--> statement-breakpoint
alter table public.orders add column if not exists billing_name text;
--> statement-breakpoint
alter table public.orders add column if not exists billing_phone text;
--> statement-breakpoint
alter table public.orders add column if not exists billing_address text;
--> statement-breakpoint
alter table public.orders add column if not exists notes text;
--> statement-breakpoint

-- --- orders: guest lookup ----------------------------------------------------
--
-- `code` is ORD-1234: quoted over the phone, and guessable in four digits.
-- A public "where is my order" lookup keyed on it alone would hand anyone a
-- stranger's name, phone number and home address. The token is what the
-- confirmation page carries instead. Null for admin-placed orders, which are
-- read through an authenticated session and never need one.

alter table public.orders add column if not exists public_token text;
--> statement-breakpoint
create index if not exists orders_public_token_idx on public.orders (public_token);
--> statement-breakpoint

comment on column public.orders.public_token is
  'Bearer secret for the anonymous order-status lookup. Never expose alongside the code.';
--> statement-breakpoint
comment on column public.orders.savings is
  'List-price savings: sum of (list - offer) across the lines. Distinct from discount, which is the promo code.';
--> statement-breakpoint

-- --- storefront commerce configuration ---------------------------------------

-- The foreign keys are named explicitly to match what drizzle-kit would have
-- generated. An inline `references` lets Postgres pick `..._fkey`, which then
-- disagrees with meta/*_snapshot.json and schedules a pointless drop/recreate
-- on the next `db:generate`.
create table if not exists public.storefront_delivery_zones (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  name text not null,
  -- Null is the catch-all zone: "everywhere else".
  district text,
  fee numeric(12,2) not null default 0,
  sort integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint storefront_delivery_zones_tenant_id_tenants_id_fk
    foreign key (tenant_id) references public.tenants(id) on delete cascade
);
--> statement-breakpoint

create index if not exists storefront_delivery_zones_tenant_idx
  on public.storefront_delivery_zones (tenant_id);
--> statement-breakpoint

-- Postgres treats NULLs as distinct in a unique index, so this constrains named
-- districts without stopping a tenant having exactly one catch-all row. Two
-- catch-alls would make the delivery fee depend on row order.
create unique index if not exists storefront_delivery_zones_tenant_district
  on public.storefront_delivery_zones (tenant_id, district);
--> statement-breakpoint

create table if not exists public.storefront_payment_methods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  code text not null,
  label text not null,
  description text not null default '',
  -- A fraction, not a percentage: 0.0250 is 2.5%.
  fee_pct numeric(6,4) not null default 0,
  skips_delivery boolean not null default false,
  pay_on_delivery boolean not null default false,
  sort integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint storefront_payment_methods_tenant_id_tenants_id_fk
    foreign key (tenant_id) references public.tenants(id) on delete cascade
);
--> statement-breakpoint

create index if not exists storefront_payment_methods_tenant_idx
  on public.storefront_payment_methods (tenant_id);
--> statement-breakpoint

create unique index if not exists storefront_payment_methods_tenant_code
  on public.storefront_payment_methods (tenant_id, code);
--> statement-breakpoint

-- --- RLS ---------------------------------------------------------------------
--
-- RLS does not cascade to new tables (0009_storefront_rls.sql). Both of these
-- are read on the anonymous checkout path, but always inside
-- TenantDb.forTenant() — the tenant is resolved from the host first — so unlike
-- storefront_configs they can be FORCEd like every other tenant table.
--
-- The platform_admin_all policy is additive and keys off asPlatform(), so the
-- import script and any cross-tenant admin tooling can seed these rows.
--
-- Verify before deploying:
--   select relname, relrowsecurity, relforcerowsecurity from pg_class
--    where relname like 'storefront_delivery%' or relname like 'storefront_payment%';
--   -- both must be true/true

do $$
declare
  t text;
begin
  foreach t in array array[
    'storefront_delivery_zones','storefront_payment_methods'
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

-- 0011_app_api_role.sql set default privileges for future tables, but only for
-- objects created by the role that ran it. Granting explicitly costs nothing
-- and means the next feature does not ship a permission-denied error.
--
-- Guarded because `app_api` is optional by design: 0011 says it stays inert
-- until someone sets a password and repoints DATABASE_URL, and a database where
-- that never happened has no such role. An unguarded GRANT there fails the
-- whole migration — which is how this file first refused to apply.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select, insert, update, delete
      on public.storefront_delivery_zones, public.storefront_payment_methods
      to app_api;
  else
    raise notice 'app_api role absent — skipping grant (see 0011_app_api_role.sql)';
  end if;
end $$;
