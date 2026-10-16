import "server-only";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { callStructured } from "@/ai/client";
import { checkDraft, hasLink, REGENERATE_ON, type CheckResult } from "@/ai/draft-checks";
import {
  REVISE_INSTRUCTIONS,
  REVISE_PROMPT_VERSION,
  reviseTask,
  TWEAKS,
  type Tweak,
} from "@/ai/prompts/revise.v1";
import { MAX_REVISIONS_PER_DRAFT, UNDO_WINDOW_SECONDS } from "@/config/drafting";
import { hasUnfilledGap } from "@/ai/gaps";
import {
  conversationBlock,
  DRAFT_INSTRUCTIONS,
  DRAFT_PROMPT_VERSION,
  draftSchema,
  workspaceBlock,
  type WorkspaceContext,
} from "@/ai/prompts/draft.v5";
import { prepareBody } from "@/ai/classify";
import {
  FOLLOWUP_INSTRUCTIONS,
  FOLLOWUP_PROMPT_VERSION,
  followupTask,
} from "@/ai/prompts/followup.v3";
import {
  closingQuestionTask,
  depositTask,
  PURPOSE_PROMPT_VERSION,
  reviewRequestTask,
} from "@/ai/prompts/purpose.v1";
import {
  ensureDepositGap,
  isQuoteAcceptance,
  NO_PAYMENT_TERMS_FLAG,
  PURPOSE_FLAG_CONFIDENCE_CAP,
  REVIEW_LINK_MISSING_FLAG,
} from "@/ai/purpose";
import { AiCapReachedError, bumpUsageCounter } from "@/ai/usage";
import { featureOn } from "@/config/features";
import { activeNotes } from "./seasonal-notes";
import { db } from "@/db";
import {
  activityLog,
  businessProfiles,
  drafts,
  mailboxes,
  messages,
  threads,
  voiceProfiles,
  workspaces,
  type Draft,
  type DraftPurpose,
  type Mailbox,
} from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { MailboxAuthError, type MailboxReader, type MailboxWriter } from "@/mailbox/connector";
import { createGmailReader } from "@/mailbox/gmail/api";
import { buildReplyMime, replySubject, sameText, toGmailRaw } from "@/mailbox/mime";
import {
  canSend,
  effectiveStatus,
  jobsAllowed,
  ReadOnlyError,
  SendingBlockedError,
} from "./lifecycle";
import { batchEligible, firstLine } from "./batch-rules";
import { isInvoiceThread, paymentSaid } from "./money-rules";
import { quoteStopsNudges } from "./quote-rules";
import { BACK_ON_TOP_MS, isEmergency } from "./snooze-rules";
import { headerPickIds, toNeedsYouItem } from "./digest-rules";
import { asDate, notDraftMessage, sideEmailSql, waitingSinceSql } from "./thread-sql";
import { closingQuestionAllowed, recentReviewAddresses, reviewAllowed } from "./offers";
import { lockReviewAddress } from "./review-lock";
import { markReconnectNeeded, recordSentMessage } from "./sync";

/** Categories we draft for without being asked. Complaints and noise never are. */
export const AUTO_DRAFT_CATEGORIES = [
  "quote_request",
  "customer_question",
  "scheduling",
  "invoice_payment",
  "supplier_vendor",
] as const;
/** Quiet threads in these categories get nudged. */
export const FOLLOWUP_CATEGORIES = ["quote_request", "invoice_payment"] as const;
/** Nudges per thread, ever. A guardrail, not a setting. */
export const MAX_FOLLOWUPS = 2;
const CONVERSATION_MESSAGES = 6;
const PER_MESSAGE_CHARS = 3_000;

export type DraftDeps = { writerFor?: (m: Mailbox) => MailboxWriter; now?: () => Date };

export const defaultWriter = (m: Mailbox) =>
  createGmailReader({ refreshToken: decryptSecret(m.encryptedRefreshToken) });

export type CreateOutcome =
  | { status: "created"; draftId: string }
  | {
      status: "skipped";
      reason:
        | "not_found"
        | "mailbox_inactive"
        | "noise"
        | "needs_owner"
        | "category"
        | "already_pending"
        | "owner_replied_last"
        | "no_text"
        | "capped"
        | "model_failed"
        | "read_only"
        | "followup_not_allowed"
        | "customer_replied"
        | "followup_cap"
        | "untrusted"
        | "municipal"
        // Purpose drafts (plan #26 #28 #29). S6 adds the per-purpose eligibility reasons.
        | "purpose_not_allowed"
        | "feature_off"
        | "already_asked"
        | "no_review_link"
        | "review_recent"
        | "complaint"
        | "not_eligible";
    }
  | { status: "reconnect_needed" };

async function loadThread(threadId: string) {
  const [row] = await db()
    .select({ thread: threads, mailbox: mailboxes, workspace: workspaces })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(eq(threads.id, threadId));
  return row;
}

/** Purposes only the owner's tap may ask for. Deposit is never asked for: it's derived (#28). */
export const OWNER_PURPOSES = ["review_request", "closing_question"] as const;
export type OwnerPurpose = (typeof OWNER_PURPOSES)[number];

/** Nudges actually sent in this thread (from the app or from Gmail). Discarded ones don't count. */
export async function countSentFollowups(threadId: string): Promise<number> {
  const rows = await db()
    .select({ id: drafts.id })
    .from(drafts)
    .where(
      and(
        eq(drafts.threadId, threadId),
        eq(drafts.kind, "followup"),
        inArray(drafts.status, ["sent", "edited_and_sent"]),
      ),
    );
  return rows.length;
}

/**
 * A deposit, review request or closing question went out on this thread (A3). After that
 * the thread is never nudged: the customer accepted, was thanked, or was asked once already.
 * A deposit note only stops the QUOTE's nudges: once the thread is about an invoice
 * (`invoiceThread`, isInvoiceThread), the won job's invoice is still chased.
 */
export async function purposeSentOn(
  threadId: string,
  opts: { invoiceThread?: boolean } = {},
): Promise<boolean> {
  const [row] = await db()
    .select({ id: drafts.id })
    .from(drafts)
    .where(
      and(
        eq(drafts.threadId, threadId),
        isNotNull(drafts.purpose),
        opts.invoiceThread ? sql`${drafts.purpose} <> 'deposit'` : undefined,
        inArray(drafts.status, ["sent", "edited_and_sent"]),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Why a quiet thread is never nudged, apart from the outcome and paid marks: the customer's
 * newest email said they paid (we may not have marked it — a deposit is not the job being
 * paid — but they aren't chased right after paying), or a purpose note went out (A3).
 */
async function nudgeBlocked(thread: {
  id: string;
  category: string | null;
  extracted: unknown;
}): Promise<boolean> {
  if (paymentSaid(thread.extracted) === "paid") return true;
  return purposeSentOn(thread.id, { invoiceThread: isInvoiceThread(thread) });
}

/**
 * A deposit note was drafted on this thread and the owner saw it through: sent, still
 * waiting, or discarded (the owner may have sent the deposit details from Gmail themselves).
 * A customer who writes again ("Great. When can you start?") often reads as another
 * acceptance; they get an ordinary reply, never a second request for the deposit. An
 * `expired` one doesn't count: it went stale because the customer wrote again before the
 * owner tapped anything, so the deposit request is drafted afresh.
 */
async function depositAlreadyOn(threadId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: drafts.id })
    .from(drafts)
    .where(
      and(
        eq(drafts.threadId, threadId),
        eq(drafts.purpose, "deposit"),
        inArray(drafts.status, ["pending", "sent", "edited_and_sent", "discarded"]),
      ),
    )
    .limit(1);
  return !!row;
}

export async function followupSettings(workspaceId: string) {
  const [p] = await db()
    .select({ enabled: businessProfiles.followupsEnabled, days: businessProfiles.followupDays })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  return { enabled: p?.enabled ?? true, days: p?.days ?? 3 };
}

/** The customer in a thread: whoever most recently wrote in. */
async function customerOf(threadId: string) {
  const [m] = await db()
    .select({ name: messages.fromName, address: messages.fromAddress })
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.direction, "in")))
    .orderBy(desc(messages.sentAt))
    .limit(1);
  return m ?? null;
}

type DraftContext = WorkspaceContext & { reviewUrl: string | null };

/**
 * The terms check for deposit and review notes (A4). Percentages, amounts, ways to pay and
 * anything offered must come from the owner: their written terms, or what they wrote this customer
 * themselves. Never from the customer's emails — "can I pay by Venmo?" isn't a yes.
 * A review request has no terms to draw on: it never mentions payment or offers anything.
 */
function termsCheck(
  purpose: DraftPurpose | null,
  ctx: DraftContext,
  owner: { wrote: (string | null)[]; terms?: (string | null)[] },
) {
  if (purpose !== "deposit" && purpose !== "review_request") return {};
  const join = (xs: (string | null | undefined)[]) => xs.filter(Boolean).join("\n");
  return {
    checkTerms: true,
    termsSource:
      purpose === "deposit"
        ? join([
            ctx.paymentTerms,
            ctx.policies,
            ctx.pricingNotes,
            ...ctx.seasonalNotes.map((n) => n.text),
            ...(owner.terms ?? []),
          ])
        : "",
    ownerWrote: purpose === "deposit" ? join(owner.wrote) : "",
    review: purpose === "review_request" ? { url: ctx.reviewUrl } : undefined,
  };
}

/**
 * What a purpose note needs after every model call — a new draft or a tweak alike, so a
 * rewrite can never drop it: a deposit with no payment terms always carries the deposit gap
 * (the send gate holds until it's filled), and a review request must still carry the link.
 */
