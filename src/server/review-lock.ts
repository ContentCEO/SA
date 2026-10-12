import { sql, type SQL } from "drizzle-orm";

/**
 * One review request per customer address a year, even with two taps on two threads at once
 * (A16): `createDraftForThread` takes this lock inside its transaction before it re-checks
 * and inserts, so the second tap waits for the first and then sees its draft. Released when
 * the transaction ends. Kept free of `server-only` so the e2e suite can run it against real
 * Postgres (PGlite in unit tests is more forgiving).
 */
export async function lockReviewAddress(
  tx: { execute(query: SQL): PromiseLike<unknown> },
  workspaceId: string,
  address: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`review:${workspaceId}:${address.toLowerCase()}`}))`,
  );
}
