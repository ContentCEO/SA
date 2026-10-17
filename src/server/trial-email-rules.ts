/**
 * Trial emails (Davi, 2026-10-16: yes). Pure rules and wording; the database side is
 * `trial-emails.ts`. No `server-only`, no database.
 *
 * - Day 1 is the "your first drafts are ready" email that already exists (`sendFirstDraftsReady`):
 *   no second day-1 email.
 * - Day 2: once the trial's second day has started (24 hours after the clock started).
 * - Day 3: on the day the trial ends ("Your trial ends today at 3:00 PM"), or the day before when
 *   it ends too early in the morning to tell them in time ("…ends tomorrow at 6:30 AM").
 * - After: 7 days after an evaluation expired with no payment at all ("Your drafts are still
 *   here"), for one more week only — accounts that ran out long ago never get a late one.
 *
 * Each goes once ever, only at or after the owner's morning-email hour in their own time zone and
 * before 8 PM there — never at night. Counts only: no names, subjects or email text.
 */
import { localParts, usableTimeZone } from "./snooze-rules";

export const TRIAL_EMAIL_KINDS = ["day2", "day3", "after"] as const;
export type TrialEmailKind = (typeof TRIAL_EMAIL_KINDS)[number];
export const isTrialEmailKind = (v: unknown): v is TrialEmailKind =>
  typeof v === "string" && (TRIAL_EMAIL_KINDS as readonly string[]).includes(v);

/** Nothing goes at or after this local hour (texts' quiet hours start at 9 PM). */
export const TRIAL_EMAIL_LAST_HOUR = 20;
/** The day-3 email needs this long between the owner's hour and the end, or it goes the day before. */
export const DAY3_MIN_LEAD_MS = 2 * 60 * 60 * 1000;
/** The "still here" email: this long after the trial ran out… */
export const AFTER_EXPIRY_MS = 7 * 86_400_000;
/** …and only within this window after that (never a late one for an old account). */
export const AFTER_WINDOW_MS = 7 * 86_400_000;

const DAY_MS = 86_400_000;

export type TrialEmailInput = {
  /** The effective status (lifecycle's `effectiveStatus`). */
  status: string;
  evaluationStartedAt: Date | null;
  evaluationEndsAt: Date | null;
  /** Any payment at all: a setup paid (any way), or a subscription. */
  paidAnything: boolean;
  stoppedAt: Date | null;
  sent: readonly string[];
  digestHour: number;
  timeZone: string;
};

/** Minutes past local midnight, in the owner's zone. */
function localMinutes(at: Date, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      hour: "numeric",
      minute: "numeric",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return Number(p.hour) * 60 + Number(p.minute);
}

/** The local date ('YYYY-MM-DD') the day-3 email belongs to. */
export function day3Date(endsAt: Date, timeZone: string, digestHour: number): string {
  const tz = usableTimeZone(timeZone);
  if (localMinutes(endsAt, tz) * 60_000 >= digestHour * 3_600_000 + DAY3_MIN_LEAD_MS)
    return localParts(endsAt, tz).date;
  // Too early in the morning to say "today" in time: the day before.
  return localParts(new Date(endsAt.getTime() - DAY_MS), tz).date;
}

/** Which trial email is due now, if any. One at a time; the caller marks it once Resend took it. */
export function trialEmailDue(f: TrialEmailInput, now: Date): TrialEmailKind | null {
  if (f.stoppedAt || f.paidAnything) return null;
  const tz = usableTimeZone(f.timeZone);
  const { date, hour } = localParts(now, tz);
  if (hour < f.digestHour || hour >= TRIAL_EMAIL_LAST_HOUR) return null;
  const sent = new Set(f.sent);
  if (f.status === "evaluating") {
    if (!f.evaluationEndsAt || now >= f.evaluationEndsAt) return null;
    // The last day's email first; once it went, day 2 never goes after it.
    if (!sent.has("day3") && date >= day3Date(f.evaluationEndsAt, tz, f.digestHour)) return "day3";
    const started = f.evaluationStartedAt ?? new Date(f.evaluationEndsAt.getTime() - 3 * DAY_MS);
    if (!sent.has("day2") && !sent.has("day3") && now.getTime() >= started.getTime() + DAY_MS)
      return "day2";
    return null;
  }
  if (f.status === "evaluation_expired" && f.evaluationEndsAt && !sent.has("after")) {
    const since = now.getTime() - f.evaluationEndsAt.getTime();
    if (since >= AFTER_EXPIRY_MS && since < AFTER_EXPIRY_MS + AFTER_WINDOW_MS) return "after";
  }
  return null;
}

