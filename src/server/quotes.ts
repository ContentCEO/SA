import "server-only";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { prepareBody } from "@/ai/classify";
import { db } from "@/db";
import { activityLog, mailboxes, messages, priceHistory, threads, workspaces } from "@/db/schema";
import { expirePendingNudge, flagPendingNudge, followupSettings, type DraftDeps } from "./drafts";
import { effectiveStatus, JOBS_ALLOWED, jobsAllowed, ReadOnlyError } from "./lifecycle";
import {
  amountFromOwnerText,
  canAutoSet,
  closeRate,
  guessNoAnswer,
  NO_ANSWER_AFTER_NUDGES_DAYS,
  NO_ANSWER_WITHOUT_NUDGES_DAYS,
  noAnswerAfterDays,
  QUOTE_GUESS_FLAG,
  quoteDecidedNote,
  quoteStage,
  quoteStopsNudges,
  type QuoteOutcome,
  type QuoteStage,
} from "./quote-rules";

export type QuoteRow = {
  threadId: string;
  gmailThreadId: string;
  mailboxEmail: string;
  customerName: string | null;
  customerAddress: string | null;
  summary: string | null;
  subject: string | null;
  stage: QuoteStage;
  /** The outcome is our guess (won from "go ahead", or no answer) — the owner can change it. */
  outcomeGuessed: boolean;
  amountCents: number | null;
  lastMessageAt: Date | null;
  startedAt: Date;
};

const asDate = (v: unknown) => (v ? new Date(v as string | Date) : null);
const DAY_MS = 86_400_000;
const WINDOW_MS = 30 * DAY_MS;

/** When the customer / the owner last wrote on the thread (correlated subqueries). */
const lastInSql = () =>
  sql<
    string | Date | null
  >`(select max(m.sent_at) from messages m where m.thread_id = ${threads.id} and m.direction = 'in')`;
const lastOutSql = () =>
  sql<
    string | Date | null
  >`(select max(m.sent_at) from messages m where m.thread_id = ${threads.id} and m.direction = 'out')`;

/**
 * SQL twin of `jobsAllowed` for the joined workspace, so a cron never pages through rows
 * of read-only accounts (they're never deleted, so they'd pile up). Callers keep the
 * in-code check as well.
 */
const workspaceJobsAllowedSql = (now: Date) =>
  and(
    inArray(workspaces.status, [...JOBS_ALLOWED]),
    sql`(${workspaces.status} <> 'evaluating' or ${workspaces.evaluationEndsAt} is null or ${workspaces.evaluationEndsAt} > ${now.toISOString()}::timestamptz)`,
  );

/**
 * SQL twin of `isQuoteThread`: sorted as a quote request, or has ever had an outcome
 * (a cleared guess or an owner's reopen keeps its source), whatever its category now.
 */
const quoteThreadSql = () =>
  or(
    eq(threads.category, "quote_request"),
    isNotNull(threads.quoteOutcome),
    isNotNull(threads.quoteOutcomeSource),
  );

