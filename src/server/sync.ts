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
import { decryptSecret } from "@/lib/crypto";
import {
  HistoryExpiredError,
  MailboxAuthError,
  MailboxRateLimitError,
  type MailboxReader,
  type MailMessage,
  type MessageRef,
} from "@/mailbox/connector";
import { createGmailReader } from "@/mailbox/gmail/api";
import { parseAddressList } from "@/mailbox/gmail/parse";
import { jobsAllowed } from "./lifecycle";
import { unsentDraftMessage } from "./thread-sql";

/** How far back the first sync reaches. */
export const BACKFILL_DAYS = 30;
/** When the history cursor has expired, re-read this many days instead. */
export const RESYNC_DAYS = 7;
/**
 * Gmail allows roughly 50 message reads a second per user, and refuses bursts
 * well before that. Four at a time stays comfortably under it.
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
  | { status: "skipped"; reason: "not_found" | "not_active" | "not_ready" | "read_only" }
  | { status: "reconnect_needed" };

export const defaultReaderFor = (m: Mailbox) =>
  createGmailReader({ refreshToken: decryptSecret(m.encryptedRefreshToken) });

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
  if (row.mailbox.status !== "active") {
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
    if (outcome.status === "ok") await noteSyncError(mailbox.id, null);
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

  const meta = (
    await mapLimit(todo, FETCH_CONCURRENCY, (r) => reader.getMessage(r.id, { withBody: false }))
  )
    .filter((m): m is MailMessage => m !== null)
    // Drafts are skipped before anything is written: no row, no thread, no lastMessageAt move.
    .filter((m) => !isUnsentDraft(m.labelIds));
  if (meta.length === 0) return 0;

  const threadIds = [...new Set(meta.map((m) => m.providerThreadId))];
  const knownThreads = await db()
    .select()
    .from(threads)
    .where(and(eq(threads.mailboxId, mailbox.id), inArray(threads.gmailThreadId, threadIds)));
  const known = new Map(knownThreads.map((t) => [t.gmailThreadId, t]));

  const inboxThreads = new Set(knownThreads.filter((t) => t.inInbox).map((t) => t.gmailThreadId));
  for (const m of meta) if (m.labelIds.includes("INBOX")) inboxThreads.add(m.providerThreadId);

  const retentionCutoff = now.getTime() - bodyRetentionDays() * 86_400_000;
  const full = await mapLimit(meta, FETCH_CONCURRENCY, async (m) =>
    inboxThreads.has(m.providerThreadId) && m.internalDate >= retentionCutoff
      ? ((await reader.getMessage(m.providerMessageId, { withBody: true })) ?? m)
      : m,
  );

  const self = mailbox.email.toLowerCase();
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
        toAddresses: parseAddressList(m.headers.to).map((a) => a.email),
        ccAddresses: parseAddressList(m.headers.cc).map((a) => a.email),
        subject: m.headers.subject ?? null,
        direction: outbound ? ("out" as const) : ("in" as const),
        labelIds: m.labelIds,
        snippet: m.internalDate >= retentionCutoff ? m.snippet : null,
        bodyText: m.bodyText ?? null,
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
        },
        setWhere: unsentDraftMessage(),
      })
      .returning({ id: messages.id });
    ingested += inserted.length;
  }
  return ingested;
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

/** Step 2, repeated: one page (up to 100 messages) of the 30-day window. */
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
    const page = await reader.listMessages({
      query: windowQuery(BACKFILL_DAYS),
      pageToken,
      maxResults: BACKFILL_PAGE_SIZE,
    });
    const ingested = await ingest(mailbox, reader, page.messages, now);
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
        cursor = page.historyId;
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (err) {
      if (!(err instanceof HistoryExpiredError)) throw err;
      const profile = await reader.getProfile();
      let pageToken: string | undefined;
      do {
        const page = await reader.listMessages({ query: windowQuery(RESYNC_DAYS), pageToken });
        ingested += await ingest(mailbox, reader, page.messages, now);
        pageToken = page.nextPageToken;
      } while (pageToken);
      cursor = profile.historyId;
    }
    await db()
      .update(mailboxes)
      .set({ historyId: cursor, lastSyncedAt: now })
      .where(eq(mailboxes.id, mailbox.id));
    return { status: "ok", ingested };
  });
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
    .where(eq(mailboxes.status, "active"));
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
        eq(mailboxes.status, "active"),
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
  // Draft text is email text too. Anything still pending that old is stale; expire it.
  await db()
    .update(drafts)
    .set({ status: "expired", closedNote: "Expired after the retention window.", decidedAt: now })
    .where(and(eq(drafts.status, "pending"), lt(drafts.createdAt, cutoff)));
  await db()
    .update(drafts)
    .set({ body: null, originalBody: null })
    .where(
      and(lt(drafts.createdAt, cutoff), or(isNotNull(drafts.body), isNotNull(drafts.originalBody))),
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
