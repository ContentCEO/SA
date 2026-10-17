import "server-only";
import { and, desc, eq, gte, inArray, isNull, like, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  activityLog,
  appSettings,
  drafts,
  mailboxes,
  messages,
  threads,
  workspaces,
  type Mailbox,
} from "@/db/schema";
import { MailboxAuthError, type MailboxReader, type MailboxWriter } from "@/mailbox/connector";
import { sameText } from "@/mailbox/mime";
import { mailboxOn } from "./mailbox-plan-rules";
import { defaultWriter, mimeFor, replyToHeaders } from "./drafts";
import { jobsAllowed } from "./lifecycle";
import { storeReplyTo, workspaceMailboxEmails } from "./reply-address";
import {
  looksLikeFormSender,
  pickReplyTo,
  REPOINTED_FLAG,
  type ReplyToHeader,
} from "./reply-address-rules";
import { localParts } from "./snooze-rules";
import { workspaceTimeZone } from "./snooze";
import { BACKFILL_DAYS, defaultReaderFor, markReconnectNeeded } from "./sync";
import { sideEmailSql, unsentDraftSql } from "./thread-sql";

/**
 * One-shot data fix for website-form leads (review "Must fix", B1), its own 15-minute job so a
 * slow mailbox never delays the lifecycle job.
 *
 * Sync now stores each inbound email's usable Reply-To (`messages.reply_to_header`). Rows
 * stored before that are NULL ("never read"). For each mailbox, newest first:
 *
 * 1. Inbound emails from the last 30 days on inbox threads with no stored Reply-To get one
 *    Gmail read each — format=metadata, the Reply-To header only — two at a time, at most 100
 *    per mailbox per run and 20 seconds per mailbox. Gone (404) or a bad id (400) → {} (From
 *    is all there is), so one bad id can't stall a mailbox.
 * 2. Pending drafts addressed to a form's robot address (the one inbound email the draft
 *    answers — `answeredIdSql` — came from the draft's To and now has a stored Reply-To) are
 *    RE-POINTED, not expired:
 *    expiring would drop the lead from the Queue (nothing re-drafts a thread with a newer
 *    draft), the same quiet loss this fixes. Gmail first — the draft there is rewritten to
 *    the customer's address with the same text — then the row, with a first flag telling the
 *    owner to check the greeting. A draft the owner touched in Gmail (text or message id
 *    changed), one gone from Gmail, or one in its undo window / being sent is left alone.
 * 3. A reply sent in the last 30 days the same way gets one Activity line: "the customer may
 *    not have it" when the address looks like a form's robot (`looksLikeFormSender`), else a
 *    gentler "check they got it" (a person whose email named their other address).
 *
 * Skipped with no Gmail call and no marker (checked again next run): a mailbox that isn't
 * active, a read-only account, or a mailbox whose own sync is still busy (no cursor yet, first
 * backfill not done, or synced in the last 2 minutes — this must not stack on a running
 * backfill). A mailbox with no NULL rows left gets its marker; the run-wide key is written
 * only when every mailbox is done. Logs counts only, never an address.
 */
export const REPLY_TO_BACKFILL_KEY = "backfill:reply-to-v1";
export const replyToDoneKey = (mailboxId: string) => `${REPLY_TO_BACKFILL_KEY}:${mailboxId}`;
export const REPLY_TO_BACKFILL_BATCH = 100;
export const REPLY_TO_BACKFILL_CONCURRENCY = 2;
export const REPLY_TO_BACKFILL_BUDGET_MS = 20_000;
/** A mailbox synced this recently may still be syncing: wait for the next run. */
const SYNC_BUSY_MS = 2 * 60_000;

export type ReplyToBackfillDeps = {
  readerFor?: (m: Mailbox) => Pick<MailboxReader, "getMessage">;
  writerFor?: (m: Mailbox) => MailboxWriter;
  /** Milliseconds, for the time budget. */
  clock?: () => number;
};

export type MailboxBackfillResult = {
  status: "done" | "more" | "skipped" | "failed";
  read: number;
  redirected: number;
  repointed: number;
  pastSends: number;
};

const empty = (status: MailboxBackfillResult["status"]): MailboxBackfillResult => ({
  status,
  read: 0,
  redirected: 0,
  repointed: 0,
  pastSends: 0,
});

