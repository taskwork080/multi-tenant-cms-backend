import { Module } from "@nestjs/common";
import { InventoryController } from "./inventory.controller";
import { PackingController } from "./packing.controller";
import { PackingCreateController } from "./packing-create.controller";
import { ShipmentsController } from "./shipments.controller";

@Module({
  // These specific routes must be registered before the generic CRUD catch-all
  // (WorkflowsModule already precedes CrudModule in app.module.ts).
  controllers: [ShipmentsController, PackingController, PackingCreateController, InventoryController],
})
export class WorkflowsModule {}
