import "server-only";
import { callStructured } from "./client";
import {
  businessBlock,
  CLASSIFY_INSTRUCTIONS,
  CLASSIFY_PROMPT_VERSION,
  classificationSchema,
  emailBlock,
  type BusinessContext,
  type Category,
  type EmailInput,
  type ModelClassification,
} from "./prompts/classify.v5";
import { SENDER_NEEDS_ME_REASON } from "@/server/owner-sender-rule-rules";
import {
  ASKS_IF_AI_REASON,
  asksIfAi,
  CO_REASON,
  ELECTRICAL_HAZARD_REASON,
  GAS_SMELL_REASON,
  INJECTION_REASON,
  injectionCheck,
  looksLikePaymentChange,
  looksMunicipal,
  mentionsCarbonMonoxide,
  mentionsElectricalHazard,
  mentionsGasSmell,
  mentionsLegalThreat,
  mentionsRealLegal,
  mentionsWaterSmell,
  incentiveAmounts,
  PAYMENT_CHANGE_REASON,
  WATER_SMELL_REASON,
} from "./guards";
import { isLeadCategory } from "@/config/categories";
import { EMERGENCY_REASON } from "@/server/emergency-rules";
import { followupSignalsOf } from "@/server/followup-rules";
import { OUTSIDE_AREA_REASON, outsideArea } from "@/server/service-area-rules";
import type { ChannelKind } from "@/server/channel-rules";

/**
 * What we keep about an email. The model's facts, plus flags:
 * `municipal` (building dept / inspector — never noise, never auto-drafted),
 * `injection` (tries to instruct the assistant — needs the owner, never
 * auto-drafted, never autopilot), the model's `accepts_quote` / `job_done`
 * signals (classify.v3; only ever present as `true`), and `quote_accepted`,
 * set at classification when the acceptance lands on a thread that really
 * was a quote the owner answered (see `quoteAccepted` in quote-rules).
 * Rows written before v3 simply lack the newer keys — read them as optional.
 */
