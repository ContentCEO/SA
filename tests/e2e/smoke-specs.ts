/**
 * The only specs a smoke run against a deployed site (PLAYWRIGHT_BASE_URL) may run: they touch
 * no database (no ./support import, no postgres or drizzle). Everything else seeds rows, which
 * would land in the deployed site's database. tests/unit/e2e-harness.test.ts checks each file.
 */
export const SMOKE_SPECS = ["smoke.spec.ts", "security-public.spec.ts"] as const;
