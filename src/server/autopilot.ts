import "server-only";
import { claimsHuman } from "@/ai/draft-checks";
import { hasUnfilledGap } from "@/ai/gaps";
import {
  looksLikePaymentChange,
  mentionsCarbonMonoxide,
  mentionsElectricalHazard,
  mentionsGasSmell,
  mentionsLegalThreat,
  mentionsRealLegal,
} from "@/ai/guards";
import { mentionsMoney } from "@/ai/money-words";
import { looksNonEnglish } from "@/ai/language";
import { prepareBody } from "@/ai/classify";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { pricing } from "@/config/pricing";
import { EARN_THRESHOLD, GRACE_MINUTES } from "@/config/rules";
import { autopilotPlanNames } from "./plan-features";
import { db } from "@/db";
import {
  activityLog,
  drafts,
  mailboxes,
  messages,
  rules,
  threads,
  workspaces,
  type Workspace,
} from "@/db/schema";
import { MailboxAuthError } from "@/mailbox/connector";
import { MAILBOX_PAUSED_LINE, mailboxOn } from "./mailbox-plan-rules";
import {
  AUTO_DRAFT_CATEGORIES,
  AUTOPILOT_CLAIM_LEASE_MS,
  autopilotSending,
  defaultWriter,
  sendDraft,
  type DraftDeps,
  type SendOutcome,
} from "./drafts";
import { canSend, effectiveStatus, setupReallyPaid } from "./lifecycle";
import { knownCustomer } from "./known-customer";
import { isEmailToTextAddress, looksLikePhoneAddress } from "./channel-rules";
import { complainedAddresses } from "./offers";
import { recentEmergency } from "./emergency-rules";
import { injectionClearedRecently } from "./injection-clear-rules";
import { isUnsentDraft, markReconnectNeeded } from "./sync";
import { staleTiming, timingNote } from "./draft-timing";
import { workspaceTimeZone } from "./snooze";
import { unsentDraftMessage } from "./thread-sql";

export { knownCustomer };

/**
 * Autopilot: the owner's explicit exception to "nothing leaves without your
 * okay". Every rule here is enforced in code and has a test. Three layers:
 *
 * 1. Account: Crew or Company plan, setup finished (status `active`), and the setup really
 *    paid (`setupReallyPaid`) — the same payment the send gate needs.
 * 2. Category: the owner turned it on, and it has earned it — at least
 *    EARN_THRESHOLD drafts in that category approved without edits.
 * 3. Each email: never complaints, money, flagged threads, people the owner
 *    has never written to, follow-ups, deposit / review / closing notes, or
 *    anything the checks were unsure of.
 *
 * Then a grace window: the reply sits in the queue for GRACE_MINUTES saying
 * when it will go, with "Hold it". Everything is checked again just before
 * sending.
 */
export const AUTOPILOT_CATEGORIES = AUTO_DRAFT_CATEGORIES;
export { EARN_THRESHOLD, GRACE_MINUTES };
export const MIN_CONFIDENCE_PCT = 85;
export const DAILY_AUTOPILOT_CAP = 20;

type Category = (typeof AUTOPILOT_CATEGORIES)[number];
export function isAutopilotCategory(c: unknown): c is Category {
  return typeof c === "string" && (AUTOPILOT_CATEGORIES as readonly string[]).includes(c);
}

/** Layer 1. Returns why not, in plain words, or null when unlocked. */
export function accountLockReason(
  w: Pick<Workspace, "status" | "evaluationEndsAt" | "plan" | "setupPaidVia">,
  now: Date = new Date(),
): string | null {
  if (!w.plan || !pricing.plans[w.plan].autopilot) {
    return `Autopilot comes with the ${autopilotPlanNames()} plans.`;
  }
  if (effectiveStatus(w, now) !== "active") {
    return "Autopilot opens up once your setup call is done.";
  }
  // An active account that hasn't really paid (marked by hand before 2026-10-10, or reset after
  // a test-card payment) can't send, so no countdown may start: it could never go.
  if (!setupReallyPaid(w)) {
    return "Autopilot opens up once your setup payment goes through.";
  }
  return null;
}

