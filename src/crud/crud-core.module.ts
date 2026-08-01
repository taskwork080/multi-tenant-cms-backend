import { Module } from "@nestjs/common";
import { InventoryCoreModule } from "../inventory/inventory-core.module";
import { CrudService } from "./crud.service";

/**
 * CrudService without CrudController.
 *
 * Anything that needs the generic query engine — SearchModule runs `?q=` across
 * every registered resource through it — must import *this*, never CrudModule.
 *
 * Nest registers routes in the order modules enter the container, and a module
 * enters at the position of whoever imports it first, not where it sits in
 * app.module.ts. SearchModule importing CrudModule therefore hoisted
 * CrudController's `/api/:tenant/:resource/:id` ahead of every workflow route
 * declared after SearchModule, and that catch-all silently 404s any path whose
 * first segment isn't a registered resource — `/api/:tenant/inventory/stats`
 * resolved as `resource=inventory, id=stats` and died there.
 *
 * Splitting the service out keeps CrudController's position exactly where
 * app.module.ts puts it: last, behind every specific route.
 */
@Module({
  imports: [InventoryCoreModule],
  providers: [CrudService],
  exports: [CrudService],
})
export class CrudCoreModule {}
