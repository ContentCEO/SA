import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { mailboxes, threads } from "@/db/schema";
import { FOLLOWUP_CATEGORIES, followupSettings, MAX_FOLLOWUPS } from "./drafts";

/** Don't chase anything the owner last wrote about more than this long ago. */
export const FOLLOWUP_MAX_AGE_DAYS = 21;

/**
 * Threads due a nudge, for the daily scan:
 * - a quote or invoice thread that isn't flagged for the owner;
 * - the owner wrote last, at least `days` ago (and not ages ago);
 * - the customer has written at least once (someone to nudge);
 * - fewer than two nudges sent, ever;
 * - no draft of any kind since the owner's last message — so a nudge the
 *   owner discarded isn't written again until they write again — and none pending.
 */
export async function threadsToFollowUp(
  mailboxId: string,
  now: Date = new Date(),
  limit = 20,
): Promise<string[]> {
  const [box] = await db()
    .select({ workspaceId: mailboxes.workspaceId })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId));
  if (!box) return [];
  const settings = await followupSettings(box.workspaceId);
  if (!settings.enabled) return [];

  const quietSince = new Date(now.getTime() - settings.days * 86_400_000).toISOString();
  const notBefore = new Date(now.getTime() - FOLLOWUP_MAX_AGE_DAYS * 86_400_000).toISOString();
  const lastIn = sql`(select max(m.sent_at) from messages m where m.thread_id = ${threads.id} and m.direction = 'in')`;
  const lastOut = sql`(select max(m.sent_at) from messages m where m.thread_id = ${threads.id} and m.direction = 'out')`;
  const lastDraft = sql`(select max(d.created_at) from drafts d where d.thread_id = ${threads.id})`;
  const sentNudges = sql`(select count(*) from drafts d where d.thread_id = ${threads.id} and d.kind = 'followup' and d.status in ('sent', 'edited_and_sent'))`;
  const pending = sql`exists (select 1 from drafts d where d.thread_id = ${threads.id} and d.status = 'pending')`;

  const rows = await db()
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.mailboxId, mailboxId),
        eq(threads.needsOwner, false),
        inArray(threads.category, [...FOLLOWUP_CATEGORIES]),
        sql`${lastIn} is not null`,
        sql`${lastOut} > ${lastIn}`,
        sql`${lastOut} <= ${quietSince}::timestamptz`,
        sql`${lastOut} >= ${notBefore}::timestamptz`,
        sql`${sentNudges} < ${MAX_FOLLOWUPS}`,
        sql`(${lastDraft} is null or ${lastDraft} < ${lastOut})`,
        sql`not ${pending}`,
      ),
    )
    .orderBy(desc(threads.lastMessageAt))
    .limit(limit);
  return rows.map((r) => r.id);
}
