import "server-only";
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { bodyRetentionDays } from "@/config/retention";
import { db } from "@/db";
import {
  activityLog,
  drafts,
  mailboxes,
  messages,
  threads,
  workspaces,
  type Mailbox,
} from "@/db/schema";
import {
  HistoryExpiredError,
  type HistoryPage,
  MailboxAuthError,
  MailboxRateLimitError,
  type MailboxReader,
  type MailMessage,
  type MessageRef,
} from "@/mailbox/connector";
import { gmailClientFor, logGmailUnits } from "./gmail-units";
import { parseAddressList } from "@/mailbox/gmail/parse";
import { jobsAllowed } from "./lifecycle";
import { mailboxRunning } from "./mailbox-plan";
import { mailboxOn } from "./mailbox-plan-rules";
import { pickReplyTo, type ReplyToHeader } from "./reply-address-rules";
import { isAutoReply } from "./auto-reply-rules";
import { lastInSql, lastOutSql, unsentDraftMessage } from "./thread-sql";

const MAIL_INBOX = "INBOX";

/** How far back the first sync reaches. */
export const BACKFILL_DAYS = 30;
/** When the history cursor has expired, re-read this many days instead. */
export const RESYNC_DAYS = 7;
/**
 * Google's quota page (developers.google.com/workspace/gmail/api/reference/quota, last updated
 * 2026-09-10) allows 6,000 units a minute per user, and a message read costs 20: about 5 reads a
 * second. The shared unit budget (src/server/gmail-units.ts) enforces that across every job;
 * this only bounds how many requests one job has in flight.
 */
const FETCH_CONCURRENCY = 4;
/** Messages per backfill step. Smaller pages mean a retry redoes less work. */
const BACKFILL_PAGE_SIZE = 50;

export type SyncDeps = {
  readerFor?: (mailbox: Mailbox) => MailboxReader;
  now?: () => Date;
};

export type SyncOutcome =
  | { status: "ok"; ingested: number; nextPageToken?: string }
  /** Check 25 P3: history expired; re-read from `since` (ISO) with `resyncPage`. */
  | { status: "resync_needed"; since: string }
  | { status: "skipped"; reason: "not_found" | "not_active" | "not_ready" | "read_only" }
  | { status: "reconnect_needed" };

export const defaultReaderFor = (m: Mailbox) => gmailClientFor(m);

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

async function loadActiveMailbox(mailboxId: string) {
  const [row] = await db()
    .select({ mailbox: mailboxes, workspace: workspaces })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(eq(mailboxes.id, mailboxId));
  if (!row)
    return { mailbox: undefined, skip: { status: "skipped", reason: "not_found" } as const };
  // Lost Google access, or paused because the plan covers fewer addresses (2026-10-16).
  if (!mailboxOn(row.mailbox)) {
    return { mailbox: undefined, skip: { status: "skipped", reason: "not_active" } as const };
  }
  // Read-only workspaces (expired, paused, past due, canceled) aren't synced.
  if (!jobsAllowed(row.workspace)) {
    return { mailbox: undefined, skip: { status: "skipped", reason: "read_only" } as const };
  }
  return { mailbox: row.mailbox, skip: undefined };
}

/**
 * Access is gone: flag the mailbox so every job skips it and the owner sees
 * "Reconnect Gmail". Logged once, content-free.
 */
export async function markReconnectNeeded(mailbox: Pick<Mailbox, "id" | "workspaceId">) {
  const changed = await db()
    .update(mailboxes)
    .set({ status: "reconnect_needed", accessLostAt: new Date(), accessAlertsSent: 0 })
    .where(and(eq(mailboxes.id, mailbox.id), eq(mailboxes.status, "active")))
    .returning({ id: mailboxes.id });
  if (changed.length > 0) {
    await db()
      .insert(activityLog)
      .values({
        workspaceId: mailbox.workspaceId,
        actor: "squared_away",
        action: "mailbox_access_lost",
        detail: { mailboxId: mailbox.id },
      });
  }
}

export type SyncErrorCode = "access_lost" | "rate_limited" | "sync_failed";

/** Remember the last problem as a code for Settings → Your Gmail (cleared on the next success). */
async function noteSyncError(mailboxId: string, code: SyncErrorCode | null) {
  await db()
    .update(mailboxes)
    .set({ lastSyncErrorCode: code, lastSyncErrorAt: code ? new Date() : null })
    .where(
      code
        ? eq(mailboxes.id, mailboxId)
        : and(eq(mailboxes.id, mailboxId), isNotNull(mailboxes.lastSyncErrorCode)),
    );
}

async function guarded(mailbox: Mailbox, fn: () => Promise<SyncOutcome>): Promise<SyncOutcome> {
  try {
    const outcome = await fn();
    if (outcome.status === "ok" || outcome.status === "resync_needed")
      await noteSyncError(mailbox.id, null);
    return outcome;
  } catch (err) {
    if (err instanceof MailboxAuthError) {
      await markReconnectNeeded(mailbox);
      await noteSyncError(mailbox.id, "access_lost");
      return { status: "reconnect_needed" };
    }
    await noteSyncError(
      mailbox.id,
      err instanceof MailboxRateLimitError ? "rate_limited" : "sync_failed",
    ).catch(() => {});
    throw err;
  }
}

