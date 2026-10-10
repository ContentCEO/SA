import "server-only";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { prepareBody } from "@/ai/classify";
import { db } from "@/db";
import { activityLog, mailboxes, messages, threads } from "@/db/schema";
import { followupSettings } from "./drafts";
import { amountFromOwnerText, quoteStage, type QuoteStage } from "./quote-rules";

export type QuoteRow = {
  threadId: string;
  gmailThreadId: string;
  mailboxEmail: string;
  customerName: string | null;
  customerAddress: string | null;
  summary: string | null;
  subject: string | null;
  stage: QuoteStage;
  amountCents: number | null;
  lastMessageAt: Date | null;
  startedAt: Date;
};

const asDate = (v: unknown) => (v ? new Date(v as string | Date) : null);
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Quote-request threads (and anything the owner marked Won/Lost) for one workspace. */
export async function listQuotes(workspaceId: string, now: Date = new Date()) {
  await captureQuoteAmounts(workspaceId);
  const { days } = await followupSettings(workspaceId);
  const rows = await db()
    .select({
      threadId: threads.id,
      gmailThreadId: threads.gmailThreadId,
      mailboxEmail: mailboxes.email,
      summary: threads.summary,
      subject: threads.subject,
      outcome: threads.quoteOutcome,
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
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        or(eq(threads.category, "quote_request"), isNotNull(threads.quoteOutcome)),
      ),
    )
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
    amountCents: r.amountCents,
    lastMessageAt: asDate(r.lastMessageAt),
    startedAt: asDate(r.firstAt) ?? r.startedAt,
  }));

  // Last 30 days, by when the request came in.
  const recent = quotes.filter((q) => now.getTime() - q.startedAt.getTime() <= WINDOW_MS);
  const sum = (qs: QuoteRow[]) => qs.reduce((t, q) => t + (q.amountCents ?? 0), 0);
  const quoted = recent.filter((q) => q.stage !== "waiting_on_you");
  const won = recent.filter((q) => q.stage === "won");
  const decided = recent.filter((q) => q.stage === "won" || q.stage === "lost");
  const totals = {
    requests: recent.length,
    quotedCount: quoted.length,
    quotedCents: sum(quoted),
    wonCount: won.length,
    wonCents: sum(won),
    winRatePct: decided.length ? Math.round((won.length / decided.length) * 100) : null,
  };
  return { quotes, totals, quietDays: days };
}

async function ownedThread(workspaceId: string, threadId: string) {
  const [t] = await db()
    .select({ id: threads.id, outcome: threads.quoteOutcome })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(and(eq(threads.id, threadId), eq(mailboxes.workspaceId, workspaceId)));
  return t;
}

/** The owner's Won / Lost / Reopen. Scoped to their workspace. */
export async function setQuoteOutcome(
  workspaceId: string,
  threadId: string,
  outcome: "won" | "lost" | null,
  amountCents?: number | null,
  now: Date = new Date(),
): Promise<boolean> {
  const t = await ownedThread(workspaceId, threadId);
  if (!t) return false;
  await db()
    .update(threads)
    .set({
      quoteOutcome: outcome,
      quoteOutcomeAt: outcome ? now : null,
      ...(amountCents !== undefined && amountCents !== null
        ? { quoteAmountCents: amountCents }
        : {}),
    })
    .where(eq(threads.id, threadId));
  await db().insert(activityLog).values({
    workspaceId,
    actor: "owner",
    action: "quote_marked",
    threadId,
    detail: { outcome },
  });
  return true;
}

/**
 * Remember what each quote was for while the owner's reply text still exists
 * (bodies are purged after the retention window; the amount is kept). Never
 * overwrites an amount that's already set.
 */
export async function captureQuoteAmounts(workspaceId?: string): Promise<number> {
  const open = await db()
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        workspaceId ? eq(mailboxes.workspaceId, workspaceId) : undefined,
        eq(threads.category, "quote_request"),
        isNull(threads.quoteAmountCents),
      ),
    )
    .limit(500);
  if (!open.length) return 0;
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
  const byThread = new Map<string, number>();
  for (const m of outbound) {
    if (byThread.has(m.threadId)) continue; // newest reply with a figure wins
    const cents = amountFromOwnerText(prepareBody(m.body ?? ""));
    if (cents) byThread.set(m.threadId, cents);
  }
  for (const [id, cents] of byThread) {
    await db()
      .update(threads)
      .set({ quoteAmountCents: cents })
      .where(and(eq(threads.id, id), isNull(threads.quoteAmountCents)));
  }
  return byThread.size;
}
