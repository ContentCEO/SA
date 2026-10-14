import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { isLocalDatabaseUrl } from "../../src/config/e2e";

/** Bring the test database up to the checked-in migrations before any test runs. */
export default async function globalSetup() {
  // A smoke run against a deployed site (PLAYWRIGHT_BASE_URL) never opens a database: no
  // migrate, no rate_limits wipe, whatever DATABASE_URL says. playwright.config.ts also limits
  // it to the specs that touch no database (tests/e2e/smoke-specs.ts).
  if (process.env.PLAYWRIGHT_BASE_URL) return;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("E2E tests need DATABASE_URL (a disposable local Postgres).");
  // Specs seed and delete rows: never against a database on another machine (the shared
  // production one included). The app's e2e-mode rule (src/config/e2e.ts), which reads the
  // URL the way postgres.js does.
  if (!isLocalDatabaseUrl(url, process.env)) {
    throw new Error(
      "E2E tests only run against a Postgres on this machine (localhost, 127.0.0.1, ::1 or a " +
        "unix socket). Point DATABASE_URL in .env.local at a disposable local database.",
    );
  }
  const client = postgres(url, { max: 1, onnotice: () => {} });
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  // Every run comes from 127.0.0.1; start each with fresh abuse-limit windows.
  await client`delete from rate_limits`;
  await client.end();
}
