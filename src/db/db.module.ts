import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { DRIZZLE } from "./db.tokens";
import { TenantDb } from "./tenant-db.service";

export { DRIZZLE, type Db } from "./db.tokens";

@Global()
@Module({
  providers: [
    {
      provide: "PG_CLIENT",
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        postgres(config.getOrThrow<string>("DATABASE_URL"), {
          prepare: false, // works with both direct connections and pgbouncer poolers
          max: 10,
        }),
    },
    {
      provide: DRIZZLE,
      inject: ["PG_CLIENT"],
      useFactory: (client: ReturnType<typeof postgres>) => drizzle(client, { schema }),
    },
    TenantDb,
  ],
  exports: [DRIZZLE, TenantDb],
})
export class DbModule {}
