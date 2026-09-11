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

**Migrations run before the new version starts, never in the start command.** In the start command a
failed migration crash-loops the service on every boot, taking the previous working version down with it.
Run before start, a failure aborts the deploy and the old version keeps serving.

On the **free** plan (current) they run at the end of `buildCommand`, because free has no
`preDeployCommand`; Render passes the service's env vars to the build, so `MIGRATE_DATABASE_URL` is there.
On **starter** and above, move them to `preDeployCommand` — Render's dedicated step for this, which also
keeps a rebuild from touching the database.

**Free plan limits.** The service sleeps after ~15 minutes idle. While asleep the `@nestjs/schedule` jobs in
[`src/maintenance/maintenance.service.ts`](../src/maintenance/maintenance.service.ts) (reservation expiry
every 10 minutes, promo status hourly) do not run, Socket.IO clients are disconnected, and the first
request back takes ~50 seconds. Fine for a trial; switch the instance type to Starter before real tenants
depend on it.

**Two database roles.** `DATABASE_URL` is the `app_api` role from
[`drizzle/0011_app_api_role.sql`](../drizzle/0011_app_api_role.sql) — `NOBYPASSRLS` and DML-only, so RLS
actually applies to the API. That role has no DDL, so migrations would fail on it; `MIGRATE_DATABASE_URL`
carries the owner (`postgres`) string for `scripts/migrate.ts` alone. Nothing in `src/` reads it.

**One instance.** The Socket.IO gateway has no Redis adapter, `@nestjs/throttler` counts in memory, and the
`@nestjs/schedule` cron jobs are not leader-gated. A second instance duplicates cron work, multiplies rate
limits, and splits realtime rooms. Scale the instance up, not out.

**Render's npm is not necessarily yours.** Render installs the Node version in `.nvmrc` and uses the npm
bundled with it — npm 10 for Node 22 — while a local machine may run npm 11. The two validate lockfiles
differently: npm 10 rejects a lock that leaves an *optional* peer dependency installed at an out-of-range
version, and npm 11 accepts it. The first deploy failed exactly this way (`npm ci` → `Missing:
esbuild@0.28.2 from lock file`, from vitest's nested vite). After any dependency change, check the lock the
way Render will before pushing:

```bash
npx -y npm@10 ci --dry-run
```

If it fails, `npx -y npm@10 install --package-lock-only` rewrites the lock so both versions accept it.

---

## 1. Supabase production project

1. Create a **separate** project for production. Never share a database with development.
   Choose region **Southeast Asia (Singapore) `ap-southeast-1`** and keep `render.yaml`'s `region` on
   `singapore` to match. Users are in Bangladesh (see the phone validation in
   [`src/storefront/checkout.schemas.ts`](../src/storefront/checkout.schemas.ts)), every request makes
   several round trips to Postgres, and **a Supabase region cannot be changed after creation** — it is the
   one decision here with no cheap fix.
   Save the generated database password immediately; it is shown once, and resetting it later breaks every
   live connection string.
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

Set a password on `app_api` (created by [`drizzle/0011_app_api_role.sql`](../drizzle/0011_app_api_role.sql))
in the SQL editor. Use letters and digits only, about 32 characters: no URL-encoding in the connection
string, no quote-escaping in SQL, nothing the shell can misread. Then delete that query from the editor,
which keeps it as a saved snippet otherwise.

```sql
alter role app_api with password '<letters-and-digits>';
```

Until the API runs as `app_api`, RLS is inert — `postgres` has `rolbypassrls`, so the only tenant boundary
is the `WHERE tenant_id = ...` clauses in application code, and one forgotten clause is a cross-tenant
leak. On the development database, a connection as `postgres` with a *random* `app.tenant_id` still sees
every product.

Note the pooler username is `app_api.<project-ref>`, not `app_api` as the comment in 0011 shows — the
pooler routes on that suffix and rejects the bare role name.

**Verify the role before pointing anything at it.** Log in as `app_api` through the pooler and confirm:
it does not bypass RLS; a `select` on `tenants`, and on `products` with `app.tenant_id` set, both succeed;
`alter table ... disable row level security` is refused (no ownership); and `public.platform_admin_count`
is readable. [`0016_tenant_id_without_auth_schema.sql`](../drizzle/0016_tenant_id_without_auth_schema.sql)
exists because the reads failed here with `permission denied for schema auth` — every tenant query would
have failed in production.

**The behavioural isolation check needs data, so it runs after step 7**, not here. On an empty database
`select count(*) from products` returns 0 whether RLS works or not. Once real tenants exist, as `app_api`:

```sql
select count(*) from products;                              -- no tenant set: must be 0
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
- **Migrations run on deploy.** Push a trivial commit and confirm `Migrations applied.` appears in the
  deploy log before the new instance starts — at the end of the build on free, in the pre-deploy step on
  starter.
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
