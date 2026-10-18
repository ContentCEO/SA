import type { PGlite, Transaction } from "@electric-sql/pglite";
import type { Database } from "@/db";

/**
 * Make the in-memory database refuse a JS Date as a bound value, the way production's
 * postgres.js does inside a raw sql`` template (plan M8 A10). PGlite quietly accepts one, so
 * without this a `${new Date()}` in raw SQL passes every unit test and fails live. Drizzle's
 * column encoders turn Dates into ISO strings first, so only raw-SQL Dates trip it.
 */
/** The error code a Date bound into raw SQL fails with (in "Failed query: … (code …)"). */
export const DATE_BOUND_CODE = "SA_DATE_BOUND_INTO_SQL";

export function refuseDateParams(database: Database): void {
  const client = (database as unknown as { $client: PGlite }).$client;
  const check = (params: unknown) => {
    if (Array.isArray(params) && params.some((p) => p instanceof Date))
      // The code survives Check 26 P5's SafeQueryError (which drops the cause's message).
      throw Object.assign(
        new TypeError(
          "A Date was bound into SQL: postgres.js can't send one (use toISOString()::timestamptz)",
        ),
        { code: DATE_BOUND_CODE },
      );
  };
  const guard = <T extends Pick<PGlite, "query">>(target: T) => {
    const query = target.query.bind(target);
    target.query = ((q: string, params?: unknown[], options?: unknown) => {
      check(params);
      return query(q, params, options as never);
    }) as T["query"];
  };
  guard(client);
  const transaction = client.transaction.bind(client);
  client.transaction = (<R>(fn: (tx: Transaction) => Promise<R>) =>
    transaction((tx) => {
      guard(tx);
      return fn(tx);
    })) as PGlite["transaction"];
}
