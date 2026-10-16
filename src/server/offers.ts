import "server-only";
import { and, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { DISPUTE_REASONS } from "@/ai/classify";
import { featureOn } from "@/config/features";
import { db } from "@/db";
import { businessProfiles, drafts, mailboxes, messages, threads, workspaces } from "@/db/schema";
import { knownCustomer } from "./known-customer";
import { jobsAllowed } from "./lifecycle";
import {
  closingQuestionReason,
  COMPLAINT_MEMORY_DAYS,
  REVIEW_REQUEST_WINDOW_DAYS,
  reviewOfferReason,
  type ClosingQuestionReason,
  type ReviewOfferReason,
} from "./offer-rules";
import { isQuoteThread } from "./quote-rules";
import { customerAddressSql, messageReplyAddress, notDraftSql } from "./thread-sql";

/**
 * Which owner-tap offers a thread gets (plan #29 "Ask for a review", #26 "Want to ask if
 * they went another way?"). The screens show a button only when these say yes, and
 * `createDraftForThread` asks the same questions (reviewAllowed / closingQuestionAllowed)
 * before any model call — so a stale screen or a forged form can't get past them.
 */
export type ThreadOffers = { review: boolean; closingQuestion: boolean };

const DAY_MS = 86_400_000;
const LIVE_OR_SENT = ["pending", "sent", "edited_and_sent"] as const;

type Facts = Awaited<ReturnType<typeof threadFacts>>[number];

/** Everything the rules need about these threads, in one query, scoped to the workspace. */
async function threadFacts(workspaceId: string, threadIds: string[]) {
  if (threadIds.length === 0) return [];
  const rows = await db()
    .select({
      id: threads.id,
      mailboxId: threads.mailboxId,
      category: threads.category,
      needsOwner: threads.needsOwner,
      needsOwnerManual: threads.needsOwnerManual,
      needsOwnerReason: threads.needsOwnerReason,
      extracted: threads.extracted,
      complainedAt: threads.complainedAt,
      invoicePaidAt: threads.invoicePaidAt,
      invoicePaidSource: threads.invoicePaidSource,
      quoteOutcome: threads.quoteOutcome,
      quoteOutcomeSource: threads.quoteOutcomeSource,
      // Where a reply goes (a website form's Reply-To, else the sender) and who sent it.
      customerAddress: customerAddressSql(),
      senderAddress: sql<
        string | null
      >`(select lower(trim(m.from_address)) from messages m where m.thread_id = ${threads.id} and m.direction = 'in' order by m.sent_at desc limit 1)`,
      lastInboundAt: sql<
        string | Date | null
      >`(select max(m.sent_at) from messages m where m.thread_id = ${threads.id} and m.direction = 'in')`,
      lastOutboundAt: sql<
        string | Date | null
      >`(select max(m.sent_at) from messages m where m.thread_id = ${threads.id} and m.direction = 'out' and ${notDraftSql("m")})`,
      sentNudges: sql<number>`(select count(*) from drafts d where d.thread_id = ${threads.id} and d.kind = 'followup' and d.status in ('sent', 'edited_and_sent'))::int`,
      askedClosing: sql<boolean>`exists (select 1 from drafts d where d.thread_id = ${threads.id} and d.purpose = 'closing_question')`,
      // Two things the create path refuses that the rules don't know about: a draft already
      // waiting on the thread (already_pending), and a newest message whose text was purged
      // (no_text). An offer that can only fail isn't shown.
      hasPending: sql<boolean>`exists (select 1 from drafts d where d.thread_id = ${threads.id} and d.status = 'pending')`,
      newestHasText: sql<boolean>`coalesce((select length(trim(coalesce(m.body_text, m.snippet, ''))) > 0 from messages m where m.thread_id = ${threads.id} order by m.sent_at desc limit 1), false)`,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(and(eq(mailboxes.workspaceId, workspaceId), inArray(threads.id, threadIds)));
  const asDate = (v: string | Date | null) => (v ? new Date(v) : null);
  return rows.map((r) => ({
    ...r,
    lastInboundAt: asDate(r.lastInboundAt),
    lastOutboundAt: asDate(r.lastOutboundAt),
    sentNudges: Number(r.sentNudges),
    askedClosing: r.askedClosing === true,
    hasPending: r.hasPending === true,
    newestHasText: r.newestHasText === true,
  }));
}

/**
 * This thread holds a complaint: the sticky mark (A1, which a dispute or legal threat also
 * sets — `extracted.disputed` is written in the same UPDATE, so it never needs checking
 * apart), or a thread sorted before that mark existed whose dispute reason still shows.
 * Disputes count as complaints for offers.
 */
function threadComplained(f: {
  complainedAt: Date | null;
  needsOwnerReason: string | null;
}): boolean {
  return (
    f.complainedAt != null ||
    (f.needsOwnerReason != null && DISPUTE_REASONS.includes(f.needsOwnerReason))
  );
}

/**
 * Addresses (lowercased) that wrote in on a thread with a complaint in the last 12 months
 * (A1; complained_at is the latest complaint), or one still sorted as a complaint. A customer
 * who complained on one job isn't asked for a review on another.
 */
export async function complainedAddresses(workspaceId: string, now: Date): Promise<Set<string>> {
  const since = new Date(now.getTime() - COMPLAINT_MEMORY_DAYS * DAY_MS);
  const rows = await db()
    // Both the sender and the reply address: blocking more is the safe direction.
    .selectDistinct({
      address: sql<string>`lower(${messages.fromAddress})`,
      reply: messageReplyAddress(),
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        eq(messages.direction, "in"),
        isNotNull(messages.fromAddress),
        // A thread still sorted as a complaint (or still showing a dispute reason) counts
        // whatever its mark says: one sorted before complained_at existed (or by older code)
        // may not have the mark yet. `extracted.disputed` is always written together with
        // the mark, so it needs no check of its own.
        or(
          gte(threads.complainedAt, since),
          eq(threads.category, "complaint"),
          inArray(threads.needsOwnerReason, [...DISPUTE_REASONS]),
        ),
      ),
    );
  return new Set(rows.flatMap((r) => [r.address, r.reply].filter((a): a is string => !!a)));
}

/**
 * Addresses (lowercased) that got a review request, waiting or sent, in the last 12 months.
 * Discarded and expired ones don't count: they never reached the customer.
 */
export async function recentReviewAddresses(
  workspaceId: string,
  now: Date,
  q: Pick<ReturnType<typeof db>, "selectDistinct"> = db(),
): Promise<Set<string>> {
  const since = new Date(now.getTime() - REVIEW_REQUEST_WINDOW_DAYS * DAY_MS);
  const rows = await q
    .selectDistinct({ address: sql<string>`lower(${drafts.toAddress})` })
    .from(drafts)
    .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        eq(drafts.purpose, "review_request"),
        inArray(drafts.status, [...LIVE_OR_SENT]),
        // The 12 months count from when it reached the customer: a sent one by when it was
        // sent (a note drafted 370 days ago but sent 340 days ago still blocks), a waiting
        // one by when it was drafted.
        or(
          and(eq(drafts.status, "pending"), gte(drafts.createdAt, since)),
          and(
            inArray(drafts.status, ["sent", "edited_and_sent"]),
            sql`coalesce(${drafts.decidedAt}, ${drafts.createdAt}) >= ${since.toISOString()}::timestamptz`,
          ),
        ),
      ),
    );
  return new Set(rows.map((r) => r.address));
}

async function reviewUrlOf(workspaceId: string): Promise<string | null> {
  const [p] = await db()
    .select({ reviewUrl: businessProfiles.reviewUrl })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  return p?.reviewUrl ?? null;
}

async function workspaceOf(workspaceId: string) {
  const [w] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId));
  return w;
}

