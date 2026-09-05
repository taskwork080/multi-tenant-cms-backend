import { readArtifact, writeArtifact } from "./env";

/**
 * One short id per QA run, stamped into every record the suite creates.
 *
 * This is what makes the run safe against a SHARED LIVE database holding real
 * tenant work: everything the suite writes is named `QA-...-<runId>`, so
 * teardown can find its own droppings without pattern-matching anything a real
 * user made, and a Playwright locator can select "the row this run created"
 * rather than "the first row".
 */

const FILE = "run-id.json";

export function newRunId(): string {
  const id = Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 5);
  writeArtifact(FILE, { runId: id, startedAt: new Date().toISOString() });
  return id;
}

export function currentRunId(): string {
  const saved = readArtifact<{ runId: string }>(FILE);
  if (!saved?.runId) throw new Error("No run id — run `npm run qa:provision` first.");
  return saved.runId;
}

export const qaName = (kind: string, runId = currentRunId()) => `QA-${kind}-${runId}`;