function purposeGuards(purpose: DraftPurpose | null, body: string, ctx: DraftContext) {
  const flags: string[] = [];
  if (purpose === "deposit" && !ctx.paymentTerms?.trim()) {
    body = ensureDepositGap(body);
    flags.push(NO_PAYMENT_TERMS_FLAG);
  }
  if (purpose === "review_request" && !(ctx.reviewUrl && hasLink(body, ctx.reviewUrl))) {
    flags.push(REVIEW_LINK_MISSING_FLAG);
  }
  return { body, flags };
}

/**
 * Flags and confidence (0–100) for a finished draft. Purpose flags go first, so the cut to six
 * can't drop them, and they cap confidence on their own (A6).
 */
function scoreDraft(
  result: { flags: string[]; confidence: number },
  checks: CheckResult,
  purposeFlags: string[],
) {
  const flags = [
    ...new Set([
      ...purposeFlags,
      ...result.flags.map((f) => f.trim()).filter(Boolean),
      ...checks.flags,
    ]),
  ].slice(0, 6);
  const confidence = Math.round(
    Math.max(
      0,
      Math.min(
        1,
        result.confidence,
        checks.confidenceCap,
        purposeFlags.length ? PURPOSE_FLAG_CONFIDENCE_CAP : 1,
      ),
    ) * 100,
  );
  return { flags, confidence };
}

/**
 * Everything the drafter knows about the business. `reviewUrl` rides along for the review
 * request task only; it is never part of the cached business block.
 */
export async function workspaceContext(
  workspaceId: string,
  ws: { businessName: string | null; trade: string | null },
  now: Date = new Date(),
): Promise<DraftContext> {
  const [profile] = await db()
    .select()
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  const [voice] = await db()
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.workspaceId, workspaceId));
  const ctx: WorkspaceContext = {
    businessName: ws.businessName,
    trade: ws.trade,
    services: profile?.services ?? null,
    serviceArea: profile?.serviceArea ?? null,
    hours: profile?.hours ?? null,
    leadTime: profile?.leadTime ?? null,
    pricingNotes: profile?.pricingNotes ?? null,
    paymentTerms: profile?.paymentTerms ?? null,
    policies: profile?.policies ?? null,
    signature: profile?.signature ?? null,
    doNotPromise: profile?.doNotPromise ?? [],
    neverSay: profile?.neverSay ?? [],
    seasonalNotes: (await activeNotes(workspaceId, now)).map(({ text, endsOn }) => ({
      text,
      endsOn,
    })),
    voice:
      voice?.status === "ready"
        ? {
            summary: voice.summary,
            greetingStyle: voice.greetingStyle,
            signoffStyle: voice.signoffStyle,
            avgLengthWords: voice.avgLengthWords,
            formality: voice.formality,
            phrasesUsed: voice.phrasesUsed,
            phrasesAvoided: voice.phrasesAvoided,
            examples: voice.examples,
          }
        : null,
  };
  return { ...ctx, reviewUrl: profile?.reviewUrl ?? null };
}

/**
 * Write a reply for a thread and save it as a real Gmail draft in the right
 * conversation. `trigger: "auto"` follows the rules (never noise, complaints,
 * or anything that needs the owner); `trigger: "owner"` is the owner asking
 * from the Inbox, which can draft anything that has text to reply to.
 *
 * Purpose drafts (plan #26 #28 #29) are ordinary replies with `drafts.purpose` set: a
 * deposit draft is written, whatever the trigger, when the newest email accepts a quote
 * the owner gave; a review request or closing question only when the owner taps for one.
 */
