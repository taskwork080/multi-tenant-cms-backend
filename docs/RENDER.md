# Deploying the API to Render

The NestJS API runs on Render as a single always-on web service, defined by
[`render.yaml`](../render.yaml) at the repo root. Supabase (Postgres + Auth) and Cloudflare R2 stay where
they are; the Next.js admin app is deployed separately.

Work through this top to bottom. Steps 1–3 happen **before** the service exists — the order is what makes
the first deploy boring.

---

## Why Render is configured the way it is

Four constraints in this codebase drive every non-obvious choice below.

**The Supabase pooler is mandatory, not a preference.** `db.<project-ref>.supabase.co` resolves to IPv6
only, and Render's outbound network is IPv4. A direct connection string cannot work from Render — it fails
with `ENETUNREACH` or a DNS error that looks like a credentials problem. Use the **Session Pooler** host
(`aws-<n>.pooler.supabase.com:5432`). The driver is already pooler-safe: `prepare: false, max: 10` in
[`src/db/db.module.ts`](../src/db/db.module.ts).

**Migrations run as a pre-deploy step, never in the start command.** In the start command a failed
migration crash-loops the service on every boot, taking the previous working version down with it. As
Render's `preDeployCommand`, a failure aborts the deploy and the old version keeps serving.

**Two database roles.** `DATABASE_URL` is the `app_api` role from
[`drizzle/0011_app_api_role.sql`](../drizzle/0011_app_api_role.sql) — `NOBYPASSRLS` and DML-only, so RLS
actually applies to the API. That role has no DDL, so migrations would fail on it; `MIGRATE_DATABASE_URL`
carries the owner (`postgres`) string for `scripts/migrate.ts` alone. Nothing in `src/` reads it.

**One instance.** The Socket.IO gateway has no Redis adapter, `@nestjs/throttler` counts in memory, and the
`@nestjs/schedule` cron jobs are not leader-gated. A second instance duplicates cron work, multiplies rate
limits, and splits realtime rooms. Scale the instance up, not out.

---

## 1. Supabase production project

1. Create a **separate** project for production. Never share a database with development.
2. Dashboard → **Connect** → copy the **Session Pooler** string. Note the username form is
   `<role>.<project-ref>` — so `postgres.abcdefghijkl`, and after step 3, `app_api.abcdefghijkl`.
3. Copy `SUPABASE_URL` (`https://<ref>.supabase.co`), the publishable/anon key, and the service-role key.

## 2. Apply migrations once, from your machine

Run this locally against the production database so you can read the output, rather than discovering a
schema problem inside a deploy log:

```bash
MIGRATE_DATABASE_URL="postgresql://postgres.<ref>:<pw>@aws-<n>.pooler.supabase.com:5432/postgres" \
  npm run db:migrate
```

Then note the high-water mark, because `drizzle/meta/_journal.json` uses synthetic `when` values and the
migrator only applies entries newer than the newest row here — a new migration can otherwise be **silently
skipped** while still printing "Migrations applied.":

```sql
select max(created_at) from drizzle.__drizzle_migrations;
```

Run that on the development database too. Production starts clean, so the two will diverge; before writing
any new migration, pick a `when` above the higher of the two.

## 3. Switch to the non-bypass role

Follow the steps in [`drizzle/0011_app_api_role.sql`](../drizzle/0011_app_api_role.sql) to set a password
on `app_api`. Until this is done RLS is inert — `postgres` has `rolbypassrls`, so the only tenant boundary
is the `WHERE tenant_id = ...` clauses in application code, and one forgotten clause is a cross-tenant
leak. Verify it took before going further:

```sql
-- connected as app_api, with no tenant set
select count(*) from products;                              -- must be 0
select set_config('app.tenant_id', '<a-tenant-uuid>', false);
select count(*) from products;                              -- only that tenant's rows
```

If the first query returns rows, you are still connected as a bypassing role.

## 4. Create the Render service