export type Extracted = ModelClassification["extracted"] & {
  /**
   * Check 10 P7: the model failed twice and nothing was decided (the category is a placeholder
   * so other code keeps working). Only ever present as `true`. Screens say "Couldn't sort".
   */
  unreadable?: boolean;
  municipal?: boolean;
  injection?: boolean;
  accepts_quote?: boolean;
  job_done?: boolean;
  /**
   * Check 21 P1: the email only thanks or acknowledges ("we'll look it over and get back to
   * you"), asks nothing and needs no answer. Read from the model's
   * `signals.acknowledgment_only`, which the next classify prompt version adds (until then it
   * is never present). Only ever present as `true`.
   */
  acknowledgment_only?: boolean;
  quote_accepted?: boolean;
  /** When the acceptance email was written (ISO), kept with `quote_accepted`. */
  quote_accepted_at?: string;
  /**
   * Check 38 P1: THIS email says yes on a job that was already won before it (a change order:
   * "go ahead with the lights and the outlet"). Set instead of `quote_accepted`, so no deposit
   * note is written for it. Content-free; only ever present as `true`; not carried over.
   */
  change_order_approved?: boolean;
  /**
   * The customer disputes a charge, asks for money back or mentions something legal
   * (the model's mentions_refund_or_dispute / mentions_legal signals). Treated as a
   * complaint for review requests: it sets the sticky `threads.complained_at`. Only ever
   * present as `true`.
   */
  disputed?: boolean;
  /**
   * What THIS email says about paying, in its own words (`invoice.status` before the
   * stored facts are carried over): never carried to the next email. A customer who just
   * said they paid isn't chased, and isn't asked for a deposit.
   */
  payment_said?: "paid" | "partly_paid";
  /**
   * Plan #27: this thread has been about an invoice (sorted invoice_payment at some point).
   * Sticky, set at classification, so a later "use the side gate" re-sorted as a question
   * keeps the invoice on Money owed. Only ever present as `true`.
   */
  invoice_thread?: boolean;
  /**
   * Round 2 A11: the email asks to pay a new or different account (bank details changed,
   * gift cards). Never drafted by a job, never autopilot. Only ever present as `true`.
   */
  payment_change?: boolean;
  /**
   * Check 36 P2: this thread had an emergency (the model's urgency on a lead, a gas smell or a
   * CO alarm), kept for 48 hours from `emergency_at` (ISO) across later sorts. Autopilot and
   * batch send refuse the thread meanwhile. Only ever present as `true`.
   */
  emergency?: boolean;
  emergency_at?: string;
  /**
   * Check 22 P2: why the attack mark was set — content-free codes ("instructions", "encoded",
   * "hidden", "sticky", "model"). The owner may clear only a mark with no "hidden" / "encoded".
   */
  injection_reasons?: string[];
  /** Check 22 P2: the owner rules' answer with the attack mark left out (for clearing it). */
  without_injection?: {
    needs_owner: boolean;
    reason: string | null;
    priority: "high" | "normal" | "low";
    hits: string[];
  };
  /**
   * Check 22 P2: the owner said "This is a normal email" (`injection_cleared_at`, ISO). Kept
   * across later sorts; autopilot stays away for 30 days.
   */
  injection_cleared_by_owner?: boolean;
  injection_cleared_at?: string;
  /**
   * Check 48 P1 + 43 P2: the customer asks whether a person or an AI is answering (or asks the
   * assistant to pass a message on). Needs the owner, never drafted by a job, never autopilot.
   * Sticky for the thread, like `injection`. Only ever present as `true`.
   */
  asks_if_ai?: boolean;
  /** Round 2 TW B4: someone smells gas. Only ever present as `true`. */
  gas_smell?: boolean;
  /**
   * Check 22 P4: a carbon monoxide alarm went off. Treated like a gas smell (needs you, top
   * priority, emergency, one fixed safety note). Only ever present as `true`.
   */
  co_alarm?: boolean;
  /**
   * Check 37 P1: electrical fire signs (burning smell, sparks, smoke or heat at an outlet or
   * panel, a shock, wires down). Like gas: needs you, top priority, emergency, its own fixed
   * safety note. Only ever present as `true`.
   */
  electrical_hazard?: boolean;
  /**
   * Check 36 P1: the water smells like rotten eggs and nothing says gas (the anode rod). Needs
   * the owner, no safety note, no emergency. Only ever present as `true`.
   */
  water_smell?: boolean;
  /**
   * Round 2 TW A1: routine insurance / warranty / lien-waiver paperwork the model saw. A
   * signal only; it never sets the complaint mark. Only ever present as `true`.
   */
  routine_paperwork?: boolean;
  /**
   * Ideas H3: the owner's sender rule that applied to this email: "junk" (sorted as junk by the
   * rule, no model call) or "no_draft" (sorted as usual, never drafted by a job).
   */
  sender_rule?: "junk" | "no_draft";
  /** Ideas H4: the sorter's own kind for this email, whatever kind the owner chose. */
  model_category?: Category;
  /**
   * Check 22 P10 + 41 P6: a conversation with the owner's own people only (the crew list in
   * Settings, another connected Gmail address of theirs, or their business domain). Never a
   * customer, never drafted by a job, never autopilot. Only ever present as `true`.
   */
  crew?: boolean;
  /**
   * Leads package: every owner rule this email matched, as fixed content-free keys
   * (`OWNER_RULE_KEYS`). Cards read these, never the reason text.
   */
  owner_rule_hits?: string[];
  /**
   * Check 12 P1: why the thread needs the owner, content-free (`needsOwnerCode`). Absent when it
   * doesn't, and on rows sorted before it existed.
   */
  owner_code?: string;
  /**
   * Check 21 P2: the customer turns the quote down (hired someone else, holding off
   * indefinitely, no longer needs it). Our "lost" guess; stops nudges. Only ever `true`.
   */
  declines_quote?: boolean;
  /** Check 21 P2: the date (YYYY-MM-DD) they asked us to wait for. Becomes `threads.nudge_after`. */
  wait_until?: string;
};

/** The owner-rule keys, in display order (leads package §1g). */
export const OWNER_RULE_KEYS = [
  "injection",
  "gas",
  "co_alarm",
  "electrical",
  "payment_change",
  "asks_if_ai",
  "complaint",
  "legal",
  "dispute",
  "vip",
  "sender_rule",
  "amount",
  "big_new_job",
  "emergency",
  "water_smell",
  "phone",
  "site",
  "outside_area",
  "low_confidence",
  "model",
] as const;
export type OwnerRuleKey = (typeof OWNER_RULE_KEYS)[number];
/** Hits whose fixed text always wins over the model's own reason (no town or name rides along). */
const FIXED_TEXT_HITS: readonly OwnerRuleKey[] = [
  "emergency",
  "water_smell",
  "phone",
  "site",
  "outside_area",
];

/** The needs-owner reasons a dispute or legal threat gets (when the model gave none). */
export const LEGAL_REASON = "Mentions a lawyer, a lien or a claim.";
export const DISPUTE_REASON = "Asks for money back or disputes a charge.";
/** Check 10 P10: the legal reason's wording before 2026-10-17, still on stored rows. */
export const OLD_LEGAL_REASON = "Mentions something legal.";
/**
 * Threads sorted before `extracted.disputed` existed only kept the reason: one of these
 * still showing marks a dispute (treated as a complaint for review requests). Older wordings
 * stay listed so rows stored with them are still recognised (Check 10 P10).
 */
