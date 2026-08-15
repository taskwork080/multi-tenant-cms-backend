import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { UserAccess } from "./access.service";
import { CAPABILITIES_KEY } from "./decorators";

/**
 * Enforces @RequireCapability against the role resolved by AccessGuard.
 *
 * This is the boundary that did not exist: tenant roles were written by the
 * role editor and read by nobody, so a `viewer` could DELETE anything. Menu
 * keys are still UX scoping and still fail open (menu-access.ts explains why);
 * capabilities fail closed.
 *
 * The one fail-open case left is a user nobody has configured — no role, or a
 * role carrying no capability keys. After scripts/backfill-rbac.ts that state
 * cannot exist, so it only survives to keep a deploy that lands before the
 * backfill from locking out a whole workspace. See `unconfigured` below.
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(CAPABILITIES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const req = context.switchToHttp().getRequest<Request & { access?: UserAccess }>();
    const access = req.access;
    if (!access) return true; // no tenant context resolved — nothing to check against

    assertCapabilities(access, required);
    return true;
  }
}

/**
 * Nobody ever chose what this user may do: they hold no role, or a role that
 * predates the capability catalog. Treated as unconfigured rather than
 * unprivileged, mirroring resolveMenuAccess rules 2 and 4 so the menu and the
 * API agree — a user shown every nav item but 403'd on all of them is a worse
 * outcome than either honest answer.
 *
 * scripts/backfill-rbac.ts gives every role a capability set and every
 * staff row a role, so after it runs this branch is unreachable and
 * enforcement is total. It exists so a deployment that ships the code before
 * the migration degrades to today's behaviour instead of locking out a
 * workspace.
 */
function unconfigured(access: UserAccess): boolean {
  return access.roleId === null || access.capabilities.length === 0;
}

/**
 * Shared by CapabilityGuard and CrudService so both produce the same 403.
 * Throws unless the access grants every required capability.
 */
export function assertCapabilities(access: UserAccess, required: readonly string[]) {
  if (access.bypass) return;
  if (unconfigured(access)) return;

  const held = new Set(access.capabilities);
  const missing = required.filter((c) => !held.has(c));
  if (missing.length) {
    throw new ForbiddenException({
      message: `Your role does not allow this action (requires: ${missing.join(", ")})`,
      code: "CAPABILITY_REQUIRED",
      required: missing,
    });
  }
}
