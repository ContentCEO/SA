import "server-only";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";
import { prepareBody } from "@/ai/classify";
import { db } from "@/db";
import {
  activityLog,
  appSettings,
  drafts,
  mailboxes,
  messages,
  priceHistory,
  threads,
  workspaces,
  type Mailbox,
} from "@/db/schema";
import { MailboxAuthError, type MailboxReader, type MailMessage } from "@/mailbox/connector";
import { jobsAllowed } from "./lifecycle";
import { amountFromOwnerText } from "./quote-rules";
import { defaultReaderFor, isUnsentDraft, markReconnectNeeded } from "./sync";
import { notDraftSql, unsentDraftMessage } from "./thread-sql";

/**
 * One-shot data fix, run by the 15-minute workspace-lifecycle job after the M7 backfill.
 *
 * Until sync learned to skip them (`isUnsentDraft` in sync.ts), every Gmail draft — each reply
 * we drafted, and the owner's own drafts — was stored as a message from the owner (direction
 * 'out'), and moved its thread's `last_message_at` to the draft's time. Stored labels are never
 * trusted here: if Gmail keeps a draft's id when it's sent, a row stored as a draft may be the
 * owner's real answer. So, mailbox by mailbox:
 *
 * 1. A row whose id an app send recorded (`drafts.sent_gmail_message_id`) was sent: it takes
 *    the SENT label, no Gmail call needed.
 * 2. Every other row still marked DRAFT is looked up in Gmail. Sent now → updated in place
 *    (labels, time). Gone (404) or still a draft → deleted.
 * 3. A pending draft that replies to a deleted row is re-pointed to the newest real message on
 *    its thread (the customer never got the deleted one).
 * 4. A quote amount or price-memory row captured from a deleted draft's text (draft.v2+ quotes
 *    the price list) is cleared, unless the same figure is in the owner's real mail, the owner
 *    typed it, or a real owner email's text is already purged (it may have had the figure);
 *    `captureQuoteAmounts` then works it out again from sent mail.
 * 5. `last_message_at` is recomputed from what's left (a thread with nothing left keeps it).
 *
 * Gmail calls happen outside the transaction; each mailbox's writes are one transaction.
 * Done is tracked per mailbox: once a mailbox has no stored draft left it gets its own marker
 * (`draftMessagesDoneKey`) and isn't looked at again. A mailbox we can't read (lost access,
 * read-only account) keeps its rows and gets no marker, so every run checks it again (one
 * query) until it can be read — after a reconnect or a payment its rows are verified like the
 * rest. Meanwhile the "the owner wrote" checks ignore those rows (`notDraftSql`), and auto-
 * drafting and autopilot wait on a thread that has one after the customer's email (it might be
 * the owner's answer, sent under the same id). A failure (rate limit, error) is logged by error
 * name only and that mailbox gets no marker, so the next run tries again; so does a mailbox
 * with more rows than one run takes. The run-wide key is written only when every mailbox is
 * done; after that the job is a no-op. Counts only, never content.
 */
export const DRAFT_MESSAGES_CLEANUP_KEY = "cleanup:draft-messages-v1";
/** One mailbox's marker: none of its stored drafts is left to check. */
export const draftMessagesDoneKey = (mailboxId: string) =>
  `${DRAFT_MESSAGES_CLEANUP_KEY}:${mailboxId}`;
/** Gmail look-ups per mailbox per run (four at a time); the rest wait for the next run. */
export const DRAFT_MESSAGES_BATCH = 100;
const LOOKUP_CONCURRENCY = 4;

export type DraftMessagesCleanupResult =
  | { ran: false }
  | {
      ran: true;
      deleted: number;
      markedSent: number;
      threadsUpdated: number;
      pricesCleared: number;
      skipped: number;
      failed: number;
    };

export type DraftMessagesCleanupDeps = {
  readerFor?: (m: Mailbox) => Pick<MailboxReader, "getMessage">;
};

type Totals = Omit<Extract<DraftMessagesCleanupResult, { ran: true }>, "ran">;

