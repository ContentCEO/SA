/**
 * Apply checked-in migrations before a Vercel build (see `vercel-build` in
 * package.json). Migrations are additive-first by convention, so running them
 * ahead of the new code is safe for the code that's currently live.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { checkAfterMigrate, checkBeforeMigrate, type Query } from "./migrate-guard";

const FOLDER = "./drizzle";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log("DATABASE_URL not set; skipping migrations.");
    return;
  }
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const query: Query = (text) => client.unsafe(text) as unknown as ReturnType<Query>;
  try {
    // Check 30 P2: drizzle skips a migration stamped older than the newest applied one without
    // an error. Refuse that (and a malformed journal) before touching the database.
    await checkBeforeMigrate(query, FOLDER);
    await migrate(drizzle(client), { migrationsFolder: FOLDER });
    await checkAfterMigrate(query, FOLDER);
    console.log("Migrations applied.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
