import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { Public } from "./auth/decorators";
import { DRIZZLE, type Db } from "./db/db.tokens";

@Controller()
export class HealthController {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * The probe a host routes traffic on.
   *
   * This used to answer 200 with `database: "unreachable"` in the body, which
   * meant a container with a broken DATABASE_URL passed its health check and
   * received traffic — the one failure the check exists to catch. Platform
   * probes and uptime monitors read the status code, not the body, so a dead
   * database has to be a 503.
   *
   * The consequence is deliberate: a sustained Postgres outage will make the
   * host restart this service. An API that cannot reach its database has
   * nothing to serve, and a deploy that fails this way should fail visibly.
   */
  @Get("health")
  @Public()
  async health() {
    const time = new Date().toISOString();
    try {
      await this.db.execute(sql`select 1`);
    } catch {
      throw new ServiceUnavailableException({ status: "error", database: "unreachable", time });
    }
    return { status: "ok", database: "ok", time };
  }
}
