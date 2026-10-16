import "server-only";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { DISPUTE_REASONS } from "@/ai/classify";
import { db } from "@/db";
import { appSettings, threads } from "@/db/schema";

/**
 * One-shot data fix for Milestone 7, run by the 15-minute workspace-lifecycle job.
 *
 * Migrations 0023/0024 back-filled the same two things, but migrations run when a preview
 * builds — against the database production shares — while the old production code is still
 * sorting mail and taking the owner's Won/Lost taps without knowing the new columns. This
 * repeats the back-fill from new code, which only runs once production runs it (Inngest only
 * reaches production), so whatever the old code wrote in between is covered.
 *
 * - Complaints: a thread still sorted as a complaint, or still showing a dispute / legal
 *   reason, or with `extracted.disputed`, gets the sticky `complained_at` mark (A1). A
 *   complaint the old code re-sorted as something else before the merge left no trace and
 *   can't be recovered (no category history is kept).
 * - Quote outcomes: when the owner's newest Won/Lost/Reopen tap (`quote_marked`, which every
 *   version writes) is newer than our newest guess (`quote_outcome_guessed`), the thread's
 *   outcome is the owner's: `quote_outcome_source = 'owner'`, so our guesses never touch it.
 *   That covers an old-code tap over one of our guesses (which left `'auto'`) and an old-code
 *   Reopen (which left the source empty).
 *
 * Gated by an `app_settings` key written in the same transaction, so it runs once; both
 * updates only touch rows that still need it, so a second run would change nothing anyway.
 */
export const M7_BACKFILL_KEY = "backfill:m7-v1";

export type M7BackfillResult =
  { ran: false } | { ran: true; complaintsMarked: number; ownerOutcomes: number };

export async function runM7Backfill(now: Date = new Date()): Promise<M7BackfillResult> {
  const [done] = await db()
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(eq(appSettings.key, M7_BACKFILL_KEY));
  if (done) return { ran: false };

  return db().transaction(async (tx) => {
    const complaints = await tx
      .update(threads)
      .set({
        complainedAt: sql`coalesce(${threads.classifiedAt}, ${threads.lastMessageAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(
        and(
          isNull(threads.complainedAt),
          or(
            eq(threads.category, "complaint"),
            inArray(threads.needsOwnerReason, [...DISPUTE_REASONS]),
            sql`${threads.extracted}->>'disputed' = 'true'`,
          ),
        ),
      )
      .returning({ id: threads.id });

    const owner = await tx
      .update(threads)
      .set({ quoteOutcomeSource: "owner" })
      .where(
        and(
          sql`${threads.quoteOutcomeSource} is distinct from 'owner'`,
          sql`(select max(a.created_at) from activity_log a where a.thread_id = ${threads.id} and a.action = 'quote_marked')
            > coalesce((select max(g.created_at) from activity_log g where g.thread_id = ${threads.id} and g.action = 'quote_outcome_guessed'), '-infinity'::timestamptz)`,
        ),
      )
      .returning({ id: threads.id });

    await tx
      .insert(appSettings)
      .values({ key: M7_BACKFILL_KEY, value: now.toISOString(), updatedAt: now })
      .onConflictDoNothing();

    // Counts only.
    return { ran: true, complaintsMarked: complaints.length, ownerOutcomes: owner.length };
  });
}
