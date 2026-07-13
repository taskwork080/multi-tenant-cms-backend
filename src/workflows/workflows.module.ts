import { Module } from "@nestjs/common";
import { PackingController } from "./packing.controller";
import { ShipmentsController } from "./shipments.controller";

@Module({
  controllers: [ShipmentsController, PackingController],
})
export class WorkflowsModule {}
