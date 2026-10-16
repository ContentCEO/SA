import { relativeTime } from "@/lib/relative-time";

/**
 * Round 2, "First week" review (FW): pure rules and wording for a new owner's first days.
 * No `server-only`, no database (tests read it directly).
 */

/**
 * FW E11 "I called them": the owner's phone call counts as their answer while it's newer than
 * the customer's newest email. A later email from the customer starts things over.
 */
export function answeredByPhone(handledAt: Date | null, lastInAt: Date | null): boolean {
  if (!handledAt) return false;
  return !lastInAt || handledAt.getTime() >= lastInAt.getTime();
}

/** FW E9: how old the customer's email is, on every card ("Wrote 9 days ago"). */
export function wroteLine(sentAt: Date | null, now: Date = new Date()): string | null {
  return sentAt ? `Wrote ${relativeTime(sentAt, now)}` : null;
}

/** FW D1/D2: the "your last 30 days" card shows on the queue for this long after the first read. */
export const FIRST_LOOK_DAYS = 7;

/**
 * Only accounts this new get the first-week emails and cards: a Gmail reconnected months later
 * is read again, and that's not a first week.
 */
export const NEW_ACCOUNT_DAYS = 14;

export function isNewAccount(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() < NEW_ACCOUNT_DAYS * 86_400_000;
}

export function showFirstLook(f: {
  firstReadAt: Date | null;
  hiddenAt: Date | null;
  readOnly: boolean;
  now: Date;
  /** When the account was created (no card for old accounts that reconnect). */
  accountCreatedAt?: Date;
}): boolean {
  if (!f.firstReadAt || f.hiddenAt || f.readOnly) return false;
  if (f.accountCreatedAt && !isNewAccount(f.accountCreatedAt, f.now)) return false;
  return f.now.getTime() - f.firstReadAt.getTime() < FIRST_LOOK_DAYS * 86_400_000;
}

export type FirstLookCounts = {
  /** Emails read from the last 30 days (both directions). */
  read: number;
  /** Customer emails from the last two weeks that were sorted. */
  sorted: number;
  quoteRequests: number;
  /** Quote requests where the customer wrote last and no draft is waiting. */
  unansweredQuotes: number;
  invoices: number;
  complaints: number;
  junk: number;
  /** Quotes the owner answered that have gone quiet, with no nudge yet. */
  quietQuotes: number;
};

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * FW D1: plain lines, counts only. Honest about the two windows: we read 30 days, but only the
 * last two weeks were sorted (older mail is never sent to the AI on the first pass).
 */
export function firstLookLines(c: FirstLookCounts, sortDays: number): string[] {
  const parts = [
    c.quoteRequests
      ? `${n(c.quoteRequests, "quote request", "quote requests")}${
          c.unansweredQuotes ? ` (${c.unansweredQuotes} with no answer or draft yet)` : ""
        }`
      : null,
    c.invoices ? n(c.invoices, "invoice or payment email", "invoice or payment emails") : null,
    c.complaints ? n(c.complaints, "complaint", "complaints") : null,
    c.junk ? `${c.junk} junk` : null,
  ].filter(Boolean);
  return [
    `We read ${n(c.read, "email", "emails")} from the last 30 days.`,
    c.sorted
      ? `From the last ${sortDays === 14 ? "two weeks" : `${sortDays} days`}, we sorted ${n(
          c.sorted,
          "conversation",
          "conversations",
        )}${parts.length ? `: ${parts.join(", ")}.` : "."}`
      : `Nothing from the last ${sortDays === 14 ? "two weeks" : `${sortDays} days`} needed sorting.`,
  ];
}

/** FW D2: "found money", only when there is some. Null = no offer. */
export function foundMoneyLine(c: Pick<FirstLookCounts, "unansweredQuotes" | "quietQuotes">) {
  const total = c.unansweredQuotes + c.quietQuotes;
  if (!total) return null;
  const bits = [
    c.unansweredQuotes
      ? `${n(c.unansweredQuotes, "quote request", "quote requests")} still ${c.unansweredQuotes === 1 ? "has" : "have"} no answer`
      : null,
    c.quietQuotes
      ? `${n(c.quietQuotes, "quote you sent", "quotes you sent")} never got a follow-up`
      : null,
  ].filter(Boolean);
  return `${bits.join(", and ")}. Want drafts? You check each one before anything goes out.`;
}

