import { defineConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";

/**
 * Runs spec FILES in filename order.
 *
 * `shuffle: false` is not enough on its own: Vitest's default sequencer sorts
 * by file size (largest first) so its parallel workers finish together. With
 * fileParallelism off that heuristic buys nothing and actively breaks the
 * test/ suite, whose numeric prefixes are a real dependency order — zz-teardown
 * deletes the fixtures every earlier file asserts against, and 90-cache-
 * staleness mutates roles the RBAC matrix depends on being untouched.
 */
class FilenameSequencer extends BaseSequencer {
  async sort(files: Parameters<BaseSequencer["sort"]>[0]) {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  test: {
    // Specs live beside the code they cover, matching the *.spec.ts names the
    // existing comments in platform.module.ts already promised.
    include: ["src/**/*.spec.ts", "test/**/*.spec.ts"],
    environment: "node",
    // The test/ specs drive ONE shared live database through ONE HTTP server and
    // share the http.ts rate-limit budget, which is per-process. Running spec
    // files in parallel would both blow that budget and let a teardown in one
    // file delete a fixture another file is mid-assertion on. The numeric name
    // prefixes (00-, ... 90-, 99-) are the intended order, so no shuffling.
    fileParallelism: false,
    sequence: { shuffle: false, sequencer: FilenameSequencer },
    // Cache-staleness specs deliberately wait out a 30s TTL.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // The matrices below are pure functions over the registries — no database,
    // no HTTP — so they run in milliseconds and can gate every commit.
    globals: true,
  },
});
