import { Module } from "@nestjs/common";
import { ProductStatsController } from "./product-stats.controller";
import { ProductsImportController } from "./products-import.controller";
import { ProductsImportService } from "./products-import.service";

@Module({
  controllers: [ProductsImportController, ProductStatsController],
  providers: [ProductsImportService],
})
export class ProductsModule {}
