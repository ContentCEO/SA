import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** Bring the test database up to the checked-in migrations before any test runs. */
export default async function globalSetup() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("E2E tests need DATABASE_URL (a disposable local Postgres).");
  const client = postgres(url, { max: 1, onnotice: () => {} });
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  // Every run comes from 127.0.0.1; start each with fresh abuse-limit windows.
  await client`delete from rate_limits`;
  await client.end();
}
