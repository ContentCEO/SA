import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { e2eMode } from "../../src/config/e2e";

/**
 * The same database rule the app's e2e mode uses (src/config/e2e.ts): loopback host or unix
 * socket. Asked with stand-in fake URLs so only the database decides.
 */
function localDatabase(url: string) {
  const fake = "http://127.0.0.1:1";
  return e2eMode({
    SA_E2E: "1",
    SA_E2E_GOOGLE_BASE_URL: fake,
    SA_E2E_ANTHROPIC_BASE_URL: fake,
    DATABASE_URL: url,
    PGHOST: process.env.PGHOST,
  });
}

/** Bring the test database up to the checked-in migrations before any test runs. */
export default async function globalSetup() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("E2E tests need DATABASE_URL (a disposable local Postgres).");
  // Specs seed and delete rows: never against a database on another machine (the shared
  // production one included). A smoke run against a deployed site (PLAYWRIGHT_BASE_URL) is
  // the only exception.
  if (!process.env.PLAYWRIGHT_BASE_URL && !localDatabase(url)) {
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
