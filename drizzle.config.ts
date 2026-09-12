// drizzle-kit parses its own command line, so this file cannot use
// scripts/lib/env-target (its --env flag would reach drizzle-kit and be
// rejected). It stays on plain dotenv, which means `db:generate` and `db:push`
// always read `.env` — development.
//
// That is deliberate. `db:push` rewrites a schema in place with no migration
// and no record; production schema changes go through `npm run db:migrate`,
// which is reviewable and recorded in drizzle.__drizzle_migrations. The guard
// below is here in case someone ever pastes production values into `.env`.
import "dotenv/config";
import { defineConfig } from "drizzle-kit";

if (process.env.APP_ENV === "production") {
  throw new Error(
    "drizzle-kit is development-only here: .env declares APP_ENV=production.\n" +
      "  Apply schema changes to production with: npm run db:migrate -- --env=prod --allow-prod",
  );
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