export async function createDraftForThread(
  threadId: string,
  opts: DraftDeps & {
    /** auto: reply to new mail. owner: they asked. followup: nudge a quiet thread. */
    trigger: "auto" | "owner" | "followup";
    ownerNote?: string | null;
    /** Required when the owner triggers it: the thread must belong to them. */
    workspaceId?: string;
    /** A special note only the owner's tap may ask for. */
    purpose?: OwnerPurpose;
  } = { trigger: "auto" },
): Promise<CreateOutcome> {
  const now = opts.now?.() ?? new Date();
  const row = await loadThread(threadId);
  if (!row) return { status: "skipped", reason: "not_found" };
  if (opts.trigger === "owner" && row.workspace.id !== opts.workspaceId) {
    return { status: "skipped", reason: "not_found" };
  }
  const { thread, mailbox, workspace } = row;
  if (!jobsAllowed(workspace, now)) return { status: "skipped", reason: "read_only" };
  if (mailbox.status !== "active") return { status: "skipped", reason: "mailbox_inactive" };
  // Review requests and closing questions come from the owner's tap, never a job.
  if (
    opts.purpose !== undefined &&
    (opts.trigger !== "owner" || !(OWNER_PURPOSES as readonly string[]).includes(opts.purpose))
  ) {
    return { status: "skipped", reason: "purpose_not_allowed" };
  }
  // Plan #26 waits on Davi: off unless FEATURE_CLOSING_QUESTION is on.
  if (opts.purpose === "closing_question" && !featureOn("closingQuestion")) {
    return { status: "skipped", reason: "feature_off" };
  }
  // The same rules as the buttons, checked here before any model call whatever the screen
  // showed (plan #29 #26): never a complaint, a known customer with a finished job, once a
  // year per address; the closing question only after both nudges and a quiet week, once ever.
  if (opts.purpose === "review_request") {
    const why = await reviewAllowed(workspace.id, threadId, now);
    if (why) return { status: "skipped", reason: why };
  }
  if (opts.purpose === "closing_question") {
    const why = await closingQuestionAllowed(workspace.id, threadId, now);
    if (why) return { status: "skipped", reason: why };
  }

  const marks = (thread.extracted ?? {}) as { municipal?: boolean; injection?: boolean };
  // Only the owner's tap drafts for these (feature plan #17, #42) — never a job.
  if (opts.trigger !== "owner") {
    if (marks.injection) return { status: "skipped", reason: "untrusted" };
    if (marks.municipal) return { status: "skipped", reason: "municipal" };
  }
  if (opts.trigger === "auto") {
    if (thread.category === "noise") return { status: "skipped", reason: "noise" };
    if (thread.needsOwner) return { status: "skipped", reason: "needs_owner" };
    if (
      !AUTO_DRAFT_CATEGORIES.includes(thread.category as (typeof AUTO_DRAFT_CATEGORIES)[number])
    ) {
      return { status: "skipped", reason: "category" };
    }
  }
  const followup = opts.trigger === "followup";
  let nudgeNumber: 1 | 2 = 1;
  if (followup) {
    // Checked here, where the draft is made, whatever selected the thread.
    if (
      thread.needsOwner ||
      // A decided quote (lost / no answer, any source; won, unless it's now the job's
      // invoice) is never chased.
      quoteStopsNudges(thread) ||
      // Nor a paid invoice (the owner's mark or our guess) or one that isn't owed (#27).
      thread.invoicePaidAt != null ||
      !FOLLOWUP_CATEGORIES.includes(thread.category as (typeof FOLLOWUP_CATEGORIES)[number]) ||
      // Nor a thread where a deposit, review request or closing question went out (A3) —
      // a deposit only while it's a quote — or whose customer just said they paid.
      (await nudgeBlocked(thread))
    ) {
      return { status: "skipped", reason: "followup_not_allowed" };
    }
    const sentNudges = await countSentFollowups(threadId);
    if (sentNudges >= MAX_FOLLOWUPS) return { status: "skipped", reason: "followup_cap" };
    nudgeNumber = sentNudges === 0 ? 1 : 2;
  }
  // The owner's purpose, or deposit details when the newest email accepts the quote (#28, A5).
  // Only once per thread: after a deposit note was drafted (whatever became of it), or when
  // the email itself says it paid ("Sent the deposit, when can you start?"), it is answered
  // as an ordinary reply.
  const purpose: DraftPurpose | null =
    opts.purpose ??
    (!followup &&
    isQuoteAcceptance(thread) &&
    paymentSaid(thread.extracted) === null &&
    !(await depositAlreadyOn(threadId))
      ? "deposit"
      : null);

  const [pending] = await db()
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(eq(drafts.threadId, threadId), eq(drafts.status, "pending")));
  if (pending) return { status: "skipped", reason: "already_pending" };

  // A nudge or closing question follows the owner's own last message; a review request
  // may follow either; everything else answers the customer.
  const afterOwner = followup || purpose === "closing_question";
  // An unsent Gmail draft is not part of the conversation: never "the owner wrote", never
  // text for the model or the checks, never what a nudge is threaded to (notDraftMessage).
  // For a nudge or closing question, neither is a side conversation (a forward to the crew
  // and the crew's reply, `sideEmailSql`): the same "who wrote last" as the follow-up scan,
  // so a thread it picks isn't skipped here, and the note is threaded to — and only shows
  // the model — the conversation with the customer.
  const conversation = afterOwner
    ? and(eq(messages.threadId, threadId), notDraftMessage(), sql`not ${sideEmailSql("messages")}`)
    : and(eq(messages.threadId, threadId), notDraftMessage());
  const recent = (
    await db()
      .select()
      .from(messages)
      .where(conversation)
      .orderBy(desc(messages.sentAt))
      .limit(CONVERSATION_MESSAGES)
  ).reverse();
  const last = recent.at(-1);
  if (!last) return { status: "skipped", reason: "no_text" };
  if (afterOwner && last.direction !== "out")
    return { status: "skipped", reason: "customer_replied" };
  if (!afterOwner && purpose !== "review_request" && last.direction !== "in")
    return { status: "skipped", reason: "owner_replied_last" };
  // Who the reply goes to: the customer — whoever last wrote in.
  const customer =
    last.direction !== "in"
      ? (
          await db()
            .select()
            .from(messages)
            .where(and(conversation, eq(messages.direction, "in")))
            .orderBy(desc(messages.sentAt))
            .limit(1)
        )[0]
      : last;
  if (!customer) return { status: "skipped", reason: "no_text" };
  const withText = recent
    .map((m) => ({
      m,
      text: prepareBody(m.bodyText ?? m.snippet ?? "").slice(0, PER_MESSAGE_CHARS),
    }))
    .filter((x) => x.text.length > 0);
  if (!withText.some((x) => x.m.id === last.id)) return { status: "skipped", reason: "no_text" };

  const ctx = await workspaceContext(workspace.id, workspace, now);
  // Nothing to ask with: never call the model for a review request without the link.
  if (purpose === "review_request" && !ctx.reviewUrl)
    return { status: "skipped", reason: "no_review_link" };
  const daysQuiet = Math.max(1, Math.round((now.getTime() - last.sentAt.getTime()) / 86_400_000));
  const wsBlock = workspaceBlock(ctx);
  const convo = conversationBlock({
    subject: thread.subject,
    category: thread.category,
    summary: thread.summary,
    extracted: thread.extracted,
    ownerNote: opts.ownerNote,
    task: followup
      ? followupTask({ nudgeNumber, daysQuiet })
      : purpose === "deposit"
        ? depositTask({ paymentTerms: ctx.paymentTerms })
        : purpose === "review_request"
          ? reviewRequestTask({ reviewUrl: ctx.reviewUrl! })
          : purpose === "closing_question"
            ? closingQuestionTask({ daysQuiet })
            : undefined,
    messages: withText.map(({ m, text }) => ({
      from: m.direction === "out" ? mailbox.email : (m.fromName ?? m.fromAddress ?? "customer"),
      direction: m.direction,
      sentAt: m.sentAt,
      body: text,
    })),
  });

  // What the draft may draw facts from, and what it must never say.
  const checkContext = {
    sourceText: [
      withText.map((x) => x.text).join("\n"),
      ctx.pricingNotes,
      ctx.hours,
      ctx.leadTime,
      ctx.policies,
      ctx.paymentTerms,
      ...ctx.seasonalNotes.map((n) => n.text),
    ]
      .filter(Boolean)
      .join("\n"),
    doNotPromise: ctx.doNotPromise,
    phrasesAvoided: ctx.voice?.phrasesAvoided ?? [],
    neverSay: ctx.neverSay,
    // Deposit and review notes: no percentage, way to pay or incentive the owner never set (A4).
    ...termsCheck(purpose, ctx, {
      wrote: withText.filter((x) => x.m.direction === "out").map((x) => x.text),
    }),
  };
  const promptVersion = followup
    ? FOLLOWUP_PROMPT_VERSION
    : purpose
      ? `${DRAFT_PROMPT_VERSION}+${PURPOSE_PROMPT_VERSION}`
      : DRAFT_PROMPT_VERSION;

  let result;
  try {
    const request = {
      workspaceId: workspace.id,
      role: "draft" as const,
      promptVersion,
      maxTokens: 2048,
      effort: "medium" as const,
      system: [
        { text: followup ? FOLLOWUP_INSTRUCTIONS : DRAFT_INSTRUCTIONS, cache: false },
        { text: wsBlock, cache: true },
      ],
      user: convo,
      schema: draftSchema,
      now,
    };
    result = (await callStructured(request)) ?? (await callStructured(request));
    if (result?.body.trim()) {
      // Something the owner explicitly banned slipped in: one fresh attempt, then flag (plan #23).
      const first = checkDraft(result.body.trim(), checkContext);
      if (first.hits.some((h) => REGENERATE_ON.includes(h))) {
        const retry = await callStructured({
          ...request,
          user: `${convo}\n\nYour last attempt broke the owner's rules: ${first.flags.join(" ")} Write it again without that.`,
        });
        if (retry?.body.trim()) result = retry;
      }
    }
  } catch (err) {
    if (err instanceof AiCapReachedError) return { status: "skipped", reason: "capped" };
    throw err;
  }
  if (!result || !result.body.trim()) return { status: "skipped", reason: "model_failed" };

  // What the owner must sort before a purpose note can go (A6).
  const { body, flags: purposeFlags } = purposeGuards(purpose, result.body.trim(), ctx);
  const { flags, confidence } = scoreDraft(result, checkDraft(body, checkContext), purposeFlags);

  const to = customer.fromAddress;
  if (!to) return { status: "skipped", reason: "no_text" };
  const subject = replySubject(last.subject ?? thread.subject);
  const writer = (opts.writerFor ?? defaultWriter)(mailbox);

  let created: { draftId: string; messageId: string };
  try {
    created = await writer.createDraft({
      threadId: thread.gmailThreadId,
      raw: toGmailRaw(
        buildReplyMime({
          from: mailbox.email,
          to,
          subject,
          inReplyTo: last.rfc822MessageId,
          references: last.references,
          body,
        }),
      ),
    });
  } catch (err) {
    if (err instanceof MailboxAuthError) {
      await markReconnectNeeded(mailbox);
      return { status: "reconnect_needed" };
    }
    throw err;
  }

  const insertDraft = (q: Pick<ReturnType<typeof db>, "insert">) =>
    q
      .insert(drafts)
      .values({
        threadId,
        mailboxId: mailbox.id,
        replyToMessageId: last.id,
        // Purpose notes are replies, so they never count as a nudge (followup_count).
        kind: followup ? "followup" : "reply",
        purpose,
        gmailDraftId: created.draftId,
        gmailMessageId: created.messageId,
        toAddress: to,
        subject,
        body,
        originalBody: body,
        reason:
          result.reason.trim().slice(0, 200) || (followup ? "Follow-up nudge." : "Reply drafted."),
        flags,
        confidence,
        usedFacts: [...new Set(result.used_facts ?? [])],
        promptVersion,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: drafts.id });

  let row2: { id: string } | undefined;
  let reviewTaken = false;
  if (purpose === "review_request") {
    // One review request per address a year, even with two taps on two threads at once
    // (A16): the check and the insert run under a lock on this workspace + address.
    await db().transaction(async (tx) => {
      await lockReviewAddress(tx, workspace.id, to);
      if ((await recentReviewAddresses(workspace.id, now, tx)).has(to.toLowerCase())) {
        reviewTaken = true;
        return;
      }
      [row2] = await insertDraft(tx);
    });
  } else {
    [row2] = await insertDraft(db());
  }
  if (!row2) {
    // Lost a race with another run; don't leave an orphan in Gmail.
    await writer.deleteDraft(created.draftId);
    if (reviewTaken) return { status: "skipped", reason: "review_recent" };
    // The insert skips on any unique index: tell "asked once already" (the closing question's
    // own index, A7) apart from "a draft is already waiting".
    if (purpose === "closing_question") {
      const [asked] = await db()
        .select({ id: drafts.id })
        .from(drafts)
        .where(and(eq(drafts.threadId, threadId), eq(drafts.purpose, "closing_question")))
        .limit(1);
      if (asked) return { status: "skipped", reason: "already_asked" };
    }
    return { status: "skipped", reason: "already_pending" };
  }
  if (followup) {
    // The owner may have decided the quote (or marked the invoice paid) while the model was
    // writing. Checked after the insert: setQuoteOutcome / setInvoicePaid write their mark
    // before they look for a waiting nudge, so either they find this row, or this re-read
    // sees the mark. Whoever removes the row removes the Gmail draft. Our own paid guess
    // lands here too: a nudge being written as it happens is simply dropped.
    const [fresh] = await db()
      .select({
        quoteOutcome: threads.quoteOutcome,
        category: threads.category,
        invoicePaidAt: threads.invoicePaidAt,
      })
      .from(threads)
      .where(eq(threads.id, threadId));
    if (fresh && (quoteStopsNudges(fresh) || fresh.invoicePaidAt != null)) {
      const gone = await db()
        .delete(drafts)
        .where(and(eq(drafts.id, row2.id), eq(drafts.status, "pending")))
        .returning({ id: drafts.id });
      if (gone.length) await writer.deleteDraft(created.draftId);
      return { status: "skipped", reason: "followup_not_allowed" };
    }
  }

  await bumpUsageCounter(workspace.id, "draftsCreated", now);
  await db()
    .insert(activityLog)
    .values({
      workspaceId: workspace.id,
      actor: "squared_away",
      action:
        purpose === "closing_question"
          ? "closing_question"
          : followup
            ? "followup_drafted"
            : "draft_created",
      threadId,
      detail: {
        draftId: row2.id,
        trigger: opts.trigger,
        confidence,
        flagCount: flags.length,
        ...(followup ? { nudgeNumber } : {}),
        ...(purpose ? { purpose } : {}),
      },
    });
  return { status: "created", draftId: row2.id };
}

async function loadOwnedDraft(workspaceId: string, draftId: string) {
  const [row] = await db()
    .select({ draft: drafts, mailbox: mailboxes, thread: threads, workspace: workspaces })
    .from(drafts)
    .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(and(eq(drafts.id, draftId), eq(mailboxes.workspaceId, workspaceId)));
  return row;
}

function mimeFor(
  d: Draft,
  mailbox: Mailbox,
  body: string,
  replyTo: { rfc822MessageId: string | null; references: string | null } | undefined,
) {
  return toGmailRaw(
    buildReplyMime({
      from: mailbox.email,
      to: d.toAddress,
      subject: d.subject,
      inReplyTo: replyTo?.rfc822MessageId,
      references: replyTo?.references,
      body,
    }),
  );
}

async function replyToHeaders(d: Draft) {
  if (!d.replyToMessageId) return undefined;
  const [m] = await db()
    .select({ rfc822MessageId: messages.rfc822MessageId, references: messages.references })
    .from(messages)
    .where(eq(messages.id, d.replyToMessageId));
  return m;
}

export type SendOutcome =
  | { status: "sent"; edited: boolean; toName: string | null }
  | { status: "blocked"; reason: string }
  | { status: "changed_in_gmail" }
  | { status: "deleted_in_gmail" }
  | { status: "gaps_unfilled" }
  | { status: "already_sending" }
  | { status: "not_found" }
  | { status: "reconnect_needed" };

