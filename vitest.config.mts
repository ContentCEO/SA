import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    // `server-only` throws outside the React server runtime; it's a no-op for tests.
    alias: { "server-only": new URL("./tests/support/empty.ts", import.meta.url).pathname },
  },
  test: {
    include: ["tests/unit/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    // Check 25 P8: a fresh PGlite database (all migrations) per test takes seconds on a busy
    // machine; the 10-second default timed out in beforeEach.
    hookTimeout: 30_000,
    // The same machine runs a test against that database in several seconds under load.
    testTimeout: 60_000,
  },
});
