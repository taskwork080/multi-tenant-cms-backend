import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AlertsModule } from "./alerts/alerts.module";
import { AuthModule } from "./auth/auth.module";
import { ChatModule } from "./chat/chat.module";
import { CrudModule } from "./crud/crud.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { DbModule } from "./db/db.module";
import { HealthController } from "./health.controller";
import { ProductsModule } from "./products/products.module";
import { SearchModule } from "./search/search.module";
import { TenantModule } from "./tenant/tenant.module";
import { UploadsModule } from "./uploads/uploads.module";
import { WorkflowsModule } from "./workflows/workflows.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DbModule,
    AuthModule,
    TenantModule,
    ChatModule,
    // NOTE: specific routes (uploads, dashboard, product import, shipment/packing
    // workflows) must register before the generic /api/:tenant/:resource
    // catch-all — otherwise e.g. GET products/import/template is swallowed by
    // CrudController's @Get(":id").
    UploadsModule,
    DashboardModule,
    AlertsModule,
    SearchModule,
    WorkflowsModule,
    ProductsModule,
    CrudModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