export type GuardrailInput = {
  category: string | null;
  needsOwner: boolean;
  kind: "reply" | "followup";
  confidencePct: number | null;
  flags: string[];
  /** Dollar amounts the classifier found in the customer's email. */
  amountsInEmail: number[];
  draftBody: string;
  /** The owner has written to this address before (not just received from it). */
  knownCustomer: boolean;
  /** The email tried to instruct the assistant, or came from a building department. */
  untrusted?: boolean;
  municipal?: boolean;
  /** The customer's email accepts a quote (classify.v3 signal) — the owner answers those. */
  acceptsQuote?: boolean;
  /** Deposit details, review request, thank-you or closing question (plan #26 #28 #29). */
  purpose: string | null;
  /**
   * A Gmail draft older sync stored after the customer's email, not yet checked with Gmail
   * (draft-message-cleanup): if Gmail sent it under the same id, the owner already answered.
   */
  maybeAnswered?: boolean;
  /**
   * Review B1: the reply goes to a different address than the customer's email came from (a
   * website form's Reply-To). Anyone can send from their own domain with a Reply-To naming
   * someone else, so autopilot never sends there, even to an address the owner knows.
   */
  redirected?: boolean;
  /** Review B1: the customer's newest email was never checked for a Reply-To. */
  replyToUnchecked?: boolean;
  /**
   * Round 2 A10: this customer complained or disputed something in the last 12 months (on
   * any thread). Their next "ok, when can you come?" waits for the owner.
   */
  complainedRecently?: boolean;
  /** Round 2 A11: the email asks to pay a new or different account. */
  paymentChange?: boolean;
  /**
   * Check 20 P5: a lawyer, a lien or small claims anywhere in the customer's newest email,
   * quoted part included (the sorter only reads the newest part).
   */
  legalInEmail?: boolean;
  /** Check 20 P5: the customer's newest email has no text left to check (purged). */
  emailUnreadable?: boolean;
  /** Round 2 TW B4: someone smells gas. */
  gasSmell?: boolean;
  /** Check 22 P4: a carbon monoxide alarm went off. */
  coAlarm?: boolean;
  /** Check 37 P1: electrical fire signs. */
  electricalHazard?: boolean;
  /**
   * Check 48 P1: the customer asked whether a person is answering, or the draft says a person
   * wrote it with no help.
   */
  asksIfAi?: boolean;
  /** Check 22 P2: the owner cleared an attack mark on this thread in the last 30 days. */
  injectionCleared?: boolean;
  /** Check 36 P2: an emergency on this conversation in the last 48 hours. */
  recentEmergency?: boolean;
  /** Ideas H4: the owner chose this kind and the sorter said otherwise. */
  ownerMoved?: boolean;
  /** Leads package: a lead-site / voicemail / text-message thread. */
  leadChannel?: boolean;
  /** Leads package: the reply goes to an email-to-text gateway or a phone-number address. */
  textAddress?: boolean;
  /**
   * Replies package (draft.v7): a first reply to someone the owner never wrote to. Davi said
   * no to any instant reply to a new lead, so it always waits for a tap — even when an old
   * forward to that address makes them look known.
   */
  firstReply?: boolean;
  /**
   * Check 20 P3: the draft or the customer's newest email looks Spanish or Portuguese. Every
   * code check here reads English only, so it waits.
   */
  otherLanguage?: boolean;
};

