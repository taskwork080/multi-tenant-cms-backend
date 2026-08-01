import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard } from "./auth.guard";
import { JwtVerifier } from "./jwt.service";
import { MeController } from "./me.controller";
import { RolesGuard } from "./roles.guard";
import { SupabaseAdminService } from "./supabase-admin.service";

@Global()
@Module({
  controllers: [MeController],
  providers: [
    JwtVerifier,
    SupabaseAdminService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [JwtVerifier, SupabaseAdminService],
})
export class AuthModule {}
