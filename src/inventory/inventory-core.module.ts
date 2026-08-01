import { Module } from "@nestjs/common";
import { FulfilmentService } from "./fulfilment.service";
import { InventoryService } from "./inventory.service";

/**
 * The inventory services, with no controllers of their own.
 *
 * This exists so the CRUD and workflow layers can reserve and deduct stock
 * without importing InventoryModule. Importing a controller-bearing module
 * pulls it into the graph at the importer's position and reorders route
 * registration — which is load-bearing here: CrudController's
 * `@Get(":resource/:id")` will happily swallow `/inventory/stats` as
 * `resource=inventory, id=stats` if it registers first, and the inventory
 * routes 404 with nothing to explain why.
 *
 * Keeping providers here and controllers in InventoryModule means route order
 * is decided solely by the import list in app.module.ts, where it's visible.
 */
@Module({
  providers: [InventoryService, FulfilmentService],
  exports: [InventoryService, FulfilmentService],
})
export class InventoryCoreModule {}
