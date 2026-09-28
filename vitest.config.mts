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
  },
});
