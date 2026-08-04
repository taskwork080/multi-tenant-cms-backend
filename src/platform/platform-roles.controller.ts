import { Body, Controller, Delete, Get, Injectable, NotFoundException, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { and, asc, eq, sql } from "drizzle-orm";
import { PLATFORM_ADMIN } from "../auth/auth.types";
import { Roles } from "../auth/decorators";
import { TenantDb } from "../db/tenant-db.service";
import { rolePermissions, roles, staffUsers, tenants } from "../db/schema";
import { Audit, AuditService, type AuditCtx } from "./audit.service";
import { adminRolePatchSchema, adminRoleSchema } from "./dto";

@Injectable()
export class PlatformRolesService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /** Roles for one workspace, or every workspace's roles when tenantId is omitted. */
  async list(tenantId?: string) {
    return this.tdb.asPlatform(async (tx) => {
      const rows = await tx
        .select({
          id: roles.id,
          tenantId: roles.tenantId,
          name: roles.name,
          description: roles.description,
          createdAt: roles.createdAt,
          updatedAt: roles.updatedAt,
          tenantSlug: tenants.slug,
          tenantName: tenants.name,
        })
        .from(roles)
        .leftJoin(tenants, eq(tenants.id, roles.tenantId))
        .where(tenantId ? eq(roles.tenantId, tenantId) : undefined)
        .orderBy(asc(tenants.name), asc(roles.name));

      const [perms, counts] = await Promise.all([
        tx.select().from(rolePermissions).orderBy(asc(rolePermissions.sort)),
        tx
          .select({ roleId: staffUsers.roleId, n: sql<number>`count(*)::int` })
          .from(staffUsers)
          .groupBy(staffUsers.roleId),
      ]);
      const byRole = new Map<string, string[]>();
      for (const p of perms) byRole.set(p.roleId, [...(byRole.get(p.roleId) ?? []), p.permission]);
      const memberCount = new Map(counts.map((c) => [c.roleId ?? "", c.n]));

      return {
        data: rows.map((r) => ({
          ...r,
          permissions: byRole.get(r.id) ?? [],
          memberCount: memberCount.get(r.id) ?? 0,
        })),
        total: rows.length,
        page: 1,
        pageSize: rows.length,
      };
    });
  }

  async create(body: unknown, ctx: AuditCtx) {
    const input = adminRoleSchema.parse(body);
    return this.tdb.asPlatform(async (tx) => {
      const [tenant] = await tx.select().from(tenants).where(eq(tenants.id, input.tenantId)).limit(1);
      if (!tenant) throw new NotFoundException("Unknown workspace");
      const [row] = await tx
        .insert(roles)
        .values({ tenantId: input.tenantId, name: input.name, description: input.description })
        .returning();
      await this.replacePermissions(tx, row.id, input.tenantId, input.permissions);
      await this.audit.record(tx, ctx, {
        action: "role.create",
        targetType: "role",
        targetId: row.id,
        tenantId: input.tenantId,
        after: { name: row.name, permissions: input.permissions },
      });
      return { ...row, permissions: input.permissions };
    });
  }

  async update(id: string, body: unknown, ctx: AuditCtx) {
    const input = adminRolePatchSchema.parse(body);
    return this.tdb.asPlatform(async (tx) => {
      const [before] = await tx.select().from(roles).where(eq(roles.id, id)).limit(1);
      if (!before) throw new NotFoundException("Role not found");
      const beforePerms = await tx
        .select({ permission: rolePermissions.permission })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, id));

      const [row] = await tx
        .update(roles)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          updatedAt: new Date(),
        })
        .where(eq(roles.id, id))
        .returning();

      if (input.permissions) await this.replacePermissions(tx, id, before.tenantId, input.permissions);

      await this.audit.record(tx, ctx, {
        action: "role.update",
        targetType: "role",
        targetId: id,
        tenantId: before.tenantId,
        before: { name: before.name, permissions: beforePerms.map((p) => p.permission) },
        after: { name: row.name, permissions: input.permissions },
      });
      return { ...row, permissions: input.permissions ?? beforePerms.map((p) => p.permission) };
    });
  }

  async remove(id: string, ctx: AuditCtx) {
    return this.tdb.asPlatform(async (tx) => {
      const [before] = await tx.select().from(roles).where(eq(roles.id, id)).limit(1);
      if (!before) throw new NotFoundException("Role not found");
      await this.audit.record(tx, ctx, {
        action: "role.delete",
        targetType: "role",
        targetId: id,
        tenantId: before.tenantId,
        before: { name: before.name },
      });
      // staff_users.role_id is ON DELETE SET NULL, so members simply lose the
      // assignment rather than the row.
      await tx.delete(roles).where(eq(roles.id, id));
      return { deleted: true, id };
    });
  }

  private async replacePermissions(tx: Parameters<AuditService["record"]>[0], roleId: string, tenantId: string, permissions: string[]) {
    await tx.delete(rolePermissions).where(and(eq(rolePermissions.roleId, roleId)));
    if (permissions.length) {
      await tx
        .insert(rolePermissions)
        .values(permissions.map((permission, sort) => ({ tenantId, roleId, permission, sort })));
    }
  }
}

@ApiTags("platform")
@ApiBearerAuth()
@Roles(PLATFORM_ADMIN)
@Controller("api/admin/roles")
export class PlatformRolesController {
  constructor(private readonly svc: PlatformRolesService) {}

  @Get()
  @ApiOperation({ summary: "Roles + permissions, for one workspace or all of them" })
  @ApiQuery({ name: "tenantId", required: false })
  list(@Query("tenantId") tenantId?: string) {
    return this.svc.list(tenantId);
  }

  @Post()
  @ApiOperation({ summary: "Create a role in a workspace" })
  create(@Body() body: unknown, @Audit() ctx: AuditCtx) {
    return this.svc.create(body, ctx);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Rename a role or replace its permission set" })
  update(@Param("id") id: string, @Body() body: unknown, @Audit() ctx: AuditCtx) {
    return this.svc.update(id, body, ctx);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a role (members keep their accounts, unassigned)" })
  remove(@Param("id") id: string, @Audit() ctx: AuditCtx) {
    return this.svc.remove(id, ctx);
  }
}
