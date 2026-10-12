import "server-only";
import { eq, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { threads } from "@/db/schema";
import { NO_REPLY_LOCAL_PATTERN } from "./sender-rules";

/**
 * SQL pieces about a thread, shared by the quote tracker, the scorecard and the summaries.
 * Content-free: times and flags only. (Price memory is not here and never will be.)
 */

/** A timestamp column or subquery result as a Date (postgres.js and PGlite differ). */
export const asDate = (v: unknown): Date | null => (v ? new Date(v as string | Date) : null);

/**
 * The outer thread's id, always written "threads"."id". Drizzle writes a column that sits
 * directly in a selected field of a one-table query as a bare "id" — which, inside a
 * subquery on messages, would quietly mean the message's own id. Nested, it's qualified.
 */
const outerThreadId = () => sql`${threads.id}`;

/** When the customer / the owner last wrote on the thread (correlated subqueries). */
export const lastInSql = () =>
  sql<
    string | Date | null
  >`(select max(m.sent_at) from messages m where m.thread_id = ${outerThreadId()} and m.direction = 'in')`;
export const lastOutSql = () =>
  sql<
    string | Date | null
  >`(select max(m.sent_at) from messages m where m.thread_id = ${outerThreadId()} and m.direction = 'out')`;

/**
 * Since when the customer has been waiting (plan M8 A14): their first message after the
 * owner's last one. Null when the owner wrote last (or nobody wrote in) — nothing to wait on.
 */
export const waitingSinceSql = () =>
  sql<
    string | Date | null
  >`(select min(w.sent_at) from messages w where w.thread_id = ${outerThreadId()} and w.direction = 'in' and w.sent_at > coalesce(${lastOutSql()}, '-infinity'::timestamptz))`;

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

/**
 * A quote request, even one later re-sorted (plan M8 A11): the sticky `quote_requested_at`
 * mark from classification, or the current quote-thread rule (older threads have no mark).
 */
export const quoteRequestSql = () => or(isNotNull(threads.quoteRequestedAt), quoteThreadSql());

/**
 * SQL twin of `isNoReplyAddress` for an address expression: the local part before the last
 * "@" matches the shared no-reply pattern. Used only inside WHERE clauses, so the address
 * itself never leaves the database.
 */
export const noReplySql = (address: SQL) =>
  sql`(position('@' in coalesce(${address}, '')) > 1 and regexp_replace(lower(trim(${address})), '@[^@]*$', '') ~ ${NO_REPLY_LOCAL_PATTERN})`;
