import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { setDbForTests, type Database } from "@/db";
import * as schema from "@/db/schema";
import { refuseDateParams } from "./no-date-params";

/**
 * Fresh in-memory Postgres with all checked-in migrations applied. Like production's
 * postgres.js, it refuses a JS Date bound into raw SQL (plan M8 A10), so every unit test
 * catches a `${date}` that would only fail live.
 */
export async function createTestDb(): Promise<Database> {
  const client = new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: "./drizzle" });
  refuseDateParams(database as unknown as Database);
  setDbForTests(database as unknown as Database);
  return database as unknown as Database;
}
