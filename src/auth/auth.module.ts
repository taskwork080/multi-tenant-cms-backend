import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard } from "./auth.guard";
import { ImpersonationGuard } from "./impersonation.guard";
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
    // After RolesGuard: it needs req.user, and it should only run on requests
    // that were already going to be allowed.
    { provide: APP_GUARD, useClass: ImpersonationGuard },
  ],
  exports: [JwtVerifier, SupabaseAdminService],
})
export class AuthModule {}
