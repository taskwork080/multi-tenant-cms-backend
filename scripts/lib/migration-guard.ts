/**
 * Catches the migration that Drizzle would skip without saying so.
 *
 * THE FAILURE THIS EXISTS FOR
 *
 * Drizzle does not track which migrations ran. It reads the single newest row
 * of drizzle.__drizzle_migrations and runs a migration only when
 *
 *   Number(lastDbMigration.created_at) < migration.folderMillis
 *
 * (drizzle-orm/pg-core/dialect.cjs). `folderMillis` is the `when` in
 * drizzle/meta/_journal.json. So a migration whose `when` lands at or below the
 * newest applied one is skipped permanently, silently, and the migrations after
 * it still run — against a schema that never got its columns.
 *
 * That is not hypothetical. Merging two branches that had each added their own
 * 0016/0017 resolved _journal.json to one side's entries, which reused `when`
 * values the database had already recorded from the other side's. Four
 * migrations were skipped and the fifth failed on the deploy with
 * `column "line_total" does not exist` — the first sign anything was wrong.
 *
 * WHAT IT CHECKS
 *
 *   1. `when` values increase strictly down the journal. A journal that goes
 *      backwards is the shape that produces the bug, and it needs no database
 *      to detect.
 *   2. Every journal entry at or below the applied watermark has its hash in
 *      drizzle.__drizzle_migrations. An entry below the watermark is fine when
 *      it genuinely ran; it is a silent skip when it did not. The hash is what
 *      tells those two apart, which is why this compares hashes rather than
 *      counting rows.
 *
 * The hash must match Drizzle's byte for byte or every migration would look
 * unapplied, hence `digestOf`: sha256 over the raw file, exactly as
 * readMigrationFiles computes it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

export interface MigrationDigest {
  tag: string;
  when: number;
  /** As drizzle would compute it from this checkout. */
  hash: string;
  /**
   * Every hash this file could have been recorded under, line endings aside.
   *
   * Drizzle hashes the file's bytes, so the same migration applied from a Linux
   * CI checkout and read back on a Windows one hashes differently — git hands
   * out CRLF here and LF there. Matching on the as-is hash alone would report
   * an applied migration as a silent skip on every Windows machine and block
   * local migrations for a difference that does not exist in the database.
   * Drizzle itself never compares hashes, so being tolerant here is no weaker
   * than the thing being guarded.
   */
  hashes: string[];
}

/** sha256 of the migration file, the way drizzle-orm/migrator computes it. */
function digestOf(sql: string): string {
  return crypto.createHash("sha256").update(sql).digest("hex");
}

/** The as-is hash plus its all-LF and all-CRLF equivalents. */
function digestVariants(sql: string): string[] {
  const lf = sql.replace(/\r\n/g, "\n");
  return [...new Set([digestOf(sql), digestOf(lf), digestOf(lf.replace(/\n/g, "\r\n"))])];
}

/**
 * Journal entries with each migration's hash, in journal order.
 *
 * Reads the same two things the migrator reads — meta/_journal.json and one
 * <tag>.sql per entry — so a missing file surfaces here rather than half way
 * through a migration run.
 */
export function loadMigrationDigests(migrationsFolder: string): MigrationDigest[] {
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries.map((entry) => {
    const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
    if (!fs.existsSync(sqlPath)) {
      throw new Error(
        `Journal entry ${entry.idx} names ${entry.tag}, but ${sqlPath} does not exist.`,
      );
    }
    const sql = fs.readFileSync(sqlPath, "utf8");
    return {
      tag: entry.tag,
      when: entry.when,
      hash: digestOf(sql),
      hashes: digestVariants(sql),
    };
  });
}

export interface OutOfOrderEntry {
  tag: string;
  when: number;
  previousTag: string;
  previousWhen: number;
}

/** Entries whose `when` does not beat the entry before them. */
export function findOutOfOrder(entries: MigrationDigest[]): OutOfOrderEntry[] {
  const out: OutOfOrderEntry[] = [];
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    if (current.when <= previous.when) {
      out.push({
        tag: current.tag,
        when: current.when,
        previousTag: previous.tag,
        previousWhen: previous.when,
      });
    }
  }
  return out;
}

/**
 * Entries the migrator will skip although they never ran.
 *
 * `watermark` is the newest `created_at` in drizzle.__drizzle_migrations — the
 * exact value Drizzle compares against.
 */
export function findSilentlySkipped(
  entries: MigrationDigest[],
  appliedHashes: ReadonlySet<string>,
  watermark: number,
): MigrationDigest[] {
  return entries.filter(
    (entry) =>
      entry.when <= watermark &&
      !entry.hashes.some((hash) => appliedHashes.has(hash)),
  );
}

/** The message a failed check prints. Separate so it can be read in a test. */
export function describeSilentSkips(
  skipped: MigrationDigest[],
  watermark: number,
): string {
  const lines = skipped.map(
    (entry) => `  - ${entry.tag} (when ${entry.when}, never applied)`,
  );
  return [
    `${skipped.length} migration(s) would be SKIPPED SILENTLY and never applied:`,
    ...lines,
    "",
    `The newest applied migration in this database is stamped ${watermark}, and`,
    "drizzle only runs migrations whose `when` is strictly greater than that.",
    "",
    "Fix: in drizzle/meta/_journal.json, raise the `when` of each migration above",
    `${watermark} (keeping the entries in order), then run this again. Do not edit`,
    "migrations that have already been applied elsewhere.",
  ].join("\n");
}

export function describeOutOfOrder(entries: OutOfOrderEntry[]): string {
  const lines = entries.map(
    (entry) =>
      `  - ${entry.tag} (when ${entry.when}) does not beat ${entry.previousTag} (when ${entry.previousWhen})`,
  );
  return [
    "drizzle/meta/_journal.json is out of order:",
    ...lines,
    "",
    "Every entry's `when` must be strictly greater than the one before it, or",
    "drizzle skips it. This usually means a merge reused another branch's `when`.",
  ].join("\n");
}