/** Quote-request threads (and anything that has had an outcome) for one workspace. */
export async function listQuotes(workspaceId: string, now: Date = new Date()) {
  await captureQuoteAmounts(workspaceId);
  await guessNoAnswers(now, workspaceId);
  const { days } = await followupSettings(workspaceId);
  const rows = await db()
    .select({
      threadId: threads.id,
      gmailThreadId: threads.gmailThreadId,
      mailboxEmail: mailboxes.email,
      summary: threads.summary,
      subject: threads.subject,
      outcome: threads.quoteOutcome,
      outcomeSource: threads.quoteOutcomeSource,
      amountCents: threads.quoteAmountCents,
      lastMessageAt: threads.lastMessageAt,
      startedAt: threads.createdAt,
      lastIn: sql<Date | null>`(select max(m.sent_at) from messages m where m.thread_id = ${threads.id} and m.direction = 'in')`,
      lastOut: sql<Date | null>`(select max(m.sent_at) from messages m where m.thread_id = ${threads.id} and m.direction = 'out')`,
      firstAt: sql<Date | null>`(select min(m.sent_at) from messages m where m.thread_id = ${threads.id})`,
      customerName: sql<
        string | null
      >`(select m.from_name from messages m where m.thread_id = ${threads.id} and m.direction = 'in' order by m.sent_at desc limit 1)`,
      customerAddress: sql<
        string | null
      >`(select lower(m.from_address) from messages m where m.thread_id = ${threads.id} and m.direction = 'in' order by m.sent_at desc limit 1)`,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(and(eq(mailboxes.workspaceId, workspaceId), quoteThreadSql()))
    .orderBy(desc(threads.lastMessageAt))
    .limit(300);

  const quotes: QuoteRow[] = rows.map((r) => ({
    threadId: r.threadId,
    gmailThreadId: r.gmailThreadId,
    mailboxEmail: r.mailboxEmail,
    customerName: r.customerName,
    customerAddress: r.customerAddress,
    summary: r.summary,
    subject: r.subject,
    stage: quoteStage(
      { outcome: r.outcome, lastInboundAt: asDate(r.lastIn), lastOutboundAt: asDate(r.lastOut) },
      now,
      days,
    ),
    outcomeGuessed: r.outcome != null && r.outcomeSource === "auto",
    amountCents: r.amountCents,
    lastMessageAt: asDate(r.lastMessageAt),
    startedAt: asDate(r.firstAt) ?? r.startedAt,
  }));

  // Last 30 days, by when the request came in.
  const recent = quotes.filter((q) => now.getTime() - q.startedAt.getTime() <= WINDOW_MS);
  const sum = (qs: QuoteRow[]) => qs.reduce((t, q) => t + (q.amountCents ?? 0), 0);
  const quoted = recent.filter((q) => q.stage !== "waiting_on_you");
  const won = recent.filter((q) => q.stage === "won");
  const totals = {
    requests: recent.length,
    quotedCount: quoted.length,
    quotedCents: sum(quoted),
    wonCount: won.length,
    wonCents: sum(won),
    // "No answer" counts as decided: a quote nobody answered wasn't won.
    winRatePct: closeRate({
      won: won.length,
      lost: recent.filter((q) => q.stage === "lost").length,
      noAnswer: recent.filter((q) => q.stage === "no_answer").length,
    }),
  };
  return { quotes, totals, quietDays: days };
}

async function ownedThread(workspaceId: string, threadId: string) {
  const [t] = await db()
    .select({
      id: threads.id,
      outcome: threads.quoteOutcome,
      category: threads.category,
      workspace: workspaces,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(and(eq(threads.id, threadId), eq(mailboxes.workspaceId, workspaceId)));
  return t;
}

/**
 * The owner's Won / Lost / No answer / Reopen (null). Scoped to their workspace;
 * refused for read-only accounts (ReadOnlyError). Always recorded as the owner's —
 * reopening too — so our guesses never touch this quote again.
 */
export async function setQuoteOutcome(
  workspaceId: string,
  threadId: string,
  outcome: QuoteOutcome | null,
  amountCents?: number | null,
  now: Date = new Date(),
  opts: Pick<DraftDeps, "writerFor"> = {},
): Promise<boolean> {
  const t = await ownedThread(workspaceId, threadId);
  if (!t) return false;
  if (!jobsAllowed(t.workspace, now)) throw new ReadOnlyError(effectiveStatus(t.workspace, now));
  const typed = amountCents !== undefined && amountCents !== null;
  // One transaction, so price memory never sees a typed amount without its mark.
  await db().transaction(async (tx) => {
    await tx
      .update(threads)
      .set({
        quoteOutcome: outcome,
        quoteOutcomeSource: "owner",
        quoteOutcomeAt: outcome ? now : null,
        ...(typed ? { quoteAmountCents: amountCents } : {}),
      })
      .where(eq(threads.id, threadId));
    await tx.insert(activityLog).values({
      workspaceId,
      actor: "owner",
      action: "quote_marked",
      threadId,
      // `amountTyped` (yes/no, never the amount): a typed Won amount stays out of price memory.
      detail: typed ? { outcome, amountTyped: true } : { outcome },
    });
  });
  // A decided quote is never chased, so a nudge still waiting in the queue goes too
  // (here and in Gmail). The mark stands even if Gmail can't be reached right now.
  // A won job's invoice is still chased (quoteStopsNudges), so its nudge stays.
  if (outcome && quoteStopsNudges({ quoteOutcome: outcome, category: t.category })) {
    try {
      await expirePendingNudge(threadId, quoteDecidedNote(outcome), { ...opts, now: () => now });
    } catch (err) {
      console.error("quote_nudge_expire_failed", {
        workspaceId,
        threadId,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return true;
}

/**
 * Our guess at a quote's outcome. The owner always wins, in the UPDATE itself:
 * only a thread with no outcome that the owner never touched, or one holding our
 * own earlier guess, is written — never an owner's choice, a reopen, or a legacy
 * outcome with no source (amendment A13). `extra` adds the rest of the decision
 * to the same WHERE so a stale snapshot can't win a race (A14). The activity row
 * is written only when a row really changed, so a re-run is a no-op.
 */
export async function autoSetQuoteOutcome(
  threadId: string,
  outcome: QuoteOutcome,
  now: Date,
  opts: { extra?: SQL; why?: string } = {},
): Promise<boolean> {
  const [row] = await db()
    .update(threads)
    .set({ quoteOutcome: outcome, quoteOutcomeSource: "auto", quoteOutcomeAt: now })
    .where(
      and(
        eq(threads.id, threadId),
        sql`((${threads.quoteOutcome} is null and ${threads.quoteOutcomeSource} is distinct from 'owner') or ${threads.quoteOutcomeSource} = 'auto')`,
        sql`${threads.quoteOutcome} is distinct from ${outcome}`,
        opts.extra,
      ),
    )
    .returning({ mailboxId: threads.mailboxId, category: threads.category });
  if (!row) return false;
  const [box] = await db()
    .select({ workspaceId: mailboxes.workspaceId })
    .from(mailboxes)
    .where(eq(mailboxes.id, row.mailboxId));
  if (box) {
    await db()
      .insert(activityLog)
      .values({
        workspaceId: box.workspaceId,
        actor: "squared_away",
        action: "quote_outcome_guessed",
        threadId,
        detail: { outcome, ...(opts.why ? { why: opts.why } : {}) },
      });
  }
  // A guess never deletes a waiting nudge; it asks the owner to check it (unless the
  // nudge is for a won job's invoice, which is still chased).
  if (quoteStopsNudges({ quoteOutcome: outcome, category: row.category })) {
    await flagPendingNudge(threadId, QUOTE_GUESS_FLAG);
  }
  return true;
}

/**
 * The customer wrote back after our "no answer" guess, so the guess was wrong: the quote
 * is open again (and can be chased again). Only our own guess is cleared — never an
 * owner's mark — and only while the customer really wrote last. The source stays 'auto'
 * so we may guess again later. Returns whether it changed anything.
 */
export async function clearNoAnswerGuess(threadId: string): Promise<boolean> {
  const rows = await db()
    .update(threads)
    .set({ quoteOutcome: null, quoteOutcomeAt: null })
    .where(
      and(
        eq(threads.id, threadId),
        eq(threads.quoteOutcome, "no_answer"),
        eq(threads.quoteOutcomeSource, "auto"),
        sql`${lastInSql()} > coalesce(${lastOutSql()}, '-infinity'::timestamptz)`,
      ),
    )
    .returning({ id: threads.id });
  return rows.length > 0;
}

/**
 * Guess "no answer" for open quotes that went quiet after the owner's quote
 * (see `guessNoAnswer`), and drop our earlier guesses where the customer has
 * since written back (a backstop for `afterClassified`). Read-only accounts are
 * skipped. Runs from the daily follow-up scan and whenever the Quotes screen
 * loads; idempotent.
 *
 * The cheap parts of the decision run in SQL and the rows are paged by id, so
 * not-yet-due quotes and read-only accounts can never crowd out a due one.
 */
export async function guessNoAnswers(
  now: Date = new Date(),
  workspaceId?: string,
  opts: { pageSize?: number } = {},
): Promise<number> {
  const pageSize = opts.pageSize ?? 500;
  const lastIn = lastInSql();
  const lastOut = lastOutSql();
  const sentNudges = sql<number>`(select count(*) from drafts d where d.thread_id = ${threads.id} and d.kind = 'followup' and d.status in ('sent', 'edited_and_sent'))`;
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  const inScope = and(
    workspaceId ? eq(mailboxes.workspaceId, workspaceId) : undefined,
    workspaceJobsAllowedSql(now),
  );

  // The customer wrote back after our guess → open again.
  const answered = await db()
    .select({ threadId: threads.id })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(
      and(
        inScope,
        eq(threads.quoteOutcome, "no_answer"),
        eq(threads.quoteOutcomeSource, "auto"),
        sql`${lastIn} > coalesce(${lastOut}, '-infinity'::timestamptz)`,
      ),
    );
  for (const r of answered) await clearNoAnswerGuess(r.threadId);

  let set = 0;
  let after: string | null = null;
  for (;;) {
    const rows = await db()
      .select({
        threadId: threads.id,
        workspace: workspaces,
        source: threads.quoteOutcomeSource,
        lastIn,
        lastOut,
        sentNudges,
      })
      .from(threads)
      .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
      .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
      .where(
        and(
          inScope,
          after ? sql`${threads.id} > ${after}::uuid` : undefined,
          // Includes a quote whose earlier guess was cleared and whose category has since
          // changed (the customer's "can you do March?" sorted as scheduling).
          quoteThreadSql(),
          isNull(threads.quoteOutcome),
          sql`${threads.quoteOutcomeSource} is distinct from 'owner'`,
          sql`${lastIn} is not null`,
          sql`${lastOut} > ${lastIn}`,
          // Pre-filter on the two bars of `guessNoAnswer` (which still decides below).
          sql`(${lastOut} <= ${ago(NO_ANSWER_WITHOUT_NUDGES_DAYS)}::timestamptz or (${lastOut} <= ${ago(NO_ANSWER_AFTER_NUDGES_DAYS)}::timestamptz and ${sentNudges} >= 2))`,
        ),
      )
      .orderBy(threads.id)
      .limit(pageSize);

    for (const r of rows) {
      if (!jobsAllowed(r.workspace, now) || !canAutoSet(null, r.source)) continue;
      const lastOutboundAt = asDate(r.lastOut);
      const nudges = Number(r.sentNudges);
      const why = guessNoAnswer(
        { lastInboundAt: asDate(r.lastIn), lastOutboundAt, sentNudges: nudges },
        now,
      );
      if (!why || !lastOutboundAt) continue;
      // Re-checked in the UPDATE: still no outcome, still nothing from the customer since the
      // owner's last message, and that message still old enough.
      const ok = await autoSetQuoteOutcome(r.threadId, "no_answer", now, {
        why,
        extra: and(
          isNull(threads.quoteOutcome),
          sql`${lastOut} > ${lastIn}`,
          sql`${lastOut} <= ${ago(noAnswerAfterDays(nudges))}::timestamptz`,
        ),
      });
      if (ok) set++;
    }
    if (rows.length < pageSize) break;
    after = rows[rows.length - 1]!.threadId;
  }
  return set;
}

/**
 * Remember what each quote was for while the owner's reply text still exists
 * (bodies are purged after the retention window; the amount is kept). Never
 * overwrites an amount that's already set.
 *
 * Plan #15: a captured amount on a thread whose kind of job is known also goes
 * into the owner's price memory (one row per thread, write-only from here). The
 * amount the owner types when marking a quote Won does not (it may be the final
 * bill, not the quote) — see `backfillPriceMemory`.
 */
export async function captureQuoteAmounts(workspaceId?: string): Promise<number> {
  const open = await db()
    .select({
      id: threads.id,
      workspaceId: mailboxes.workspaceId,
      extracted: threads.extracted,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        workspaceId ? eq(mailboxes.workspaceId, workspaceId) : undefined,
        quoteThreadSql(),
        isNull(threads.quoteAmountCents),
      ),
    )
    // Newest first, so quotes with no figure in them can't crowd out today's.
    .orderBy(desc(threads.lastMessageAt))
    .limit(500);
  let captured = 0;
  if (open.length) {
    const outbound = await db()
      .select({ threadId: messages.threadId, body: messages.bodyText, sentAt: messages.sentAt })
      .from(messages)
      .where(
        and(
          inArray(
            messages.threadId,
            open.map((t) => t.id),
          ),
          eq(messages.direction, "out"),
          isNotNull(messages.bodyText),
        ),
      )
      .orderBy(desc(messages.sentAt));
    const byThread = new Map<string, { cents: number; sentAt: Date }>();
    for (const m of outbound) {
      if (byThread.has(m.threadId)) continue; // newest reply with a figure wins
      const cents = amountFromOwnerText(prepareBody(m.body ?? ""));
      if (cents) byThread.set(m.threadId, { cents, sentAt: m.sentAt });
    }
    const info = new Map(open.map((t) => [t.id, t]));
    for (const [id, { cents, sentAt }] of byThread) {
      const set = await db()
        .update(threads)
        .set({ quoteAmountCents: cents })
        .where(and(eq(threads.id, id), isNull(threads.quoteAmountCents)))
        .returning({ id: threads.id });
      if (!set.length) continue;
      captured++;
      const t = info.get(id)!;
      const service = serviceOf(t.extracted);
      if (!service) continue;
      await db()
        .insert(priceHistory)
        .values({
          workspaceId: t.workspaceId,
          threadId: id,
          service,
          amountCents: cents,
          quotedAt: sentAt,
        })
        .onConflictDoNothing();
    }
  }
  await backfillPriceMemory(workspaceId);
  return captured;
}

/** The kind of job sorting found, trimmed for price memory; null if there isn't one. */
function serviceOf(extracted: unknown): string | null {
  const s = (extracted as { service_requested?: unknown } | null)?.service_requested;
  if (typeof s !== "string") return null;
  const t = s.trim().slice(0, 200);
  return t || null;
}

/**
 * Price memory for quotes that had an amount before it existed (amendment 8), or
 * whose kind of job became known later. Skips any thread whose amount the owner
 * typed when marking it Won (the `amountTyped` mark on that activity row) — only
 * prices from the owner's own sent quotes go in. Idempotent: one row per thread.
 */
async function backfillPriceMemory(workspaceId?: string): Promise<number> {
  const service = sql<string | null>`btrim(${threads.extracted}->>'service_requested')`;
  const rows = await db()
    .select({
      threadId: threads.id,
      workspaceId: mailboxes.workspaceId,
      extracted: threads.extracted,
      amountCents: threads.quoteAmountCents,
      quotedAt: sql<
        string | Date
      >`coalesce(${lastOutSql()}, ${threads.quoteOutcomeAt}, ${threads.createdAt})`,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        workspaceId ? eq(mailboxes.workspaceId, workspaceId) : undefined,
        quoteThreadSql(),
        isNotNull(threads.quoteAmountCents),
        sql`coalesce(${service}, '') <> ''`,
        sql`not exists (select 1 from price_history ph where ph.thread_id = ${threads.id})`,
        // Scoped by workspace so activity_log's (workspace_id, created_at) index applies —
        // this runs on every Quotes view, and the log grows with every account.
        sql`not exists (select 1 from activity_log a where a.workspace_id = ${mailboxes.workspaceId} and a.thread_id = ${threads.id} and a.action = 'quote_marked' and a.detail->>'amountTyped' = 'true')`,
      ),
    )
    .limit(500);
  let added = 0;
  for (const r of rows) {
    const s = serviceOf(r.extracted);
    if (!s || !r.amountCents) continue;
    const inserted = await db()
      .insert(priceHistory)
      .values({
        workspaceId: r.workspaceId,
        threadId: r.threadId,
        service: s,
        amountCents: r.amountCents,
        quotedAt: new Date(r.quotedAt),
      })
      .onConflictDoNothing()
      .returning({ id: priceHistory.id });
    added += inserted.length;
  }
  return added;
}