/**
 * A Gmail draft not yet sent: a message carrying the DRAFT label and not SENT. A draft is
 * never stored: from the owner, it would read as the owner having replied (every "the owner
 * wrote" check, and autopilot's "has written to this address before") when nothing was sent.
 *
 * We don't rely on what Gmail does to the id when a draft is sent. If the sent email is a new
 * message, history reports it as added. If Gmail keeps the draft's id and swaps DRAFT for SENT,
 * history reports a SENT label added (listHistory asks for both), and an app send records its
 * own sent message (`recordSentMessage`). Either way the sent email is stored; a row stored as
 * a draft by older code is fetched again and updated in place (`ingest`).
 */
export function isUnsentDraft(labelIds: readonly string[]): boolean {
  return labelIds.includes("DRAFT") && !labelIds.includes("SENT");
}

function windowQuery(days: number) {
  return `newer_than:${days}d`;
}

/** A fixed window start (Gmail's `after:` takes epoch seconds), so a re-read never drifts. */
function afterQuery(since: Date) {
  return `after:${Math.floor(since.getTime() / 1000)}`;
}

/**
 * A window is listed in two passes, inbox first (`in:inbox`, so each ref is known to be an
 * inbox email and is read in full in one call), then everything else (read as metadata). The
 * page token carries the pass: "inbox:<gmail token>" / "rest:<gmail token>".
 */
async function windowPage(
  reader: Pick<MailboxReader, "listMessages">,
  window: string,
  token: string | undefined,
  maxResults: number,
): Promise<{ messages: MessageRef[]; nextPageToken?: string }> {
  const pass = token?.startsWith("rest:") ? "rest" : "inbox";
  const gmailToken = token ? token.slice(token.indexOf(":") + 1) || undefined : undefined;
  const page = await reader.listMessages({
    query: pass === "inbox" ? `in:inbox ${window}` : `-in:inbox ${window}`,
    pageToken: gmailToken,
    maxResults,
  });
  const messages =
    pass === "inbox" ? page.messages.map((m) => ({ ...m, labelIds: [MAIL_INBOX] })) : page.messages;
  const nextPageToken = page.nextPageToken
    ? `${pass}:${page.nextPageToken}`
    : pass === "inbox"
      ? "rest:"
      : undefined;
  return { messages, nextPageToken };
}

/**
 * Store a batch of messages. Idempotent: already-stored messages are skipped,
 * threads are merged. Bodies are fetched only for threads in the inbox, and
 * never for mail already past the retention window.
 */
