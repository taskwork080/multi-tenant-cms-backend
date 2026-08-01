-- Indexes for server-side pagination.
--
-- The frontend used to pull whole collections and page/sort/filter in the
-- browser, so the only index that mattered was (tenant_id). Now the CRUD list
-- endpoint does LIMIT/OFFSET with ORDER BY created_at DESC plus status filters,
-- and only `activities` had a composite index to support it — every other table
-- was sorting the tenant's full row set in memory per request.
--
-- CONCURRENTLY is deliberately NOT used: these run inside the migration
-- transaction. On a large existing table, run them by hand with CONCURRENTLY
-- outside a transaction instead, then mark this migration applied.

-- Default sort (created_at DESC) on the high-volume tables.
create index if not exists orders_tenant_created_idx     on public.orders          (tenant_id, created_at desc);
create index if not exists products_tenant_created_idx   on public.products        (tenant_id, created_at desc);
create index if not exists customers_tenant_created_idx  on public.customers       (tenant_id, created_at desc);
create index if not exists shipments_tenant_created_idx  on public.shipments       (tenant_id, created_at desc);
create index if not exists returns_tenant_created_idx    on public.return_requests (tenant_id, created_at desc);
create index if not exists reviews_tenant_created_idx    on public.reviews         (tenant_id, created_at desc);
create index if not exists notes_tenant_created_idx      on public.notes           (tenant_id, created_at desc);

-- The order list's status quick-filters and the dashboard's counts.
create index if not exists orders_tenant_delivery_idx on public.orders (tenant_id, delivery_status);
create index if not exists orders_tenant_payment_idx  on public.orders (tenant_id, payment_status);

-- ?q= uses ILIKE '%term%'. A leading wildcard can never use a btree index, so
-- search was a sequential scan over the tenant's rows. pg_trgm makes it an
-- index scan on the columns registered as `searchable` in resource-registry.ts.
create extension if not exists pg_trgm;

create index if not exists products_name_en_trgm  on public.products  using gin (name_en gin_trgm_ops);
create index if not exists products_style_trgm    on public.products  using gin (style_code gin_trgm_ops);
create index if not exists orders_code_trgm       on public.orders    using gin (code gin_trgm_ops);
create index if not exists orders_customer_trgm   on public.orders    using gin (customer_name gin_trgm_ops);
create index if not exists customers_name_trgm    on public.customers using gin (name gin_trgm_ops);
create index if not exists customers_phone_trgm   on public.customers using gin (phone gin_trgm_ops);
create index if not exists categories_name_trgm   on public.categories using gin (name_en gin_trgm_ops);
create index if not exists brands_name_trgm       on public.brands    using gin (name gin_trgm_ops);
create index if not exists sellers_name_trgm      on public.sellers   using gin (name gin_trgm_ops);
create index if not exists promo_codes_code_trgm  on public.promo_codes using gin (code gin_trgm_ops);
