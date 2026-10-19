import "server-only";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Category } from "@/ai/prompts/classify.v4";
import { db } from "@/db";
import { activityLog, drafts, mailboxes, threads, workspaces } from "@/db/schema";
import { discardDraft, expireWaitingDeposit, type DraftDeps } from "./drafts";
import { effectiveStatus, jobsAllowed, ReadOnlyError } from "./lifecycle";
import { notDraftSql, sideEmailSql } from "./thread-sql";

export type ResortOutcome = "moved" | "not_found" | "sending" | "same";

/**
 * Ideas H4: the owner moves a conversation to another kind ("Wrong kind?" → Move it). It fixes
 * this conversation only, and wins over the sorter on every later email (`category_manual`).
 *
 * - To Complaint: it needs the owner, and the sticky complaint mark is set.
 * - To Junk: off "Needs you" (unless the owner said so themselves), and a waiting reply is thrown
 *   away here and in Gmail — refused while that reply is set to send.
 * - To Quote request: counted as a request from the customer's first email since the owner's
 *   last real reply (the same rule as classification).
 * - Away from Quote request while undecided: the request mark, the kind of job and a quote
 *   acceptance go (the only thing that ever clears `quote_requested_at`), and a waiting deposit
 *   note is withdrawn. A decided quote keeps everything.
 * - Any move stops an autopilot countdown.
 */
export async function resortThread(
  workspaceId: string,
  threadId: string,
  category: Category,
  opts: DraftDeps = {},
): Promise<ResortOutcome> {
  const now = opts.now?.() ?? new Date();
  const [row] = await db()
    .select({ thread: threads, workspace: workspaces })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(and(eq(threads.id, threadId), eq(mailboxes.workspaceId, workspaceId)));
  if (!row) return "not_found";
  if (!jobsAllowed(row.workspace, now))
    throw new ReadOnlyError(effectiveStatus(row.workspace, now));
  const from = row.thread.category;
  if (from === category && row.thread.categoryManual === category) return "same";

  const [pending] = await db()
    .select({ id: drafts.id, sendAfter: drafts.sendAfter })
    .from(drafts)
    .where(and(eq(drafts.threadId, threadId), eq(drafts.status, "pending")));
  if (category === "noise" && pending?.sendAfter) return "sending";

  const nowIso = now.toISOString();
  const undecided = row.thread.quoteOutcome == null;
  const leavingQuote = from === "quote_request" && category !== "quote_request" && undecided;
  const requestTime = sql`(select min(i.sent_at) from messages i where i.thread_id = ${threads.id} and i.direction = 'in' and not ${sideEmailSql("i")} and i.sent_at > coalesce((select max(o.sent_at) from messages o where o.thread_id = ${threads.id} and o.direction = 'out' and ${notDraftSql("o")} and not ${sideEmailSql("o")}), '-infinity'::timestamptz))`;

  await db()
    .update(threads)
    .set({
      category,
      categoryManual: category,
      categoryManualAt: now,
      // The sorter's own kind, kept the first time the owner overrides it (threads sorted
      // before it was stored), so automatic drafts know what the sorter thought.
      extracted: sql`case when ${threads.categoryManual} is null and not (coalesce(${threads.extracted}, '{}'::jsonb) ? 'model_category') and ${threads.category} is not null then coalesce(${threads.extracted}, '{}'::jsonb) || jsonb_build_object('model_category', ${threads.category}) else ${threads.extracted} end${
        leavingQuote ? sql` - 'quote_accepted' - 'quote_accepted_at'` : sql``
      }`,
      ...(category === "complaint"
        ? {
            needsOwner: true,
            needsOwnerManual: true,
            needsOwnerReason: "You marked this a complaint.",
            needsOwnerSince: sql`${nowIso}::timestamptz`,
            complainedAt: sql`greatest(${threads.complainedAt}, ${nowIso}::timestamptz)`,
          }
        : category === "noise"
          ? { needsOwner: sql`${threads.needsOwnerManual}` }
          : {}),
      ...(category === "quote_request"
        ? {
            quoteRequestedAt: sql`coalesce(${threads.quoteRequestedAt}, ${requestTime}, (select min(i.sent_at) from messages i where i.thread_id = ${threads.id} and i.direction = 'in'))`,
          }
        : leavingQuote
          ? { quoteRequestedAt: null, jobKind: null }
          : {}),
    })
    .where(eq(threads.id, threadId));

  if (pending) {
    if (category === "noise") {
      await discardDraft(workspaceId, pending.id, opts);
    } else {
      await db()
        .update(drafts)
        .set({ autoSendAt: null })
        .where(and(eq(drafts.id, pending.id), isNotNull(drafts.autoSendAt)));
      if (leavingQuote) await expireWaitingDeposit(threadId, opts);
    }
  }
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "owner",
      action: "thread_resorted",
      threadId,
      detail: { from, to: category },
    });
  return "moved";
}
