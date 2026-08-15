import { Controller, Get } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { TenantService, type TenantDto } from "../tenant/tenant.service";
import { CurrentAccess, CurrentUser } from "./decorators";
import { PLATFORM_ADMIN, type AuthUser } from "./auth.types";
import type { UserAccess } from "./access.service";

export interface MeResponse {
  user: AuthUser;
  /** Tenants visible to this user: all for platform admins, else their own. */
  tenants: TenantDto[];
  /**
   * Resolved access. Comes from AccessGuard, which is the *same* object the
   * capability and menu checks run against — so what the UI hides and what the
   * API refuses can no longer drift apart.
   */
  access: UserAccess;
}

@ApiTags("auth")
@ApiBearerAuth()
@Controller("api/me")
export class MeController {
  constructor(private readonly tenants: TenantService) {}

  @Get()
  @ApiOperation({ summary: "Current user, their tenant(s), and their resolved access" })
  async me(@CurrentUser() user: AuthUser, @CurrentAccess() access: UserAccess): Promise<MeResponse> {
    if (user.role === PLATFORM_ADMIN) {
      return { user, tenants: await this.tenants.list(), access };
    }
    if (!user.tenantId) return { user, tenants: [], access };

    return { user, tenants: [await this.tenants.byId(user.tenantId)], access };
  }
}