async function ingest(
  mailbox: Mailbox,
  reader: Pick<MailboxReader, "getMessage">,
  refs: MessageRef[],
  now: Date,
): Promise<number> {
  const unique = [...new Map(refs.map((r) => [r.id, r])).values()];
  if (unique.length === 0) return 0;

  const existing = await db()
    .select({ id: messages.gmailMessageId, labelIds: messages.labelIds })
    .from(messages)
    .where(
      and(
        eq(messages.mailboxId, mailbox.id),
        inArray(
          messages.gmailMessageId,
          unique.map((r) => r.id),
        ),
      ),
    );
  // A row older code stored as an unsent draft is fetched again: Gmail may have sent it under
  // the same id, and then it's updated in place below.
  const have = new Set(existing.filter((e) => !isUnsentDraft(e.labelIds)).map((e) => e.id));
  const todo = unique.filter((r) => !have.has(r.id));
  if (todo.length === 0) return 0;

  const refThreadIds = [...new Set(todo.map((r) => r.threadId))];
  const knownThreads = await db()
    .select()
    .from(threads)
    .where(and(eq(threads.mailboxId, mailbox.id), inArray(threads.gmailThreadId, refThreadIds)));
  const known = new Map(knownThreads.map((t) => [t.gmailThreadId, t]));
  const inboxThreads = new Set(knownThreads.filter((t) => t.inInbox).map((t) => t.gmailThreadId));

  // Check 25 P1: an email known to be in the inbox (listed with in:inbox, or history said so,
  // or its conversation is already in the inbox) is read in full in one call. Everything else
  // is read as metadata, and read again in full only if it turns out to belong in the inbox.
  const knownInbox = (r: MessageRef) =>
    (r.labelIds ?? []).includes(MAIL_INBOX) || inboxThreads.has(r.threadId);
  const retentionCutoff = now.getTime() - bodyRetentionDays() * 86_400_000;
  const firstRead = (
    await mapLimit(todo, FETCH_CONCURRENCY, async (r) => {
      const withBody = knownInbox(r);
      const m = await reader.getMessage(r.id, { withBody });
      return m ? { m, full: withBody } : null;
    })
  )
    .filter((x): x is { m: MailMessage; full: boolean } => x !== null)
    // Drafts are skipped before anything is written: no row, no thread, no lastMessageAt move.
    .filter((x) => !isUnsentDraft(x.m.labelIds));
  if (firstRead.length === 0) return 0;

  for (const { m } of firstRead)
    if (m.labelIds.includes(MAIL_INBOX)) inboxThreads.add(m.providerThreadId);

  const full = await mapLimit(firstRead, FETCH_CONCURRENCY, async ({ m, full: read }) => {
    if (read) {
      // Read in full already. A body past retention, or (if the listing was wrong) outside the
      // inbox, is still never kept.
      return m.internalDate >= retentionCutoff && inboxThreads.has(m.providerThreadId)
        ? m
        : { ...m, bodyText: undefined };
    }
    return inboxThreads.has(m.providerThreadId) && m.internalDate >= retentionCutoff
      ? ((await reader.getMessage(m.providerMessageId, { withBody: true })) ?? m)
      : m;
  });

  const self = mailbox.email.toLowerCase();
  // Every mailbox of the workspace: a form set to reply to the shop's other Gmail is no
  // customer address.
  const workspaceEmails = (
    await db()
      .select({ email: mailboxes.email })
      .from(mailboxes)
      .where(eq(mailboxes.workspaceId, mailbox.workspaceId))
  ).map((r) => r.email.toLowerCase());
  if (!workspaceEmails.includes(self)) workspaceEmails.push(self);
  const replyToOf = (m: MailMessage): ReplyToHeader | null => {
    const from = parseAddressList(m.headers.from)[0];
    if (m.labelIds.includes("SENT") || from?.email === self) return {};
    // Never "no Reply-To" unless the read could have returned one.
    if (!m.headers.replyToRead) return null;
    return pickReplyTo(m.headers.replyTo, { from: from?.email ?? null, self: workspaceEmails });
  };
  const byThread = new Map<string, MailMessage[]>();
  for (const m of full)
    byThread.set(m.providerThreadId, [...(byThread.get(m.providerThreadId) ?? []), m]);

  let ingested = 0;
  for (const [gmailThreadId, msgs] of byThread) {
    const prior = known.get(gmailThreadId);
    const participants = new Set(prior?.participants ?? []);
    for (const m of msgs) {
      for (const a of [
        ...parseAddressList(m.headers.from),
        ...parseAddressList(m.headers.to),
        ...parseAddressList(m.headers.cc),
      ]) {
        if (a.email !== self) participants.add(a.email);
      }
      const replyTo = replyToOf(m)?.address;
      if (replyTo) participants.add(replyTo);
    }
    // From these messages only. On an existing thread the stored messages' newest time is
    // read inside the upsert (not from `prior`, read earlier): a time a draft row gave the
    // thread, removed meanwhile by draft-message-cleanup, never comes back.
    const newest = Math.max(...msgs.map((m) => m.internalDate));
    const oldest = msgs.reduce((a, b) => (a.internalDate <= b.internalDate ? a : b));

    const [thread] = await db()
      .insert(threads)
      .values({
        mailboxId: mailbox.id,
        gmailThreadId,
        subject: prior?.subject ?? oldest.headers.subject ?? null,
        participants: [...participants],
        lastMessageAt: new Date(newest),
        inInbox: inboxThreads.has(gmailThreadId),
      })
      .onConflictDoUpdate({
        target: [threads.mailboxId, threads.gmailThreadId],
        set: {
          // Merged in the database, not overwritten with what was read above: an app send
          // (recordSentMessage) can run alongside a sync of the same thread, and neither may
          // lose the other's addresses.
          participants: sql`(select coalesce(jsonb_agg(distinct p), '[]'::jsonb) from jsonb_array_elements_text(${threads.participants} || excluded.participants) as p)`,
          lastMessageAt: sql`greatest(excluded.last_message_at, (select max(m.sent_at) from messages m where m.thread_id = ${threads.id}))`,
          inInbox: sql`${threads.inInbox} or excluded.in_inbox`,
          subject: sql`coalesce(${threads.subject}, excluded.subject)`,
        },
      })
      .returning({ id: threads.id });

    const rows = msgs.map((m) => {
      const from = parseAddressList(m.headers.from)[0];
      const outbound = m.labelIds.includes("SENT") || from?.email === self;
      return {
        threadId: thread!.id,
        mailboxId: mailbox.id,
        gmailMessageId: m.providerMessageId,
        rfc822MessageId: m.headers.messageId ?? null,
        references: m.headers.references ?? null,
        fromAddress: from?.email ?? null,
        fromName: from?.name ?? null,
        replyToHeader: replyToOf(m),
        toAddresses: parseAddressList(m.headers.to).map((a) => a.email),
        ccAddresses: parseAddressList(m.headers.cc).map((a) => a.email),
        subject: m.headers.subject ?? null,
        direction: outbound ? ("out" as const) : ("in" as const),
        // Check 20 P4 / 21 P1: only the true/false, never the header values.
        autoReply: !outbound && isAutoReply(m.headers, from?.email),
        labelIds: m.labelIds,
        snippet: m.internalDate >= retentionCutoff ? m.snippet : null,
        bodyText: m.bodyText ?? null,
        // Check 40 P2: counts by kind only.
        attachmentImages: m.attachments?.images ?? 0,
        attachmentPdfs: m.attachments?.pdfs ?? 0,
        attachmentOther: m.attachments?.other ?? 0,
        sentAt: new Date(m.internalDate),
      };
    });
    // New messages are inserted. A stored row that is still an unsent draft (older code
    // stored drafts) and is now sent mail takes the sent message's labels, direction and time;
    // anything else already stored is left as it is.
    const inserted = await db()
      .insert(messages)
      .values(rows)
      .onConflictDoUpdate({
        target: [messages.mailboxId, messages.gmailMessageId],
        set: {
          labelIds: sql`excluded.label_ids`,
          direction: sql`excluded.direction`,
          sentAt: sql`excluded.sent_at`,
          bodyText: sql`coalesce(excluded.body_text, ${messages.bodyText})`,
          snippet: sql`coalesce(excluded.snippet, ${messages.snippet})`,
          replyToHeader: sql`coalesce(excluded.reply_to_header, ${messages.replyToHeader})`,
        },
        setWhere: unsentDraftMessage(),
      })
      .returning({ id: messages.id });
    ingested += inserted.length;
    if (inserted.length) await markBounce(thread!.id);
  }
  return ingested;
}

