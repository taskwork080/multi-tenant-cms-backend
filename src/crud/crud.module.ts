import { Module } from "@nestjs/common";
import { CrudCoreModule } from "./crud-core.module";
import { CrudController } from "./crud.controller";

/**
 * The generic /api/:tenant/:resource catch-all.
 *
 * Must stay LAST in app.module.ts, and nothing may import this module — import
 * CrudCoreModule for the service instead. An import would pull the controller
 * into the container at the importer's position, ahead of the specific routes
 * it is supposed to fall behind.
 */
@Module({
  imports: [CrudCoreModule],
  controllers: [CrudController],
  exports: [CrudCoreModule],
})
export class CrudModule {}