export const DISPUTE_REASONS: readonly string[] = [LEGAL_REASON, DISPUTE_REASON, OLD_LEGAL_REASON];

/** Check 10 P10: plain, kind reasons with no dashes. */
export const COMPLAINT_REASON = "A complaint. You'll want to answer this one yourself.";
export const LOW_CONFIDENCE_REASON = "Not sure what this one is. Have a look.";
export const UNREADABLE_REASON = "Couldn't sort this one. Have a look.";
export const MODEL_FLAG_REASON = "The assistant thinks you should see this one.";

/**
 * Check 41 P5: the big-job reason. The backfill reads only 30 days, and seasonal trades hear
 * from most customers once a year, so until a year of mail is read it never says "new".
 */
export const BIG_JOB_UNREAD_REASON =
  "Big job from someone who hasn't written in the mail we've read so far.";
export const BIG_JOB_NEW_REASON = "Big job from someone new.";
export function bigJobReason(historyDays: number | undefined): string {
  return historyDays !== undefined && historyDays >= 365
    ? BIG_JOB_NEW_REASON
    : BIG_JOB_UNREAD_REASON;
}

/** Below this, the owner looks. */
export const CONFIDENCE_THRESHOLD = 0.6;
/** Enough of the email to classify it; long quoted chains add nothing. */
export const MAX_CLASSIFY_BODY_CHARS = 6_000;

export type Classification = {
  category: Category;
  priority: "high" | "normal" | "low";
  needsOwner: boolean;
  needsOwnerReason: string | null;
  summary: string;
  confidence: number;
  extracted: Extracted;
  /** true when the model output couldn't be used and we flagged instead of guessing. */
  unreadable: boolean;
};

/** Check 22 P3: the whole email the safety checks read, quoted part included. */
export const MAX_FULL_TEXT_CHARS = 20_000;
/** Check 22 P3: how much of the quoted part a short reply shows the model. */
export const MAX_QUOTED_FOR_MODEL_CHARS = 1_500;
/** Check 22 P3: a reply this short may be about "the letter below". */
export const SHORT_REPLY_CHARS = 300;

/**
 * Check 22 P6: Outlook quotes the earlier email under a header block, not "On … wrote:":
 * "From: …" followed within four lines by "Sent:" or "Date:", and "Subject:".
 */
function outlookHeaderAt(lines: string[], i: number): boolean {
  if (!/^\*?From:\*?\s+\S/i.test(lines[i]!.trim())) return false;
  const next = lines.slice(i + 1, i + 5).map((l) => l.trim());
  return (
    next.some((l) => /^\*?(Sent|Date):\*?\s/i.test(l)) &&
    next.some((l) => /^\*?Subject:\*?\s?/i.test(l))
  );
}

/**
 * Split an email into the newest part and what quoting cut off ("On … wrote:", an Outlook
 * "Original Message", "> " lines). The newest part is what the model sorts; the safety checks
 * read both (Check 22 P3).
 */
export function splitQuoted(body: string): { kept: string; removed: string } {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const removed: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (
      /^On .+wrote:\s*$/.test(line.trim()) ||
      /^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim()) ||
      // Check 22 P6: Spanish and Portuguese mail apps, and Outlook's header block.
      /^El .+escribi[oó]:\s*$/i.test(line.trim()) ||
      /^Em .+escreveu:\s*$/i.test(line.trim()) ||
      // Only below something the sender wrote: a form or lead-site email that starts with
      // labelled "From: / Date: / Subject:" lines is the email itself.
      (out.some((l) => l.trim()) && outlookHeaderAt(lines, i))
    ) {
      removed.push(...lines.slice(i));
      break;
    }
    if (line.trimStart().startsWith(">")) {
      removed.push(line);
      continue;
    }
    out.push(line);
  }
  const tidy = (x: string[]) =>
    x
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  return { kept: tidy(out), removed: tidy(removed) };
}

/** Drop quoted replies ("On … wrote:", "> …") and signature-ish tails, then cap length. */
export function prepareBody(body: string): string {
  return splitQuoted(body).kept.slice(0, MAX_CLASSIFY_BODY_CHARS);
}

/**
 * The rules for needs_owner live in code as well as the prompt: the model
 * suggests, these decide. Order matters only for which reason is shown.
 */
