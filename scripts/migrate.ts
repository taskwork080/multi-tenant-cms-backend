import "./lib/env-target";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  describeOutOfOrder,
  describeSilentSkips,
  findOutOfOrder,
  findSilentlySkipped,
  loadMigrationDigests,
} from "./lib/migration-guard";

const MIGRATIONS_FOLDER = "./drizzle";

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
  try {
    await preflight(client);
    // Relative to the working directory, which is the repo root for both
    // `npm run db:migrate*` and a host's pre-deploy command.
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    console.log("Migrations applied.");
  } finally {
    await client.end();
  }
}

/**
 * Refuses to migrate when drizzle would skip a migration without saying so.
 *
 * See scripts/lib/migration-guard.ts for why this is possible at all. Running
 * before migrate() matters: the skip is not an error to drizzle, so by the time
 * anything looks wrong the run has either succeeded with missing DDL or failed
 * somewhere unrelated to the actual cause.
 */
async function preflight(client: postgres.Sql): Promise<void> {
  const entries = loadMigrationDigests(MIGRATIONS_FOLDER);

  const outOfOrder = findOutOfOrder(entries);
  if (outOfOrder.length > 0) {
    throw new Error(describeOutOfOrder(outOfOrder));
  }

  // A database that has never been migrated has no drizzle schema at all, and
  // nothing to check. 3F000 = no such schema, 42P01 = no such table.
  let rows: { hash: string; created_at: string }[];
  try {
    rows = await client<{ hash: string; created_at: string }[]>`
      select "hash", "created_at" from drizzle.__drizzle_migrations
    `;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "3F000" || code === "42P01") return;
    throw err;
  }
  if (rows.length === 0) return;

  // created_at is bigint, which postgres.js hands back as a string.
  const watermark = Math.max(...rows.map((row) => Number(row.created_at)));
  const applied = new Set(rows.map((row) => row.hash));

  const skipped = findSilentlySkipped(entries, applied, watermark);
  if (skipped.length > 0) {
    throw new Error(describeSilentSkips(skipped, watermark));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
