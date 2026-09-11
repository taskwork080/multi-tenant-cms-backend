import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

// Migrations need DDL; the API deliberately does not have it. In production
// DATABASE_URL points at the app_api role from drizzle/0011_app_api_role.sql,
// which is NOBYPASSRLS and DML-only, so migrating on it fails with
// permission-denied. MIGRATE_DATABASE_URL carries the owner (postgres)
// connection string instead. Locally the two are the same and only
// DATABASE_URL is set, hence the fallback.
const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;

async function main() {
  if (!url) {
    throw new Error(
      "No database URL: set MIGRATE_DATABASE_URL (the owner role, in production) or DATABASE_URL",
    );
  }
  const client = postgres(url, { prepare: false, max: 1 });
  const db = drizzle(client);
  // Relative to the working directory, which is the repo root for both
  // `npm run db:migrate*` and a host's pre-deploy command.
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