/**
 * Check 21 P1: a bounce (mailer-daemon / postmaster) that came after the owner's newest email,
 * with no real customer email since, means the customer never got it: `extracted.bounced`
 * (the card says so, and no nudge is drafted). Cleared once the owner writes again or the
 * customer answers.
 */
async function markBounce(threadId: string) {
  const bounced = sql`(exists (select 1 from messages b where b.thread_id = ${threads.id} and b.direction = 'in' and b.auto_reply and lower(coalesce(b.from_address, '')) ~ '^(mailer-daemon|postmaster)@' and b.sent_at >= ${lastOutSql()}) and ${lastOutSql()} > coalesce(${lastInSql()}, '-infinity'::timestamptz))`;
  await db()
    .update(threads)
    .set({
      extracted: sql`case when ${bounced} then coalesce(${threads.extracted}, '{}'::jsonb) || '{"bounced": true}'::jsonb else ${threads.extracted} - 'bounced' end`,
    })
    .where(
      and(
        eq(threads.id, threadId),
        sql`(${bounced} or coalesce(${threads.extracted} ? 'bounced', false))`,
      ),
    );
}

/**
 * Store the email an app send just made (Gmail's id from drafts.send), without waiting for
 * sync to come across it — so the owner's answer never depends on how Gmail's history reports
 * a sent draft. Same path as sync: idempotent, bodies only for inbox threads in retention.
 */
export async function recordSentMessage(
  mailbox: Mailbox,
  reader: Pick<MailboxReader, "getMessage">,
  sent: MessageRef,
  now: Date,
): Promise<number> {
  return ingest(mailbox, reader, [sent], now);
}

export const TRASHED_NOTE = "You deleted this in Gmail.";
export const SPAM_NOTE = "You marked this as spam in Gmail.";
/** Shown on a waiting draft whose conversation the owner archived in Gmail (Check 25 P2). */
export const ARCHIVED_LINE = "You archived this in Gmail.";
const GONE_LABELS = ["TRASH", "SPAM"];

/**
 * Check 25 P2: follow what the owner did in Gmail — archive, Trash, Spam, Not spam, delete.
 * Called after each history page is ingested. Never writes to the owner's Gmail.
 *
 * - Stored messages take the label changes (history order; the last change to a label wins,
 *   so replaying a page is harmless). A message deleted for good is treated like Trash: its
 *   row stays (drafts may point at it) with INBOX removed and TRASH added.
 * - A message that gains INBOX and has no body yet (it arrived in Spam, say) is read in full if
 *   still within retention, and sorted again. One we never stored is stored now.
 * - `threads.in_inbox` is recomputed for every touched conversation: some stored message has
 *   INBOX and isn't in Trash or Spam.
 * - Every message trashed / spam / deleted → waiting drafts expire with a plain note, and any
 *   send or autopilot countdown on them is dropped. Archived only → the draft stays in the Queue
 *   (with ARCHIVED_LINE), its autopilot countdown and any send still in its undo window stop.
 */