/**
 * Send a pending draft — the only way anything leaves the owner's inbox.
 * Order matters: lifecycle gate first (no Google call at all when blocked),
 * then reconcile against Gmail so we never send text the owner hasn't seen.
 * `editedBody` is the text in front of the owner when they tapped Send.
 */
export async function sendDraft(
  workspaceId: string,
  draftId: string,
  opts: DraftDeps & {
    editedBody?: string;
    /** Who pressed send: the owner, or autopilot after its checks and grace window. */
    by?: "owner" | "autopilot";
    /** The undo window has ended and this caller holds the claim (deliverQueuedSend). */
    queued?: boolean;
  } = {},
): Promise<SendOutcome> {
  const now = opts.now?.() ?? new Date();
  const row = await loadOwnedDraft(workspaceId, draftId);
  if (!row || row.draft.status !== "pending" || !row.draft.gmailDraftId)
    return { status: "not_found" };
  const { draft, mailbox, thread, workspace } = row;
  // A draft in its undo window only leaves through the job that claimed it (plan #7).
  if (opts.queued ? !draft.sendAfter : draft.sendAfter) {
    return opts.queued ? { status: "not_found" } : { status: "already_sending" };
  }
  if (!canSend(workspace, now)) throw new SendingBlockedError(effectiveStatus(workspace, now));
  if (mailbox.status !== "active") return { status: "reconnect_needed" };
  // A reply with a {{gap}} still in it never leaves (plan #2) — checked before any Gmail call.
  if (hasUnfilledGap(opts.editedBody ?? draft.body ?? "")) return { status: "gaps_unfilled" };

  const writer = (opts.writerFor ?? defaultWriter)(mailbox);
  try {
    const remote = await writer.getDraft(draft.gmailDraftId!);
    if (!remote) {
      await closeDraft(
        draft,
        workspaceId,
        "discarded",
        "You deleted or sent this draft in Gmail.",
        now,
      );
      return { status: "deleted_in_gmail" };
    }
    if (!sameText(remote.bodyText, draft.body)) {
      // Changed in Gmail since the owner last saw it. Show them the new text; don't send blind.
      await db()
        .update(drafts)
        .set({ body: remote.bodyText, autoSendAt: null })
        .where(eq(drafts.id, draft.id));
      return { status: "changed_in_gmail" };
    }

    let body = draft.body ?? "";
    if (opts.editedBody !== undefined && !sameText(opts.editedBody, body)) {
      body = opts.editedBody.trim();
      await writer.updateDraft(draft.gmailDraftId!, {
        threadId: thread.gmailThreadId,
        raw: mimeFor(draft, mailbox, body, await replyToHeaders(draft)),
      });
    }

    const sent = await writer.sendDraft(draft.gmailDraftId!);
    const edited = !sameText(body, draft.originalBody);
    await db()
      .update(drafts)
      .set({
        status: edited ? "edited_and_sent" : "sent",
        body,
        decidedAt: now,
        sentGmailMessageId: sent.messageId,
        sendAfter: null,
        sendClaimedAt: null,
      })
      .where(eq(drafts.id, draft.id));
    await db()
      .update(threads)
      .set({
        needsOwner: false,
        needsOwnerManual: false,
        needsOwnerReason: null,
        awaitingReplySince: now,
        ...(draft.kind === "followup" ? { followupCount: sql`${threads.followupCount} + 1` } : {}),
      })
      .where(eq(threads.id, thread.id));
    await bumpUsageCounter(workspaceId, "emailsSent", now);
    await db()
      .insert(activityLog)
      .values({
        workspaceId,
        actor: opts.by === "autopilot" ? "squared_away" : "owner",
        action: "reply_sent",
        threadId: thread.id,
        detail: {
          draftId: draft.id,
          editedByOwner: edited,
          kind: draft.kind,
          gmailMessageId: sent.messageId,
          ...(opts.queued ? { undoWindowSec: UNDO_WINDOW_SECONDS } : {}),
          ...(opts.by === "autopilot" ? { autopilot: true } : {}),
        },
      });
    // Last, after the record of the send: storing the sent email is a nice-to-have (Gmail
    // reads can retry for a while), the activity row is what Activity and /record rely on.
    await recordSent(mailbox, writer, sent, now);
    return { status: "sent", edited, toName: (await customerOf(thread.id))?.name ?? null };
  } catch (err) {
    if (err instanceof MailboxAuthError) {
      await markReconnectNeeded(mailbox);
      return { status: "reconnect_needed" };
    }
    throw err;
  }
}

/**
 * Store the email a send just made as the owner's mail, now. How Gmail's history reports a sent
 * draft (a new message, or the draft's own id relabelled SENT) then doesn't matter for app
 * sends. The Gmail client reads as well as writes; a writer that can't read (tests) skips this.
 * Best effort: it's already sent, and the next sync picks the message up anyway.
 */
async function recordSent(
  mailbox: Mailbox,
  writer: MailboxWriter,
  sent: { messageId: string; threadId: string },
  now: Date,
) {
  const reader = writer as Partial<Pick<MailboxReader, "getMessage">>;
  if (typeof reader.getMessage !== "function") return;
  try {
    await recordSentMessage(
      mailbox,
      { getMessage: reader.getMessage.bind(writer) },
      { id: sent.messageId, threadId: sent.threadId },
      now,
    );
  } catch (err) {
    console.error("sent_message_record_failed", {
      mailboxId: mailbox.id,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

/**
 * A tap that lost a race: "already sending" only if another tap really did start the undo
 * window; anything else (closed, expired, discarded) is "not found" — never shown as sent.
 */
async function whyNotQueued(draftId: string): Promise<{ status: "already_sending" | "not_found" }> {
  const [row] = await db()
    .select({ status: drafts.status, sendAfter: drafts.sendAfter })
    .from(drafts)
    .where(eq(drafts.id, draftId));
  const sending =
    (row?.status === "pending" && row.sendAfter != null) ||
    row?.status === "sent" ||
    row?.status === "edited_and_sent";
  return sending ? { status: "already_sending" } : { status: "not_found" };
}

export type QueueSendOutcome =
  | { status: "queued"; sendAfter: Date }
  | { status: "changed_since_seen" }
  | { status: "intent_expired" }
  | Exclude<SendOutcome, { status: "sent" }>;

/** Plan #10: an okay given with no signal counts for this long, no longer. */
export const OFFLINE_INTENT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** The fingerprint of a draft's text, as the phone saw it (sha-256, hex). */
export const bodyHash = (body: string) => createHash("sha256").update(body, "utf8").digest("hex");

/**
 * Plan #7: the owner tapped Send reply. Every check a send makes runs now (so
 * a blocked account still gets its 403 and nothing unchecked waits), the text
 * they approved is written to the Gmail draft, and it goes after the undo
 * window — via deliverQueuedSend, which checks everything again then.
 */
export async function queueSend(
  workspaceId: string,
  draftId: string,
  opts: DraftDeps & {
    editedBody?: string;
    device?: "phone" | "computer";
    /**
     * Plan #10, an okay given offline: the text the owner saw (its hash) and
     * when they tapped. If the draft changed since, or it was over 12 hours
     * ago, nothing is sent and they're told.
     */
    offline?: { seenHash: string; okayedAt: Date };
  } = {},
): Promise<QueueSendOutcome> {
  const now = opts.now?.() ?? new Date();
  const row = await loadOwnedDraft(workspaceId, draftId);
  if (!row || row.draft.status !== "pending" || !row.draft.gmailDraftId)
    return { status: "not_found" };
  const { draft, mailbox, thread, workspace } = row;
  if (draft.sendAfter) return { status: "already_sending" };
  if (!canSend(workspace, now)) throw new SendingBlockedError(effectiveStatus(workspace, now));
  if (opts.offline) {
    const age = now.getTime() - opts.offline.okayedAt.getTime();
    if (!(age >= -5 * 60_000 && age <= OFFLINE_INTENT_MAX_AGE_MS))
      return { status: "intent_expired" };
    if (opts.offline.seenHash !== bodyHash(draft.body ?? ""))
      return { status: "changed_since_seen" };
  }
  if (mailbox.status !== "active") return { status: "reconnect_needed" };
  if (hasUnfilledGap(opts.editedBody ?? draft.body ?? "")) return { status: "gaps_unfilled" };

  const writer = (opts.writerFor ?? defaultWriter)(mailbox);
  let body = draft.body ?? "";
  // Everything below runs while the row may change under us (another device closing the
  // nudge, say), so each write only lands on a draft that is still waiting for this tap.
  const stillWaiting = and(
    eq(drafts.id, draft.id),
    eq(drafts.status, "pending"),
    isNull(drafts.sendAfter),
  );
  try {
    const remote = await writer.getDraft(draft.gmailDraftId!);
    if (!remote) {
      const [closed] = await db()
        .update(drafts)
        .set({
          status: "discarded",
          closedNote: "You deleted or sent this draft in Gmail.",
          decidedAt: now,
        })
        .where(stillWaiting)
        .returning({ id: drafts.id });
      if (!closed) return await whyNotQueued(draft.id);
      await logClosed(draft, workspaceId, "discarded", "squared_away");
      return { status: "deleted_in_gmail" };
    }
    if (!sameText(remote.bodyText, draft.body)) {
      const [taken] = await db()
        .update(drafts)
        .set({ body: remote.bodyText, autoSendAt: null })
        .where(stillWaiting)
        .returning({ id: drafts.id });
      if (!taken) return await whyNotQueued(draft.id);
      return { status: "changed_in_gmail" };
    }
    if (opts.editedBody !== undefined && !sameText(opts.editedBody, body)) {
      body = opts.editedBody.trim();
      await writer.updateDraft(draft.gmailDraftId!, {
        threadId: thread.gmailThreadId,
        raw: mimeFor(draft, mailbox, body, await replyToHeaders(draft)),
      });
    }
  } catch (err) {
    if (err instanceof MailboxAuthError) {
      await markReconnectNeeded(mailbox);
      return { status: "reconnect_needed" };
    }
    throw err;
  }

  const sendAfter = new Date(now.getTime() + UNDO_WINDOW_SECONDS * 1000);
  const queued = await db()
    .update(drafts)
    .set({ body, sendAfter, sendClaimedAt: null, autoSendAt: null })
    .where(stillWaiting)
    .returning({ id: drafts.id });
  // Two taps at once: only the first starts a window. Anything else that got there first
  // (the nudge closed on another device) means nothing is going out, and the owner is told so.
  if (!queued.length) return await whyNotQueued(draft.id);
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "owner",
      action: "send_approved",
      threadId: thread.id,
      // Content-free: what the proof-of-okay record (#41) shows.
      detail: {
        draftId: draft.id,
        device: opts.device ?? "unknown",
        undoWindowSec: UNDO_WINDOW_SECONDS,
        editedByOwner: !sameText(body, draft.originalBody),
        ...(opts.offline ? { offline: true } : {}),
      },
    });
  return { status: "queued", sendAfter };
}

/** Undo inside the window: back to the queue, unchanged. False once the send has started. */
export async function undoSend(workspaceId: string, draftId: string): Promise<boolean> {
  const undone = await db()
    .update(drafts)
    .set({ sendAfter: null })
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.status, "pending"),
        isNotNull(drafts.sendAfter),
        isNull(drafts.sendClaimedAt),
        inArray(
          drafts.mailboxId,
          db()
            .select({ id: mailboxes.id })
            .from(mailboxes)
            .where(eq(mailboxes.workspaceId, workspaceId)),
        ),
      ),
    )
    .returning({ threadId: drafts.threadId });
  if (!undone.length) return false;
  await db().insert(activityLog).values({
    workspaceId,
    actor: "owner",
    action: "send_undone",
    threadId: undone[0]!.threadId,
    detail: { draftId },
  });
  return true;
}

