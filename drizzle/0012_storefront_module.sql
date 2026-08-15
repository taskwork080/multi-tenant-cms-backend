-- Split the public storefront out of the `cms` entitlement.
--
-- `cms` used to gate two unrelated things: whether a tenant can edit content
-- inside the admin (cms_blocks, the Storefront manager) and whether a public
-- website exists at all. The note at src/db/schema.ts already called this out.
-- The consequences of one key doing both:
--
--   * a workspace that wants internal content blocks but no public site
--     cannot have that combination;
--   * granting `cms` to a non-retail workspace silently publishes a storefront.
--
-- After this, `cms` means the in-admin content editor and `storefront` means
-- the public site. `storefront_configs.is_active` is unchanged and still
-- decides whether a *provisioned* site is live — the two switches were always
-- separate and stay separate.
--
-- Backfill is deliberately total: every tenant holding `cms` today also gets
-- `storefront`, so nobody's live site goes dark on deploy. Splitting them
-- apart afterwards is a per-tenant decision for a platform admin.

insert into public.tenant_entitlements (tenant_id, module)
select tenant_id, 'storefront'
  from public.tenant_entitlements
 where module = 'cms'
on conflict (tenant_id, module) do nothing;
--> statement-breakpoint

-- `inventoryItems` was observed in tenant_entitlements but appears in no
-- MODULE_KEYS list, no nav item and no ResourceDef — exactly the dead row the
-- closed zod enum was introduced to prevent. Nothing reads it, so it only
-- makes the entitlement list harder to audit.
delete from public.tenant_entitlements
 where module not in (
   'dashboard','schedule','products','categories','brands','manufacturers','badges',
   'sales','inventory','inventoryInbound','inventoryOutbound','inventoryTransfers',
   'inventoryCounts','warehouses','delivery','location','customers','sellers','cms',
   'storefront','discounts','reviews','returns','shipments','tax','staff','roles',
   'activity','configuration','language','notes','messages','packing','packingShipments'
 );