export function applyOwnerRules(
  m: ModelClassification,
  ctx: OwnerRuleContext,
): Pick<Classification, "needsOwner" | "needsOwnerReason" | "priority"> & {
  hits: OwnerRuleKey[];
  /**
   * Check 12 P1: WHY the thread needs the owner, as a content-free code: the rule whose reason is
   * shown, else "model" (the model's own call). Null when it doesn't need the owner. Stored as
   * `extracted.owner_code`; the follow-up scan reads it with `owner_rule_hits`.
   */
  needsOwnerCode: OwnerRuleKey | null;
} {
  const r = ownerRules(m, ctx);
  return { ...r, needsOwnerCode: r.needsOwner ? (r.hits[0] ?? "model") : null };
}

type OwnerRuleContext = {
  /** Check 22 P7: "unknown" (a lead site or voicemail robot) counts as first time. */
  firstTimeSender: boolean | "unknown";
  /**
   * Check 41 P5: days of mail we have for this mailbox (now minus its oldest synced email).
   * Under a year, "first time" only means "not in the mail we've read", so the big-job
   * reason says so. Unknown counts as under a year.
   */
  historyDays?: number;
  senderIsVip: boolean;
  /** Ideas H3: a company-wide "Always needs me" rule matched the sender or reply address. */
  senderNeedsMe?: boolean;
  amountThresholdDollars: number;
  injection?: boolean;
  /** Someone smells gas (round 2, TW B4): top priority, whatever the model said. */
  gasSmell?: boolean;
  /** A carbon monoxide alarm went off (Check 22 P4): like gas, its own reason. */
  coAlarm?: boolean;
  /** Electrical fire signs (Check 37 P1): like gas, its own reason. */
  electricalHazard?: boolean;
  /** Asks to pay a new account (round 2, A11). */
  paymentChange?: boolean;
  /** Check 22 P3: lawyers, liens, small claims found in code anywhere in the email. */
  legalThreat?: boolean;
  /** Check 48 P1: asks whether a person or an AI is answering. */
  asksIfAi?: boolean;
  /**
   * Check 39 P2 + Check 38 P3: amounts that never count toward the limit (whole dollars): a
   * rebate's, a loan's or a tax credit's, and ones the owner already wrote on this
   * conversation (a homeowner repeating the contract total isn't new money).
   */
  ignoreAmounts?: readonly number[];
  /** The water smells like rotten eggs, nothing says gas (Check 36 P1). */
  waterSmell?: boolean;
  /** Leads package: the email came through a phone service or a lead website (code-decided). */
  channel?: { kind: ChannelKind; name: string } | null;
  /** Leads package (B9): a quote request from a town that isn't on the owner's list. */
  outsideArea?: boolean;
};