/** A claim older than this belongs to a run that died; another may take it. */
const SEND_CLAIM_LEASE_MS = 2 * 60_000;

export type DeliverResult =
  { status: "sent" } | { status: "not_due" } | { status: "stopped"; why: string };

/**
 * The undo window is over: claim the draft (only one runner ever can), run the
 * whole send — gate included, since the account can change in 20 seconds —
 * and send. Anything that stops it puts the draft back in the queue.
 */
export async function deliverQueuedSend(
  draftId: string,
  opts: DraftDeps = {},
): Promise<DeliverResult> {
  const now = opts.now?.() ?? new Date();
  const [claimed] = await db()
    .update(drafts)
    .set({ sendClaimedAt: now })
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.status, "pending"),
        isNotNull(drafts.sendAfter),
        lte(drafts.sendAfter, now),
        or(
          isNull(drafts.sendClaimedAt),
          lt(drafts.sendClaimedAt, new Date(now.getTime() - SEND_CLAIM_LEASE_MS)),
        ),
      ),
    )
    .returning({ mailboxId: drafts.mailboxId, threadId: drafts.threadId });
  if (!claimed) return { status: "not_due" };
  const [box] = await db()
    .select({ workspaceId: mailboxes.workspaceId })
    .from(mailboxes)
    .where(eq(mailboxes.id, claimed.mailboxId));
  const workspaceId = box!.workspaceId;

  let why: string;
  try {
    const outcome = await sendDraft(workspaceId, draftId, { ...opts, queued: true });
    if (outcome.status === "sent") return { status: "sent" };
    why = outcome.status;
  } catch (err) {
    if (!(err instanceof SendingBlockedError)) throw err; // the claim lapses; a retry takes it
    why = "blocked";
  }
  await db()
    .update(drafts)
    .set({ sendAfter: null, sendClaimedAt: null })
    .where(and(eq(drafts.id, draftId), eq(drafts.status, "pending")));
  await db().insert(activityLog).values({
    workspaceId,
    actor: "squared_away",
    action: "send_stopped",
    threadId: claimed.threadId,
    detail: { draftId, why },
  });
  return { status: "stopped", why };
}

/** Backstop for lost events: sends whose window ended a minute ago and nobody holds. */
export async function overdueQueuedSends(now: Date = new Date()): Promise<string[]> {
  const rows = await db()
    .select({ id: drafts.id })
    .from(drafts)
    .where(
      and(
        eq(drafts.status, "pending"),
        isNotNull(drafts.sendAfter),
        lte(drafts.sendAfter, new Date(now.getTime() - 60_000)),
        or(
          isNull(drafts.sendClaimedAt),
          lt(drafts.sendClaimedAt, new Date(now.getTime() - SEND_CLAIM_LEASE_MS)),
        ),
      ),
    )
    .limit(50);
  return rows.map((r) => r.id);
}

export type BatchRow = {
  draftId: string;
  to: string;
  category: string;
  firstLine: string;
};

/** Plan #5: drafts that may be sent together, freshly read and filtered by the rules. */
export async function batchCandidates(
  workspaceId: string,
  picked: readonly string[],
): Promise<BatchRow[]> {
  const rows = await db()
    .select({ draft: drafts, thread: threads })
    .from(drafts)
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        eq(mailboxes.status, "active"),
        eq(drafts.status, "pending"),
        isNull(drafts.sendAfter),
      ),
    )
    .orderBy(desc(threads.lastMessageAt));
  const out: BatchRow[] = [];
  for (const { draft, thread } of rows) {
    const extracted = (thread.extracted ?? {}) as {
      dollar_amounts?: number[];
      injection?: boolean;
      municipal?: boolean;
      accepts_quote?: boolean;
    };
    const ok = batchEligible(
      {
        category: thread.category,
        needsOwner: thread.needsOwner || thread.needsOwnerManual,
        flags: draft.flags,
        confidencePct: draft.confidence,
        body: draft.body ?? "",
        amountsInEmail: extracted.dollar_amounts ?? [],
        untrusted: extracted.injection === true || extracted.municipal === true,
        autopilotCounting: draft.autoSendAt !== null,
        acceptsQuote: extracted.accepts_quote === true,
        purpose: draft.purpose ?? null,
      },
      picked,
    );
    if (!ok) continue;
    const who = await customerOf(thread.id);
    out.push({
      draftId: draft.id,
      to: who?.name || who?.address || draft.toAddress,
      category: thread.category!,
      firstLine: firstLine(draft.body ?? ""),
    });
  }
  return out;
}

/**
 * Plan #5 "Send N replies": each requested draft is re-checked against the
 * rules on fresh rows (IDs from the browser prove nothing), then goes through
 * queueSend — the one gate, its own undo window, its own log entry.
 */
export async function batchSend(
  workspaceId: string,
  draftIds: readonly string[],
  picked: readonly string[],
  opts: DraftDeps & { device?: "phone" | "computer" } = {},
): Promise<{ queued: { draftId: string; sendAfter: Date }[]; refused: number }> {
  const allowed = new Set((await batchCandidates(workspaceId, picked)).map((r) => r.draftId));
  const queued: { draftId: string; sendAfter: Date }[] = [];
  let refused = 0;
  for (const id of new Set(draftIds)) {
    if (!allowed.has(id)) {
      refused++;
      continue;
    }
    // A blocked account throws here, on the first one, before any Gmail call.
    const r = await queueSend(workspaceId, id, { ...opts });
    if (r.status === "queued") queued.push({ draftId: id, sendAfter: r.sendAfter });
    else refused++;
  }
  return { queued, refused };
}

/** Save the owner's edits to the Gmail draft without sending. */
export async function saveDraftEdit(
  workspaceId: string,
  draftId: string,
  body: string,
  opts: DraftDeps = {},
): Promise<"saved" | "not_found" | "deleted_in_gmail" | "reconnect_needed"> {
  const row = await loadOwnedDraft(workspaceId, draftId);
  if (!row || row.draft.status !== "pending" || !row.draft.gmailDraftId || row.draft.sendAfter)
    return "not_found";
  const { draft, mailbox, thread, workspace } = row;
  const now = opts.now?.() ?? new Date();
  if (!jobsAllowed(workspace, now)) throw new ReadOnlyError(effectiveStatus(workspace, now));
  const writer = (opts.writerFor ?? defaultWriter)(mailbox);
  try {
    const remote = await writer.getDraft(draft.gmailDraftId!);
    if (!remote) {
      await closeDraft(
        draft,
        workspaceId,
        "discarded",
        "You deleted or sent this draft in Gmail.",
        now,
      );
      return "deleted_in_gmail";
    }
    await writer.updateDraft(draft.gmailDraftId!, {
      threadId: thread.gmailThreadId,
      raw: mimeFor(draft, mailbox, body.trim(), await replyToHeaders(draft)),
    });
    // The owner touched it, so it waits for their tap — autopilot stands down.
    await db()
      .update(drafts)
      .set({ body: body.trim(), autoSendAt: null })
      .where(eq(drafts.id, draft.id));
    return "saved";
  } catch (err) {
    if (err instanceof MailboxAuthError) {
      await markReconnectNeeded(mailbox);
      return "reconnect_needed";
    }
    throw err;
  }
}

export type ReviseOutcome =
  | { status: "revised"; flags: string[] }
  | { status: "limit" }
  | { status: "model_failed" }
  | { status: "capped" }
  | { status: "deleted_in_gmail" }
  | { status: "reconnect_needed" }
  | { status: "not_found" };

/**
 * Quick tweaks and voice edits (plan #3, #4): rewrite a pending draft with the
 * same guardrails as a new one — the #43 checks run on the new text (a
 * tweak can't hide a problem the check would raise), an invented price or
 * date gets one more try, then a flag. The Gmail draft is updated; nothing is
 * sent. At most MAX_REVISIONS_PER_DRAFT per draft.
 */
