import { Module } from "@nestjs/common";
import { ProductsImportController } from "./products-import.controller";
import { ProductsImportService } from "./products-import.service";

@Module({
  controllers: [ProductsImportController],
  providers: [ProductsImportService],
})
export class ProductsModule {}
