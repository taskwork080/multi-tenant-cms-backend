import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard } from "@nestjs/throttler";
import { TenantGuard } from "../tenant/tenant.guard";
import { EntitlementGuard } from "../tenant/entitlement.guard";
import { AccessGuard } from "./access.guard";
import { AccessService } from "./access.service";
import { AuthGuard } from "./auth.guard";
import { CapabilityGuard } from "./capability.guard";
import { CapabilitiesController } from "./capabilities.controller";
import { ImpersonationGuard } from "./impersonation.guard";
import { JwtVerifier } from "./jwt.service";
import { MeController } from "./me.controller";
import { ProfileController, ProfileService } from "./profile.controller";
import { RolesGuard } from "./roles.guard";
import { SupabaseAdminService } from "./supabase-admin.service";

/**
 * The whole global guard chain is registered here, in one array, on purpose.
 *
 * Nest runs global guards in registration order, and registration order across
 * modules follows the order modules enter the container — the same subtlety
 * that already forces CrudModule to be imported last (see crud-core.module.ts).
 * Spreading these across the modules that own them would make the chain's order
 * an emergent property of app.module.ts's import list, and every guard below
 * depends on what the previous one attached:
 *
 *   ThrottlerGuard    -> rate limit, before any I/O
 *   AuthGuard         -> req.user      (or 401)
 *   RolesGuard        -> app-role gate, reads req.user
 *   TenantGuard       -> req.tenant    (reads req.user; no-op without :tenant)
 *   AccessGuard       -> req.access    (reads req.user; enforces staff status)
 *   EntitlementGuard  -> module gate,  reads req.tenant
 *   CapabilityGuard   -> role gate,    reads req.access
 *   ImpersonationGuard-> write gate, last because it should only reject
 *                        requests that were otherwise going to be allowed.
 *
 * TenantGuard and EntitlementGuard live in ../tenant but are instantiated here;
 * TenantModule is @Global, so TenantService resolves regardless of import order.
 */
@Global()
@Module({
  controllers: [MeController, ProfileController, CapabilitiesController],
  providers: [
    JwtVerifier,
    SupabaseAdminService,
    AccessService,
    ProfileService,
    // Rate limiting runs FIRST: a flood should be rejected before it costs a
    // JWKS fetch, a tenant lookup or a role query.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_GUARD, useClass: EntitlementGuard },
    { provide: APP_GUARD, useClass: CapabilityGuard },
    { provide: APP_GUARD, useClass: ImpersonationGuard },
  ],
  exports: [JwtVerifier, SupabaseAdminService, AccessService],
})
export class AuthModule {}