/** Mailboxes still to do, or null when the whole backfill is done (the job is then a no-op). */
export async function replyToBackfillMailboxes(): Promise<string[] | null> {
  const [done] = await db()
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(eq(appSettings.key, REPLY_TO_BACKFILL_KEY));
  if (done) return null;
  const doneBoxes = new Set(
    (
      await db()
        .select({ key: appSettings.key })
        .from(appSettings)
        .where(like(appSettings.key, `${REPLY_TO_BACKFILL_KEY}:%`))
    ).map((r) => r.key),
  );
  const boxes = await db().select({ id: mailboxes.id }).from(mailboxes);
  return boxes.map((b) => b.id).filter((id) => !doneBoxes.has(replyToDoneKey(id)));
}

const markDone = (mailboxId: string, now: Date) =>
  db()
    .insert(appSettings)
    .values({ key: replyToDoneKey(mailboxId), value: now.toISOString(), updatedAt: now })
    .onConflictDoNothing();

/** A Gmail answer that means "no such message": stored as {} so the row is settled. */
function goneOrBadId(err: unknown): boolean {
  return err instanceof Error && /^Gmail API (400|404)\b/.test(err.message);
}

/** One mailbox's share of one run. Never throws for Gmail trouble: it reports it. */
export async function runReplyToBackfillMailbox(
  mailboxId: string,
  now: Date = new Date(),
  deps: ReplyToBackfillDeps = {},
): Promise<MailboxBackfillResult> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const [row] = await db()
    .select({ mailbox: mailboxes, workspace: workspaces })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(eq(mailboxes.id, mailboxId));
  if (!row) return empty("done");
  const { mailbox, workspace } = row;
  const since = new Date(now.getTime() - BACKFILL_DAYS * 86_400_000);

  const todo = await db()
    .select({
      id: messages.id,
      gmailMessageId: messages.gmailMessageId,
      fromAddress: messages.fromAddress,
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .where(
      and(
        eq(messages.mailboxId, mailbox.id),
        eq(messages.direction, "in"),
        isNull(messages.replyToHeader),
        gte(messages.sentAt, since),
        eq(threads.inInbox, true),
      ),
    )
    .orderBy(desc(messages.sentAt))
    .limit(REPLY_TO_BACKFILL_BATCH);

  const result = empty("done");
  if (todo.length > 0) {
    // Nothing to read with, or the mailbox is busy: wait (no Gmail call, no marker).
    const busy =
      !mailbox.historyId ||
      !mailbox.backfillCompletedAt ||
      (mailbox.lastSyncedAt != null &&
        now.getTime() - mailbox.lastSyncedAt.getTime() < SYNC_BUSY_MS);
    if (!mailboxOn(mailbox) || !jobsAllowed(workspace, now) || busy) return empty("skipped");
  } else if (!mailboxOn(mailbox) || !jobsAllowed(workspace, now)) {
    // Nothing left to read; re-pointing still needs Gmail, so it waits too.
    return empty("skipped");
  }

  try {
    const self = await workspaceMailboxEmails(workspace.id);
    const reader = (deps.readerFor ?? defaultReaderFor)(mailbox);
    let next = 0;
    let outOfTime = false;
    const worker = async () => {
      while (next < todo.length) {
        if (clock() - started >= REPLY_TO_BACKFILL_BUDGET_MS) {
          outOfTime = true;
          return;
        }
        const r = todo[next++]!;
        let picked: ReplyToHeader;
        try {
          const m = await reader.getMessage(r.gmailMessageId, {
            withBody: false,
            headers: ["Reply-To"],
          });
          picked = m ? pickReplyTo(m.headers.replyTo, { from: r.fromAddress, self }) : {};
        } catch (err) {
          if (!goneOrBadId(err)) throw err;
          picked = {};
        }
        const stored = await storeReplyTo(r.id, picked);
        result.read++;
        if (stored.address) result.redirected++;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(REPLY_TO_BACKFILL_CONCURRENCY, todo.length) }, worker),
    );

    result.repointed = await repointDrafts(mailbox, now, deps);
    result.pastSends = await notePastSends(mailbox, workspace.id, now);

    if (outOfTime || result.read < todo.length || todo.length === REPLY_TO_BACKFILL_BATCH)
      result.status = "more";
    else await markDone(mailbox.id, now);
    return result;
  } catch (err) {
    if (err instanceof MailboxAuthError) {
      await markReconnectNeeded(mailbox);
      return { ...result, status: "skipped" };
    }
    console.error("reply_to_backfill_failed", {
      mailboxId: mailbox.id,
      error: err instanceof Error ? err.name : "unknown",
    });
    return { ...result, status: "failed" };
  }
}

