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
    // Check 25 P8 / Check 31 P7: a fresh PGlite database (all migrations) per test file or
    // test takes seconds on a busy machine (load 10-20 on 4 cores); the 10-second default timed
    // out in beforeEach. Migrating in beforeEach/beforeAll is the slow part, so hooks get a
    // minute.
    hookTimeout: 60_000,
    // A test body against that database takes several seconds under the same load (10-14 s
    // seen for the slowest). Kept at Check 25 P8's 60 s rather than Check 31 P7's 20 s: at 20 s
    // those pass alone and fail only when the machine is loaded.
    testTimeout: 60_000,
    // Check 31 P7: model and job metadata lines print only for a failing test.
    setupFiles: ["./tests/support/setup.ts"],
    // One migrated database per run, copied by createTestDb (tests/support/db-snapshot.ts).
    globalSetup: ["./tests/support/db-snapshot.ts"],
  },
});
