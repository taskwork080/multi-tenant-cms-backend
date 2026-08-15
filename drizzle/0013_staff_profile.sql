-- Self-service profile fields on staff_users.
--
-- The avatar menu has always offered a "Profile" item; it was wired to nothing
-- and there was no route behind it. A staff member could not change the
-- spelling of their own name, set a photo, or see when they last signed in —
-- every one of those went through a platform admin, which does not scale and is
-- not what anyone expects from an admin panel.
--
-- All five columns are nullable with no default, so every existing row stays
-- valid and "not set" is distinguishable from "set to empty".
--
-- `locale` and `timezone` are deliberately per-USER, not per-workspace:
-- tenants.default_language is what the storefront and the workspace default to,
-- but two people in the same warehouse can want different UI languages, and a
-- distributed team needs timestamps in their own zone. Null means "follow the
-- workspace" / "follow the browser", so nothing changes until someone chooses.

alter table public.staff_users add column if not exists avatar_url text;
--> statement-breakpoint
alter table public.staff_users add column if not exists phone text;
--> statement-breakpoint
alter table public.staff_users add column if not exists job_title text;
--> statement-breakpoint
alter table public.staff_users add column if not exists locale text;
--> statement-breakpoint
alter table public.staff_users add column if not exists timezone text;
--> statement-breakpoint

-- staff_users already has RLS enabled+forced with a tenant_isolation policy
-- (0001_rls.sql) and a platform_admin_all policy (0008), and adding columns
-- does not change either. Nothing to re-grant: 0011 granted DML on the table,
-- not per-column.
comment on column public.staff_users.avatar_url is 'Set by the user via /api/me/profile; uploaded through the tenant-scoped R2 presign.';
--> statement-breakpoint
comment on column public.staff_users.locale is 'Per-user UI language. Null follows tenants.default_language.';
--> statement-breakpoint
comment on column public.staff_users.timezone is 'IANA zone for rendering timestamps. Null follows the browser.';
