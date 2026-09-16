# Environments — development and production

Two Supabase projects, two sets of credentials, one repository. This file says which is which, where
each value lives, and how to run a command against either without mixing them up.

| | Development | Production |
|---|---|---|
| Supabase project | `idhdbwmgbmacdrbqafau` (ap-northeast-1, Tokyo) | `luxzdjoctrxdlxsjxxlq` (ap-southeast-1, Singapore) |
| Local file | `.env` | `.env.prod` |
| `APP_ENV` | `development` | `production` |
| Deployed API | none — you run it locally | `https://multi-tenant-cms-api.onrender.com` |
| Admin app | `http://localhost:5000` | Vercel |

Neither file is committed: `.gitignore` covers `.env` and `.env.*`, and only `.env.example` is tracked.

---

## Running a command against an environment

Development is the default, so nothing changes for everyday work:

```bash
npm run db:migrate          # development
npm run user:create -- someone@example.com 'password' acme owner
```

Production takes two flags — the target, and an acknowledgement that you mean it:

```bash
npm run db:migrate -- --env=prod --allow-prod
```

Every one of these scripts prints what it is about to touch, before it touches it:

```
▸ environment: PRODUCTION  (.env.prod)
  supabase: luxzdjoctrxdlxsjxxlq
  database: postgres.luxzdjoctrxdlxsjxxlq@aws-0-ap-southeast-1.pooler.supabase.com
```

`--env=prod` without `--allow-prod` refuses and prints the project it would have used. The flags are
consumed by the loader ([`scripts/lib/env-target.ts`](../scripts/lib/env-target.ts)), so a script's own
arguments — positional ones, `--yes`, `--force`, `--dry` — are unaffected.

Covered: `db:migrate`, `db:seed`, `db:reset-users`, `db:backfill`, `user:create`, `import:365`,
`roles:audit`.

`db:migrate:deployed` is a different thing: the compiled runner Render calls during its build, where the
credentials come from the service's own environment and there is no env file. Run locally it would read
`.env` and migrate **development** — use `db:migrate -- --env=prod --allow-prod` instead. (`db:migrate:prod`
remains as an alias so a Blueprint that has not yet re-read `render.yaml` keeps working; it can be deleted
once Render has synced.)

### Why this exists

The scripts used to load `.env` and only `.env`. Pointing one at production meant exporting half a dozen
variables by hand, and missing one silently mixed environments — reading the production database while
creating the login in the development Supabase project, for example. That very nearly happened while
creating the first platform admin.

## What is NOT switchable

- **`db:generate` and `db:push`** always use `.env` (development). `drizzle-kit` parses its own command
  line, so it cannot take `--env`. This is deliberate: `db:push` rewrites a schema in place with no
  migration and no record. Production schema changes go through `db:migrate`, which is reviewable and
  recorded in `drizzle.__drizzle_migrations`. `drizzle.config.ts` refuses to load if `.env` declares
  `APP_ENV=production`.
- **The QA suite** (`npm run qa`, and `npm test`, which includes `test/`) reads `.env` directly through
  `test/support/env.ts` and has **no production guard**. It creates fixtures and deletes them on teardown.
  Never put production values in `.env`.

## Where production values live

| What | Where |
|---|---|
| Everything the deployed API uses | **Render** → `multi-tenant-cms-api` → **Environment**. The source of truth; values can be revealed and copied |
| Variable *names*, and non-secret values | [`render.yaml`](../render.yaml). Secrets are `sync: false` — "ask in the dashboard, never store in the repo" |
| `SUPABASE_URL`, publishable key, `sb_secret_` key | **Supabase** → Project Settings → API Keys |
| `postgres` password | Shown **once**, when reset. Recoverable from Render's `MIGRATE_DATABASE_URL` |
| `app_api` password | Only inside Render's `DATABASE_URL`. Supabase cannot show it; if lost, set a new one with `alter role app_api with password '...'` |

Keep both database passwords in a password manager. Today Render is the only other copy.

**`.env.prod` is a second copy of those secrets on disk.** It is gitignored, but it is real. Fill it from
Render → Environment, and delete it if you stop needing production access from this machine.

### The two database roles

`.env.prod` uses the **owner** (`postgres`) connection, because these scripts do DDL and read and write
`auth.users` — neither of which `app_api` can do, by design.

The deployed API is the opposite: its `DATABASE_URL` is **`app_api`**, a `NOBYPASSRLS`, DML-only role, so
row-level security applies to it and one tenant cannot read another's rows. Never point the deployed
service at the owner role; it would silently disable every RLS policy.

## Checking a connection string

Without printing the password:

```bash
node scripts/lib/env-target.ts --env=prod --allow-prod   # prints project + db user@host, nothing else
```

## Adding a variable

1. Add it to `.env.example` (documentation) and to your `.env`.
2. Add it to `src/config/env.validation.ts`, so a missing or malformed value fails at boot with a named
   error instead of at the first request.
3. Add the key to `render.yaml` — `sync: false` if it is a secret — and set its value in Render.
4. Add it to `.env.prod` if a local script needs it against production.