function ownerRules(
  m: ModelClassification,
  ctx: OwnerRuleContext,
): Pick<Classification, "needsOwner" | "needsOwnerReason" | "priority"> & { hits: OwnerRuleKey[] } {
  // Never let the model's own words explain away an email that tried to instruct it.
  if (ctx.injection) {
    return {
      needsOwner: true,
      needsOwnerReason: INJECTION_REASON,
      priority: ctx.gasSmell || ctx.coAlarm || ctx.electricalHazard ? "high" : "normal",
      hits: ["injection"],
    };
  }
  if (ctx.gasSmell)
    return {
      needsOwner: true,
      needsOwnerReason: GAS_SMELL_REASON,
      priority: "high",
      hits: ["gas"],
    };
  if (ctx.coAlarm)
    return {
      needsOwner: true,
      needsOwnerReason: CO_REASON,
      priority: "high",
      hits: ["co_alarm"],
    };
  if (ctx.electricalHazard)
    return {
      needsOwner: true,
      needsOwnerReason: ELECTRICAL_HAZARD_REASON,
      priority: "high",
      hits: ["electrical"],
    };
  if (ctx.paymentChange)
    return {
      needsOwner: true,
      needsOwnerReason: PAYMENT_CHANGE_REASON,
      priority: "high",
      hits: ["payment_change"],
    };
  if (ctx.asksIfAi)
    return {
      needsOwner: true,
      needsOwnerReason: ASKS_IF_AI_REASON,
      priority: m.priority === "low" ? "normal" : m.priority,
      hits: ["asks_if_ai"],
    };
  // Check 22 P6: junk never needs the owner for an amount alone. Check 39 P2 / 38 P3: program
  // money and the owner's own figures don't count.
  const ignore = new Set((ctx.ignoreAmounts ?? []).map((a) => Math.round(a)));
  const overThreshold =
    m.category !== "noise" &&
    m.extracted.dollar_amounts.some(
      (a) => a > ctx.amountThresholdDollars && !ignore.has(Math.round(a)),
    );
  const confidence = Math.max(0, Math.min(1, m.confidence));
  // Leads package: a lead-site or phone email someone wrote with a job (a phone message about
  // anything but junk or a supplier); an emergency from someone with a job.
  const channel = ctx.channel ?? null;
  const channelLead =
    !!channel &&
    (channel.kind === "site"
      ? isLeadCategory(m.category)
      : m.category !== "noise" && m.category !== "supplier_vendor");
  const emergency = m.extracted.urgency === "emergency" && isLeadCategory(m.category);
  const reasons: [boolean, OwnerRuleKey, string][] = [
    [m.category === "complaint", "complaint", COMPLAINT_REASON],
    [m.signals.mentions_legal || !!ctx.legalThreat, "legal", LEGAL_REASON],
    [m.signals.mentions_refund_or_dispute, "dispute", DISPUTE_REASON],
    [ctx.senderIsVip, "vip", "From someone on your VIP list."],
    [ctx.senderNeedsMe === true, "sender_rule", SENDER_NEEDS_ME_REASON],
    // Check 38 P3: a new customer's big job reads better than "Mentions more than $2,500".
    [
      ctx.firstTimeSender !== false && m.signals.large_request,
      "big_new_job",
      bigJobReason(ctx.historyDays),
    ],
    [
      overThreshold,
      "amount",
      `Mentions more than $${ctx.amountThresholdDollars.toLocaleString("en-US")}.`,
    ],
    [emergency, "emergency", EMERGENCY_REASON],
    [!!ctx.waterSmell, "water_smell", WATER_SMELL_REASON],
    [
      channelLead && channel?.kind !== "site",
      "phone",
      channel?.kind === "phone_text"
        ? "Text message. Text them back from your phone."
        : "Voicemail. Call them back.",
    ],
    [
      channelLead && channel?.kind === "site",
      "site",
      `Came through ${channel?.name ?? "a lead website"}. Answer them there.`,
    ],
    [!!ctx.outsideArea && m.category === "quote_request", "outside_area", OUTSIDE_AREA_REASON],
    [confidence < CONFIDENCE_THRESHOLD, "low_confidence", LOW_CONFIDENCE_REASON],
  ];
  const matched = reasons.filter(([when]) => when);
  const hit = matched[0];
  const hits: OwnerRuleKey[] = [
    ...matched.map(([, key]) => key),
    ...(m.needs_owner ? (["model"] as const) : []),
  ];

  if (m.category === "noise" && !hit) {
    return { needsOwner: false, needsOwnerReason: null, priority: "low", hits };
  }
  if (hit) {
    // A channel, emergency or outside-area rule: always our own fixed words, never the model's
    // prose (which could carry a town or a name past the 30-day purge).
    const fixed = matched.some(([, key]) => FIXED_TEXT_HITS.includes(key));
    return {
      needsOwner: true,
      needsOwnerReason:
        !fixed && m.needs_owner && m.needs_owner_reason ? m.needs_owner_reason : hit[2],
      priority:
        m.category === "complaint" || m.signals.mentions_legal || ctx.legalThreat || emergency
          ? "high"
          : // Check 36 P1: smelly water is worth a call, not a 2am emergency.
            hit[1] === "water_smell"
            ? "normal"
            : m.priority,
      hits,
    };
  }
  return {
    needsOwner: m.needs_owner,
    needsOwnerReason: m.needs_owner ? (m.needs_owner_reason ?? MODEL_FLAG_REASON) : null,
    priority: m.priority,
    hits,
  };
}

const UNREADABLE: Omit<Classification, "summary"> = {
  category: "customer_question",
  priority: "normal",
  needsOwner: true,
  needsOwnerReason: UNREADABLE_REASON,
  confidence: 0,
  extracted: {
    service_requested: null,
    address: null,
    dates: [],
    dollar_amounts: [],
    urgency: "normal",
    permit: null,
    invoice: null,
    invoice_direction: "unknown",
  },
  unreadable: true,
};

