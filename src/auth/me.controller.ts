import { Controller, Get } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { TenantService, type TenantDto } from "../tenant/tenant.service";
import { CurrentUser } from "./decorators";
import { PLATFORM_ADMIN, type AuthUser } from "./auth.types";

export interface MeResponse {
  user: AuthUser;
  /** Tenants visible to this user: all for platform admins, else their own. */
  tenants: TenantDto[];
}

@ApiTags("auth")
@ApiBearerAuth()
@Controller("api/me")
export class MeController {
  constructor(private readonly tenants: TenantService) {}

  @Get()
  @ApiOperation({ summary: "Current user + the tenant(s) they can access" })
  async me(@CurrentUser() user: AuthUser): Promise<MeResponse> {
    if (user.role === PLATFORM_ADMIN) {
      return { user, tenants: await this.tenants.list() };
    }
    if (!user.tenantId) return { user, tenants: [] };
    return { user, tenants: [await this.tenants.byId(user.tenantId)] };
  }
}
