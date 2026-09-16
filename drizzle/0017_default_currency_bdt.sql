-- The platform default currency becomes BDT (৳).
--
-- Only the COLUMN DEFAULT moves. Existing workspaces keep whatever they are
-- set to, deliberately: a workspace's currency is a claim about what every
-- stored figure means, and there are no exchange rates in this system
-- (src/common/currency.ts). Rewriting a live tenant's currency here would
-- silently restate every price it holds — 1,200 dollars becoming 1,200 taka —
-- with no record that it happened and no way for the owner to notice. Moving
-- an existing workspace is a deliberate act, one click in
-- Configuration → Currency, made by someone who knows what those numbers are.
--
-- What this does change: any tenant row inserted from here on without an
-- explicit currency lands on taka instead of dollars. That covers the
-- provisioning path, seeds, and any future migration that adds a row.
--
-- Verify after applying:
--   select column_name, column_default from information_schema.columns
--    where table_name = 'tenants' and column_name like 'currency%';
--   -- currency -> 'BDT'::text, currency_symbol -> '৳'::text

alter table public.tenants alter column "currency" set default 'BDT';
--> statement-breakpoint

alter table public.tenants alter column "currency_symbol" set default '৳';
