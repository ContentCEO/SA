import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { setDbForTests, type Database } from "@/db";
import * as schema from "@/db/schema";

/** Fresh in-memory Postgres with all checked-in migrations applied. */
export async function createTestDb(): Promise<Database> {
  const client = new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: "./drizzle" });
  setDbForTests(database as unknown as Database);
  return database as unknown as Database;
}