export async function reviseDraft(
  workspaceId: string,
  draftId: string,
  change: { tweak: Tweak } | { spoken: string },
  opts: DraftDeps = {},
): Promise<ReviseOutcome> {
  const row = await loadOwnedDraft(workspaceId, draftId);
  if (!row || row.draft.status !== "pending" || !row.draft.gmailDraftId || row.draft.sendAfter)
    return { status: "not_found" };
  const { draft, mailbox, thread, workspace } = row;
  const now = opts.now?.() ?? new Date();
  if (!jobsAllowed(workspace, now)) throw new ReadOnlyError(effectiveStatus(workspace, now));
  if (mailbox.status !== "active") return { status: "reconnect_needed" };
  if (draft.revisions >= MAX_REVISIONS_PER_DRAFT) return { status: "limit" };

  const spoken = "spoken" in change ? change.spoken.trim().slice(0, 500) : null;
  const ask = spoken ?? TWEAKS[(change as { tweak: Tweak }).tweak].ask;

  const recent = (
    await db()
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.threadId, draft.threadId),
          lte(messages.sentAt, draft.createdAt),
          notDraftMessage(),
        ),
      )
      .orderBy(desc(messages.sentAt))
      .limit(CONVERSATION_MESSAGES)
  ).reverse();
  const withText = recent
    .map((m) => ({
      m,
      text: prepareBody(m.bodyText ?? m.snippet ?? "").slice(0, PER_MESSAGE_CHARS),
    }))
    .filter((x) => x.text.length > 0);
  const ctx = await workspaceContext(workspace.id, workspace, now);
  const checkContext = {
    sourceText: [
      withText.map((x) => x.text).join("\n"),
      ctx.pricingNotes,
      ctx.hours,
      ctx.leadTime,
      ctx.policies,
      ctx.paymentTerms,
      ...ctx.seasonalNotes.map((n) => n.text),
      // What the owner said counts as a fact they gave us (plan #4).
      spoken,
      // Facts already in a clean draft stay allowed. A flagged draft's text
      // doesn't count, so a tweak can never launder a flag away.
      (draft.flags ?? []).length === 0 ? draft.body : null,
    ]
      .filter(Boolean)
      .join("\n"),
    doNotPromise: ctx.doNotPromise,
    phrasesAvoided: ctx.voice?.phrasesAvoided ?? [],
    neverSay: ctx.neverSay,
    // A tweak on a deposit or review note keeps the terms check (A4): "friendlier" can't add
    // Venmo or "10% off". What the owner said, and a clean draft's text, are theirs.
    ...termsCheck(draft.purpose, ctx, {
      wrote: [
        ...withText.filter((x) => x.m.direction === "out").map((x) => x.text),
        (draft.flags ?? []).length === 0 ? draft.body : null,
      ],
      terms: [spoken],
    }),
  };
  const convo = conversationBlock({
    subject: thread.subject,
    category: thread.category,
    summary: thread.summary,
    extracted: thread.extracted,
    task: reviseTask(draft.body ?? "", ask, spoken !== null),
    messages: withText.map(({ m, text }) => ({
      from: m.direction === "out" ? mailbox.email : (m.fromName ?? m.fromAddress ?? "customer"),
      direction: m.direction,
      sentAt: m.sentAt,
      body: text,
    })),
  });
  const request = {
    workspaceId: workspace.id,
    role: "draft" as const,
    promptVersion: REVISE_PROMPT_VERSION,
    maxTokens: 2048,
    effort: "medium" as const,
    system: [
      { text: REVISE_INSTRUCTIONS, cache: false },
      { text: workspaceBlock(ctx), cache: true },
    ],
    user: convo,
    schema: draftSchema,
    now,
  };
  let result;
  try {
    result = (await callStructured(request)) ?? (await callStructured(request));
    if (result?.body.trim()) {
      const first = checkDraft(result.body.trim(), checkContext);
      if (first.hits.some((h) => REGENERATE_ON.includes(h))) {
        const retry = await callStructured({
          ...request,
          user: `${convo}\n\nYour last attempt broke the owner's rules: ${first.flags.join(" ")} Write it again without that.`,
        });
        if (retry?.body.trim()) result = retry;
      }
    }
  } catch (err) {
    if (err instanceof AiCapReachedError) return { status: "capped" };
    throw err;
  }
  if (!result || !result.body.trim()) return { status: "model_failed" };

  // The same purpose guards as a new draft: a tweak can't drop the deposit gap or the review
  // link, nor lift their flags and confidence cap.
  const { body, flags: purposeFlags } = purposeGuards(draft.purpose, result.body.trim(), ctx);
  const { flags, confidence } = scoreDraft(result, checkDraft(body, checkContext), purposeFlags);

  const writer = (opts.writerFor ?? defaultWriter)(mailbox);
  try {
    const remote = await writer.getDraft(draft.gmailDraftId!);
    if (!remote) {
      await closeDraft(
        draft,
        workspaceId,
        "discarded",
        "You deleted or sent this draft in Gmail.",
        now,
      );
      return { status: "deleted_in_gmail" };
    }
    await writer.updateDraft(draft.gmailDraftId!, {
      threadId: thread.gmailThreadId,
      raw: mimeFor(draft, mailbox, body, await replyToHeaders(draft)),
    });
  } catch (err) {
    if (err instanceof MailboxAuthError) {
      await markReconnectNeeded(mailbox);
      return { status: "reconnect_needed" };
    }
    throw err;
  }
  await db()
    .update(drafts)
    .set({
      body,
      flags,
      confidence,
      reason: result.reason.trim().slice(0, 200) || draft.reason,
      usedFacts: [...new Set(result.used_facts ?? [])],
      revisions: sql`${drafts.revisions} + 1`,
      // The owner changed it, so autopilot stands down.
      autoSendAt: null,
    })
    .where(eq(drafts.id, draft.id));
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "owner",
      action: "draft_revised",
      threadId: draft.threadId,
      // Content-free: which tweak, or that it was spoken — never the words.
      detail: {
        draftId: draft.id,
        via: spoken !== null ? "voice" : (change as { tweak: Tweak }).tweak,
      },
    });
  return { status: "revised", flags };
}

async function closeDraft(
  d: Pick<Draft, "id" | "threadId">,
  workspaceId: string,
  status: "discarded" | "expired" | "sent",
  note: string | null,
  now: Date,
  actor: "owner" | "squared_away" = "squared_away",
) {
  await db()
    .update(drafts)
    .set({ status, closedNote: note, decidedAt: now })
    .where(eq(drafts.id, d.id));
  await logClosed(d, workspaceId, status, actor);
}

async function logClosed(
  d: Pick<Draft, "id" | "threadId">,
  workspaceId: string,
  status: "discarded" | "expired" | "sent",
  actor: "owner" | "squared_away",
) {
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor,
      action:
        status === "discarded"
          ? "draft_discarded"
          : status === "expired"
            ? "draft_expired"
            : "reply_sent_from_gmail",
      threadId: d.threadId,
      detail: { draftId: d.id },
    });
}

/** Throw the draft away here and in Gmail. */
export async function discardDraft(
  workspaceId: string,
  draftId: string,
  opts: DraftDeps = {},
): Promise<"discarded" | "not_found"> {
  const row = await loadOwnedDraft(workspaceId, draftId);
  if (!row || row.draft.status !== "pending" || row.draft.sendAfter) return "not_found";
  const now = opts.now?.() ?? new Date();
  if (!jobsAllowed(row.workspace, now))
    throw new ReadOnlyError(effectiveStatus(row.workspace, now));
  const writer = (opts.writerFor ?? defaultWriter)(row.mailbox);
  if (row.draft.gmailDraftId) {
    try {
      await writer.deleteDraft(row.draft.gmailDraftId);
    } catch (err) {
      if (!(err instanceof MailboxAuthError)) throw err;
      await markReconnectNeeded(row.mailbox);
    }
  }
  await closeDraft(row.draft, workspaceId, "discarded", null, now, "owner");
  return "discarded";
}

/** A nudge still waiting for the owner: pending, and not already tapped Send (undo window). */
const waitingNudge = (threadId: string) =>
  and(
    eq(drafts.threadId, threadId),
    eq(drafts.kind, "followup"),
    eq(drafts.status, "pending"),
    isNull(drafts.sendAfter),
  );

/**
 * The owner closed the matter (decided the quote, marked the invoice paid or not owed), so the
 * thread's waiting nudge goes — here and in Gmail. A nudge already tapped Send is the owner's
 * call and is left alone. The nudge always closes here: lost Google access → reconnect
 * banner; any other Gmail failure (rate limit, outage) or a mailbox that isn't working →
 * the Gmail draft is left in Gmail, as on the reconnect path. Returns whether one was closed.
 *
 * The row is claimed first, in one conditional UPDATE (still pending, Send not tapped), and
 * only the call that claimed it touches Gmail or writes Activity: a Send tapped a moment
 * earlier on another device wins, and a double-submitted "Mark paid" closes it once.
 */
export async function expirePendingNudge(
  threadId: string,
  note: string,
  opts: DraftDeps = {},
): Promise<boolean> {
  const now = opts.now?.() ?? new Date();
  const [claimed] = await db()
    .update(drafts)
    .set({ status: "expired", closedNote: note, decidedAt: now })
    .where(waitingNudge(threadId))
    .returning({
      id: drafts.id,
      threadId: drafts.threadId,
      gmailDraftId: drafts.gmailDraftId,
      mailboxId: drafts.mailboxId,
    });
  if (!claimed) return false;
  const [mailbox] = await db().select().from(mailboxes).where(eq(mailboxes.id, claimed.mailboxId));
  const row = { draft: claimed, mailbox };
  if (row.draft.gmailDraftId && row.mailbox.status === "active") {
    try {
      await (opts.writerFor ?? defaultWriter)(row.mailbox).deleteDraft(row.draft.gmailDraftId);
    } catch (err) {
      if (err instanceof MailboxAuthError) {
        await markReconnectNeeded(row.mailbox);
      } else {
        // Metadata only.
        console.error("nudge_gmail_delete_failed", {
          workspaceId: row.mailbox.workspaceId,
          draftId: row.draft.id,
          error: err instanceof Error ? err.name : "unknown",
        });
      }
    }
  }
  await logClosed(row.draft, row.mailbox.workspaceId, "expired", "squared_away");
  return true;
}

