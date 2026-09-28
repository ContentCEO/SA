import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

let _db: ReturnType<typeof createDb> | undefined;

function createDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. See .env.example.");
  return drizzle(neon(url), { schema });
}

/** Lazily created so builds and tests don't need a database. */
export function db() {
  _db ??= createDb();
  return _db;
}
