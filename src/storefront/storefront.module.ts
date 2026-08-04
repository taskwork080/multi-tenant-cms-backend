import { Module } from "@nestjs/common";
import { PublicStorefrontController } from "./public-storefront.controller";
import { StorefrontController } from "./storefront.controller";
import { StorefrontService } from "./storefront.service";

/**
 * Storefront CMS: admin management plus the anonymous read API.
 *
 * Must register before CrudModule in app.module.ts. Both controllers sit on
 * paths CrudController's /api/:tenant/:resource catch-all would otherwise
 * match first — /api/:tenant/storefront/* as resource="storefront", and
 * /api/public/storefront/* as tenant="public".
 *
 * Nothing should import this module; if another module needs the service,
 * split out a StorefrontCoreModule the way crud/ and inventory/ do, so the
 * controllers don't get pulled forward in registration order.
 */
@Module({
  controllers: [StorefrontController, PublicStorefrontController],
  providers: [StorefrontService],
  exports: [StorefrontService],
})
export class StorefrontModule {}
