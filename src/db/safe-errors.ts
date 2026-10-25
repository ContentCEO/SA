import { DrizzleQueryError } from "drizzle-orm";
import { PgPreparedQuery } from "drizzle-orm/pg-core";

/**
 * Check 26 P5: Drizzle's DrizzleQueryError reads "Failed query: <sql>\nparams: <every bound
 * value>", and keeps the values (and the driver's error, whose message can quote a value) on the
 * error. The values are the row being written: draft text, invoice facts, a lead's phone. Next.js
 * prints an unhandled action or route error into Vercel's logs, and Inngest keeps a failed
 * step's error in its run history, so a query error must never carry them.
 *
 * SafeQueryError keeps only the first line of the SQL (placeholders, not values) and the
 * driver's error code (Postgres's SQLSTATE, e.g. "23505", or postgres.js's own code). No params,
 * no cause, no original stack.
 */
export class SafeQueryError extends Error {
  readonly code?: string;
  constructor(query: string, code?: string) {
    super(`Failed query: ${query.split("\n")[0]}${code ? ` (code ${code})` : ""}`);
    this.name = "SafeQueryError";
    if (code) this.code = code;
  }
}

const CODE = /^[A-Za-z0-9_]{1,40}$/;

function isQueryError(e: unknown): e is DrizzleQueryError {
  if (e instanceof DrizzleQueryError) return true;
  // Another copy of drizzle-orm (a bundling quirk) would fail instanceof: match its shape.
  const x = e as { query?: unknown; params?: unknown; message?: unknown } | null;
  return (
    !!x &&
    typeof x.query === "string" &&
    Array.isArray(x.params) &&
    typeof x.message === "string" &&
    x.message.startsWith("Failed query:")
  );
}

/** A DrizzleQueryError becomes a SafeQueryError; anything else is returned as it is. */
export function toSafeQueryError(e: unknown): unknown {
  if (!isQueryError(e)) return e;
  const raw = (e.cause as { code?: unknown } | undefined)?.code;
  return new SafeQueryError(e.query, typeof raw === "string" && CODE.test(raw) ? raw : undefined);
}

let installed = false;

/**
 * Every Drizzle Postgres query (postgres.js in production, PGlite in tests, inside transactions
 * too) runs through PgPreparedQuery.queryWithCache, which is where DrizzleQueryError is made.
 * Wrap it once so the error is swapped before it leaves the database layer.
 */
export function installSafeQueryErrors() {
  if (installed) return;
  installed = true;
  type Run = (this: unknown, ...args: unknown[]) => Promise<unknown>;
  const proto = PgPreparedQuery.prototype as unknown as { queryWithCache: Run };
  const original = proto.queryWithCache;
  proto.queryWithCache = async function (this: unknown, ...args: unknown[]) {
    try {
      return await original.apply(this, args);
    } catch (e) {
      throw toSafeQueryError(e);
    }
  };
}
