/**
 * Pure checks over the migration journal — no database, no HTTP, so this runs
 * in milliseconds and gates every commit.
 *
 * The regression it guards: a merge resolved drizzle/meta/_journal.json to one
 * branch's entries, which reused `when` values the database had already
 * recorded from the other branch's 0016/0017. Drizzle skipped four migrations
 * without a word and the deploy failed on the fifth.
 */
import { describe, expect, it } from "vitest";
import {
  describeSilentSkips,
  findOutOfOrder,
  findSilentlySkipped,
  loadMigrationDigests,
  type MigrationDigest,
} from "../scripts/lib/migration-guard";

const entry = (tag: string, when: number, hash = `hash-${tag}`): MigrationDigest => ({
  tag,
  when,
  hash,
  hashes: [hash],
});

describe("the repo's own journal", () => {
  const entries = loadMigrationDigests("./drizzle");

  it("names a file that exists for every entry", () => {
    // loadMigrationDigests throws on a missing file; this asserts it found some.
    expect(entries.length).toBeGreaterThan(0);
  });

  it("increases strictly, so drizzle skips nothing", () => {
    expect(findOutOfOrder(entries)).toEqual([]);
  });

  it("leaves the already-deployed migrations applied, not skipped", () => {
    // Production's watermark: the newest migration it had applied before the
    // journal was repaired.
    const watermark = 1787000000000;
    const applied = new Set(
      entries.filter((e) => e.when <= watermark).map((e) => e.hash),
    );
    expect(findSilentlySkipped(entries, applied, watermark)).toEqual([]);
  });
});

describe("findOutOfOrder", () => {
  it("flags an entry that does not beat the one before it", () => {
    const entries = [entry("a", 100), entry("b", 100), entry("c", 200)];
    expect(findOutOfOrder(entries)).toEqual([
      { tag: "b", when: 100, previousTag: "a", previousWhen: 100 },
    ]);
  });
});

describe("findSilentlySkipped", () => {
  it("catches the merge that reused another branch's `when`", () => {
    // What HEAD looked like when the deploy broke: prod had applied the other
    // branch's entries up to 1787000000000, so everything at or below that is
    // skipped even though these files never ran.
    const entries = [
      entry("0016_purchase_prices", 1786900000000),
      entry("0017_default_currency_bdt", 1786950000000),
      entry("0018_packing_inventory", 1787000000000),
      entry("0019_landed_cost", 1787100000000),
    ];
    const skipped = findSilentlySkipped(entries, new Set(), 1787000000000);
    expect(skipped.map((e) => e.tag)).toEqual([
      "0016_purchase_prices",
      "0017_default_currency_bdt",
      "0018_packing_inventory",
    ]);
    expect(describeSilentSkips(skipped, 1787000000000)).toContain(
      "0016_purchase_prices",
    );
  });

  it("accepts a migration recorded under its LF hash from a Linux checkout", () => {
    // The Windows working copy hashes as CRLF; the deploy that applied it
    // hashed LF. Same migration, and it is not a skip.
    const crlf: MigrationDigest = {
      tag: "0016_tenant_id_without_auth_schema",
      when: 100,
      hash: "hash-crlf",
      hashes: ["hash-crlf", "hash-lf"],
    };
    expect(findSilentlySkipped([crlf], new Set(["hash-lf"]), 100)).toEqual([]);
    expect(findSilentlySkipped([crlf], new Set(["hash-other"]), 100)).toEqual([
      crlf,
    ]);
  });

  it("accepts an entry below the watermark whose hash was applied", () => {
    const applied = new Set(["hash-0015"]);
    const entries = [entry("0015", 100, "hash-0015"), entry("0016", 200)];
    expect(findSilentlySkipped(entries, applied, 100)).toEqual([]);
  });
});