/** What `classifyEmail` and `codeOnlyClassification` take besides the email itself. */
export type ClassifyOpts = {
  senderIsVip: boolean;
  senderNeedsMe?: boolean;
  now?: Date;
  /** Older unsorted emails on the thread: checked in code, never sent to the model (B3). */
  alsoCheck?: string[];
  /** Marks the thread already carries, kept whatever this email says (B3). */
  sticky?: { injection?: boolean; paymentChange?: boolean; asksIfAi?: boolean };
  /** Leads package: where the email came from, decided in code from the sender. */
  channel?: { kind: ChannelKind; name: string } | null;
  /** Leads package (B9): the owner's towns; empty = no check. */
  serviceTowns?: readonly string[];
  /** Check 38 P3: dollar amounts the owner already wrote on this conversation. */
  ownerAmounts?: readonly number[];
  /** Check 41 P5: days of mail we have for this mailbox (`applyOwnerRules`' `historyDays`). */
  historyDays?: number;
  /**
   * Check 22 P5: the thread is a supplier's (its stored bills are owed BY the business), so
   * "our bank details changed" counts even without an explicit ask.
   */
  supplierThread?: boolean;
};

/** The checks in code that never wait on the model, over the text the model would read. */
function codeChecks(email: EmailInput, opts: Pick<ClassifyOpts, "alsoCheck" | "sticky">) {
  const split = splitQuoted(email.body);
  const body = split.kept.slice(0, MAX_CLASSIFY_BODY_CHARS);
  // A burst (review B4): earlier unsorted emails minutes before this one are read with it.
  const earlier = (email.earlier ?? [])
    .map((e) => ({ receivedAt: e.receivedAt, body: prepareBody(e.body) }))
    .filter((e) => e.body.length > 0);
  const allText = [email.subject ?? "", ...earlier.map((e) => e.body), body].join("\n");
  const checked = [allText, ...(opts.alsoCheck ?? []).map(prepareBody)].join("\n");
  // Check 22 P3: the whole email, quoted and forwarded parts included ("please read the letter
  // below"), for the safety checks only. The attack check keeps to the newest part: quoted
  // text is often the owner's own words.
  const fullText = [email.subject ?? "", ...(email.earlier ?? []).map((e) => e.body), email.body]
    .join("\n")
    .replace(/\r\n/g, "\n")
    .slice(0, MAX_FULL_TEXT_CHARS);
  // A short reply above a quote: the model sees the start of the quote, in its own block.
  const quoted =
    body.length < SHORT_REPLY_CHARS && split.removed
      ? split.removed.slice(0, MAX_QUOTED_FOR_MODEL_CHARS)
      : null;
  // Checked in code first: the model is the thing being attacked. Every email in the burst,
  // and every older unsorted one the drafter may read.
  const attack = injectionCheck(checked);
  const injection = attack.flagged || opts.sticky?.injection === true;
  // Check 22 P2: why, content-free ("instructions", "encoded", "hidden", "sticky"). The owner may
  // clear only an "instructions" mark: hidden or encoded text is never ordinary.
  const injectionReasons = [
    ...attack.reasons,
    ...(opts.sticky?.injection === true ? ["sticky"] : []),
  ];
  const gasInText = mentionsGasSmell(checked) || mentionsGasSmell(fullText);
  // Check 22 P4: a carbon monoxide alarm; Check 36 P1: rotten-egg WATER with no gas word.
  const coInText = mentionsCarbonMonoxide(checked) || mentionsCarbonMonoxide(fullText);
  // Check 37 P1: electrical fire signs.
  const electricalInText = mentionsElectricalHazard(checked) || mentionsElectricalHazard(fullText);
  const waterInText = !gasInText && mentionsWaterSmell(checked);
  const paymentChangeInText =
    looksLikePaymentChange(checked) ||
    looksLikePaymentChange(fullText) ||
    opts.sticky?.paymentChange === true;
  // Check 48 P1: "am I talking to an AI?" — the newest part (and older unsorted emails), never
  // the quoted text (the owner's own words). Sticky for the thread.
  const asksAi = asksIfAi(checked) || opts.sticky?.asksIfAi === true;
  // Check 22 P3: lawyers, liens, small claims — anywhere in the email, in code.
  const legalThreat = mentionsLegalThreat(checked) || mentionsLegalThreat(fullText);
  const municipalSender = looksMunicipal(email.fromAddress, email.fromName);
  return {
    body,
    earlier,
    quoted,
    legalThreat,
    asksAi,
    allText,
    checked,
    fullText,
    injection,
    injectionReasons,
    gasInText,
    coInText,
    electricalInText,
    waterInText,
    paymentChangeInText,
    municipalSender,
  };
}

/**
 * Without a usable model answer: flag it for the owner rather than guess, with whatever the code
 * checks found (an attack, a gas smell, a CO alarm, a new bank account).
 */