Dashboard → **New → Blueprint** → connect this repo. Render reads `render.yaml` and prompts for every
`sync: false` variable:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `postgresql://app_api.<ref>:<pw>@aws-<n>.pooler.supabase.com:5432/postgres` |
| `MIGRATE_DATABASE_URL` | same host, `postgres.<ref>` user and its password |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | from the Supabase dashboard |
| `SUPABASE_SERVICE_ROLE_KEY` | **server-only** — bypasses RLS and can mint sessions for any account |
| `SUPABASE_JWT_SECRET` | leave empty unless you need legacy HS256; empty means JWKS verification |
| `CORS_ORIGIN` | `https://app.yourdomain.com` — exact scheme, no trailing slash |
| `FRONTEND_URL` | `https://app.yourdomain.com` |
| `STOREFRONT_ROOT_DOMAIN` | `yourdomain.com` |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | all three or none — two of three fails at boot |
| `R2_PUBLIC_URL` | public CDN base for assets |

Do **not** add `PORT` (Render injects it) or `ENABLE_DOCS` (unset keeps Swagger off in production, where it
would be an unauthenticated inventory of every route and payload).

Boot validation in [`src/config/env.validation.ts`](../src/config/env.validation.ts) lists every missing or
malformed variable in a single startup error, so a wrong value fails fast and legibly in the Render log
instead of half-working.

## 5. Custom domain

Service → **Settings → Custom Domains** → add `api.yourdomain.com`, then create the CNAME Render gives you
at your DNS provider. If you use Cloudflare, keep the record **DNS-only (grey cloud)** until Render has
issued the certificate.

Then point the admin app's `NEXT_PUBLIC_API_URL` at `https://api.yourdomain.com`. That value is inlined
into the JS bundle at `next build` time, so the frontend needs a **rebuild** — changing the environment
variable alone does nothing.

## 6. R2 bucket CORS

Add a rule on the production bucket allowing `PUT` and `GET` from `https://app.yourdomain.com`. This is a
third allowlist, independent of the API's `CORS_ORIGIN` and the gateway's copy of it in
[`src/chat/chat.gateway.ts`](../src/chat/chat.gateway.ts) — miss it and uploads fail only in production,
while working locally.

## 7. First platform admin

Run `npm run user:create` locally against the production database, or from Render's **Shell** tab. It needs
`SUPABASE_SERVICE_ROLE_KEY`.

---

## Verifying the deploy

```bash
curl -i https://api.yourdomain.com/health   # 200, {"status":"ok","database":"ok",...}
curl -i https://api.yourdomain.com/docs     # 404 — Swagger is off in production
```

- **The health check is honest.** [`src/health.controller.ts`](../src/health.controller.ts) returns **503**
  when the `select 1` probe fails, so Render will not route traffic to a container with a broken
  `DATABASE_URL`. Confirm it on a throwaway service by setting a bad `DATABASE_URL` and checking for 503,
  not 200. The trade-off is deliberate: a sustained Postgres outage will make Render restart the service.
- **The pre-deploy step runs.** Push a trivial commit and confirm `Migrations applied.` appears in the
  deploy log before the new instance starts.
- **A migration failure is safe.** Temporarily point `MIGRATE_DATABASE_URL` at a bad host, deploy, and
  confirm Render aborts with the previous version still serving.
- **Isolation** — the `app_api` check from step 3, re-run against production.
- End-to-end: log in, switch tenants, upload an image (no CORS error in devtools, asset loads from
  `R2_PUBLIC_URL`), open two browsers on one tenant and confirm realtime.
- Confirm the 10-minute reservation-expiry cron logs on schedule.
- **Rollback drill**: Deploys tab → a previous deploy → **Redeploy**. Do this once, on purpose, while
  nothing is wrong, and time it. Caveat: rollback only saves you if the old code still works against the
  new schema — which is why migrations must be additive (expand → migrate → contract), and why you should
  never ship a destructive migration in the same deploy as the code change that needs it.

## Not covered here

Error tracking (Sentry), JSON logs with request IDs, an uptime probe on `/health`, and CI. None are needed
to get onto Render; all are worth the same week.
