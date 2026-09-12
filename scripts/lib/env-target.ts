/**
 * Chooses which environment a script talks to, out loud.
 *
 *   npm run db:migrate                              -> .env        (development)
 *   npm run db:migrate -- --env=prod --allow-prod   -> .env.prod   (production)
 *
 * Every script here used to start with `import "dotenv/config"`, which loads
 * `.env` and nothing else. Pointing one at production therefore meant exporting
 * half a dozen variables by hand in the terminal, and forgetting one meant the
 * script silently mixed environments — reading the production database while
 * writing users into the development Supabase project, for instance.
 *
 * So: one file per environment, named, with the target printed before anything
 * runs. Production additionally requires --allow-prod, because the difference
 * between the two is a single word on the command line.
 *
 * Import this INSTEAD of "dotenv/config", as the first import in the file.
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

/**
 * Nearest directory containing package.json, walking up.
 *
 * Not a fixed "../..": this file is compiled into dist/scripts/lib as well, so a
 * relative hop lands on dist/ there and the env files would be looked for in the
 * wrong place — silently, because the deployed case has no env file anyway.
 */
function findRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return from;
    dir = up;
  }
}

const ROOT = findRoot(__dirname);

/** `--env=<name>`, also accepted as `--env <name>`. Defaults to development. */
type Target = "dev" | "prod";

const FILES: Record<Target, string> = { dev: ".env", prod: ".env.prod" };

/** A value still carrying its placeholder from the committed template. */
const PLACEHOLDER = /(^$|PASTE_|CHANGE_?ME|<[a-z-]+>|\.\.\.$)/i;

/** What an env FILE must have filled in to be considered usable. */
const REQUIRED = ["DATABASE_URL", "SUPABASE_URL"];

/**
 * Enough to run without any env file at all — the deployed case, where Render
 * supplies real variables. Deliberately narrower than REQUIRED: the migration
 * runner needs a database and nothing else, and demanding SUPABASE_URL here
 * would fail a deploy for a variable it never reads.
 */
const hasProcessEnv = () => Boolean(process.env.DATABASE_URL || process.env.MIGRATE_DATABASE_URL);

function readTarget(argv: string[]): { target: Target; allowProd: boolean; rest: string[] } {
  const rest: string[] = [];
  let target: Target | undefined;
  let allowProd = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const inline = arg.match(/^--env=(.+)$/);
    if (inline) {
      target = normalise(inline[1]);
      continue;
    }
    if (arg === "--env") {
      target = normalise(argv[++i] ?? "");
      continue;
    }
    // NOT --yes: seed.ts and reset-users.ts already use that for their own
    // confirmation, and swallowing it here would arm them silently.
    if (arg === "--allow-prod") {
      allowProd = true;
      continue;
    }
    rest.push(arg);
  }
  return { target: target ?? "dev", allowProd, rest };
}

function normalise(value: string): Target {
  const v = value.toLowerCase();
  if (v === "prod" || v === "production") return "prod";
  if (v === "dev" || v === "development" || v === "local") return "dev";
  fail(`Unknown --env "${value}". Use --env=dev or --env=prod.`);
}

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

/** Host and user only — never the password. */
function describeDb(url: string | undefined): string {
  if (!url) return "(DATABASE_URL not set)";
  try {
    const u = new URL(url);
    return `${u.username}@${u.hostname}`;
  } catch {
    return "(DATABASE_URL is not a valid URL)";
  }
}

function projectRef(supabaseUrl: string | undefined): string {
  const m = (supabaseUrl ?? "").match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i);
  return m ? m[1] : "(unknown)";
}

const { target, allowProd, rest } = readTarget(process.argv.slice(2));
// Scripts read positional arguments from process.argv; hand them back a version
// with this module's own flags removed, so `user:create -- a@b.com pw slug` keeps
// working alongside `--env=prod`.
process.argv = [process.argv[0], process.argv[1], ...rest];

const file = path.join(ROOT, FILES[target]);
const haveFile = fs.existsSync(file);

if (haveFile) {
  // override: false — a variable already exported in the shell wins, which is
  // how CI and one-off overrides work. quiet: true — dotenv v17 otherwise prints
  // its own banner above the one below.
  dotenv.config({ path: file, override: false, quiet: true });
} else if (hasProcessEnv()) {
  // The deployed case: Render supplies real environment variables and ships no
  // env file. Say so rather than pretending a file was read.
  console.log(`▸ environment: process environment (no ${FILES[target]} file)`);
  console.log(`  database: ${describeDb(process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL)}`);
} else {
  fail(
    `${FILES[target]} does not exist, and DATABASE_URL is not set in this shell.\n` +
      `  Development: copy .env.example to .env and fill it in.\n` +
      `  Production:  see docs/ENVIRONMENTS.md.`,
  );
}

if (haveFile) {
  // Parsed from the FILE, not read from process.env: `set -a; source .env.prod`
  // leaves APP_ENV=production exported in the shell, and with override:false a
  // later dev run would then be accused of a mismatch it did not cause.
  const fileValues = dotenv.parse(fs.readFileSync(file));
  const declared = fileValues.APP_ENV;
  const expected = target === "prod" ? "production" : "development";
  if (declared && declared !== expected) {
    fail(
      `${FILES[target]} declares APP_ENV=${declared}, but you asked for --env=${target}.\n` +
        `  One of the two is wrong; refusing rather than guessing which.`,
    );
  }

  // Checked before anything else about the file's contents: the gate should not
  // depend on whether the file happens to be filled in.
  if (target === "prod" && !allowProd) {
    fail(
      `Refusing to run against PRODUCTION without --allow-prod.\n` +
        `  project ${projectRef(process.env.SUPABASE_URL)} · ${describeDb(process.env.DATABASE_URL)}\n` +
        `  Re-run with:  --env=prod --allow-prod`,
    );
  }

  // override:false means anything already exported wins over the file. That is
  // intended (CI, one-off overrides), but it has to be visible: after
  // `set -a; source .env.prod`, a later dev-targeted run would otherwise print
  // "development" while actually talking to production.
  const shellWins = [...REQUIRED, "MIGRATE_DATABASE_URL"].filter(
    (k) => fileValues[k] && process.env[k] && process.env[k] !== fileValues[k],
  );
  for (const k of shellWins) console.log(`⚠ ${k} comes from the shell, not ${FILES[target]}`);

  const missing = REQUIRED.filter((k) => !process.env[k] || PLACEHOLDER.test(process.env[k] as string));
  if (missing.length) {
    fail(
      `${FILES[target]} is not filled in: ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} empty or still a placeholder.\n` +
        (target === "prod" ? `  Copy the real values from Render > multi-tenant-cms-api > Environment.` : ""),
    );
  }

  const label = target === "prod" ? "PRODUCTION" : "development";
  console.log(`\n▸ environment: ${label}  (${FILES[target]})`);
  console.log(`  supabase: ${projectRef(process.env.SUPABASE_URL)}`);
  console.log(`  database: ${describeDb(process.env.DATABASE_URL)}\n`);
}

export const ENV_TARGET = target;