function codeFallback(email: EmailInput, c: ReturnType<typeof codeChecks>): Classification {
  const safety = c.gasInText || c.coInText || c.electricalInText;
  const co = c.coInText && !c.gasInText;
  const electrical = c.electricalInText && !c.gasInText && !co;
  const hits: OwnerRuleKey[] = [
    ...(c.injection ? (["injection"] as const) : []),
    ...(c.gasInText ? (["gas"] as const) : []),
    ...(co ? (["co_alarm"] as const) : []),
    ...(electrical ? (["electrical"] as const) : []),
    ...(c.paymentChangeInText ? (["payment_change"] as const) : []),
  ];
  return {
    ...UNREADABLE,
    ...(c.injection
      ? { needsOwnerReason: INJECTION_REASON }
      : c.gasInText
        ? { needsOwnerReason: GAS_SMELL_REASON }
        : co
          ? { needsOwnerReason: CO_REASON }
          : electrical
            ? { needsOwnerReason: ELECTRICAL_HAZARD_REASON }
            : c.paymentChangeInText
              ? { needsOwnerReason: PAYMENT_CHANGE_REASON }
              : {}),
    ...(safety || c.paymentChangeInText ? { priority: "high" as const } : {}),
    extracted: {
      ...UNREADABLE.extracted,
      // Check 10 P7: nothing was decided by the model; screens say "Couldn't sort".
      unreadable: true,
      ...(safety ? { urgency: "emergency" as const } : {}),
      ...(c.injection ? { injection: true, injection_reasons: c.injectionReasons } : {}),
      ...(c.municipalSender ? { municipal: true } : {}),
      ...(c.gasInText ? { gas_smell: true } : {}),
      ...(co ? { co_alarm: true } : {}),
      ...(electrical ? { electrical_hazard: true } : {}),
      ...(c.waterInText ? { water_smell: true } : {}),
      ...(c.paymentChangeInText ? { payment_change: true } : {}),
      ...(c.asksAi ? { asks_if_ai: true } : {}),
      ...(hits.length ? { owner_rule_hits: hits } : {}),
      // Check 12 P1: unreadable always needs the owner; the first code check, else the model's.
      owner_code: hits[0] ?? "model",
    },
    summary: email.subject ? `Email: ${email.subject}` : "Email with no subject.",
  };
}

/**
 * Check 39 P1: the day's AI limit is used up, but the checks in code still work. Returns a
 * classification only when one of them found something that can't wait for the reset — a gas
 * smell, a carbon monoxide alarm, a new bank account, an attack — shaped like the no-model
 * fallback (needs you, high for safety and payment changes). Null otherwise: the email waits
 * for the model. Pure.
 */
export function codeOnlyClassification(
  email: EmailInput,
  opts: Pick<ClassifyOpts, "alsoCheck" | "sticky"> = {},
): Classification | null {
  const c = codeChecks(email, opts);
  if (!(c.gasInText || c.coInText || c.electricalInText || c.paymentChangeInText || c.injection))
    return null;
  return codeFallback(email, c);
}

/**
 * Classify one inbound email. Output is validated; on failure we retry once,
 * then flag it for the owner rather than guess.
 */
