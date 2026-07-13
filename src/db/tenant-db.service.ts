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
}
