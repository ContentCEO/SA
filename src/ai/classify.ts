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
} from "./prompts/classify.v4";
import { SENDER_NEEDS_ME_REASON } from "@/server/owner-sender-rule-rules";
import {
  GAS_SMELL_REASON,
  INJECTION_REASON,
  injectionCheck,
  looksLikePaymentChange,
  looksMunicipal,
  mentionsGasSmell,
  mentionsRealLegal,
  PAYMENT_CHANGE_REASON,
} from "./guards";
import { isLeadCategory } from "@/config/categories";
import { EMERGENCY_REASON } from "@/server/emergency-rules";
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
  quote_accepted?: boolean;
  /** When the acceptance email was written (ISO), kept with `quote_accepted`. */
  quote_accepted_at?: string;
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
  /** Round 2 TW B4: someone smells gas. Only ever present as `true`. */
  gas_smell?: boolean;
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
   * Leads package: every owner rule this email matched, as fixed content-free keys
   * (`OWNER_RULE_KEYS`). Cards read these, never the reason text.
   */
  owner_rule_hits?: string[];
};

/** The owner-rule keys, in display order (leads package §1g). */
export const OWNER_RULE_KEYS = [
  "injection",
  "gas",
  "payment_change",
  "complaint",
  "legal",
  "dispute",
  "vip",
  "sender_rule",
  "amount",
  "big_new_job",
  "emergency",
  "phone",
  "site",
  "outside_area",
  "low_confidence",
  "model",
] as const;
export type OwnerRuleKey = (typeof OWNER_RULE_KEYS)[number];
/** Hits whose fixed text always wins over the model's own reason (no town or name rides along). */
const FIXED_TEXT_HITS: readonly OwnerRuleKey[] = ["emergency", "phone", "site", "outside_area"];

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

/** Drop quoted replies ("On … wrote:", "> …") and signature-ish tails, then cap length. */
export function prepareBody(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (
      /^On .+wrote:\s*$/.test(line.trim()) ||
      /^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim())
    )
      break;
    if (line.trimStart().startsWith(">")) continue;
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_CLASSIFY_BODY_CHARS);
}

/**
 * The rules for needs_owner live in code as well as the prompt: the model
 * suggests, these decide. Order matters only for which reason is shown.
 */
