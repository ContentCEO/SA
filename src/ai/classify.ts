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
} from "./prompts/classify.v1";

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
  extracted: ModelClassification["extracted"];
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
  ctx: { firstTimeSender: boolean; senderIsVip: boolean; amountThresholdDollars: number },
): Pick<Classification, "needsOwner" | "needsOwnerReason" | "priority"> {
  const overThreshold = m.extracted.dollar_amounts.some((a) => a > ctx.amountThresholdDollars);
  const confidence = Math.max(0, Math.min(1, m.confidence));
  const reasons: [boolean, string][] = [
    [m.category === "complaint", "Complaint — you'll want to handle this yourself."],
    [m.signals.mentions_legal, "Mentions something legal."],
    [m.signals.mentions_refund_or_dispute, "Asks for money back or disputes a charge."],
    [ctx.senderIsVip, "From someone on your VIP list."],
    [overThreshold, `Mentions more than $${ctx.amountThresholdDollars.toLocaleString("en-US")}.`],
    [ctx.firstTimeSender && m.signals.large_request, "New customer asking about a big job."],
    [confidence < CONFIDENCE_THRESHOLD, "Not sure what this one is — take a look."],
  ];
  const hit = reasons.find(([when]) => when);

  if (m.category === "noise" && !hit) {
    return { needsOwner: false, needsOwnerReason: null, priority: "low" };
  }
  if (hit) {
    return {
      needsOwner: true,
      needsOwnerReason: m.needs_owner && m.needs_owner_reason ? m.needs_owner_reason : hit[1],
      priority: m.category === "complaint" || m.signals.mentions_legal ? "high" : m.priority,
    };
  }
  return {
    needsOwner: m.needs_owner,
    needsOwnerReason: m.needs_owner ? (m.needs_owner_reason ?? "Take a look at this one.") : null,
    priority: m.priority,
  };
}

const UNREADABLE: Omit<Classification, "summary"> = {
  category: "customer_question",
  priority: "normal",
  needsOwner: true,
  needsOwnerReason: "Couldn't sort this one automatically — take a look.",
  confidence: 0,
  extracted: {
    service_requested: null,
    address: null,
    dates: [],
    dollar_amounts: [],
    urgency: "normal",
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
  opts: { senderIsVip: boolean; now?: Date },
): Promise<Classification> {
  const request = {
    workspaceId,
    role: "classify" as const,
    promptVersion: CLASSIFY_PROMPT_VERSION,
    maxTokens: 1024,
    system: [
      { text: CLASSIFY_INSTRUCTIONS, cache: false },
      { text: businessBlock(business), cache: true },
    ],
    user: emailBlock({ ...email, body: prepareBody(email.body) }),
    schema: classificationSchema,
    now: opts.now,
  };

  let result = await callStructured(request);
  if (!result) result = await callStructured(request);
  if (!result) {
    return {
      ...UNREADABLE,
      summary: email.subject ? `Email: ${email.subject}` : "Email with no subject.",
    };
  }

  const rules = applyOwnerRules(result, {
    firstTimeSender: email.firstTimeSender,
    senderIsVip: opts.senderIsVip,
    amountThresholdDollars: business.amountThresholdDollars,
  });
  return {
    category: result.category,
    ...rules,
    summary: result.summary.trim().slice(0, 300),
    confidence: Math.max(0, Math.min(1, result.confidence)),
    extracted: result.extracted,
    unreadable: false,
  };
}
