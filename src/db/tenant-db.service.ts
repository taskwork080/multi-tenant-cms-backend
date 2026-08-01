import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE, type Db } from "./db.tokens";

/**
 * Runs every query inside a transaction that pins `app.tenant_id` for the
 * session. Row Level Security policies (drizzle/0001_rls.sql) then guarantee
 * the transaction can only see / write rows belonging to that tenant —
 * tenant isolation holds even if a service forgets a WHERE clause.
 */
@Injectable()
export class TenantDb {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /** Raw, unscoped handle — only for tenant bootstrap/admin paths. */
  get raw(): Db {
    return this.db;
  }

  async forTenant<T>(tenantId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx as unknown as Db);
    });
  }

  /**
   * Cross-tenant transaction for /api/admin/* only. Sets `app.platform`, which
   * the platform_admin_all policies (drizzle/0008_platform_admin.sql) key off,
   * and which is the *only* way to reach platform_audit_log / auth_events.
   *
   * This is the tenant-isolation escape hatch: every caller must already sit
   * behind `@Roles(PLATFORM_ADMIN)`. Grep for `asPlatform` to audit them all.
   */
  async asPlatform<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      // is_local = true: the setting dies with the transaction, so it can never
      // leak onto a pooled connection and widen a later tenant request.
      await tx.execute(sql`select set_config('app.platform', 'on', true)`);
      return fn(tx as unknown as Db);
    });
  }
}
