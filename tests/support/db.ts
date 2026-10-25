import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { setDbForTests, type Database } from "@/db";
import * as schema from "@/db/schema";
import { readFileSync } from "node:fs";
import { inject } from "vitest";
import { refuseDateParams } from "./no-date-params";

/**
 * Fresh in-memory Postgres with all checked-in migrations applied. Like production's
 * postgres.js, it refuses a JS Date bound into raw SQL (plan M8 A10), so every unit test
 * catches a `${date}` that would only fail live.
 */
export async function createTestDb(): Promise<Database> {
  // Tests use one database at a time (setDbForTests points the app at the newest), so the
  // previous one is closed: loading a copy is fast enough that unclosed ones piled up faster
  // than garbage collection freed them and the workers ran out of memory.
  if (current && !current.closed) await current.close();
  const snapshot = migratedSnapshot();
  const client = snapshot ? new PGlite({ loadDataDir: snapshot }) : new PGlite();
  current = client;
  const database = drizzle(client, { schema });
  // The snapshot is these same migrations, applied once per run (tests/support/db-snapshot.ts).
  if (!snapshot) await migrate(database, { migrationsFolder: "./drizzle" });
  refuseDateParams(database as unknown as Database);
  setDbForTests(database as unknown as Database);
  return database as unknown as Database;
}

let current: PGlite | null = null;
let snapshotBlob: Blob | null | undefined;

/** The run's migrated data directory, read once per test file; null without the global setup. */
function migratedSnapshot(): Blob | null {
  if (snapshotBlob === undefined) {
    const path = inject("pgliteSnapshotPath");
    snapshotBlob = path ? new Blob([readFileSync(path)]) : null;
  }
  return snapshotBlob;
}
