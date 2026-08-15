import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerModule } from "@nestjs/throttler";
import { validateEnv } from "./config/env.validation";
import { AlertsModule } from "./alerts/alerts.module";
import { AuthModule } from "./auth/auth.module";
import { ChatModule } from "./chat/chat.module";
import { CrudModule } from "./crud/crud.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { DbModule } from "./db/db.module";
import { HealthController } from "./health.controller";
import { InventoryModule } from "./inventory/inventory.module";
import { MaintenanceModule } from "./maintenance/maintenance.module";
import { PlatformModule } from "./platform/platform.module";
import { ProductsModule } from "./products/products.module";
import { SearchModule } from "./search/search.module";
import { StaffInviteModule } from "./tenant/staff-invite.module";
import { StorefrontModule } from "./storefront/storefront.module";
import { TenantModule } from "./tenant/tenant.module";
import { UploadsModule } from "./uploads/uploads.module";
import { WorkflowsModule } from "./workflows/workflows.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // Coarse global ceiling. It is not the interesting limit — the @Public()
    // storefront routes and the uploads presign carry tighter per-route
    // @Throttle decorators — but it means an unauthenticated flood of any
    // endpoint costs the database nothing.
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 300 }]),
    ScheduleModule.forRoot(),
    DbModule,
    AuthModule,
    TenantModule,
    ChatModule,
    // NOTE: specific routes (uploads, dashboard, product import, inventory,
    // shipment/packing workflows) must register before the generic
    // /api/:tenant/:resource catch-all — otherwise e.g. GET
    // products/import/template is swallowed by CrudController's @Get(":id").
    // PlatformModule especially: /api/admin/users would otherwise resolve as
    // tenant="admin" and 404 instead of 403.
    PlatformModule,
    // Tenant-facing staff invites; depends on PlatformModule, so it sits here.
    StaffInviteModule,
    UploadsModule,
    DashboardModule,
    AlertsModule,
    SearchModule,
    InventoryModule,
    WorkflowsModule,
    ProductsModule,
    StorefrontModule,
    CrudModule,
    // No controllers, so its position does not affect route ordering.
    MaintenanceModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
