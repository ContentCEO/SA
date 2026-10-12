import "server-only";
import { eq, isNotNull, or, sql } from "drizzle-orm";
import { threads } from "@/db/schema";

/**
 * SQL pieces about a thread, shared by the quote tracker, the scorecard and the summaries.
 * Content-free: times and flags only. (Price memory is not here and never will be.)
 */

/** A timestamp column or subquery result as a Date (postgres.js and PGlite differ). */
export const asDate = (v: unknown): Date | null => (v ? new Date(v as string | Date) : null);

/** When the customer / the owner last wrote on the thread (correlated subqueries). */
export const lastInSql = () =>
  sql<
    string | Date | null
  >`(select max(m.sent_at) from messages m where m.thread_id = ${threads.id} and m.direction = 'in')`;
export const lastOutSql = () =>
  sql<
    string | Date | null
  >`(select max(m.sent_at) from messages m where m.thread_id = ${threads.id} and m.direction = 'out')`;

/**
 * SQL twin of `isQuoteThread`: sorted as a quote request, or has ever had an outcome
 * (a cleared guess or an owner's reopen keeps its source), whatever its category now.
 */
export const quoteThreadSql = () =>
  or(
    eq(threads.category, "quote_request"),
    isNotNull(threads.quoteOutcome),
    isNotNull(threads.quoteOutcomeSource),
  );
