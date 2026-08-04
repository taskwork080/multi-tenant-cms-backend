import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { PLATFORM_ADMIN } from "../auth/auth.types";
import { Roles } from "../auth/decorators";
import { Audit, type AuditCtx } from "./audit.service";
import { PlatformUsersService } from "./platform-users.service";

/**
 * Cross-tenant user administration.
 *
 * INVARIANT: the class-level @Roles(PLATFORM_ADMIN) below is the only thing
 * standing between these routes and every tenant's data. It is asserted by
 * platform.roles.spec.ts — do not remove it, and do not add a controller to
 * this directory without it.
 */
@ApiTags("platform")
@ApiBearerAuth()
@Roles(PLATFORM_ADMIN)
@Controller("api/admin/users")
export class PlatformUsersController {
  constructor(private readonly users: PlatformUsersService) {}

  @Get()
  @ApiOperation({ summary: "List users across all tenants (platform admin only)" })
  @ApiQuery({ name: "q", required: false })
  @ApiQuery({ name: "tenantId", required: false })
  @ApiQuery({ name: "roleId", required: false })
  @ApiQuery({ name: "status", required: false, description: "Repeat the key for an IN filter" })
  @ApiQuery({ name: "sort", required: false, description: "name|email|status|createdAt|lastActive, `-` for desc" })
  list(@Query() query: Record<string, unknown>) {
    return this.users.list(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "User detail: profile, role, auth status, recent audit + sign-ins" })
  get(@Param("id") id: string) {
    return this.users.get(id);
  }

  @Get(":id/activity")
  @ApiOperation({ summary: "Merged sign-in / admin-action / tenant-activity feed for a user" })
  activity(@Param("id") id: string) {
    return this.users.activity(id);
  }

  @Post()
  @ApiOperation({ summary: "Create a user: Supabase identity + staff record, atomically" })
  create(@Body() body: unknown, @Audit() ctx: AuditCtx) {
    return this.users.create(body, ctx);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update name / email / role" })
  update(@Param("id") id: string, @Body() body: unknown, @Audit() ctx: AuditCtx) {
    return this.users.update(id, body, ctx);
  }

  @Patch(":id/status")
  @ApiOperation({ summary: "Activate, deactivate, suspend or restore an account" })
  setStatus(@Param("id") id: string, @Body() body: unknown, @Audit() ctx: AuditCtx) {
    return this.users.setStatus(id, body, ctx);
  }

  @Post(":id/reset-password")
  @ApiOperation({ summary: "Send a recovery link, or set a password directly when enabled" })
  resetPassword(@Param("id") id: string, @Body() body: unknown, @Audit() ctx: AuditCtx) {
    return this.users.resetPassword(id, body, ctx);
  }

  @Post(":id/move-tenant")
  @ApiOperation({ summary: "Reassign a user to another workspace" })
  moveTenant(@Param("id") id: string, @Body() body: unknown, @Audit() ctx: AuditCtx) {
    return this.users.moveTenant(id, body, ctx);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Deactivate (default) or permanently delete with ?hard=true" })
  @ApiQuery({ name: "hard", required: false, type: Boolean })
  remove(@Param("id") id: string, @Query("hard") hard: string | undefined, @Audit() ctx: AuditCtx) {
    return this.users.remove(id, hard === "true", ctx);
  }
}