/**
 * The one inbound email a draft answers: the row it is threaded to when that is an inbound
 * email (a reply), else the newest real inbound email on the thread from before the draft was
 * made (a nudge or a purpose note is threaded to the owner's own email) — never an unsent
 * Gmail draft or a side conversation (the crew's reply).
 */
const answeredIdSql = sql`coalesce(
  (select ar_m.id from messages ar_m where ar_m.id = ${drafts.replyToMessageId} and ar_m.direction = 'in'),
  (select ar_n.id from messages ar_n where ar_n.thread_id = ${drafts.threadId} and ar_n.direction = 'in' and not ${unsentDraftSql("ar_n")} and not ${sideEmailSql("ar_n")} and ar_n.sent_at <= ${drafts.createdAt} order by ar_n.sent_at desc limit 1)
)`;

/**
 * That one email's stored Reply-To, only when the draft went to its From: the draft answers
 * it at the address it came from, though the email named another one to reply to. An older
 * email on the thread with a Reply-To never counts (an office whose newest email, from Bob,
 * has none is answered at the office, as new drafts are).
 */
const formReplyToSql = sql<
  string | null
>`(select fr_m.reply_to_header->>'address' from messages fr_m where fr_m.id = ${answeredIdSql} and lower(trim(fr_m.from_address)) = lower(trim(${drafts.toAddress})) and fr_m.reply_to_header->>'address' is not null)`;
/** The same email's From, to tell a form robot from a person with a second address. */
const answeredFromSql = sql<
  string | null
>`(select fa_m.from_address from messages fa_m where fa_m.id = ${answeredIdSql})`;

/** Step 2: pending drafts addressed to a form's robot address → the customer's own address. */
async function repointDrafts(mailbox: Mailbox, now: Date, deps: ReplyToBackfillDeps) {
  const rows = await db()
    .select({ draft: drafts, thread: threads, newTo: formReplyToSql })
    .from(drafts)
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .where(
      and(
        eq(drafts.mailboxId, mailbox.id),
        eq(drafts.status, "pending"),
        isNull(drafts.sendAfter),
        isNull(drafts.sendClaimedAt),
        sql`${formReplyToSql} is not null`,
      ),
    );
  if (rows.length === 0) return 0;
  const writer = (deps.writerFor ?? defaultWriter)(mailbox);
  let repointed = 0;
  for (const { draft, thread, newTo } of rows) {
    if (!newTo || !draft.gmailDraftId) continue;
    const remote = await writer.getDraft(draft.gmailDraftId);
    // Gone: reconcile discards it. Changed (text, or a new message id — Gmail gives an edited
    // draft a new one, e.g. the owner fixed the To themselves): reconcile takes it first.
    if (!remote || !sameText(remote.bodyText, draft.body)) continue;
    if (draft.gmailMessageId && remote.messageId !== draft.gmailMessageId) continue;
    // The row first, so a Send reply tapped against the old To can't go out to the new one:
    // queueSend's own write needs the To it loaded (and the card posts the To it showed), so
    // a tap racing this is refused with "who it goes to changed" and the owner looks again.
    const [done] = await db()
      .update(drafts)
      .set({
        toAddress: newTo,
        autoSendAt: null,
        flags: [REPOINTED_FLAG, ...(draft.flags ?? []).filter((f) => f !== REPOINTED_FLAG)].slice(
          0,
          6,
        ),
      })
      .where(
        and(
          eq(drafts.id, draft.id),
          eq(drafts.status, "pending"),
          isNull(drafts.sendAfter),
          isNull(drafts.sendClaimedAt),
          eq(drafts.toAddress, draft.toAddress),
        ),
      )
      .returning({ id: drafts.id });
    if (!done) continue;
    let updated: { messageId: string };
    try {
      updated = await writer.updateDraft(draft.gmailDraftId, {
        threadId: thread.gmailThreadId,
        raw: mimeFor(
          { ...draft, toAddress: newTo },
          mailbox,
          remote.bodyText,
          await replyToHeaders(draft),
        ),
      });
    } catch (err) {
      // Gmail still has the old To: put the row back so the card shows what Gmail would send
      // (and un-queue a tap made against the new To meanwhile; the countdown stays off).
      await db()
        .update(drafts)
        .set({ toAddress: draft.toAddress, flags: draft.flags, sendAfter: null })
        .where(
          and(
            eq(drafts.id, draft.id),
            eq(drafts.toAddress, newTo),
            eq(drafts.status, "pending"),
            isNull(drafts.sendClaimedAt),
          ),
        );
      throw err;
    }
    await db()
      .update(drafts)
      .set({ gmailMessageId: updated.messageId })
      .where(eq(drafts.id, draft.id));
    if (!done) continue;
    repointed++;
    await db()
      .insert(activityLog)
      .values({
        workspaceId: mailbox.workspaceId,
        actor: "squared_away",
        action: "draft_repointed",
        threadId: draft.threadId,
        detail: { draftId: draft.id },
      });
  }
  return repointed;
}

