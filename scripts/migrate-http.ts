/**
 * Apply checked-in migrations over Neon's HTTPS endpoint instead of TCP 5432.
 * For environments where Postgres ports are blocked (e.g. cloud sandboxes).
 * Usage: DATABASE_URL=... pnpm db:migrate:http
 * Same migration table as `drizzle-kit migrate`, so the two are interchangeable.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  await migrate(drizzle(neon(url)), { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
