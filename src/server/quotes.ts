import "server-only";
import { and, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { prepareBody } from "@/ai/classify";
import { db } from "@/db";
import { activityLog, mailboxes, messages, priceHistory, threads, workspaces } from "@/db/schema";
import { expirePendingNudge, flagPendingNudge, followupSettings, type DraftDeps } from "./drafts";
import { effectiveStatus, JOBS_ALLOWED, jobsAllowed, ReadOnlyError } from "./lifecycle";
import {
  asDate,
  customerAddressSql,
  customerNameSql,
  lastInSql,
  lastOutSql,
  notDraftMessage,
  quoteThreadSql,
} from "./thread-sql";
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
  shownLostReason,
  type LostReason,
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
  /** Ideas C5: why it was lost, only while it is lost. */
  lostReason: LostReason | null;
  amountCents: number | null;
  lastMessageAt: Date | null;
  startedAt: Date;
};

const DAY_MS = 86_400_000;
const WINDOW_MS = 30 * DAY_MS;

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
 * An owner message on the thread that is NOT a purpose note the app sent (deposit details,
 * a review request, a closing question): those carry the deposit or no price at all, never
 * the quote.
 */
const notPurposeNote = () =>
  sql`not exists (select 1 from drafts d where d.thread_id = ${messages.threadId} and d.purpose is not null and d.sent_gmail_message_id = ${messages.gmailMessageId})`;

/**
 * The quote's price as written by the owner: the newest owner message with a dollar figure
 * that isn't a purpose note, sent before `before` (null = any time). Quoted text is stripped.
 */
async function ownerQuotedCents(
  threadIds: string[],
  before: (threadId: string) => Date | null,
): Promise<Map<string, { cents: number; sentAt: Date }>> {
  const out = new Map<string, { cents: number; sentAt: Date }>();
  if (threadIds.length === 0) return out;
  const outbound = await db()
    .select({ threadId: messages.threadId, body: messages.bodyText, sentAt: messages.sentAt })
    .from(messages)
    .where(
      and(
        inArray(messages.threadId, threadIds),
        eq(messages.direction, "out"),
        // An unsent Gmail draft (an auto-draft quotes the price list) is no price given.
        notDraftMessage(),
        isNotNull(messages.bodyText),
        notPurposeNote(),
      ),
    )
    .orderBy(desc(messages.sentAt));
  for (const m of outbound) {
    if (out.has(m.threadId)) continue; // newest reply with a figure wins
    const cutoff = before(m.threadId);
    if (cutoff && new Date(m.sentAt).getTime() >= cutoff.getTime()) continue;
    const cents = amountFromOwnerText(prepareBody(m.body ?? ""));
    if (cents) out.set(m.threadId, { cents, sentAt: new Date(m.sentAt) });
  }
  return out;
}

/**
 * Evidence the owner gave a price on this thread before `before` (an acceptance needs one,
 * plan #28): the quote's amount is already known, or an owner message (not a purpose note)
 * has a dollar figure. "I can come look Tuesday" → "Sounds good, book us in" is a site
 * visit, not a won quote.
 */
export async function ownerGavePrice(
  thread: { id: string; quoteAmountCents: number | null },
  before: Date,
): Promise<boolean> {
  if (thread.quoteAmountCents != null) return true;
  return (await ownerQuotedCents([thread.id], () => before)).has(thread.id);
}

/**
 * When the quote was decided, for price memory: the customer's acceptance email
 * (`extracted.quote_accepted_at`) or the outcome's time, whichever is earlier. Owner
 * messages from then on (deposit details, the invoice) are never the quote.
 */
function decidedAt(t: { extracted: unknown; quoteOutcomeAt: Date | null }): Date | null {
  const raw = (t.extracted as { quote_accepted_at?: unknown } | null)?.quote_accepted_at;
  const accepted = typeof raw === "string" ? new Date(raw) : null;
  const times = [accepted, t.quoteOutcomeAt ? new Date(t.quoteOutcomeAt) : null].filter(
    (d): d is Date => d != null && Number.isFinite(d.getTime()),
  );
  return times.length ? new Date(Math.min(...times.map((d) => d.getTime()))) : null;
}

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
      lostReason: threads.quoteLostReason,
      amountCents: threads.quoteAmountCents,
      lastMessageAt: threads.lastMessageAt,
      startedAt: threads.createdAt,
      // The same "who wrote last" as leads at risk: a lead forwarded to the crew is still
      // waiting on you, so the push's /quotes link lands on it.
      lastIn: lastInSql(),
      lastOut: lastOutSql(),
      firstAt: sql<Date | null>`(select min(m.sent_at) from messages m where m.thread_id = ${threads.id})`,
      // As a reply addresses them: a website form's Reply-To, else the sender.
      customerName: customerNameSql(),
      customerAddress: customerAddressSql(),
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
    lostReason: shownLostReason(r.outcome, r.lostReason),
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
        // Ideas C5: a new mark starts without a reason (asked again after Mark lost).
        quoteLostReason: null,
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
      quoteOutcomeAt: threads.quoteOutcomeAt,
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
    const info = new Map(open.map((t) => [t.id, t]));
    // The newest owner figure from before the quote was decided — never the deposit note
    // or an invoice sent after "go ahead" (nor any purpose note the app sent).
    const byThread = await ownerQuotedCents(
      open.map((t) => t.id),
      (id) => decidedAt(info.get(id)!),
    );
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

/**
 * Ideas C5: the owner's one tap on why a lost quote was lost. Only on a quote that is lost
 * right now; a repeat tap of the same reason changes and logs nothing. Never sent to the AI.
 */
export async function setLostReason(
  workspaceId: string,
  threadId: string,
  reason: LostReason,
  now: Date = new Date(),
): Promise<"ok" | "not_lost" | "not_found"> {
  const t = await ownedThread(workspaceId, threadId);
  if (!t) return "not_found";
  if (!jobsAllowed(t.workspace, now)) throw new ReadOnlyError(effectiveStatus(t.workspace, now));
  const [row] = await db()
    .update(threads)
    .set({ quoteLostReason: reason })
    .where(
      and(
        eq(threads.id, threadId),
        eq(threads.quoteOutcome, "lost"),
        sql`${threads.quoteLostReason} is distinct from ${reason}`,
      ),
    )
    .returning({ id: threads.id });
  if (!row) {
    const [cur] = await db()
      .select({ outcome: threads.quoteOutcome })
      .from(threads)
      .where(eq(threads.id, threadId));
    return cur?.outcome === "lost" ? "ok" : "not_lost";
  }
  await db().insert(activityLog).values({
    workspaceId,
    actor: "owner",
    action: "quote_lost_reason",
    threadId,
    detail: { reason },
  });
  return "ok";
}