export async function applyLabelChanges(
  mailbox: Mailbox,
  reader: Pick<MailboxReader, "getMessage">,
  page: Pick<HistoryPage, "labelChanges" | "deleted">,
  now: Date,
): Promise<{ ingested: number; changed: number }> {
  const changes = page.labelChanges ?? [];
  const deleted = page.deleted ?? [];
  if (changes.length === 0 && deleted.length === 0) return { ingested: 0, changed: 0 };

  const ids = [...new Set([...changes.map((c) => c.id), ...deleted.map((d) => d.id)])];
  const stored = await db()
    .select({
      id: messages.id,
      gmailMessageId: messages.gmailMessageId,
      threadId: messages.threadId,
      labelIds: messages.labelIds,
      bodyText: messages.bodyText,
      sentAt: messages.sentAt,
    })
    .from(messages)
    .where(and(eq(messages.mailboxId, mailbox.id), inArray(messages.gmailMessageId, ids)));

  const labels = new Map(stored.map((r) => [r.gmailMessageId, new Set(r.labelIds)]));
  /** Messages we never stored whose last INBOX change was an add (Not spam on new mail). */
  const toStore = new Map<string, MessageRef>();
  for (const c of changes) {
    const set = labels.get(c.id);
    if (set) {
      for (const l of c.added) set.add(l);
      for (const l of c.removed) set.delete(l);
    } else if (c.added.includes(MAIL_INBOX)) {
      toStore.set(c.id, { id: c.id, threadId: c.threadId, labelIds: [MAIL_INBOX] });
    } else if (c.removed.includes(MAIL_INBOX)) {
      toStore.delete(c.id);
    }
  }
  for (const d of deleted) {
    toStore.delete(d.id);
    const set = labels.get(d.id);
    if (set) {
      set.delete(MAIL_INBOX);
      set.add("TRASH");
    }
  }

  let changed = 0;
  const retentionCutoff = now.getTime() - bodyRetentionDays() * 86_400_000;
  const touchedThreads = new Set<string>();
  const resort = new Set<string>();
  for (const row of stored) {
    const before = row.labelIds;
    const after = [...labels.get(row.gmailMessageId)!];
    touchedThreads.add(row.threadId);
    const same = before.length === after.length && before.every((l) => after.includes(l));
    if (same) continue;
    changed++;
    const gainedInbox =
      !before.includes(MAIL_INBOX) &&
      after.includes(MAIL_INBOX) &&
      !after.some((l) => GONE_LABELS.includes(l));
    if (gainedInbox && row.bodyText === null && row.sentAt.getTime() >= retentionCutoff) {
      const full = await reader.getMessage(row.gmailMessageId, { withBody: true });
      if (full) {
        await db()
          .update(messages)
          .set({
            labelIds: full.labelIds,
            bodyText: full.bodyText ?? null,
            snippet: full.snippet,
            attachmentImages: full.attachments?.images ?? 0,
            attachmentPdfs: full.attachments?.pdfs ?? 0,
            attachmentOther: full.attachments?.other ?? 0,
            classifiedAt: null,
          })
          .where(eq(messages.id, row.id));
        resort.add(row.threadId);
        continue;
      }
    }
    await db().update(messages).set({ labelIds: after }).where(eq(messages.id, row.id));
  }

  const ingested = toStore.size ? await ingest(mailbox, reader, [...toStore.values()], now) : 0;
  if (toStore.size) {
    const newThreads = await db()
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          eq(threads.mailboxId, mailbox.id),
          inArray(threads.gmailThreadId, [
            ...new Set([...toStore.values()].map((r) => r.threadId)),
          ]),
        ),
      );
    for (const t of newThreads) touchedThreads.add(t.id);
  }
  if (touchedThreads.size === 0) return { ingested, changed };
  const touched = [...touchedThreads];

  if (resort.size) {
    await db()
      .update(threads)
      .set({ classifiedAt: null })
      .where(inArray(threads.id, [...resort]));
  }

  const liveInbox = sql`exists (select 1 from messages li where li.thread_id = ${threads.id} and li.label_ids ? 'INBOX' and not li.label_ids ? 'TRASH' and not li.label_ids ? 'SPAM')`;
  const before = await db()
    .select({ id: threads.id, inInbox: threads.inInbox })
    .from(threads)
    .where(inArray(threads.id, touched));
  const after = await db()
    .update(threads)
    .set({ inInbox: liveInbox })
    .where(inArray(threads.id, touched))
    .returning({ id: threads.id, inInbox: threads.inInbox });
  const wasInInbox = new Map(before.map((t) => [t.id, t.inInbox]));
  const outOfInbox = after.filter((t) => !t.inInbox).map((t) => t.id);
  if (outOfInbox.length === 0) return { ingested, changed };

  // Which conversations are gone altogether (every message in Trash or Spam), and why.
  const fate = await db()
    .select({
      threadId: messages.threadId,
      total: sql<number>`count(*)::int`,
      gone: sql<number>`count(*) filter (where ${messages.labelIds} ? 'TRASH' or ${messages.labelIds} ? 'SPAM')::int`,
      spam: sql<number>`count(*) filter (where ${messages.labelIds} ? 'SPAM')::int`,
    })
    .from(messages)
    .where(inArray(messages.threadId, outOfInbox))
    .groupBy(messages.threadId);
  for (const f of fate) {
    if (f.total > 0 && f.gone === f.total) {
      await db()
        .update(drafts)
        .set({
          status: "expired",
          closedNote: f.spam === f.total ? SPAM_NOTE : TRASHED_NOTE,
          decidedAt: now,
          autoSendAt: null,
          sendAfter: null,
          sendClaimedAt: null,
        })
        .where(and(eq(drafts.threadId, f.threadId), eq(drafts.status, "pending")));
    } else if (wasInInbox.get(f.threadId)) {
      // Archived just now: the draft waits for a tap, nothing goes on its own. A send already
      // being delivered (claimed) is left to finish.
      await db()
        .update(drafts)
        .set({ autoSendAt: null })
        .where(and(eq(drafts.threadId, f.threadId), eq(drafts.status, "pending")));
      const unqueued = await db()
        .update(drafts)
        .set({ sendAfter: null })
        .where(
          and(
            eq(drafts.threadId, f.threadId),
            eq(drafts.status, "pending"),
            isNotNull(drafts.sendAfter),
            isNull(drafts.sendClaimedAt),
          ),
        )
        .returning({ id: drafts.id });
      for (const d of unqueued)
        await db()
          .insert(activityLog)
          .values({
            workspaceId: mailbox.workspaceId,
            actor: "squared_away",
            action: "send_stopped",
            threadId: f.threadId,
            detail: { draftId: d.id, why: "archived_in_gmail" },
          });
    } else {
      await db()
        .update(drafts)
        .set({ autoSendAt: null })
        .where(and(eq(drafts.threadId, f.threadId), eq(drafts.status, "pending")));
    }
  }
  return { ingested, changed };
}

