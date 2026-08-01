import { Module } from "@nestjs/common";
import { InventoryCoreModule } from "../inventory/inventory-core.module";
import { ConversationsController } from "./conversations.controller";
import { PackingController } from "./packing.controller";
import { PackingCreateController } from "./packing-create.controller";
import { ShipmentsController } from "./shipments.controller";

@Module({
  // Packing confirm deducts stock. Imports the services-only module so this
  // module's position doesn't move the inventory routes.
  imports: [InventoryCoreModule],
  // These specific routes must be registered before the generic CRUD catch-all
  // (WorkflowsModule already precedes CrudModule in app.module.ts).
  //
  // Inventory used to live here; it moved to src/inventory/ when it grew a
  // service the order and packing workflows also depend on.
  controllers: [ShipmentsController, PackingController, PackingCreateController, ConversationsController],
})
export class WorkflowsModule {}