export async function classifyEmail(
  workspaceId: string,
  business: BusinessContext,
  email: EmailInput,
  opts: ClassifyOpts,
): Promise<Classification> {
  const checks = codeChecks(email, opts);
  const {
    body,
    earlier,
    quoted,
    legalThreat,
    asksAi,
    allText,
    checked,
    fullText,
    gasInText,
    coInText,
    electricalInText,
    waterInText,
    paymentChangeInText,
    municipalSender,
  } = checks;
  const preCheck = { flagged: checks.injection };
  const request = {
    workspaceId,
    role: "classify" as const,
    promptVersion: CLASSIFY_PROMPT_VERSION,
    maxTokens: 1024,
    system: [
      { text: CLASSIFY_INSTRUCTIONS, cache: false },
      { text: businessBlock(business), cache: true },
    ],
    user: emailBlock({ ...email, body, earlier, quoted }),
    schema: classificationSchema,
    now: opts.now,
  };

  let result = await callStructured(request);
  if (!result) result = await callStructured(request);
  if (!result) return codeFallback(email, checks);

  const injection = preCheck.flagged || result.signals.tries_to_instruct_assistant;
  const municipal = municipalSender || result.signals.from_building_department;
  // Check 36 P1: when the code read sulfur WATER, the model's gas signal only wins if the email
  // itself names gas or propane somewhere.
  const gasSmell =
    gasInText ||
    (result.signals.smells_gas && (!waterInText || /\b(gas|propane)\b/i.test(checked)));
  const coAlarm = !gasSmell && (coInText || result.signals.co_alarm);
  const electricalHazard = !gasSmell && !coAlarm && electricalInText;
  const waterSmell = !gasSmell && !coAlarm && waterInText;
  // Check 22 P5: a supplier the owner pays (this email sorted as one, or the thread's bills)
  // saying its details changed counts without an explicit "please update".
  const supplier = result.category === "supplier_vendor" || opts.supplierThread === true;
  const paymentChange =
    paymentChangeInText ||
    result.signals.payment_change_request ||
    (supplier &&
      (looksLikePaymentChange(checked, { supplier }) ||
        looksLikePaymentChange(fullText, { supplier })));
  // Round 2 TW A1: "the adjuster approved the claim" is paperwork, not a lawsuit. The legal mark
  // only drops when the model itself calls it routine AND no word of a real dispute or threat
  // is in the email; a refund or dispute signal still stands on its own.
  // Check 22 P3: the code's own legal check (the whole email, quoted part included) always
  // stands.
  const legal =
    legalThreat ||
    (result.signals.mentions_legal &&
      !(result.signals.routine_paperwork && !mentionsRealLegal(allText)));
  const model: ModelClassification = {
    ...result,
    signals: { ...result.signals, mentions_legal: legal },
  };
  const ownerCtx = {
    firstTimeSender: email.firstTimeSender,
    historyDays: opts.historyDays,
    senderIsVip: opts.senderIsVip,
    senderNeedsMe: opts.senderNeedsMe,
    amountThresholdDollars: business.amountThresholdDollars,
    injection,
    gasSmell,
    coAlarm,
    electricalHazard,
    paymentChange,
    legalThreat,
    asksIfAi: asksAi,
    ignoreAmounts: [...incentiveAmounts(allText), ...(opts.ownerAmounts ?? [])],
    waterSmell,
    channel: opts.channel ?? null,
    outsideArea:
      outsideArea({
        category: result.category,
        address: result.extracted.address,
        towns: opts.serviceTowns ?? [],
      }) !== null,
  };
  const { hits, needsOwnerCode, ...rules } = applyOwnerRules(model, ownerCtx);
  // Check 22 P2: what the rules say with the attack mark left out, kept so the owner's "This is
  // a normal email" can put the card right without another model call.
  const withoutInjection = injection
    ? applyOwnerRules(model, { ...ownerCtx, injection: false })
    : null;
  // Building departments are never noise.
  const category: Category =
    municipal && result.category === "noise"
      ? result.extracted.permit?.result === "scheduled"
        ? "scheduling"
        : "customer_question"
      : result.category;
  return {
    category,
    ...rules,
    ...(municipal && rules.priority === "low" ? { priority: "normal" as const } : {}),
    summary: result.summary.trim().slice(0, 300),
    confidence: Math.max(0, Math.min(1, result.confidence)),
    extracted: {
      ...result.extracted,
      ...(gasSmell || coAlarm || electricalHazard ? { urgency: "emergency" as const } : {}),
      ...(injection
        ? {
            injection: true,
            injection_reasons: [
              ...checks.injectionReasons,
              ...(result.signals.tries_to_instruct_assistant ? ["model"] : []),
            ],
          }
        : {}),
      ...(withoutInjection
        ? {
            without_injection: {
              needs_owner: withoutInjection.needsOwner,
              reason: withoutInjection.needsOwnerReason,
              priority: withoutInjection.priority,
              hits: withoutInjection.hits,
            },
          }
        : {}),
      ...(municipal ? { municipal: true } : {}),
      ...(gasSmell ? { gas_smell: true } : {}),
      ...(coAlarm ? { co_alarm: true } : {}),
      ...(electricalHazard ? { electrical_hazard: true } : {}),
      ...(waterSmell ? { water_smell: true } : {}),
      ...(paymentChange ? { payment_change: true } : {}),
      ...(asksAi ? { asks_if_ai: true } : {}),
      // Signals only — they never change needs_owner (applyOwnerRules ignores them).
      ...(result.signals.accepts_quote ? { accepts_quote: true } : {}),
      ...(result.signals.job_done ? { job_done: true } : {}),
      // Check 21 P1: inert until the classify prompt's schema carries the signal.
      ...((result.signals as { acknowledgment_only?: unknown }).acknowledgment_only === true
        ? { acknowledgment_only: true }
        : {}),
      ...(result.signals.routine_paperwork ? { routine_paperwork: true } : {}),
      ...(result.signals.mentions_refund_or_dispute || legal ? { disputed: true } : {}),
      owner_rule_hits: hits,
      ...(needsOwnerCode ? { owner_code: needsOwnerCode } : {}),
      // Check 21 P2: read loosely, so a classify version without them simply has none.
      ...followupSignalsOf(result, opts.now ?? new Date()),
    },
    unreadable: false,
  };
}
