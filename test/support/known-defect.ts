import { expect, it } from "vitest";
import fs from "node:fs";
import { artifactPath } from "./env";

/**
 * A test that asserts the CURRENT (wrong) behaviour of a confirmed defect.
 *
 * The alternative — asserting the correct behaviour and letting it fail — turns
 * the suite permanently red, and a permanently red suite stops being read. The
 * alternative to *that* — skipping the case — loses the finding entirely. So
 * these pin what the system does today and fail loudly if it changes, which is
 * exactly what you want: the day someone fixes the bug, the pin fails and tells
 * them to promote it to a real assertion.
 *
 * Every call also appends to the defect ledger that the final QA report is
 * generated from, so the report can never drift from what actually ran.
 */

export type Severity = "critical" | "high" | "medium" | "low";

export type DefectRecord = {
  id: string;
  title: string;
  severity: Severity;
  expected: string;
  observed: string;
  source: string;
  confirmed: boolean;
  detail?: string;
};

const LEDGER = "defects.json";

function append(rec: DefectRecord) {
  const p = artifactPath(LEDGER);
  let all: DefectRecord[] = [];
  if (fs.existsSync(p)) {
    try {
      all = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      all = [];
    }
  }
  all = all.filter((d) => d.id !== rec.id);
  all.push(rec);
  fs.writeFileSync(p, JSON.stringify(all, null, 2));
}

export function recordDefect(rec: DefectRecord) {
  append(rec);
}

type Meta = Omit<DefectRecord, "confirmed" | "observed"> & { observed?: string };

/**
 * Declares a known defect and runs `body`, which must assert today's behaviour
 * and return a human-readable description of what it observed.
 */
export function knownDefect(meta: Meta, body: () => Promise<string>, timeout = 60_000) {
  it(`[${meta.severity.toUpperCase()}] ${meta.id} — ${meta.title} (asserts CURRENT behaviour)`, async () => {
    let observed: string;
    try {
      observed = await body();
    } catch (err) {
      // The defect no longer reproduces, or reproduces differently. Either way
      // the ledger must say so rather than quietly recording a stale finding.
      append({ ...meta, observed: `did not reproduce: ${(err as Error).message}`, confirmed: false });
      throw err;
    }
    append({ ...meta, observed, confirmed: true });
    expect(observed).toBeTruthy();
  }, timeout);
}

/** Records a defect the suite proved absent — the report needs the negatives too. */
export function clearedDefect(meta: Meta, observed: string) {
  append({ ...meta, observed, confirmed: false });
}
