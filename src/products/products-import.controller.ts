import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { z } from "zod";
import { CurrentTenant } from "../tenant/tenant.decorator";
import type { TenantDto } from "../tenant/tenant.service";
import { ProductsImportService } from "./products-import.service";
import { RequireCapability } from "../auth/decorators";
import { RequireModule } from "../tenant/module.decorator";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

const modeSchema = z.enum(["create", "upsert"]).default("create");

/**
 * Bulk import lives in its own controller because the generic CRUD layer at
 * /api/:tenant/:resource is a catch-all — see the ordering note in app.module.ts.
 */
@ApiTags("products")
@ApiBearerAuth()
@ApiParam({ name: "tenant", description: "Tenant slug" })
@RequireModule("products")
@Controller("api/:tenant/products")
export class ProductsImportController {
  constructor(private readonly importer: ProductsImportService) {}

  /** CSV header row users fill in before importing. */
  @Get("import/template")
  @RequireCapability("catalog.view")
  @ApiOperation({ summary: "Download the bulk-import CSV template" })
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="product-import-template.csv"')
  template(): string {
    return this.importer.template();
  }

  @Post("import")
  @RequireCapability("catalog.manage")
  @ApiOperation({
    summary: "Bulk import products from a CSV or XLSX file",
    description:
      "Multipart field `file`. Optional `mode`: create (default) or upsert, matching on style_code then slug. " +
      "Valid rows are committed even when others fail; per-row problems come back in `errors`.",
  })
  @ApiConsumes("multipart/form-data")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_FILE_BYTES } }))
  async import(
    @CurrentTenant() tenant: TenantDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body("mode") mode?: unknown,
  ) {
    if (!file?.buffer?.length) throw new BadRequestException("No file uploaded (multipart field `file`)");
    return this.importer.import(tenant.id, file.buffer, modeSchema.parse(mode ?? undefined));
  }
}
