import { Controller, Get, Inject } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { Public } from "./auth/decorators";
import { DRIZZLE, type Db } from "./db/db.tokens";

@Controller()
export class HealthController {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  @Get("health")
  @Public()
  async health() {
    let database = "ok";
    try {
      await this.db.execute(sql`select 1`);
    } catch {
      database = "unreachable";
    }
    return { status: "ok", database, time: new Date().toISOString() };
  }
}