function cheapReviewReason(
  f: Facts,
  ctx: { complained: Set<string>; recent: Set<string>; reviewUrl: string | null },
  ownerWroteToThem: boolean,
): ReviewOfferReason | null {
  const marks = (f.extracted ?? {}) as {
    job_done?: unknown;
    injection?: unknown;
    municipal?: unknown;
  };
  const address = f.customerAddress;
  return reviewOfferReason({
    category: f.category,
    needsOwner: f.needsOwner,
    needsOwnerManual: f.needsOwnerManual,
    complained: threadComplained(f) || (address != null && ctx.complained.has(address)),
    untrusted: marks.injection === true || marks.municipal === true,
    jobDone: marks.job_done === true,
    // "Not owed to me" also sets invoice_paid_at; only a real paid mark counts.
    invoicePaid:
      f.invoicePaidAt != null &&
      (f.invoicePaidSource === "owner" || f.invoicePaidSource === "auto"),
    customerAddress: address,
    senderAddress: f.senderAddress,
    ownerWroteToThem,
    reviewUrl: ctx.reviewUrl,
    recentReviewToAddress: address != null && ctx.recent.has(address),
  });
}

async function reviewReasons(
  workspaceId: string,
  facts: Facts[],
  now: Date,
): Promise<Map<string, ReviewOfferReason | null>> {
  const out = new Map<string, ReviewOfferReason | null>();
  if (facts.length === 0) return out;
  const [complained, recent, reviewUrl] = await Promise.all([
    complainedAddresses(workspaceId, now),
    recentReviewAddresses(workspaceId, now),
    reviewUrlOf(workspaceId),
  ]);
  const ctx = { complained, recent, reviewUrl };
  for (const f of facts) {
    // Everything but "has the owner written to them?" first, assuming they have: only the
    // few threads that pass need the lookup.
    const first = cheapReviewReason(f, ctx, true);
    if (first !== null) {
      out.set(f.id, first);
      continue;
    }
    const known = await knownCustomer(f.mailboxId, f.customerAddress, now);
    out.set(f.id, known ? null : cheapReviewReason(f, ctx, false));
  }
  return out;
}