/** Step 3: replies sent in the last 30 days to a form's robot address → one Activity line each. */
async function notePastSends(mailbox: Mailbox, workspaceId: string, now: Date) {
  const since = new Date(now.getTime() - BACKFILL_DAYS * 86_400_000);
  const rows = await db()
    .select({
      id: drafts.id,
      threadId: drafts.threadId,
      decidedAt: drafts.decidedAt,
      createdAt: drafts.createdAt,
      from: answeredFromSql,
    })
    .from(drafts)
    .where(
      and(
        eq(drafts.mailboxId, mailbox.id),
        inArray(drafts.status, ["sent", "edited_and_sent"]),
        gte(drafts.decidedAt, since),
        sql`${formReplyToSql} is not null`,
        sql`not exists (select 1 from activity_log a where a.workspace_id = ${workspaceId} and a.action = 'reply_went_to_form' and a.detail->>'draftId' = ${drafts.id}::text)`,
      ),
    );
  if (rows.length === 0) return 0;
  const zone = await workspaceTimeZone(workspaceId);
  await db()
    .insert(activityLog)
    .values(
      rows.map((r) => ({
        workspaceId,
        actor: "squared_away" as const,
        action: "reply_went_to_form",
        threadId: r.threadId,
        // Content-free: the draft, the local date it went, and whether the address it went
        // to looks like a form's robot (else a person's other address: worded more gently).
        detail: {
          draftId: r.id,
          sentOn: localParts(r.decidedAt ?? r.createdAt, zone).date,
          robot: looksLikeFormSender(r.from),
        },
      })),
    );
  return rows.length;
}

/** Write the run-wide key once every mailbox is done. Counts only in the log. */
export async function finishReplyToBackfill(
  results: MailboxBackfillResult[],
  now: Date = new Date(),
): Promise<boolean> {
  const totals = {
    read: 0,
    redirected: 0,
    repointed: 0,
    pastSends: 0,
    skipped: 0,
    failed: 0,
    more: 0,
  };
  for (const r of results) {
    totals.read += r.read;
    totals.redirected += r.redirected;
    totals.repointed += r.repointed;
    totals.pastSends += r.pastSends;
    if (r.status === "skipped") totals.skipped++;
    if (r.status === "failed") totals.failed++;
    if (r.status === "more") totals.more++;
  }
  console.info("reply_to_backfill", totals);
  const allDone = totals.skipped === 0 && totals.failed === 0 && totals.more === 0;
  if (allDone)
    await db()
      .insert(appSettings)
      .values({ key: REPLY_TO_BACKFILL_KEY, value: now.toISOString(), updatedAt: now })
      .onConflictDoNothing();
  return allDone;
}

/** The whole run in one call (tests; the job does the same one mailbox per step). */
export async function runReplyToBackfill(now: Date = new Date(), deps: ReplyToBackfillDeps = {}) {
  const ids = await replyToBackfillMailboxes();
  if (!ids) return { ran: false as const };
  const results: MailboxBackfillResult[] = [];
  for (const id of ids) results.push(await runReplyToBackfillMailbox(id, now, deps));
  const done = await finishReplyToBackfill(results, now);
  return { ran: true as const, done, results };
}