/** At most this many drafts from one "Draft them" tap (FW D2). */
export const FOUND_MONEY_MAX = 10;

/** FW F2: the trial's last day — the banner changes inside this window. */
export const LAST_DAY_MS = 24 * 60 * 60 * 1000;

export function isLastDay(msLeft: number): boolean {
  return msLeft > 0 && msLeft <= LAST_DAY_MS;
}

/** FW F2: what the three days did, counts only. Null when nothing happened yet. */
export function trialSoFarLine(c: { sorted: number; drafted: number }): string | null {
  if (!c.sorted && !c.drafted) return null;
  const bits = [
    c.sorted ? `sorted ${n(c.sorted, "email", "emails")}` : null,
    c.drafted ? `written ${n(c.drafted, "draft", "drafts")}` : null,
  ].filter(Boolean);
  return `So far it has ${bits.join(" and ")} for you.`;
}

/** FW E7/F6: what an expired or stopped account still has waiting. Null when nothing is. */
export function waitingLine(c: { drafts: number; needsYou: number }): string | null {
  const bits = [
    c.drafts ? `${n(c.drafts, "reply", "replies")} drafted` : null,
    c.needsYou
      ? `${n(c.needsYou, "email", "emails")} that need${c.needsYou === 1 ? "s" : ""} you`
      : null,
  ].filter(Boolean);
  return bits.length ? `Waiting for you: ${bits.join(" and ")}.` : null;
}

/**
 * FW A1: the invite email. Nothing anyone typed goes in it (the address is the only thing that
 * came from the waitlist form), so it can't carry a stranger's text.
 */
export function inviteEmailCopy(o: {
  signInUrl: string;
  operatorFirstName: string;
  phone: string;
}) {
  return {
    subject: "You're in: your Squared Away invite",
    serif: "you're in,",
    heavy: "here's how to start.",
    lines: [
      `${o.operatorFirstName} has let you into Squared Away. Sign in with Google using this email address.`,
      "Setting up takes about 10 minutes. Have these handy: the password for the Gmail you run the business from, and your price list if you have one.",
      "For your first three days it reads your email and writes drafts for you to check. It won't send anything to a customer during those days.",
    ],
    button: { label: "Sign in", url: o.signInUrl },
    footer: `Questions? Call or text ${o.operatorFirstName} at ${o.phone}.`,
  };
}

/** FW D4: once, when the first read and the voice learning are done and drafts are waiting. */
export function firstDraftsEmailCopy(o: { queueUrl: string; drafts: number }) {
  return {
    subject: "Your first drafts are ready to check",
    serif: "all read,",
    heavy: "your first drafts are ready.",
    lines: [
      `Squared Away read your email and wrote ${n(o.drafts, "draft", "drafts")} in your own words.`,
      "Nothing has been sent. Each one waits for you to check it.",
    ],
    button: { label: "Open my queue", url: o.queueUrl },
    footer: "We send this once, when your inbox is first read.",
  };
}

/** FW K7: Davi's notice that an owner paid. Content-free: who it is stays on the admin page. */
export function paymentNoticeCopy(o: {
  planName: string | null;
  includesSetup: boolean;
  adminUrl: string;
}) {
  return {
    subject: "A payment came in",
    serif: "paid,",
    heavy: "book the setup call.",
    lines: [
      `An owner just paid${o.planName ? ` for the ${o.planName} plan` : ""}${
        o.includesSetup ? ", with the setup fee" : ""
      }. Sending is on for them now.`,
      "Open the admin page to see who it is and call them to book the setup call.",
    ],
    button: { label: "Open admin", url: o.adminUrl },
    footer: "Names and numbers stay in the admin page, not in this email.",
  };
}