/**
 * Step 1 of the first sync: remember where "now" is in the mailbox's history
 * before reading the past, so nothing that arrives during backfill is missed.
 */
export async function beginBackfill(mailboxId: string, deps: SyncDeps = {}): Promise<SyncOutcome> {
  const { mailbox, skip } = await loadActiveMailbox(mailboxId);
  if (skip) return skip;
  const reader = (deps.readerFor ?? defaultReaderFor)(mailbox);
  return guarded(mailbox, async () => {
    const profile = await reader.getProfile();
    await db()
      .update(mailboxes)
      .set({ historyId: profile.historyId, backfillCompletedAt: null })
      .where(eq(mailboxes.id, mailbox.id));
    return { status: "ok", ingested: 0 };
  });
}

/** Step 2, repeated: one page (up to BACKFILL_PAGE_SIZE = 50 messages) of the 30-day window. */
export async function backfillPage(
  mailboxId: string,
  pageToken: string | undefined,
  deps: SyncDeps = {},
): Promise<SyncOutcome> {
  const { mailbox, skip } = await loadActiveMailbox(mailboxId);
  if (skip) return skip;
  const reader = (deps.readerFor ?? defaultReaderFor)(mailbox);
  const now = deps.now?.() ?? new Date();
  return guarded(mailbox, async () => {
    const page = await windowPage(
      reader,
      windowQuery(BACKFILL_DAYS),
      pageToken,
      BACKFILL_PAGE_SIZE,
    );
    const ingested = await ingest(mailbox, reader, page.messages, now);
    logGmailUnits("backfill", mailbox.id, reader);
    return { status: "ok", ingested, nextPageToken: page.nextPageToken };
  });
}

/** Step 3: mark the backfill done so incremental sync can take over. */
export async function finishBackfill(mailboxId: string, deps: SyncDeps = {}) {
  const now = deps.now?.() ?? new Date();
  await db()
    .update(mailboxes)
    .set({ backfillCompletedAt: now, lastSyncedAt: now })
    .where(eq(mailboxes.id, mailboxId));
}

/** Whole backfill in one go. Used by tests and small mailboxes; jobs run it step by step. */
export async function runBackfill(mailboxId: string, deps: SyncDeps = {}): Promise<SyncOutcome> {
  const start = await beginBackfill(mailboxId, deps);
  if (start.status !== "ok") return start;
  let pageToken: string | undefined;
  let total = 0;
  do {
    const page = await backfillPage(mailboxId, pageToken, deps);
    if (page.status !== "ok") return page;
    total += page.ingested;
    pageToken = page.nextPageToken;
  } while (pageToken);
  await finishBackfill(mailboxId, deps);
  return { status: "ok", ingested: total };
}

/**
 * Pick up everything new since the stored cursor via the History API. If the
 * cursor is too old, re-read the last week and start a fresh cursor.
 */