/** Layer 3. Every reason this email must wait for the owner; empty = may go. */
export function guardrailReasons(g: GuardrailInput): string[] {
  const out: string[] = [];
  if (!isAutopilotCategory(g.category))
    out.push("Complaints and other emails always wait for you.");
  if (g.needsOwner) out.push("Flagged as needing you.");
  if (g.kind !== "reply") out.push("Follow-ups always wait for you.");
  if ((g.confidencePct ?? 0) < MIN_CONFIDENCE_PCT) out.push("Not confident enough to send alone.");
  if (g.flags.length) out.push("Has things to check before sending.");
  if (g.category === "invoice_payment" && g.amountsInEmail.length)
    out.push("Payments with an amount always wait for you.");
  // Any way of naming a price: "$450", "450 dollars", "1.2k", "twelve hundred" (review A1).
  if (mentionsMoney(g.draftBody)) out.push("Mentions money, so it waits for you.");
  if (hasUnfilledGap(g.draftBody)) out.push("Has gaps for you to fill in.");
  if (!g.knownCustomer) out.push("You haven't written to this person before.");
  if (g.untrusted) out.push("This email tried to give instructions to the assistant.");
  if (g.municipal) out.push("Building departments always wait for you.");
  if (g.acceptsQuote) out.push("Quote acceptances always wait for you.");
  // Thank-you notes (2026-10-16) are purpose notes too, so this line covers them.
  if (g.purpose != null) out.push("Deposit, review and closing notes always wait for you.");
  if (g.maybeAnswered) out.push("You might already have answered this in Gmail.");
  if (g.redirected)
    out.push("This reply goes to a different address than the sender's, so it waits for you.");
  if (g.replyToUnchecked) out.push("We couldn't check where this reply goes, so it waits for you.");
  if (g.complainedRecently)
    out.push("This customer complained in the last 12 months, so it waits for you.");
  if (g.paymentChange) out.push("Asks to pay a new account, so it waits for you.");
  if (g.legalInEmail)
    out.push("Something legal is mentioned in this conversation, so it waits for you.");
  if (g.emailUnreadable) out.push("We can't read their email any more, so it waits for you.");
  if (g.gasSmell) out.push("Someone smells gas. Call them.");
  if (g.coAlarm) out.push("A carbon monoxide alarm went off. Call them.");
  if (g.asksIfAi || claimsHuman(g.draftBody))
    out.push("Asks if a person is answering, so it waits for you.");
  if (g.injectionCleared)
    out.push("You said an email here was normal after we flagged it, so it waits for you.");
  if (g.electricalHazard) out.push("Sounds like an electrical fire risk. Call them.");
  if (g.recentEmergency)
    out.push(
      "There was an emergency on this conversation in the last 2 days, so it waits for you.",
    );
  if (g.ownerMoved) out.push("You chose this kind yourself, so it waits for you.");
  if (g.leadChannel) out.push("Lead-site and voicemail emails always wait for you.");
  if (g.textAddress) out.push("That address may turn into a text message, so it waits for you.");
  if (g.firstReply) out.push("First replies to new customers always wait for you.");
  if (g.otherLanguage || looksNonEnglish(g.draftBody))
    out.push("Not in English, so it waits for you.");
  return out;
}

/** Layer 2's evidence: replies in each category the owner sent exactly as drafted. */
export async function earnedCounts(workspaceId: string): Promise<Map<string, number>> {
  const rows = await db()
    .select({ category: threads.category, n: count() })
    .from(drafts)
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        eq(drafts.kind, "reply"),
        // Deposit / review / closing notes never earn autopilot: it can never send them.
        isNull(drafts.purpose),
        eq(drafts.status, "sent"),
        sql`${drafts.sentGmailMessageId} is not null`,
        // Ideas H4: replies on a conversation the owner moved to a kind the sorter didn't pick
        // never earn that kind.
        sql`(${threads.categoryManual} is null or ${threads.categoryManual} = ${threads.extracted}->>'model_category')`,
      ),
    )
    .groupBy(threads.category);
  return new Map(rows.filter((r) => r.category).map((r) => [r.category!, r.n]));
}

async function modes(workspaceId: string) {
  const rows = await db().select().from(rules).where(eq(rules.workspaceId, workspaceId));
  return new Map(rows.map((r) => [r.category, r.mode]));
}

export type AutopilotState = {
  lockedReason: string | null;
  categories: { category: Category; on: boolean; earned: number; canTurnOn: boolean }[];
};

export async function autopilotState(
  workspace: Pick<Workspace, "id" | "status" | "evaluationEndsAt" | "plan" | "setupPaidVia">,
  now: Date = new Date(),
): Promise<AutopilotState> {
  const lockedReason = accountLockReason(workspace, now);
  const [earned, mode] = await Promise.all([earnedCounts(workspace.id), modes(workspace.id)]);
  return {
    lockedReason,
    categories: AUTOPILOT_CATEGORIES.map((category) => {
      const n = earned.get(category) ?? 0;
      return {
        category,
        on: !lockedReason && mode.get(category) === "autopilot",
        earned: n,
        canTurnOn: !lockedReason && n >= EARN_THRESHOLD,
      };
    }),
  };
}

export class AutopilotNotAllowedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AutopilotNotAllowedError";
  }
}

