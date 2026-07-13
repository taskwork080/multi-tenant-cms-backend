import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard } from "./auth.guard";
import { JwtVerifier } from "./jwt.service";
import { RolesGuard } from "./roles.guard";

@Global()
@Module({
  providers: [
    JwtVerifier,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [JwtVerifier],
})
export class AuthModule {}