export function applyOwnerRules(
  m: ModelClassification,
  ctx: {
    firstTimeSender: boolean;
    senderIsVip: boolean;
    /** Ideas H3: a company-wide "Always needs me" rule matched the sender or reply address. */
    senderNeedsMe?: boolean;
    amountThresholdDollars: number;
    injection?: boolean;
    /** Someone smells gas (round 2, TW B4): top priority, whatever the model said. */
    gasSmell?: boolean;
    /** Asks to pay a new account (round 2, A11). */
    paymentChange?: boolean;
    /** Leads package: the email came through a phone service or a lead website (code-decided). */
    channel?: { kind: ChannelKind; name: string } | null;
    /** Leads package (B9): a quote request from a town that isn't on the owner's list. */
    outsideArea?: boolean;
  },
): Pick<Classification, "needsOwner" | "needsOwnerReason" | "priority"> & { hits: OwnerRuleKey[] } {
  // Never let the model's own words explain away an email that tried to instruct it.
  if (ctx.injection) {
    return {
      needsOwner: true,
      needsOwnerReason: INJECTION_REASON,
      priority: ctx.gasSmell ? "high" : "normal",
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
  if (ctx.paymentChange)
    return {
      needsOwner: true,
      needsOwnerReason: PAYMENT_CHANGE_REASON,
      priority: "high",
      hits: ["payment_change"],
    };
  const overThreshold = m.extracted.dollar_amounts.some((a) => a > ctx.amountThresholdDollars);
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
    [m.signals.mentions_legal, "legal", LEGAL_REASON],
    [m.signals.mentions_refund_or_dispute, "dispute", DISPUTE_REASON],
    [ctx.senderIsVip, "vip", "From someone on your VIP list."],
    [ctx.senderNeedsMe === true, "sender_rule", SENDER_NEEDS_ME_REASON],
    [
      overThreshold,
      "amount",
      `Mentions more than $${ctx.amountThresholdDollars.toLocaleString("en-US")}.`,
    ],
    [
      ctx.firstTimeSender && m.signals.large_request,
      "big_new_job",
      "New customer asking about a big job.",
    ],
    [emergency, "emergency", EMERGENCY_REASON],
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
        m.category === "complaint" || m.signals.mentions_legal || emergency ? "high" : m.priority,
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

/**
 * Classify one inbound email. Output is validated; on failure we retry once,
 * then flag it for the owner rather than guess.
 */
export async function classifyEmail(
  workspaceId: string,
  business: BusinessContext,
  email: EmailInput,
  opts: {
    senderIsVip: boolean;
    senderNeedsMe?: boolean;
    now?: Date;
    /** Older unsorted emails on the thread: checked in code, never sent to the model (B3). */
    alsoCheck?: string[];
    /** Marks the thread already carries, kept whatever this email says (B3). */
    sticky?: { injection?: boolean; paymentChange?: boolean };
    /** Leads package: where the email came from, decided in code from the sender. */
    channel?: { kind: ChannelKind; name: string } | null;
    /** Leads package (B9): the owner's towns; empty = no check. */
    serviceTowns?: readonly string[];
  },
): Promise<Classification> {
  const body = prepareBody(email.body);
  // A burst (review B4): earlier unsorted emails minutes before this one are read with it.
  const earlier = (email.earlier ?? [])
    .map((e) => ({ receivedAt: e.receivedAt, body: prepareBody(e.body) }))
    .filter((e) => e.body.length > 0);
  const allText = [email.subject ?? "", ...earlier.map((e) => e.body), body].join("\n");
  const checked = [allText, ...(opts.alsoCheck ?? []).map(prepareBody)].join("\n");
  // Checked in code first: the model is the thing being attacked. Every email in the burst,
  // and every older unsorted one the drafter may read.
  const injectedText = injectionCheck(checked).flagged;
  const preCheck = { flagged: injectedText || opts.sticky?.injection === true };
  const gasInText = mentionsGasSmell(checked);
  const paymentChangeInText =
    looksLikePaymentChange(checked) || opts.sticky?.paymentChange === true;
  const municipalSender = looksMunicipal(email.fromAddress, email.fromName);
  const request = {
    workspaceId,
    role: "classify" as const,
    promptVersion: CLASSIFY_PROMPT_VERSION,
    maxTokens: 1024,
    system: [
      { text: CLASSIFY_INSTRUCTIONS, cache: false },
      { text: businessBlock(business), cache: true },
    ],
    user: emailBlock({ ...email, body, earlier }),
    schema: classificationSchema,
    now: opts.now,
  };

  let result = await callStructured(request);
  if (!result) result = await callStructured(request);
  if (!result) {
    return {
      ...UNREADABLE,
      ...(preCheck.flagged
        ? { needsOwnerReason: INJECTION_REASON }
        : gasInText
          ? { needsOwnerReason: GAS_SMELL_REASON }
          : paymentChangeInText
            ? { needsOwnerReason: PAYMENT_CHANGE_REASON }
            : {}),
      ...(gasInText || paymentChangeInText ? { priority: "high" as const } : {}),
      extracted: {
        ...UNREADABLE.extracted,
        unreadable: true,
        ...(gasInText ? { urgency: "emergency" as const } : {}),
        ...(preCheck.flagged ? { injection: true } : {}),
        ...(municipalSender ? { municipal: true } : {}),
        ...(gasInText ? { gas_smell: true } : {}),
        ...(paymentChangeInText ? { payment_change: true } : {}),
      },
      summary: email.subject ? `Email: ${email.subject}` : "Email with no subject.",
    };
  }

  const injection = preCheck.flagged || result.signals.tries_to_instruct_assistant;
  const municipal = municipalSender || result.signals.from_building_department;
  const gasSmell = gasInText || result.signals.smells_gas;
  const paymentChange = paymentChangeInText || result.signals.payment_change_request;
  // Round 2 TW A1: "the adjuster approved the claim" is paperwork, not a lawsuit. The legal mark
  // only drops when the model itself calls it routine AND no word of a real dispute or threat
  // is in the email; a refund or dispute signal still stands on its own.
  const legal =
    result.signals.mentions_legal &&
    !(result.signals.routine_paperwork && !mentionsRealLegal(allText));
  const model: ModelClassification = {
    ...result,
    signals: { ...result.signals, mentions_legal: legal },
  };
  const { hits, ...rules } = applyOwnerRules(model, {
    firstTimeSender: email.firstTimeSender,
    senderIsVip: opts.senderIsVip,
    senderNeedsMe: opts.senderNeedsMe,
    amountThresholdDollars: business.amountThresholdDollars,
    injection,
    gasSmell,
    paymentChange,
    channel: opts.channel ?? null,
    outsideArea:
      outsideArea({
        category: result.category,
        address: result.extracted.address,
        towns: opts.serviceTowns ?? [],
      }) !== null,
  });
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
      ...(gasSmell ? { urgency: "emergency" as const } : {}),
      ...(injection ? { injection: true } : {}),
      ...(municipal ? { municipal: true } : {}),
      ...(gasSmell ? { gas_smell: true } : {}),
      ...(paymentChange ? { payment_change: true } : {}),
      // Signals only — they never change needs_owner (applyOwnerRules ignores them).
      ...(result.signals.accepts_quote ? { accepts_quote: true } : {}),
      ...(result.signals.job_done ? { job_done: true } : {}),
      ...(result.signals.routine_paperwork ? { routine_paperwork: true } : {}),
      ...(result.signals.mentions_refund_or_dispute || legal ? { disputed: true } : {}),
      owner_rule_hits: hits,
    },
    unreadable: false,
  };
}