/** The owner's switch. Turning on is checked against layers 1 and 2; turning off always works. */
export async function setAutopilot(
  workspace: Pick<Workspace, "id" | "status" | "evaluationEndsAt" | "plan" | "setupPaidVia">,
  category: string,
  on: boolean,
  now: Date = new Date(),
) {
  if (!isAutopilotCategory(category))
    throw new AutopilotNotAllowedError("Not available for that kind of email.");
  if (on) {
    const locked = accountLockReason(workspace, now);
    if (locked) throw new AutopilotNotAllowedError(locked);
    const earned = (await earnedCounts(workspace.id)).get(category) ?? 0;
    if (earned < EARN_THRESHOLD)
      throw new AutopilotNotAllowedError(
        `Needs ${EARN_THRESHOLD - earned} more replies sent as drafted.`,
      );
  }
  const mode = on ? ("autopilot" as const) : ("draft" as const);
  await db()
    .insert(rules)
    .values({ workspaceId: workspace.id, category, mode, updatedAt: now })
    .onConflictDoUpdate({
      target: [rules.workspaceId, rules.category],
      set: { mode, updatedAt: now },
    });
  if (!on) {
    // Anything already counting down in that category waits for the owner instead.
    await db().execute(sql`
      update ${drafts} set auto_send_at = null
      where ${drafts.autoSendAt} is not null and ${drafts.status} = 'pending'
        and ${drafts.threadId} in (
          select ${threads.id} from ${threads}
          join ${mailboxes} on ${mailboxes.id} = ${threads.mailboxId}
          where ${mailboxes.workspaceId} = ${workspace.id} and ${threads.category} = ${category}
        )`);
  }
  await db().insert(activityLog).values({
    workspaceId: workspace.id,
    actor: "owner",
    action: "autopilot_changed",
    detail: { category, on },
  });
}

async function loadForAutopilot(draftId: string) {
  const [row] = await db()
    .select({ draft: drafts, thread: threads, mailbox: mailboxes, workspace: workspaces })
    .from(drafts)
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .where(eq(drafts.id, draftId));
  return row;
}

/**
 * The daily cap's count: countdowns started (held ones included) in the last 24 hours, not
 * sends and not the owner's calendar day — a rolling window can't let 20 go just before
 * midnight and 20 more just after.
 */
async function countdownsStartedLast24h(
  q: Pick<ReturnType<typeof db>, "select">,
  workspaceId: string,
  now: Date,
) {
  const since = new Date(now.getTime() - 86_400_000);
  const [row] = await q
    .select({ n: count() })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.workspaceId, workspaceId),
        eq(activityLog.action, "autopilot_scheduled"),
        gte(activityLog.createdAt, since),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Round 2 A10: a complaint or dispute from this address on ANY thread in the last 12 months —
 * the same memory review requests use (sender or reply address, sticky complaint mark).
 */
export async function customerComplainedRecently(
  workspaceId: string,
  address: string,
  now: Date = new Date(),
): Promise<boolean> {
  return (await complainedAddresses(workspaceId, now)).has(address.trim().toLowerCase());
}

