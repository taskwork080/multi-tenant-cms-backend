import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ROLES } from "./decorators";
import { AuthUser, PLATFORM_ADMIN } from "./auth.types";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES, [context.getHandler(), context.getClass()]);
    if (!required?.length) return true;

    const user: AuthUser | undefined = context.switchToHttp().getRequest().user;
    if (!user) return false;
    if (user.role === PLATFORM_ADMIN) return true;
    if (!required.includes(user.role)) {
      throw new ForbiddenException(`Requires role: ${required.join(" | ")}`);
    }
    return true;
  }
}