/**
 * Our own guess closed the matter (a quote outcome, or an invoice we think was paid).
 * A guess never deletes anything: the waiting nudge stays, with a flag asking the owner to
 * check, and any autopilot countdown is cleared. Idempotent.
 */
export async function flagPendingNudge(threadId: string, flag: string): Promise<boolean> {
  const rows = await db()
    .update(drafts)
    .set({
      flags: sql`case when ${drafts.flags} @> jsonb_build_array(${flag}::text) then ${drafts.flags} else ${drafts.flags} || jsonb_build_array(${flag}::text) end`,
      autoSendAt: null,
    })
    .where(waitingNudge(threadId))
    .returning({ id: drafts.id });
  return rows.length > 0;
}

/** Takes a flag back off the thread's waiting nudge (the owner said otherwise). Idempotent. */
export async function unflagPendingNudge(threadId: string, flag: string): Promise<boolean> {
  const rows = await db()
    .update(drafts)
    .set({ flags: sql`${drafts.flags} - ${flag}::text` })
    .where(and(waitingNudge(threadId), sql`${drafts.flags} @> jsonb_build_array(${flag}::text)`))
    .returning({ id: drafts.id });
  return rows.length > 0;
}

/**
 * Keep the queue honest about what happened in Gmail:
 * - draft gone and the owner replied in the thread → they sent it from Gmail;
 * - draft gone otherwise → they deleted it;
 * - a newer customer message arrived → this reply is stale; expire it (and
 *   remove it from Gmail) so a fresh one can be written;
 * - text changed in Gmail → take their version.
 */
export async function reconcileDrafts(mailboxId: string, opts: DraftDeps = {}) {
  const now = opts.now?.() ?? new Date();
  const [box] = await db()
    .select({ mailbox: mailboxes, workspace: workspaces })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(eq(mailboxes.id, mailboxId));
  // Read-only workspaces are left exactly as they are, here and in Gmail.
  if (!box || box.mailbox.status !== "active" || !jobsAllowed(box.workspace, now))
    return { checked: 0, closed: 0, expiredThreads: [] as string[] };
  const { mailbox } = box;
  const pending = await db()
    .select()
    .from(drafts)
    .where(and(eq(drafts.mailboxId, mailboxId), eq(drafts.status, "pending")))
    .orderBy(asc(drafts.createdAt));
  const writer = (opts.writerFor ?? defaultWriter)(mailbox);
  let closed = 0;
  const expiredThreads: string[] = [];
  try {
    for (const d of pending) {
      // The send job holds this one right now; it does its own checks.
      if (d.sendClaimedAt) continue;
      const newer = await db()
        .select({ direction: messages.direction })
        .from(messages)
        .where(
          and(
            eq(messages.threadId, d.threadId),
            gt(messages.sentAt, d.createdAt),
            // An unsent Gmail draft (an edit of this one, or the owner's own) isn't mail sent.
            notDraftMessage(),
          ),
        );
      if (newer.some((m) => m.direction === "in")) {
        if (d.gmailDraftId) await writer.deleteDraft(d.gmailDraftId);
        await closeDraft(
          d,
          mailbox.workspaceId,
          "expired",
          "The customer wrote again, so this reply was out of date.",
          now,
        );
        expiredThreads.push(d.threadId);
        closed++;
        continue;
      }
      const remote = d.gmailDraftId ? await writer.getDraft(d.gmailDraftId) : null;
      if (!remote) {
        const ownerReplied = newer.some((m) => m.direction === "out");
        await closeDraft(
          d,
          mailbox.workspaceId,
          ownerReplied ? "sent" : "discarded",
          ownerReplied ? "You sent this from Gmail." : "You deleted this draft in Gmail.",
          now,
          "owner",
        );
        if (ownerReplied) {
          await db()
            .update(threads)
            .set({ awaitingReplySince: now, needsOwner: false, needsOwnerManual: false })
            .where(eq(threads.id, d.threadId));
        }
        closed++;
      } else if (
        (d.kind === "followup" ||
          d.purpose === "closing_question" ||
          d.purpose === "review_request") &&
        newer.some((m) => m.direction === "out")
      ) {
        // The owner wrote to them some other way since; this nudge or note would repeat it.
        await writer.deleteDraft(d.gmailDraftId!);
        await closeDraft(
          d,
          mailbox.workspaceId,
          "expired",
          d.kind === "followup"
            ? "You wrote to them since, so this nudge was out of date."
            : "You wrote to them since, so this note was out of date.",
          now,
        );
        closed++;
      } else if (!sameText(remote.bodyText, d.body)) {
        // Changed in Gmail: the owner hasn't approved this text, so any send stops too.
        await db()
          .update(drafts)
          .set({ body: remote.bodyText, autoSendAt: null, sendAfter: null })
          .where(eq(drafts.id, d.id));
      }
    }
  } catch (err) {
    if (err instanceof MailboxAuthError) {
      await markReconnectNeeded(mailbox);
      return { checked: pending.length, closed, expiredThreads };
    }
    throw err;
  }
  return { checked: pending.length, closed, expiredThreads };
}

export type QueueItem = {
  draftId: string | null;
  kind: "reply" | "followup" | null;
  /** Deposit details / review request / closing question (plan #26 #28 #29). Null = ordinary. */
  purpose: DraftPurpose | null;
  /** Autopilot will send this at this time unless held. */
  autoSendAt: Date | null;
  threadId: string;
  customerName: string | null;
  customerAddress: string | null;
  category: string | null;
  summary: string | null;
  needsOwnerReason: string | null;
  reason: string | null;
  body: string | null;
  flags: string[];
  confidence: number | null;
  /** Profile facts / voice traits the drafter relied on (keys). */
  usedFacts: string[];
  /** Quick tweaks / voice edits left on this draft (plan #3, #4). */
  revisionsLeft: number;
  /** Plan #6: high priority and needs the owner — snooze only until tonight. */
  emergency: boolean;
  /** Plan #6: came back from a snooze — shown on top. */
  backFromSnooze: boolean;
  gmailThreadId: string;
  mailboxEmail: string;
  lastMessageAt: Date | null;
};

/** Plan #6: back from a snooze within the last day — pinned on top. */
const backFromSnoozeAt = (snoozedUntil: Date | null, now: Date) =>
  !!snoozedUntil && snoozedUntil <= now && now.getTime() - snoozedUntil.getTime() < BACK_ON_TOP_MS;

/** One queue entry with no content: ids, category, flags and times only (plan M8 A1). */
export type QueueMember = {
  threadId: string;
  category: string | null;
  /** Plan #6: high priority and needs the owner. */
  emergency: boolean;
  backFromSnooze: boolean;
  lastMessageAt: Date | null;
};
export type QueueMembership = {
  /** `waitingSince`: the customer's first email since the owner last wrote (plan M8 A14). */
  needsYou: (QueueMember & { waitingSince: Date | null })[];
  drafts: (QueueMember & { draftId: string; kind: "reply" | "followup" })[];
};

/**
 * Who is on the queue, and nothing else (plan M8 A1): the same rules the queue screen uses —
 * needs the owner, in the inbox, no draft waiting, not snoozed; drafts pending and not in
 * their undo window (plan #7), not snoozed; items back from a snooze first. It selects only
 * ids, category, priority, kind and times — no names, addresses, summaries, reasons, bodies
 * or mailbox rows — so the morning summary, phone notifications and the badge can count from
 * it without ever holding an email's content. No row cap: totals are real totals (A19).
 */
export async function queueMembership(
  workspaceId: string,
  now: Date = new Date(),
): Promise<QueueMembership> {
  const boxIds = (
    await db()
      .select({ id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.workspaceId, workspaceId))
  ).map((b) => b.id);
  if (boxIds.length === 0) return { needsYou: [], drafts: [] };

  const threadCols = {
    threadId: threads.id,
    category: threads.category,
    priority: threads.priority,
    needsOwner: threads.needsOwner,
    snoozedUntil: threads.snoozedUntil,
    lastMessageAt: threads.lastMessageAt,
  };
  const pending = await db()
    .select({ draftId: drafts.id, kind: drafts.kind, ...threadCols })
    .from(drafts)
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .where(
      and(
        inArray(drafts.mailboxId, boxIds),
        eq(drafts.status, "pending"),
        // In its undo window (plan #7): shown on the sent screen, not here.
        isNull(drafts.sendAfter),
      ),
    )
    .orderBy(desc(threads.lastMessageAt));
  // Every pending draft's thread counts as handled for "Needs you", snoozed or not.
  const draftedThreads = new Set(pending.map((r) => r.threadId));
  const needs = (
    await db()
      .select({ ...threadCols, waitingSince: waitingSinceSql() })
      .from(threads)
      .where(
        and(
          inArray(threads.mailboxId, boxIds),
          eq(threads.needsOwner, true),
          eq(threads.inInbox, true),
        ),
      )
      .orderBy(desc(threads.lastMessageAt))
  ).filter((t) => !draftedThreads.has(t.threadId));

  const snoozed = (t: { snoozedUntil: Date | null }) => !!t.snoozedUntil && t.snoozedUntil > now;
  const member = (t: (typeof pending)[number] | (typeof needs)[number]): QueueMember => ({
    threadId: t.threadId,
    category: t.category,
    emergency: isEmergency(t),
    backFromSnooze: backFromSnoozeAt(t.snoozedUntil, now),
    lastMessageAt: t.lastMessageAt,
  });
  // A stable sort: newest first, with anything back from a snooze on top.
  const backFirst = <T extends QueueMember>(rows: T[]) =>
    [...rows].sort((a, b) => Number(b.backFromSnooze) - Number(a.backFromSnooze));

  return {
    needsYou: backFirst(
      needs
        .filter((t) => !snoozed(t))
        .map((t) => ({ ...member(t), waitingSince: asDate(t.waitingSince) })),
    ),
    drafts: backFirst(
      pending
        .filter((r) => !snoozed(r))
        .map((r) => ({ ...member(r), draftId: r.draftId, kind: r.kind })),
    ),
  };
}