/** Every reason this draft can't go on its own right now (all three layers + the daily cap). */
async function blockers(row: NonNullable<Awaited<ReturnType<typeof loadForAutopilot>>>, now: Date) {
  const { draft, thread, mailbox, workspace } = row;
  const locked = accountLockReason(workspace, now);
  if (locked) return [locked];
  // The plan covers fewer Gmail addresses and this one is paused (2026-10-16): nothing from it
  // goes on its own (sendDraft refuses it too).
  if (mailbox.planPausedAt) return [MAILBOX_PAUSED_LINE];
  const mode = (await modes(workspace.id)).get(thread.category ?? "");
  if (mode !== "autopilot") return ["Autopilot is off for this kind of email."];
  const [customer] = await db()
    .select({
      address: messages.fromAddress,
      replyToHeader: messages.replyToHeader,
      sentAt: messages.sentAt,
      subject: messages.subject,
      bodyText: messages.bodyText,
    })
    .from(messages)
    .where(and(eq(messages.threadId, thread.id), eq(messages.direction, "in")))
    .orderBy(desc(messages.sentAt))
    .limit(1);
  const maybeAnswered = customer
    ? (
        await db()
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.threadId, thread.id),
              unsentDraftMessage(),
              gte(messages.sentAt, customer.sentAt),
            ),
          )
          .limit(1)
      ).length > 0
    : false;
  const extracted = (thread.extracted ?? {}) as {
    dollar_amounts?: number[];
    injection?: boolean;
    municipal?: boolean;
    accepts_quote?: boolean;
    payment_change?: boolean;
    gas_smell?: boolean;
    co_alarm?: boolean;
    electrical_hazard?: boolean;
    model_category?: string;
  };
  const complainedRecently = await customerComplainedRecently(workspace.id, draft.toAddress, now);
  // Check 20 P5: the WHOLE newest customer email, quoted part included ("Fine, Thursday at 10"
  // above "> If the leak isn't fixed I'm calling our lawyer"). Never logged. A purged body
  // can't be checked, so it waits.
  const fullBody = customer?.bodyText ?? null;
  const fullText = fullBody === null ? "" : `${customer?.subject ?? ""}\n${fullBody}`;
  return guardrailReasons({
    category: thread.category,
    needsOwner: thread.needsOwner || thread.needsOwnerManual,
    kind: draft.kind,
    confidencePct: draft.confidence,
    flags: draft.flags,
    amountsInEmail: extracted.dollar_amounts ?? [],
    untrusted: extracted.injection === true,
    municipal: extracted.municipal === true,
    acceptsQuote: extracted.accepts_quote === true,
    purpose: draft.purpose ?? null,
    maybeAnswered,
    draftBody: draft.body ?? "",
    // Checked on where the reply actually goes, and that must be the sender itself (B1).
    knownCustomer: await knownCustomer(mailbox.id, draft.toAddress, draft.createdAt),
    redirected:
      !customer ||
      draft.toAddress.trim().toLowerCase() !== (customer.address ?? "").trim().toLowerCase(),
    replyToUnchecked: !customer || customer.replyToHeader === null,
    complainedRecently,
    paymentChange: extracted.payment_change === true || looksLikePaymentChange(fullText),
    gasSmell: extracted.gas_smell === true || mentionsGasSmell(fullText),
    coAlarm: extracted.co_alarm === true || mentionsCarbonMonoxide(fullText),
    electricalHazard: extracted.electrical_hazard === true || mentionsElectricalHazard(fullText),
    legalInEmail: mentionsRealLegal(fullText) || mentionsLegalThreat(fullText),
    recentEmergency: recentEmergency(thread.extracted, now),
    injectionCleared: injectionClearedRecently(thread.extracted, now),
    asksIfAi: (extracted as { asks_if_ai?: unknown }).asks_if_ai === true,
    emailUnreadable: fullBody === null,
    ownerMoved: thread.categoryManual != null && thread.categoryManual !== extracted.model_category,
    leadChannel: thread.leadChannel != null,
    textAddress: isEmailToTextAddress(draft.toAddress) || looksLikePhoneAddress(draft.toAddress),
    // Any stored opening means the drafter was told it's a first contact (even "not_first").
    firstReply: draft.opening != null,
    // Check 20 P3: the newest part of their email (quoted text cut, as the sorter reads it).
    otherLanguage:
      fullBody !== null && looksNonEnglish(`${customer?.subject ?? ""}\n${prepareBody(fullBody)}`),
  });
}

/**
 * Right after a draft is written: if everything allows it, start the grace
 * window. Returns when it will send, or null if it waits for the owner.
 */
