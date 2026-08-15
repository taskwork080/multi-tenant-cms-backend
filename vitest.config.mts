import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Specs live beside the code they cover, matching the *.spec.ts names the
    // existing comments in platform.module.ts already promised.
    include: ["src/**/*.spec.ts", "test/**/*.spec.ts"],
    environment: "node",
    // The matrices below are pure functions over the registries — no database,
    // no HTTP — so they run in milliseconds and can gate every commit.
    globals: true,
  },
});