/** "3:00 PM", in the owner's zone. */
export function localClock(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: usableTimeZone(timeZone),
  }).format(at);
}

/**
 * The trial's one honest line about sending (Davi, 2026-10-16: the side door stays). Squared
 * Away's own Send is off during the trial; the drafts are real Gmail drafts, so the owner can
 * send one from Gmail themselves. Used on every screen and email that describes the trial.
 */
export const TRIAL_NO_SEND_LINE =
  "During your three-day trial, Squared Away won't send anything to a customer.";
export const TRIAL_SIDE_DOOR_LINE =
  "Your drafts are in your Gmail Drafts folder too, so you can send one from Gmail yourself if you want.";

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export type TrialEmailCounts = {
  /** Conversations sorted and drafts written since the trial started. */
  sorted: number;
  drafted: number;
  /** What waits in the queue now. */
  waitingDrafts: number;
  needsYou: number;
};

function soFar(c: TrialEmailCounts): string {
  if (!c.sorted && !c.drafted) return "Nothing new has needed sorting yet.";
  const bits = [
    c.sorted ? `sorted ${n(c.sorted, "email", "emails")}` : null,
    c.drafted ? `written ${n(c.drafted, "draft", "drafts")}` : null,
  ].filter(Boolean);
  return `So far Squared Away has ${bits.join(" and ")} for you.`;
}

function waiting(c: TrialEmailCounts): string | null {
  const bits = [
    c.waitingDrafts ? `${n(c.waitingDrafts, "reply", "replies")} drafted` : null,
    c.needsYou
      ? `${n(c.needsYou, "email", "emails")} that need${c.needsYou === 1 ? "s" : ""} you`
      : null,
  ].filter(Boolean);
  return bits.length ? `Waiting for you: ${bits.join(" and ")}.` : null;
}

export type TrialEmailCopy = {
  subject: string;
  serif: string;
  heavy: string;
  lines: string[];
  button: { label: string; url: string };
};

/** The three emails' words. Counts and the owner's own end time only; nothing from any email. */
export function trialEmailCopy(
  kind: TrialEmailKind,
  o: {
    counts: TrialEmailCounts;
    queueUrl: string;
    billingUrl: string;
    /** Day 3: when the trial ends, and whether that's today or tomorrow in their zone. */
    endsAt?: Date;
    timeZone?: string;
    now?: Date;
  },
): TrialEmailCopy {
  const wait = waiting(o.counts);
  if (kind === "day2") {
    return {
      subject: "Day 2 of your Squared Away trial",
      serif: "day 2 of 3,",
      heavy: "here's where things stand.",
      lines: [
        soFar(o.counts),
        ...(wait ? [wait] : []),
        `${TRIAL_NO_SEND_LINE} ${TRIAL_SIDE_DOOR_LINE}`,
      ],
      button: { label: "Open my queue", url: o.queueUrl },
    };
  }
  if (kind === "day3") {
    const tz = o.timeZone ?? "America/New_York";
    const end = o.endsAt ?? new Date();
    const today = localParts(o.now ?? new Date(), tz).date === localParts(end, tz).date;
    const when = `${today ? "today" : "tomorrow"} at ${localClock(end, tz)}`;
    return {
      subject: `Your trial ends ${when}`,
      serif: "last day,",
      heavy: `your trial ends ${today ? "today" : "tomorrow"}.`,
      lines: [
        `Your Squared Away trial ends ${when}.`,
        soFar(o.counts),
        ...(wait ? [wait] : []),
        "Choose a plan to keep it going and to send replies from Squared Away. Every reply still waits for your okay.",
      ],
      button: { label: "Choose a plan", url: o.billingUrl },
    };
  }
  return {
    subject: "Your drafts are still here",
    serif: "still here,",
    heavy: "your drafts are waiting.",
    lines: [
      "Your trial ended a week ago. Everything Squared Away sorted and drafted is still in your account.",
      ...(wait ? [wait] : []),
      "Choose a plan and it picks up where it left off. Every reply still waits for your okay.",
    ],
    button: { label: "Choose a plan", url: o.billingUrl },
  };
}

/** The footer every trial email carries, and the one-click way out. */
export function trialEmailFooter(o: { operatorFirstName: string; phone: string }) {
  return `You're getting this because you're trying Squared Away. Questions? Call or text ${o.operatorFirstName} at ${o.phone}.`;
}
export const STOP_TRIAL_EMAILS_LABEL = "Stop these emails";
