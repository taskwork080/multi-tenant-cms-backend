# Multi-Tenant CMS — Backend

NestJS backend for the [multi-tenant CMS admin frontend](../multi-tenant-cms), implementing its
API contract (`/api/{tenant}/{resource}`, payload shapes = the frontend's `src/lib/types.ts`).

```
Nest.js
 ├─ Supabase Postgres   → all relational data + RLS tenant isolation
 ├─ Supabase Auth       → JWT (role + tenant_id in app_metadata)
 ├─ Cloudflare R2       → images + Excel (presigned direct uploads, zero egress)
 └─ WebSocket (socket.io) → realtime chat + shipment updates (Phase 1)
 ORM: Drizzle
```

## Getting started

```bash
npm install
cp .env.example .env      # fill in credentials (see below)
npm run db:migrate        # apply migrations (drizzle/) to Supabase
npm run db:seed           # seed the 3 demo tenants (volt, nord, agri)
npm run start:dev         # http://localhost:4000
```

- **Swagger docs:** http://localhost:4000/docs
- **Health:** http://localhost:4000/health

> **DATABASE_URL:** the direct `db.<ref>.supabase.co` host is **IPv6-only**. On IPv4
> networks use the **Session Pooler** string (Dashboard → Connect), e.g.
> `postgresql://postgres.<ref>:<password>@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres`.

## Architecture

| Piece | Where | Notes |
|---|---|---|
| Schema (fully relational) | `src/db/schema.ts` | ~40 tables. Nested UI collections (order items, shipment events, chat messages, packing items → cartons → sizes, note attachments…) are child tables with `ON DELETE CASCADE` FKs. |
| Tenant isolation | `src/db/tenant-db.service.ts` + `drizzle/0001_rls.sql` | Every request runs in a transaction pinned with `set_config('app.tenant_id', …)`; **forced RLS policies** on every table make cross-tenant rows invisible even if a WHERE clause is forgotten. |
| Auth | `src/auth/` | Verifies Supabase Auth JWTs (JWKS, or `SUPABASE_JWT_SECRET` for legacy HS256). Role + tenant come from `app_metadata.role` / `app_metadata.tenant_id`. `AUTH_DEV_BYPASS=true` skips auth for local dev only. |
| Tenant resolution | `src/tenant/` | `:tenant` slug → tenant row (cached 30 s); guard rejects users whose `tenant_id` doesn't match (platform admins pass). `GET/PATCH /api/tenants/:tenant` serves config + entitlements. |
| Generic CRUD | `src/crud/` | One registry (`resource-registry.ts`) maps 25 resource slugs → tables + child relations. List/get/create/update/delete + `?q=` search, filters, sort, pagination come for free; nested arrays are composed from / persisted to child tables automatically. |
| Workflows | `src/workflows/` | Shipment tracking events + chat messages; packing-list `confirm` (assigns sequential `shipmentNo`) and courier `ship-events`. |
| Uploads | `src/uploads/` | `POST /api/:tenant/uploads/presign` → presigned PUT to R2; browser uploads directly, stores `publicUrl` on the entity. |
| Realtime | `src/chat/chat.gateway.ts` | socket.io: `chat:join`/`chat:send`/`chat:message` per conversation, `shipment:join`/`shipment:update`. Auth via `{ auth: { token, tenant } }` handshake. |
| Dashboard | `src/dashboard/` | KPI aggregates + 30-day order/revenue series. |

## API conventions

```
GET    /api/:tenant/:resource          ?q= &page= &pageSize= &sort=-createdAt &<column>=<value>
GET    /api/:tenant/:resource/:id
POST   /api/:tenant/:resource
PATCH  /api/:tenant/:resource/:id      (PUT is an alias; a provided nested array replaces that collection)
DELETE /api/:tenant/:resource/:id

POST   /api/:tenant/shipments/:id/events | messages
POST   /api/:tenant/packing-lists/:id/confirm | ship-events
POST   /api/:tenant/uploads/presign
GET    /api/:tenant/dashboard
GET|PATCH /api/tenants/:tenant
```

Resources: `categories, brands, manufacturers, badges, products, orders, stock-batches,
warehouses, delivery-channels, customers, sellers, promo-codes, reviews, returns, tax-rates,
roles, staff, activities, shipments, conversations, schedule-events, notes, packing-lists,
cms-blocks, language-entries` — each gated by the tenant's module entitlements (403 when locked).

## Auth setup (Supabase)

Give each admin user `app_metadata` via the Supabase dashboard or Admin API:

```json
{ "role": "owner", "tenant_id": "<tenant uuid>" }
```

Roles: `platform_admin` (cross-tenant) · `owner` · `admin` · `staff` · `viewer`.
The frontend sends the Supabase session's `access_token` as `Authorization: Bearer <token>`.

## Scripts

| Command | What it does |
|---|---|
| `npm run start:dev` | watch mode |
| `npm run build` / `start:prod` | compile → `node dist/src/main` |
| `npm run db:generate` | new migration from schema changes |
| `npm run db:migrate` | apply `drizzle/` migrations |
| `npm run db:seed` | seed demo tenants (idempotent) |
| `npm run typecheck` | `tsc --noEmit` |
"# multi-tenant-cms-backend" 