export async function incrementalSync(
  mailboxId: string,
  deps: SyncDeps = {},
): Promise<SyncOutcome> {
  const { mailbox, skip } = await loadActiveMailbox(mailboxId);
  if (skip) return skip;
  if (!mailbox.backfillCompletedAt || !mailbox.historyId)
    return { status: "skipped", reason: "not_ready" };
  // A re-read after expired history is still under way: finish it first (Check 25 P3).
  if (mailbox.resyncSince)
    return { status: "resync_needed", since: mailbox.resyncSince.toISOString() };
  const reader = (deps.readerFor ?? defaultReaderFor)(mailbox);
  const now = deps.now?.() ?? new Date();

  return guarded(mailbox, async () => {
    let ingested = 0;
    let cursor = mailbox.historyId!;
    try {
      let pageToken: string | undefined;
      do {
        const page = await reader.listHistory({ startHistoryId: mailbox.historyId!, pageToken });
        ingested += await ingest(mailbox, reader, page.added, now);
        ingested += (await applyLabelChanges(mailbox, reader, page, now)).ingested;
        cursor = page.historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (err) {
      if (!(err instanceof HistoryExpiredError)) throw err;
      return startResync(mailbox, reader, now);
    }
    await db()
      .update(mailboxes)
      .set({ historyId: cursor, lastSyncedAt: now })
      .where(eq(mailboxes.id, mailbox.id));
    logGmailUnits("sync", mailbox.id, reader);
    return { status: "ok", ingested };
  });
}

const DAY_MS = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Check 25 P3: Gmail's history no longer reaches back to our cursor (a long pause, a read-only
 * stretch between a trial and a payment). Take a fresh cursor first (so nothing arriving from
 * now on is missed), then re-read the whole gap — at least RESYNC_DAYS, at most BACKFILL_DAYS
 * — one page per step (`resyncPage`). A gap longer than BACKFILL_DAYS is logged once as
 * `mail_gap` (dates only) so a screen can tell the owner.
 */
async function startResync(
  mailbox: Mailbox,
  reader: Pick<MailboxReader, "getProfile">,
  now: Date,
): Promise<SyncOutcome> {
  const profile = await reader.getProfile();
  const last = mailbox.lastSyncedAt ?? mailbox.backfillCompletedAt ?? now;
  const gapDays = Math.ceil((now.getTime() - last.getTime()) / DAY_MS) + 1;
  const days = Math.min(BACKFILL_DAYS, Math.max(RESYNC_DAYS, gapDays));
  const since = new Date(now.getTime() - days * DAY_MS);
  // The fresh cursor is stored now: mail from here on comes through history; the re-read
  // covers everything before it. Until the re-read is done every sync continues it first.
  await db()
    .update(mailboxes)
    .set({ historyId: profile.historyId, resyncSince: since, resyncPageToken: null })
    .where(eq(mailboxes.id, mailbox.id));
  if (gapDays > BACKFILL_DAYS) {
    await db()
      .insert(activityLog)
      .values({
        workspaceId: mailbox.workspaceId,
        actor: "squared_away",
        action: "mail_gap",
        detail: { mailboxId: mailbox.id, fromDay: isoDay(last), toDay: isoDay(since) },
      });
  }
  return { status: "resync_needed", since: since.toISOString() };
}

/**
 * One page (BACKFILL_PAGE_SIZE) of a history-expired re-read, from the saved token. Done →
 * the re-read is cleared and `last_synced_at` set. Idempotent: stored messages are skipped.
 */
export async function resyncPage(
  mailboxId: string,
  deps: SyncDeps = {},
): Promise<SyncOutcome & { done?: boolean }> {
  const { mailbox, skip } = await loadActiveMailbox(mailboxId);
  if (skip) return skip;
  const now = deps.now?.() ?? new Date();
  if (!mailbox.resyncSince) return { status: "ok", ingested: 0, done: true };
  const reader = (deps.readerFor ?? defaultReaderFor)(mailbox);
  return guarded(mailbox, async () => {
    const page = await windowPage(
      reader,
      afterQuery(mailbox.resyncSince!),
      mailbox.resyncPageToken ?? undefined,
      BACKFILL_PAGE_SIZE,
    );
    const ingested = await ingest(mailbox, reader, page.messages, now);
    const done = !page.nextPageToken;
    await db()
      .update(mailboxes)
      .set(
        done
          ? { resyncSince: null, resyncPageToken: null, lastSyncedAt: now }
          : { resyncPageToken: page.nextPageToken },
      )
      .where(eq(mailboxes.id, mailbox.id));
    logGmailUnits("resync", mailbox.id, reader);
    return { status: "ok", ingested, done };
  });
}

/** Most re-read pages one sync run may take; the next sync event continues from the token. */
export const MAX_RESYNC_PAGES_PER_RUN = 300;

/**
 * Incremental sync plus any re-read it needs, in one go. Used by tests and the e2e hook; the
 * job runs the re-read one page per step.
 */
export async function runIncrementalSync(
  mailboxId: string,
  deps: SyncDeps = {},
): Promise<SyncOutcome> {
  const first = await incrementalSync(mailboxId, deps);
  if (first.status !== "resync_needed") return first;
  let total = 0;
  for (let i = 0; i < MAX_RESYNC_PAGES_PER_RUN; i++) {
    const page = await resyncPage(mailboxId, deps);
    if (page.status !== "ok") return page;
    total += page.ingested;
    if (page.done) break;
  }
  return { status: "ok", ingested: total };
}

/** Mailboxes that should be polled / backfilled right now. */
export async function listSyncableMailboxes(now: Date = new Date()) {
  const rows = await db()
    .select({
      id: mailboxes.id,
      backfillCompletedAt: mailboxes.backfillCompletedAt,
      workspace: { status: workspaces.status, evaluationEndsAt: workspaces.evaluationEndsAt },
    })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(mailboxRunning());
  return rows
    .filter((r) => jobsAllowed(r.workspace, now))
    .map(({ id, backfillCompletedAt }) => ({ id, backfillCompletedAt }));
}

/** Gmail's push watch lasts 7 days; renew anything expiring within 2. No-op without a topic. */
export async function renewWatches(deps: SyncDeps = {}): Promise<number> {
  const topic = process.env.GMAIL_PUBSUB_TOPIC;
  if (!topic) return 0;
  const now = deps.now?.() ?? new Date();
  const soon = new Date(now.getTime() + 2 * 86_400_000);
  const rows = await db()
    .select({ mailbox: mailboxes, workspace: workspaces })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(
      and(
        mailboxRunning(),
        isNotNull(mailboxes.backfillCompletedAt),
        or(isNull(mailboxes.watchExpiresAt), lt(mailboxes.watchExpiresAt, soon)),
      ),
    );
  // Read-only accounts aren't synced, so there's nothing for a push to wake.
  const due = rows.filter((r) => jobsAllowed(r.workspace, now)).map((r) => r.mailbox);
  let renewed = 0;
  for (const m of due) {
    const outcome = await guarded(m, async () => {
      const w = await (deps.readerFor ?? defaultReaderFor)(m).watch(topic);
      await db()
        .update(mailboxes)
        .set({ watchExpiresAt: new Date(w.expiration) })
        .where(eq(mailboxes.id, m.id));
      return { status: "ok", ingested: 0 };
    });
    if (outcome.status === "ok") renewed++;
  }
  return renewed;
}

/**
 * Retention: drop body text and Gmail's preview snippet from anything older
 * than the window. Metadata (who, when, subject) and our summaries stay.
 * Draft text goes too (body, original text and the check flags, which quote it), and the
 * email's own words in `threads.extracted` (street address, dates, an inspector's
 * corrections) once the conversation's newest email is past the window. The content-free
 * facts Money, Quotes, price memory and the permit card still need are kept: the kind of
 * job, dollar figures, urgency, invoice number / amount / due date / status, permit number /
 * issuing body / inspection time / result, and our own true/false marks.
 */
export async function purgeExpiredBodies(
  now: Date = new Date(),
  days = bodyRetentionDays(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const purged = await db()
    .update(messages)
    .set({ bodyText: null, snippet: null, bodyPurgedAt: now })
    .where(
      and(
        lt(messages.sentAt, cutoff),
        or(isNotNull(messages.bodyText), isNotNull(messages.snippet)),
      ),
    )
    .returning({ id: messages.id });
  // Draft text is email text too. Anything still pending that old is stale; expire it, and
  // drop any send it was queued for or autopilot countdown, so nothing can pick it up again.
  await db()
    .update(drafts)
    .set({
      status: "expired",
      closedNote: "Expired after the retention window.",
      decidedAt: now,
      sendAfter: null,
      sendClaimedAt: null,
      autoSendAt: null,
    })
    .where(and(eq(drafts.status, "pending"), lt(drafts.createdAt, cutoff)));
  // The flags quote the draft's own words ("Mentions $4,200", "Says “guaranteed”").
  await db()
    .update(drafts)
    .set({ body: null, originalBody: null, flags: [] })
    .where(
      and(
        lt(drafts.createdAt, cutoff),
        or(
          isNotNull(drafts.body),
          isNotNull(drafts.originalBody),
          sql`${drafts.flags} <> '[]'::jsonb`,
        ),
      ),
    );
  // The email's own words the classifier pulled out. `#-` leaves a thread without a permit
  // (or with a null one) as it is.
  await db()
    .update(threads)
    .set({ extracted: sql`(${threads.extracted} - 'address' - 'dates') #- '{permit,corrections}'` })
    .where(
      and(
        sql`${threads.lastMessageAt} < ${cutoff.toISOString()}::timestamptz`,
        sql`(${threads.extracted} ? 'address' or ${threads.extracted} ? 'dates' or ${threads.extracted} -> 'permit' ? 'corrections')`,
      ),
    );
  return purged.length;
}

/** For Settings: what's been synced, without exposing any content. */
export async function syncSummary(mailboxId: string) {
  const [row] = await db()
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(eq(messages.mailboxId, mailboxId));
  return { messageCount: row?.count ?? 0 };
}