export async function considerAutopilot(
  draftId: string,
  now: Date = new Date(),
): Promise<Date | null> {
  const row = await loadForAutopilot(draftId);
  if (!row || row.draft.status !== "pending" || row.draft.autoSendAt) return null;
  if ((await blockers(row, now)).length) return null;

  // Check 20 P13: the cap check, the countdown and its autopilot_scheduled row (what the cap
  // counts) happen in one transaction under a per-workspace lock, so two inboxes drafting at
  // once can't both read 19 and both start one. A draft that is no longer pending (or already
  // counting down) writes no row, so it takes no slot.
  const at = new Date(now.getTime() + GRACE_MINUTES * 60_000);
  const started = await db().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`autopilot-cap:${row.workspace.id}`}))`,
    );
    if ((await countdownsStartedLast24h(tx, row.workspace.id, now)) >= DAILY_AUTOPILOT_CAP)
      return false;
    const [set] = await tx
      .update(drafts)
      .set({ autoSendAt: at })
      .where(and(eq(drafts.id, draftId), eq(drafts.status, "pending"), isNull(drafts.autoSendAt)))
      .returning({ id: drafts.id });
    if (!set) return false;
    await tx.insert(activityLog).values({
      workspaceId: row.workspace.id,
      actor: "squared_away",
      action: "autopilot_scheduled",
      threadId: row.thread.id,
      detail: { draftId, sendAt: at.toISOString() },
    });
    return true;
  });
  return started ? at : null;
}

export const NEWER_MAIL_LINE = "There's newer mail in this conversation.";

/**
 * Check 20 P2: ids Gmail lists on the thread (oldest first) after the newest one we have
 * stored, that we don't have: mail that hasn't synced yet. Drafts don't count (sync never
 * stores them). Unknown ids before a stored one are older mail the 30-day backfill never read.
 * If we hold none of them we can't tell, so every one counts. Pure; ids only.
 */
export function unsyncedMessageIds(
  listed: readonly { id: string; labelIds: readonly string[] }[],
  known: ReadonlySet<string>,
): string[] {
  const mail = listed.filter((m) => !isUnsentDraft(m.labelIds));
  let last = -1;
  mail.forEach((m, i) => {
    if (known.has(m.id)) last = i;
  });
  return mail.slice(last + 1).map((m) => m.id);
}

export type AutopilotSendResult =
  | { status: "sent" }
  | { status: "not_due" }
  /** `syncMailboxId`: Gmail has mail we haven't synced; the job asks for a sync (Check 20 P2). */
  | { status: "stood_down"; reasons: string[]; syncMailboxId?: string }
  | { status: "gone" }
  | { status: "failed"; outcome: SendOutcome["status"] };

/**
 * When the grace window ends: check everything again — the owner may have
 * held it, edited it, switched autopilot off, started their own reply in
 * Gmail, the customer may have written again, or the account may have
 * changed — and only then send.
 */
export async function runAutopilotSend(
  draftId: string,
  opts: DraftDeps = {},
): Promise<AutopilotSendResult> {
  const now = opts.now?.() ?? new Date();
  const row = await loadForAutopilot(draftId);
  if (!row || row.draft.status !== "pending") return { status: "gone" };
  if (!row.draft.autoSendAt) return { status: "stood_down", reasons: ["Held or edited by you."] };
  if (row.draft.autoSendAt > now) return { status: "not_due" };

  // Check 9 P2: claim it before any Gmail call. Only one run ever holds it, and once it does,
  // Hold it is too late (and says so) instead of saying "Held." while the reply goes out.
  const [claimed] = await db()
    .update(drafts)
    .set({ autoSendClaimedAt: now })
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.status, "pending"),
        isNotNull(drafts.autoSendAt),
        lte(drafts.autoSendAt, now),
        or(
          isNull(drafts.autoSendClaimedAt),
          lt(drafts.autoSendClaimedAt, new Date(now.getTime() - AUTOPILOT_CLAIM_LEASE_MS)),
        ),
      ),
    )
    .returning({ id: drafts.id });
  if (!claimed) return { status: "not_due" };
  const release = () =>
    db().update(drafts).set({ autoSendClaimedAt: null }).where(eq(drafts.id, draftId));

  const newer = await db()
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, row.thread.id),
        sql`${messages.sentAt} > ${row.draft.createdAt.toISOString()}::timestamptz`,
      ),
    )
    .limit(1);
  // Check 43 P7: an old "tomorrow" or "in a few minutes" waits for the owner, always.
  const timing = staleTiming(
    row.draft.body ?? "",
    row.draft.createdAt,
    now,
    await workspaceTimeZone(row.workspace.id),
  );
  const reasons = [
    ...(await blockers(row, now)),
    ...(newer.length ? [NEWER_MAIL_LINE] : []),
    ...(timing ? [timingNote(timing)] : []),
  ];
  // Layer 1 already needs what the send gate needs. If they ever differ, stand down here rather
  // than let sendDraft refuse: a refusal throws, and the backstop would retry it forever.
  if (!reasons.length && !canSend(row.workspace, now)) {
    reasons.push("Sending isn't switched on for this account.");
  }
  // The owner may be writing their own reply in Gmail right now: sync doesn't store drafts,
  // so only Gmail can say. Asked only when sending is otherwise allowed — a blocked account
  // or a lost mailbox gets no Google call (sendDraft refuses those before any).
  // Check 20 P2: the same one call lists every message, so mail that landed after the last
  // sync ("Actually, hold off") stops the send too, and a sync is asked for.
  let unsynced = false;
  if (!reasons.length && canSend(row.workspace, now) && mailboxOn(row.mailbox)) {
    const writer = (opts.writerFor ?? defaultWriter)(row.mailbox);
    try {
      const own = row.draft.gmailDraftId ? await writer.getDraft(row.draft.gmailDraftId) : null;
      const ours = new Set([own?.messageId, row.draft.gmailMessageId].filter(Boolean));
      const listed = await writer.threadMessageLabels(row.thread.gmailThreadId);
      const others = listed.filter((m) => isUnsentDraft(m.labelIds) && !ours.has(m.id));
      if (others.length) reasons.push("You're writing a reply in Gmail.");
      const stored = await db()
        .select({ id: messages.gmailMessageId })
        .from(messages)
        .where(eq(messages.threadId, row.thread.id));
      if (unsyncedMessageIds(listed, new Set(stored.map((s) => s.id))).length) {
        unsynced = true;
        reasons.push(NEWER_MAIL_LINE);
      }
    } catch (err) {
      await release();
      if (err instanceof MailboxAuthError) {
        await markReconnectNeeded(row.mailbox);
        return { status: "failed", outcome: "reconnect_needed" };
      }
      throw err;
    }
  }
  if (reasons.length) {
    await db()
      .update(drafts)
      .set({ autoSendAt: null, autoSendClaimedAt: null })
      .where(eq(drafts.id, draftId));
    await db()
      .insert(activityLog)
      .values({
        workspaceId: row.workspace.id,
        actor: "squared_away",
        action: "autopilot_stood_down",
        threadId: row.thread.id,
        detail: { draftId, reasonCount: reasons.length },
      });
    return unsynced
      ? { status: "stood_down", reasons, syncMailboxId: row.mailbox.id }
      : { status: "stood_down", reasons };
  }

  let outcome;
  try {
    outcome = await sendDraft(row.workspace.id, draftId, { ...opts, by: "autopilot" });
  } catch (err) {
    // Not sent (a sent draft is no longer pending, so this touches nothing then): let a retry
    // or the backstop claim it again.
    await release();
    throw err;
  }
  if (outcome.status === "sent") return { status: "sent" };
  await release();
  return { status: "failed", outcome: outcome.status };
}

/**
 * The owner's "Hold it" (Check 9 P2): held only while no autopilot run has claimed it, so
 * "Held." is only ever said of a draft that did not go. Too late once a run holds it (or it
 * went); not found otherwise.
 */
export type HoldResult =
  { status: "held" } | { status: "too_late"; sent: boolean } | { status: "not_found" };

export async function holdAutopilot(
  workspaceId: string,
  draftId: string,
  now: Date = new Date(),
): Promise<HoldResult> {
  const owned = inArray(
    drafts.mailboxId,
    db().select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.workspaceId, workspaceId)),
  );
  const held = await db()
    .update(drafts)
    .set({ autoSendAt: null })
    .where(
      and(
        eq(drafts.id, draftId),
        eq(drafts.status, "pending"),
        isNotNull(drafts.autoSendAt),
        or(
          isNull(drafts.autoSendClaimedAt),
          lt(drafts.autoSendClaimedAt, new Date(now.getTime() - AUTOPILOT_CLAIM_LEASE_MS)),
        ),
        owned,
      ),
    )
    .returning({ threadId: drafts.threadId });
  if (held.length) {
    await db().insert(activityLog).values({
      workspaceId,
      actor: "owner",
      action: "autopilot_held",
      threadId: held[0]!.threadId,
      detail: { draftId },
    });
    return { status: "held" };
  }
  const [d] = await db()
    .select({
      status: drafts.status,
      autoSendAt: drafts.autoSendAt,
      autoSendClaimedAt: drafts.autoSendClaimedAt,
    })
    .from(drafts)
    .where(and(eq(drafts.id, draftId), owned));
  if (!d) return { status: "not_found" };
  if (d.status === "sent" || d.status === "edited_and_sent")
    return { status: "too_late", sent: true };
  if (d.status === "pending" && autopilotSending(d, now))
    return { status: "too_late", sent: false };
  return { status: "not_found" };
}

/** Backstop for lost events: drafts whose window ended a while ago and are still waiting. */
export async function overdueAutopilotDrafts(now: Date = new Date()): Promise<string[]> {
  const rows = await db()
    .select({ id: drafts.id })
    .from(drafts)
    .where(
      and(
        eq(drafts.status, "pending"),
        isNotNull(drafts.autoSendAt),
        lte(drafts.autoSendAt, new Date(now.getTime() - 5 * 60_000)),
      ),
    )
    .limit(50);
  return rows.map((r) => r.id);
}