function closingReason(f: Facts, on: boolean, now: Date): ClosingQuestionReason | null {
  return closingQuestionReason(
    {
      featureOn: on,
      isQuoteThread: isQuoteThread(f),
      category: f.category,
      needsOwner: f.needsOwner || f.needsOwnerManual,
      complained: threadComplained(f),
      outcome: f.quoteOutcome,
      sentNudges: f.sentNudges,
      lastInboundAt: f.lastInboundAt,
      lastOutboundAt: f.lastOutboundAt,
      askedBefore: f.askedClosing,
    },
    now,
  );
}

/** The offers for each of these threads (only the workspace's own). Read-only: none. */
export async function threadOffers(
  workspaceId: string,
  threadIds: string[],
  now: Date = new Date(),
): Promise<Map<string, ThreadOffers>> {
  const out = new Map<string, ThreadOffers>();
  const ws = await workspaceOf(workspaceId);
  if (!ws || !jobsAllowed(ws, now)) return out;
  const facts = await threadFacts(workspaceId, [...new Set(threadIds)]);
  const review = await reviewReasons(workspaceId, facts, now);
  const on = featureOn("closingQuestion");
  for (const f of facts) {
    // createDraftForThread would stop at "a draft is already waiting" or "no text": the
    // server rule is unchanged, the button just doesn't show for a tap that can only fail.
    const draftable = !f.hasPending && f.newestHasText;
    out.set(f.id, {
      review: draftable && review.get(f.id) === null,
      closingQuestion: draftable && closingReason(f, on, now) === null,
    });
  }
  return out;
}

/**
 * Why this thread can't get a review request right now, or null when it can. The same rules
 * as the "Ask for a review" button; `createDraftForThread` calls it before any model call.
 */
export async function reviewAllowed(
  workspaceId: string,
  threadId: string,
  now: Date = new Date(),
): Promise<ReviewOfferReason | "not_found" | null> {
  const [f] = await threadFacts(workspaceId, [threadId]);
  if (!f) return "not_found";
  return (await reviewReasons(workspaceId, [f], now)).get(f.id) ?? null;
}

/** Why the closing question can't be asked on this thread, or null when it can (plan #26). */
export async function closingQuestionAllowed(
  workspaceId: string,
  threadId: string,
  now: Date = new Date(),
): Promise<ClosingQuestionReason | "not_found" | null> {
  const [f] = await threadFacts(workspaceId, [threadId]);
  if (!f) return "not_found";
  return closingReason(f, featureOn("closingQuestion"), now);
}
