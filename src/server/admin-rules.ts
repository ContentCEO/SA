import { pricing } from "@/config/pricing";

const EVALUATION_DAYS = pricing.evaluationDays;

/**
 * Pure helpers for /admin wording and its "Needs you" box. No database, no server-only: the
 * page and the tests both use them.
 */

/** Check 17 P2: what Davi reads before pausing. Pausing never touches Stripe. */
export const PAUSE_EXPLAIN = "Stops reading, drafting and sending. Nothing is deleted.";
export const PAUSE_EXPLAIN_BILLED =
  "Stops reading, drafting and sending. Nothing is deleted. Their Stripe plan keeps charging. Pause or cancel it in Stripe if they shouldn't pay while paused.";

export function pauseExplanation(hasSubscription: boolean): string {
  return hasSubscription ? PAUSE_EXPLAIN_BILLED : PAUSE_EXPLAIN;
}

/** Check 17 P2: on a paused account's card while Stripe still has a live plan for it. */
export const STILL_BILLED_LINE = "Still billed in Stripe";

/** Check 17 P7: in place of the plan picker when Stripe has a subscription for the account. */
export const PLAN_SET_BY_STRIPE_LINE =
  "Plan is set by their Stripe subscription. Change it in Stripe, or they can use Manage billing.";

/** Check 17 P7: the plan's name from the price list ("Crew"), not its id. */
export function planName(plan: string | null, plans: Record<string, { name: string }>): string {
  if (!plan) return "None yet";
  return plans[plan]?.name ?? plan;
}

/** Check 17 P4: on a card whose account has two live Stripe subscriptions. */
export const TWO_PLANS_LINE = "Two live Stripe plans: cancel one in Stripe";

/** Check 17 P4: in Payments, when a live plan or paid checkout matched no account here. */
export const ORPHAN_PLAN_LINE = "A Stripe plan has no account here. Check Stripe.";

/**
 * Check 16 P3: the "Needs you" box at the top of /admin. Counts only, never names; each line
 * links to where Davi acts on it. Lines appear only above zero, in this fixed order.
 */
export type NeedsYouInput = {
  growthCalls: number;
  newSignups: number;
  stuckInboxes: number;
  paymentsFailed: number;
  trialsEndingSoon: number;
};
export type NeedsYouLine = { key: keyof NeedsYouInput; text: string; count: number; href: string };

const NEEDS_YOU: Array<{ key: keyof NeedsYouInput; label: string; href: string }> = [
  { key: "growthCalls", label: "Growth calls to return", href: "#waitlist" },
  { key: "newSignups", label: "New sign-ups to invite", href: "#waitlist" },
  { key: "stuckInboxes", label: "Inboxes stuck", href: "#accounts" },
  { key: "paymentsFailed", label: "Payments failed", href: "#accounts" },
  { key: "trialsEndingSoon", label: "Trials ending in the next 24 hours", href: "#accounts" },
];

export const NOTHING_NEEDS_YOU = "Nothing needs you right now.";

export function needsYou(input: NeedsYouInput): NeedsYouLine[] {
  return NEEDS_YOU.filter((l) => input[l.key] > 0).map((l) => ({
    key: l.key,
    text: `${l.label}: ${input[l.key]}`,
    count: input[l.key],
    href: l.href,
  }));
}

/**
 * Check 16 P6: after a move or a plan change Davi lands back on that card, with a notice naming
 * it. Only the workspace's uuid travels in the URL; the name comes from the loaded row. An
 * unknown or malformed `w`, or a code with no card wording, gives null (the page then shows its
 * usual top notice, if any).
 */
