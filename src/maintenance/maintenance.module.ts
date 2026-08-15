import { Module } from "@nestjs/common";
import { InventoryCoreModule } from "../inventory/inventory-core.module";
import { MaintenanceService } from "./maintenance.service";

/**
 * Scheduled maintenance jobs. Registers no controllers, so its position in
 * app.module.ts's import list does not affect route ordering.
 *
 * Imports InventoryCoreModule (services only) rather than InventoryModule, for
 * the same reason WorkflowsModule does: pulling the controller-bearing module
 * in here would move the inventory routes forward in registration order.
 */
@Module({
  imports: [InventoryCoreModule],
  providers: [MaintenanceService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