export type QueueTotals = { needsYou: number; replies: number; nudges: number; drafts: number };

/** The queue's numbers, from the same membership as the screen (plan M8 A1): counts only. */
export async function queueCounts(
  workspaceId: string,
  now: Date = new Date(),
): Promise<QueueTotals> {
  return countQueue(await queueMembership(workspaceId, now));
}

/** The totals of a membership already loaded. */
export function countQueue(q: QueueMembership): QueueTotals {
  const replies = q.drafts.filter((d) => d.kind === "reply").length;
  return {
    needsYou: q.needsYou.length,
    replies,
    nudges: q.drafts.length - replies,
    drafts: q.drafts.length,
  };
}

/** How many "Needs you" cards the queue screen shows at once (the counts above have no cap). */
const NEEDS_YOU_SHOWN = 50;

/**
 * The needs-you members the queue screen renders as cards: the newest 50, plus whatever the
 * morning summary links to (its top picks are the oldest and most urgent, which are exactly
 * the ones past 50), so every `#t-<id>` it sends lands.
 */
function shownNeedsYou(members: QueueMembership) {
  const linked = headerPickIds(members.needsYou.map(toNeedsYouItem));
  return members.needsYou.filter((m, i) => i < NEEDS_YOU_SHOWN || linked.has(m.threadId));
}

/**
 * The thread ids that have a card on the queue screen (`id="t-<uuid>"`), from the same rules
 * listQueue renders with — so a notification only deep-links to a card that's there (A26).
 */
export function queueCardIds(members: QueueMembership): Set<string> {
  return new Set([
    ...shownNeedsYou(members).map((m) => m.threadId),
    ...members.drafts.map((m) => m.threadId),
  ]);
}

/** The queue: threads that need the owner with no draft first, then drafts waiting for a decision. */
export async function listQueue(
  workspaceId: string,
  now: Date = new Date(),
): Promise<{ needsYou: QueueItem[]; drafts: QueueItem[] }> {
  // Membership (and order) come from the content-free rules, so the screen and every count
  // agree by construction; this only adds what the owner reads on the cards.
  const members = await queueMembership(workspaceId, now);
  const shownNeeds = shownNeedsYou(members);
  if (shownNeeds.length === 0 && members.drafts.length === 0) return { needsYou: [], drafts: [] };

  const boxes = await db()
    .select({ id: mailboxes.id, email: mailboxes.email })
    .from(mailboxes)
    .where(eq(mailboxes.workspaceId, workspaceId));
  const boxIds = boxes.map((b) => b.id);
  const emailOf = new Map(boxes.map((b) => [b.id, b.email]));

  const needIds = shownNeeds.map((m) => m.threadId);
  const draftIds = members.drafts.map((m) => m.draftId);
  const [needRows, draftRows] = await Promise.all([
    needIds.length
      ? db()
          .select()
          .from(threads)
          .where(and(inArray(threads.id, needIds), inArray(threads.mailboxId, boxIds)))
      : Promise.resolve([]),
    draftIds.length
      ? db()
          .select({ draft: drafts, thread: threads })
          .from(drafts)
          .innerJoin(threads, eq(threads.id, drafts.threadId))
          .where(and(inArray(drafts.id, draftIds), inArray(drafts.mailboxId, boxIds)))
      : Promise.resolve([]),
  ]);
  const threadById = new Map(needRows.map((t) => [t.id, t]));
  const draftById = new Map(draftRows.map((r) => [r.draft.id, r]));

  const senders = async (threadIds: string[]) => {
    if (!threadIds.length)
      return new Map<string, { name: string | null; address: string | null }>();
    const rows = await db()
      .select({
        threadId: messages.threadId,
        name: messages.fromName,
        address: messages.fromAddress,
        sentAt: messages.sentAt,
      })
      .from(messages)
      .where(and(inArray(messages.threadId, threadIds), eq(messages.direction, "in")))
      .orderBy(desc(messages.sentAt));
    const out = new Map<string, { name: string | null; address: string | null }>();
    for (const r of rows)
      if (!out.has(r.threadId)) out.set(r.threadId, { name: r.name, address: r.address });
    return out;
  };
  const who = await senders([...needIds, ...members.drafts.map((m) => m.threadId)]);

  return {
    needsYou: shownNeeds.flatMap((m) => {
      const t = threadById.get(m.threadId);
      if (!t) return [];
      return [
        {
          draftId: null,
          kind: null,
          purpose: null,
          autoSendAt: null,
          threadId: t.id,
          customerName: who.get(t.id)?.name ?? null,
          customerAddress: who.get(t.id)?.address ?? null,
          category: t.category,
          summary: t.summary,
          needsOwnerReason: t.needsOwnerReason,
          reason: null,
          body: null,
          flags: [],
          confidence: null,
          usedFacts: [],
          revisionsLeft: 0,
          emergency: m.emergency,
          backFromSnooze: m.backFromSnooze,
          gmailThreadId: t.gmailThreadId,
          mailboxEmail: emailOf.get(t.mailboxId) ?? "",
          lastMessageAt: t.lastMessageAt,
        } satisfies QueueItem,
      ];
    }),
    drafts: members.drafts.flatMap((m) => {
      const r = draftById.get(m.draftId);
      if (!r) return [];
      const { draft, thread } = r;
      return [
        {
          draftId: draft.id,
          kind: draft.kind,
          purpose: draft.purpose ?? null,
          autoSendAt: draft.autoSendAt,
          threadId: thread.id,
          customerName: who.get(thread.id)?.name ?? null,
          customerAddress: who.get(thread.id)?.address ?? draft.toAddress,
          category: thread.category,
          summary: thread.summary,
          needsOwnerReason: thread.needsOwner ? thread.needsOwnerReason : null,
          reason: draft.reason,
          body: draft.body,
          flags: draft.flags,
          confidence: draft.confidence,
          usedFacts: draft.usedFacts,
          revisionsLeft: Math.max(0, MAX_REVISIONS_PER_DRAFT - draft.revisions),
          emergency: m.emergency,
          backFromSnooze: m.backFromSnooze,
          gmailThreadId: thread.gmailThreadId,
          mailboxEmail: emailOf.get(draft.mailboxId) ?? "",
          lastMessageAt: thread.lastMessageAt,
        } satisfies QueueItem,
      ];
    }),
  };
}

/**
 * Threads that should get a reply drafted now: classified since the customer's
 * latest message, draftable category, not needing the owner, and no draft
 * written since that message.
 */
export async function threadsToAutoDraft(mailboxId: string, limit = 10): Promise<string[]> {
  const lastIn = sql`(select max(m.sent_at) from messages m where m.thread_id = ${threads.id} and m.direction = 'in')`;
  // Deliberately counts a Gmail draft older sync stored as owner mail (not notDraftSql): until
  // draft-message-cleanup has checked it with Gmail it might be the owner's answer, sent under
  // the same id, and an auto-draft could go out on autopilot. No reply drafted until checked;
  // the owner's own "Draft a reply" still works.
  const lastOut = sql`(select max(m.sent_at) from messages m where m.thread_id = ${threads.id} and m.direction = 'out')`;
  const lastDraft = sql`(select max(d.created_at) from drafts d where d.thread_id = ${threads.id})`;
  const rows = await db()
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.mailboxId, mailboxId),
        eq(threads.inInbox, true),
        eq(threads.needsOwner, false),
        inArray(threads.category, [...AUTO_DRAFT_CATEGORIES]),
        sql`${threads.classifiedAt} is not null and ${threads.classifiedAt} >= ${lastIn}`,
        sql`(${lastOut} is null or ${lastOut} < ${lastIn})`,
        sql`(${lastDraft} is null or ${lastDraft} < ${lastIn})`,
      ),
    )
    .orderBy(desc(threads.lastMessageAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** For the "squared away." moment: a draft this workspace just sent. */
export async function sentDraftSummary(workspaceId: string, draftId: string) {
  const row = await loadOwnedDraft(workspaceId, draftId);
  if (!row) return null;
  const sendingAt = row.draft.status === "pending" ? row.draft.sendAfter : null;
  if (!sendingAt && row.draft.status !== "sent" && row.draft.status !== "edited_and_sent")
    return null;
  const to = await customerOf(row.thread.id);
  const settings = await followupSettings(workspaceId);
  const chased =
    settings.enabled &&
    // A deposit, review request or closing question is never followed by a nudge (A3).
    row.draft.purpose == null &&
    !row.thread.needsOwner &&
    !quoteStopsNudges(row.thread) &&
    row.thread.invoicePaidAt == null &&
    FOLLOWUP_CATEGORIES.includes(row.thread.category as (typeof FOLLOWUP_CATEGORIES)[number]) &&
    !(await nudgeBlocked(row.thread));
  const sentNudges = chased ? await countSentFollowups(row.thread.id) : 0;
  const decidedAt = row.draft.decidedAt ?? sendingAt ?? new Date();
  return {
    draftId: row.draft.id,
    /** Plan #7: still in its undo window until then. Null once sent. */
    sendingAt,
    toName: to?.name ?? null,
    toAddress: row.draft.toAddress,
    category: row.thread.category,
    kind: row.draft.kind,
    purpose: row.draft.purpose ?? null,
    /** When we'll nudge if they go quiet; null if we won't. */
    nudgeOn:
      chased && sentNudges < MAX_FOLLOWUPS
        ? new Date(decidedAt.getTime() + settings.days * 86_400_000)
        : null,
    lastNudgeUsed: chased && sentNudges >= MAX_FOLLOWUPS,
  };
}
