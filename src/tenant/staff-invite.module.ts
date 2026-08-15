import { Module } from "@nestjs/common";
import { PlatformModule } from "../platform/platform.module";
import { StaffInviteController, StaffInviteService } from "./staff-invite.controller";

/**
 * The tenant-facing staff invite routes.
 *
 * Its own module rather than part of TenantModule because it depends on
 * PlatformUsersService, and TenantModule is @Global — making a global module
 * import PlatformModule (which itself consumes the global TenantService) is a
 * cycle, and a needless one: only these three routes need that dependency.
 *
 * ORDERING: must be imported in app.module.ts before CrudModule, like every
 * other specific `/api/:tenant/...` controller, or `POST /api/:tenant/staff/invite`
 * is swallowed by the generic `POST /api/:tenant/:resource`.
 */
@Module({
  imports: [PlatformModule],
  controllers: [StaffInviteController],
  providers: [StaffInviteService],
})
export class StaffInviteModule {}