export async function runDraftMessagesCleanup(
  now: Date = new Date(),
  deps: DraftMessagesCleanupDeps = {},
): Promise<DraftMessagesCleanupResult> {
  const [done] = await db()
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(eq(appSettings.key, DRAFT_MESSAGES_CLEANUP_KEY));
  if (done) return { ran: false };

  const boxes = await db()
    .select({ mailbox: mailboxes, workspace: workspaces })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId));
  const doneBoxes = new Set(
    (
      await db()
        .select({ key: appSettings.key })
        .from(appSettings)
        .where(like(appSettings.key, `${DRAFT_MESSAGES_CLEANUP_KEY}:%`))
    ).map((r) => r.key),
  );
  const markDone = (mailboxId: string) =>
    db()
      .insert(appSettings)
      .values({ key: draftMessagesDoneKey(mailboxId), value: now.toISOString(), updatedAt: now })
      .onConflictDoNothing();
  const totals: Totals = {
    deleted: 0,
    markedSent: 0,
    threadsUpdated: 0,
    pricesCleared: 0,
    skipped: 0,
    failed: 0,
  };
  let more = false;
  for (const { mailbox, workspace } of boxes) {
    if (doneBoxes.has(draftMessagesDoneKey(mailbox.id))) continue;
    try {
      // 1. Proven sent by our own send: no Gmail call needed.
      totals.markedSent += await markRecordedSends(mailbox.id);
      const rows = await db()
        .select({
          id: messages.id,
          gmailMessageId: messages.gmailMessageId,
          threadId: messages.threadId,
          sentAt: messages.sentAt,
        })
        .from(messages)
        .where(and(eq(messages.mailboxId, mailbox.id), unsentDraftMessage()))
        .orderBy(messages.sentAt)
        .limit(DRAFT_MESSAGES_BATCH);
      if (rows.length === 0) {
        await markDone(mailbox.id);
        continue;
      }
      if (mailbox.status !== "active" || !jobsAllowed(workspace, now)) {
        // Its rows wait (no marker): checked again every run until it can be read.
        totals.skipped++;
        continue;
      }
      // 2. Ask Gmail what each one is now.
      const reader = (deps.readerFor ?? defaultReaderFor)(mailbox);
      const found: (MailMessage | null)[] = [];
      for (let i = 0; i < rows.length; i += LOOKUP_CONCURRENCY) {
        found.push(
          ...(await Promise.all(
            rows
              .slice(i, i + LOOKUP_CONCURRENCY)
              .map((r) => reader.getMessage(r.gmailMessageId, { withBody: false })),
          )),
        );
      }
      const sent = rows.flatMap((r, i) => {
        const m = found[i];
        return m && !isUnsentDraft(m.labelIds) ? [{ ...r, message: m }] : [];
      });
      const gone = rows.filter((_, i) => !found[i] || isUnsentDraft(found[i]!.labelIds));
      const r = await applyMailbox(mailbox.id, sent, gone);
      totals.markedSent += r.markedSent;
      totals.deleted += r.deleted;
      totals.threadsUpdated += r.threadsUpdated;
      totals.pricesCleared += r.pricesCleared;
      // Every row this run took is now settled (updated or deleted); a full batch may have more.
      if (rows.length === DRAFT_MESSAGES_BATCH) more = true;
      else await markDone(mailbox.id);
    } catch (err) {
      if (err instanceof MailboxAuthError) {
        // Lost access: like every job, mark it; its rows wait (see above).
        await markReconnectNeeded(mailbox);
        totals.skipped++;
        continue;
      }
      totals.failed++;
      console.error("draft_messages_cleanup_failed", {
        mailboxId: mailbox.id,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  // Every mailbox done: nothing failed, nothing skipped, nothing left over.
  if (totals.failed === 0 && totals.skipped === 0 && !more) {
    await db()
      .insert(appSettings)
      .values({ key: DRAFT_MESSAGES_CLEANUP_KEY, value: now.toISOString(), updatedAt: now })
      .onConflictDoNothing();
  }
  // Counts only.
  console.info("draft_messages_cleanup", totals);
  return { ran: true, ...totals };
}

/** Rows our own send recorded as sent (same id): SENT instead of DRAFT, time = the send. */
async function markRecordedSends(mailboxId: string): Promise<number> {
  return db().transaction(async (tx) => {
    const updated = await tx
      .update(messages)
      .set({
        labelIds: sql`(${messages.labelIds} - 'DRAFT') || '["SENT"]'::jsonb`,
        direction: "out",
        sentAt: sql`greatest(${messages.sentAt}, coalesce((select max(d.decided_at) from drafts d where d.sent_gmail_message_id = "messages"."gmail_message_id" and d.mailbox_id = "messages"."mailbox_id"), ${messages.sentAt}))`,
      })
      .where(
        and(
          eq(messages.mailboxId, mailboxId),
          unsentDraftMessage(),
          sql`exists (select 1 from drafts d where d.sent_gmail_message_id = "messages"."gmail_message_id" and d.mailbox_id = "messages"."mailbox_id")`,
        ),
      )
      .returning({ threadId: messages.threadId });
    await recomputeThreadTimes(
      tx,
      updated.map((u) => u.threadId),
    );
    return updated.length;
  });
}

type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

/**
 * `last_message_at` from the thread's stored messages; a thread with none left keeps its time.
 * Written out in full: inside the subquery a bare "id" would mean the message's own.
 */
async function recomputeThreadTimes(tx: Tx, threadIds: string[]): Promise<number> {
  const ids = [...new Set(threadIds)];
  if (ids.length === 0) return 0;
  const newest = sql`(select max(m.sent_at) from messages m where m.thread_id = "threads"."id")`;
  const updated = await tx
    .update(threads)
    .set({ lastMessageAt: newest })
    .where(
      and(
        inArray(threads.id, ids),
        sql`${newest} is not null`,
        sql`${threads.lastMessageAt} is distinct from ${newest}`,
      ),
    )
    .returning({ id: threads.id });
  return updated.length;
}

type Row = { id: string; gmailMessageId: string; threadId: string; sentAt: Date };

async function applyMailbox(
  mailboxId: string,
  sent: (Row & { message: MailMessage })[],
  gone: Row[],
) {
  return db().transaction(async (tx) => {
    let markedSent = 0;
    for (const s of sent) {
      const done = await tx
        .update(messages)
        .set({
          labelIds: s.message.labelIds,
          direction: "out",
          sentAt: new Date(s.message.internalDate),
          // Owner mail: nobody to reply to (same rule as sync).
          replyToHeader: {},
        })
        .where(and(eq(messages.id, s.id), unsentDraftMessage()))
        .returning({ id: messages.id });
      markedSent += done.length;
    }
    if (gone.length === 0 && markedSent === 0) {
      return { markedSent, deleted: 0, threadsUpdated: 0, pricesCleared: 0 };
    }

    const goneIds = gone.map((g) => g.id);
    let pricesCleared = 0;
    let deleted = 0;
    if (goneIds.length) {
      // 3. A pending reply threaded to a draft the customer never got → the newest real message.
      await tx
        .update(drafts)
        .set({
          replyToMessageId: sql`(select m.id from messages m where m.thread_id = "drafts"."thread_id" and ${notDraftSql("m")} order by m.sent_at desc limit 1)`,
        })
        .where(and(eq(drafts.status, "pending"), inArray(drafts.replyToMessageId, goneIds)));

      // 4. Prices captured from a draft's text (read here, in memory only; never logged).
      pricesCleared = await clearDraftPrices(tx, gone);

      const removed = await tx
        .delete(messages)
        .where(
          and(
            eq(messages.mailboxId, mailboxId),
            inArray(messages.id, goneIds),
            unsentDraftMessage(),
          ),
        )
        .returning({ id: messages.id });
      deleted = removed.length;
    }

    // 5. The thread's time from what's left.
    const threadsUpdated = await recomputeThreadTimes(
      tx,
      [...gone, ...sent].map((r) => r.threadId),
    );
    return { markedSent, deleted, threadsUpdated, pricesCleared };
  });
}

const figureIn = (body: string | null) => (body ? amountFromOwnerText(prepareBody(body)) : null);

/**
 * Step 4. A thread's quote amount or price-memory row came from a deleted draft when the
 * draft's text has that figure (or, its text purged, price memory was dated to it), and no
 * real owner email on the thread has it. Then the amount is cleared (unless the owner typed it
 * on Won) and the price-memory row deleted. Only when that's certain: if any real owner email
 * on the thread has lost its text to the purge, nothing is cleared (it may have had the
 * figure, and captureQuoteAmounts couldn't find it again). Returns how many threads changed.
 */
async function clearDraftPrices(tx: Tx, gone: Row[]): Promise<number> {
  const threadIds = [...new Set(gone.map((g) => g.threadId))];
  const affected = await tx
    .select({
      id: threads.id,
      amount: threads.quoteAmountCents,
      phAmount: priceHistory.amountCents,
      phQuotedAt: priceHistory.quotedAt,
    })
    .from(threads)
    .leftJoin(priceHistory, eq(priceHistory.threadId, threads.id))
    .where(
      and(
        inArray(threads.id, threadIds),
        sql`(${threads.quoteAmountCents} is not null or ${priceHistory.id} is not null)`,
      ),
    );
  if (affected.length === 0) return 0;
  const goneIds = new Set(gone.map((g) => g.id));
  const owner = await tx
    .select({
      id: messages.id,
      threadId: messages.threadId,
      direction: messages.direction,
      body: messages.bodyText,
      labelIds: messages.labelIds,
    })
    .from(messages)
    .where(
      and(
        inArray(
          messages.threadId,
          affected.map((a) => a.id),
        ),
        // The owner's mail and the drafts being deleted; never the customer's text.
        or(eq(messages.direction, "out"), inArray(messages.id, [...goneIds])),
      ),
    );
  const typed = await tx
    .select({ threadId: activityLog.threadId })
    .from(activityLog)
    .where(
      and(
        inArray(
          activityLog.threadId,
          affected.map((a) => a.id),
        ),
        eq(activityLog.action, "quote_marked"),
        sql`${activityLog.detail}->>'amountTyped' = 'true'`,
      ),
    );
  const ownerTyped = new Set(typed.map((t) => t.threadId));

  let changed = 0;
  for (const a of affected) {
    const draftRows = owner.filter((m) => m.threadId === a.id && goneIds.has(m.id));
    const real = owner.filter(
      (m) =>
        m.threadId === a.id &&
        m.direction === "out" &&
        !goneIds.has(m.id) &&
        !isUnsentDraft(m.labelIds),
    );
    const goneRows = gone.filter((g) => g.threadId === a.id);
    const fromDraft = (cents: number) =>
      draftRows.some((m) =>
        m.body != null
          ? figureIn(m.body) === cents
          : a.phQuotedAt != null &&
            goneRows.some(
              (g) => g.id === m.id && g.sentAt.getTime() === new Date(a.phQuotedAt!).getTime(),
            ),
      );
    const inRealMail = (cents: number) => real.some((m) => figureIn(m.body) === cents);
    // A real owner email whose text is already purged may well have said the same figure (a
    // nudge repeating the quote): we can't tell, and once cleared it could never come back,
    // so the amount and price memory stay as they are.
    if (real.some((m) => m.body == null)) continue;

    let did = false;
    if (a.amount != null && !ownerTyped.has(a.id) && fromDraft(a.amount) && !inRealMail(a.amount)) {
      await tx.update(threads).set({ quoteAmountCents: null }).where(eq(threads.id, a.id));
      did = true;
    }
    if (a.phAmount != null && fromDraft(a.phAmount) && !inRealMail(a.phAmount)) {
      await tx.delete(priceHistory).where(eq(priceHistory.threadId, a.id));
      did = true;
    }
    if (did) changed++;
  }
  return changed;
}
