import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema";

/** Any Postgres-backed Drizzle database with our schema (Neon/local Postgres, PGlite in tests). */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

let _db: Database | undefined;

function createDb(): Database {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. See .env.example.");
  // Neon's pooled endpoint runs PgBouncer in transaction mode: no prepared statements.
  const client = postgres(url, { prepare: false, max: 5 });
  return drizzle(client, { schema }) as unknown as Database;
}

/** Lazily created so builds and tests don't need a database. */
export function db(): Database {
  _db ??= createDb();
  return _db;
}

/** Tests only: swap in an in-memory database. */
export function setDbForTests(database: Database | undefined) {
  _db = database;
}

export { schema };
