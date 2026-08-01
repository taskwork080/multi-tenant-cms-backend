import { Module } from "@nestjs/common";
import { CountsController } from "./counts.controller";
import { FulfilmentController } from "./fulfilment.controller";
import { InventoryCoreModule } from "./inventory-core.module";
import { InventoryController } from "./inventory.controller";
import { ReceiptsController } from "./receipts.controller";
import { TransfersController } from "./transfers.controller";

/**
 * Stock routes: SKUs, levels, the movement ledger, reservations, transfers,
 * receipts and counts.
 *
 * Must register before CrudModule in app.module.ts — these live under
 * /api/:tenant/inventory/* and /api/:tenant/stock-transfers/*, which
 * CrudController's `@Get(":resource/:id")` would otherwise match first.
 *
 * Other modules that need to move stock import InventoryCoreModule, not this
 * one: importing a module with controllers changes where its routes land in
 * the registration order.
 */
@Module({
  imports: [InventoryCoreModule],
  controllers: [
    InventoryController,
    FulfilmentController,
    TransfersController,
    ReceiptsController,
    CountsController,
  ],
  exports: [InventoryCoreModule],
})
export class InventoryModule {}