export type CardNoticeRow = {
  workspaceId: string;
  businessName: string | null;
  ownerEmail: string;
  plan: string | null;
  evaluationEndsAt: Date | null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cardTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function cardNotice(
  params: { done?: unknown; error?: unknown; w?: unknown },
  rows: CardNoticeRow[],
  plans: Record<string, { name: string }>,
): { workspaceId: string; text: string; strong: boolean } | null {
  if (typeof params.w !== "string" || !UUID.test(params.w)) return null;
  const row = rows.find((r) => r.workspaceId === params.w);
  if (!row) return null;
  const name = row.businessName || row.ownerEmail;
  const done = typeof params.done === "string" ? params.done : null;
  const error = typeof params.error === "string" ? params.error : null;
  const texts: Record<string, string> = {
    pause: `Paused ${name}.`,
    resume: `Resumed ${name}.`,
    mark_setup_call_done: `Marked ${name} active.`,
    house_account: `${name} can send now (marked as your own test account).`,
    extend_evaluation: `Added ${EVALUATION_DAYS} days for ${name}.${
      row.evaluationEndsAt ? ` Trial now ends ${cardTime.format(row.evaluationEndsAt)}.` : ""
    }`,
    plan: row.plan
      ? `Plan saved for ${name}: ${plans[row.plan]?.name ?? row.plan}.`
      : `Plan removed for ${name}.`,
  };
  const errorTexts: Record<string, string> = {
    move: `That change isn't allowed for ${name} from its current status. Look again.`,
    plan_stripe: `${name} pays through Stripe, so its plan follows the subscription. Change it in Stripe.`,
  };
  if (done && texts[done])
    return { workspaceId: row.workspaceId, text: texts[done], strong: false };
  if (error && errorTexts[error]) {
    return { workspaceId: row.workspaceId, text: errorTexts[error], strong: true };
  }
  return null;
}

/**
 * Check 16 P8: one activity row on the support page, in plain words. Only the action, who did
 * it, when, and a few fixed detail keys (statuses, plans, codes) — never a customer's name.
 */
export type SupportActivity = {
  action: string;
  actor: "owner" | "squared_away";
  createdAt: Date;
  detail: {
    move?: unknown;
    from?: unknown;
    to?: unknown;
    plan?: unknown;
    kind?: unknown;
    autopilot?: unknown;
    stripeStatus?: unknown;
    code?: unknown;
    by?: unknown;
  };
};

/** The detail keys the support page may read (never thread ids or anything from an email). */
export const SUPPORT_DETAIL_KEYS = [
  "move",
  "from",
  "to",
  "plan",
  "kind",
  "autopilot",
  "stripeStatus",
  "code",
  "by",
] as const;

const ACTION_WORDS: Record<string, string> = {
  reply_sent: "Reply sent",
  workspace_status_changed: "Status changed",
  subscription_changed: "Stripe plan changed",
  plan_changed: "Plan changed",
  payment_received: "Payment received",
  digest_sent: "Morning email sent",
  mailbox_access_lost: "Gmail access lost",
  mailbox_connected: "Gmail connected",
  mailbox_reconnected: "Gmail reconnected",
  mailbox_disconnected: "Gmail disconnected",
  evaluation_started: "Trial started",
  evaluation_expired: "Trial ended",
  draft_created: "Draft written",
  draft_discarded: "Draft discarded",
};

const words = (v: unknown) =>
  typeof v === "string" ? v.replace(/_/g, " ") : typeof v === "number" ? String(v) : null;
const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

const supportTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function supportSentence(a: SupportActivity): string {
  const base = ACTION_WORDS[a.action] ?? capital(words(a.action) ?? "Something happened");
  const by =
    a.detail.by === "admin"
      ? "by you"
      : a.detail.by === "stripe"
        ? "by Stripe"
        : a.actor === "owner"
          ? "by owner"
          : a.detail.autopilot === true
            ? "by autopilot"
            : "by Squared Away";
  const from = words(a.detail.from);
  const to = words(a.detail.to);
  const extra = [
    from && to ? `${from} -> ${to}` : to ? `to ${to}` : null,
    !to && words(a.detail.plan) ? `plan ${words(a.detail.plan)}` : null,
    words(a.detail.stripeStatus) ? `Stripe says ${words(a.detail.stripeStatus)}` : null,
    words(a.detail.code) ? `code ${words(a.detail.code)}` : null,
  ].filter(Boolean);
  return `${base} ${by}${extra.length ? `: ${extra.join(", ")}` : ""} · ${supportTime.format(a.createdAt)}`;
}

/** /admin's status names, shared with the support page and /admin/costs (Check 16 P8, P10). */
export const statusLabel: Record<
  | "invited"
  | "evaluating"
  | "evaluation_expired"
  | "setup_paid"
  | "active"
  | "past_due"
  | "canceled"
  | "paused",
  string
> = {
  invited: "Invited",
  evaluating: "Evaluating",
  evaluation_expired: "Evaluation over",
  setup_paid: "Setup paid",
  active: "Active",
  past_due: "Past due",
  canceled: "Canceled",
  paused: "Paused",
};
