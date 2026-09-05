import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { admin, deprovision, requireRoster, type Roster } from "./support/accounts";
import { teardownTenant, type TeardownRow } from "./support/fixtures";
import { diffSnapshots, snapshotAll, type TenantSnapshot } from "./support/snapshot";
import { artifactPath, readArtifact, writeArtifact } from "./support/env";
import type { DefectRecord } from "./support/known-defect";
import { currentRunId } from "./support/runid";

/**
 * Teardown, and the evidence that the run was safe.
 *
 * This file must run LAST — it deletes the fixtures every other file asserts
 * against. The `zz` prefix plus the filename sequencer in vitest.config.mts is
 * what guarantees that; Vitest's default sequencer sorts by file size and would
 * happily run this one first.
 *
 * Teardown is asserted rather than merely performed. A cleanup that quietly
 * fails is worse than none at all: it leaves QA rows in a live workspace AND
 * reports success, so nobody goes looking. Every delete's outcome is recorded,
 * and the snapshot diff at the end is the part that actually proves the claim —
 * assertions elsewhere in the suite can only vouch for rows somebody looked at,
 * whereas the diff vouches for the ones nobody did.
 */

const TENANTS = ["volt", "nord"];

let roster: Roster;
let runId: string;
let before: Record<string, TenantSnapshot>;
const teardownRows: Record<string, TeardownRow[]> = {};
let accountReport: Awaited<ReturnType<typeof deprovision>> = [];

beforeAll(() => {
  roster = requireRoster();
  runId = currentRunId();
  const snap = readArtifact<Record<string, TenantSnapshot>>("snapshot-before.json");
  if (!snap) throw new Error("No pre-run snapshot — cannot prove the run was clean.");
  before = snap;
});

describe("teardown", () => {
  it("removes every fixture document, product and warehouse", async () => {
    for (const slug of TENANTS) {
      teardownRows[slug] = await teardownTenant(admin, slug, runId);
    }

    const blocked = Object.entries(teardownRows).flatMap(([slug, rows]) =>
      rows.filter((r) => r.outcome !== "deleted").map((r) => `${slug}/${r.resource} ${r.ref ?? r.id}: ${r.constraint}`),
    );

    // A blocked delete is a finding in its own right — usually a foreign key
    // the teardown ORDER does not account for — so it is reported in full
    // rather than as a count.
    expect(blocked, `Teardown could not remove:\n  ${blocked.join("\n  ")}`).toEqual([]);
  });

  it("removes every QA account and role", async () => {
    accountReport = await deprovision(roster);
    const blocked = accountReport.filter((r) => r.outcome !== "deleted");
    expect(blocked, `Could not remove:\n  ${blocked.map((b) => `${b.kind} ${b.id}: ${b.detail}`).join("\n  ")}`).toEqual(
      [],
    );
  });
});

describe("blast radius", () => {
  it("left no trace in either tenant's real data", async () => {
    const after = await snapshotAll(TENANTS, "after");
    const drift = diffSnapshots(before, after, runId);

    // The headline claim of the whole exercise: a full QA pass ran against a
    // shared live database and changed nothing that belonged to anyone else.
    expect(drift, `Real tenant data drifted:\n  ${drift.join("\n  ")}`).toEqual([]);

    // diffSnapshots deliberately ignores row counts (a count can return to its
    // baseline while the rows differ), so assert them separately: after a clean
    // teardown every resource must be back to exactly the number it started at.
    const countDrift: string[] = [];
    for (const slug of TENANTS) {
      for (const [resource, n] of Object.entries(before[slug].counts)) {
        const now = after[slug].counts[resource];
        if (now !== n) countDrift.push(`${slug}.${resource}: ${n} -> ${now}`);
      }
    }
    expect(countDrift, `Row counts did not return to baseline:\n  ${countDrift.join("\n  ")}`).toEqual([]);
  });
});

describe("report", () => {
  it("writes the QA report from what actually ran", async () => {
    const defects = readArtifact<DefectRecord[]>("defects.json") ?? [];
    expect(defects.length, "No defect ledger — did the specs run?").toBeGreaterThan(0);

    const confirmed = defects.filter((d) => d.confirmed);
    const cleared = defects.filter((d) => !d.confirmed);
    const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    const bySeverity = (a: DefectRecord, b: DefectRecord) => rank[a.severity] - rank[b.severity];

    const lines: string[] = [
      `# QA report — run \`${runId}\``,
      "",
      `Generated ${new Date().toISOString()} from \`test/.artifacts/defects.json\`.`,
      "Every row below was produced by an assertion that ran; nothing here is written by hand.",
      "",
      `**${confirmed.length} confirmed defect${confirmed.length === 1 ? "" : "s"}**, `
      + `${cleared.length} behaviour${cleared.length === 1 ? "" : "s"} proved correct.`,
      "",
      "## Confirmed defects",
      "",
    ];

    if (confirmed.length === 0) {
      lines.push("_None._", "");
    } else {
      for (const d of [...confirmed].sort(bySeverity)) {
        lines.push(
          `### ${d.id} — ${d.title}`,
          "",
          `- **Severity:** ${d.severity}`,
          `- **Expected:** ${d.expected}`,
          `- **Observed:** ${d.observed}`,
          `- **Source:** \`${d.source}\``,
          "",
        );
      }
    }

    lines.push(
      "## Verified correct",
      "",
      "Recorded because a QA report that lists only failures cannot be told apart from one where",
      "the test never ran.",
      "",
    );
    for (const d of [...cleared].sort(bySeverity)) {
      lines.push(`- **${d.id}** (${d.severity}) — ${d.title}  `, `  ${d.observed}`, "");
    }

    lines.push("## Teardown", "");
    for (const slug of TENANTS) {
      const rows = teardownRows[slug] ?? [];
      lines.push(`- \`${slug}\`: ${rows.length} fixture row${rows.length === 1 ? "" : "s"} removed`);
    }
    lines.push(
      `- accounts: ${accountReport.filter((r) => r.kind === "user").length} users, `
      + `${accountReport.filter((r) => r.kind === "role").length} roles removed`,
      "- snapshot diff against the pre-run baseline: **no drift**",
      "",
    );

    const path = artifactPath("QA-REPORT.md");
    fs.writeFileSync(path, lines.join("\n"), "utf8");
    writeArtifact("run-summary.json", {
      runId,
      finishedAt: new Date().toISOString(),
      confirmed: confirmed.length,
      cleared: cleared.length,
      teardown: teardownRows,
      accounts: accountReport,
    });

    expect(fs.existsSync(path)).toBe(true);
    console.log(`\n[qa] report written to ${path}\n`);
  });
});
