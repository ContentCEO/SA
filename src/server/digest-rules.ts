/**
 * Plan #31: the "Needs you" header at the top of the morning summary, as pure rules.
 * Each line is a fixed noun for the category and how long it has waited — never a name, a
 * subject, a summary or the needs-you reason (some reasons are model-written), because the
 * summary goes through an email provider. Each line links to its card on the queue by the
 * thread's id (a uuid), never anything that identifies the customer.
 */
import type { Category } from "@/ai/prompts/classify.v3";
import { isCategory } from "@/config/categories";
import { localParts } from "./snooze-rules";

/** How many needs-you items the header lists by name of category; the rest are a count. */
export const NEEDS_YOU_HEADER_MAX = 3;

/** One needs-you item as the summary sees it. Deliberately not a QueueItem (no content fits). */
export type NeedsYouItem = {
  threadId: string;
  category: string | null;
  priority: "high" | "normal";
  /** The customer's first message since the owner last wrote; null when the owner wrote last. */
  waitingSince: Date | null;
};

/** A plain noun per category — "An invoice or payment email", never "A invoice / payment". */
export const CATEGORY_NOUN: Record<Category, string> = {
  quote_request: "A quote request",
  customer_question: "A customer question",
  scheduling: "A scheduling email",
  invoice_payment: "An invoice or payment email",
  complaint: "A complaint",
  supplier_vendor: "A supplier email",
  noise: "A notice",
};

export function categoryNoun(category: string | null): string {
  return category && isCategory(category) ? CATEGORY_NOUN[category] : "An email";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A deep link to one card on the queue: `<queue>#t-<uuid>`. Anything but a uuid → the queue. */
export function queueThreadUrl(queueUrl: string, threadId: string): string {
  return UUID.test(threadId) ? `${queueUrl}#t-${threadId.toLowerCase()}` : queueUrl;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Whole days between two local dates ('YYYY-MM-DD'). */
const dayGap = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * How long it has waited, in plain words and the owner's own calendar: "waiting 40 minutes",
 * "waiting 5 hours" (same local day), "waiting since yesterday", "waiting 3 days".
 */
export function waitedPhrase(since: Date, now: Date, timeZone: string): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000));
  if (minutes < 1) return "waiting under a minute";
  if (minutes < 60) return `waiting ${plural(minutes, "minute")}`;
  const days = dayGap(localParts(since, timeZone).date, localParts(now, timeZone).date);
  if (days <= 0) return `waiting ${plural(Math.floor(minutes / 60), "hour")}`;
  if (days === 1) return "waiting since yesterday";
  return `waiting ${days} days`;
}

/** A queue member as the summary sees it: an emergency on the queue is "high" here. */
export function toNeedsYouItem(m: {
  threadId: string;
  category: string | null;
  emergency: boolean;
  waitingSince: Date | null;
}): NeedsYouItem {
  return {
    threadId: m.threadId,
    category: m.category,
    priority: m.emergency ? "high" : "normal",
    waitingSince: m.waitingSince,
  };
}

/**
 * The header's picks, in order: high priority first, then whoever has waited longest (the
 * owner-wrote-last items, with nothing to wait on, last); the first three.
 */
export function headerPicks(items: NeedsYouItem[]): NeedsYouItem[] {
  const rank = (i: NeedsYouItem) => (i.priority === "high" ? 0 : 1);
  const sorted = [...items].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (!a.waitingSince || !b.waitingSince)
      return (a.waitingSince ? 0 : 1) - (b.waitingSince ? 0 : 1);
    return a.waitingSince.getTime() - b.waitingSince.getTime();
  });
  return sorted.slice(0, NEEDS_YOU_HEADER_MAX);
}

/** The ids the header links to — the queue screen always renders these cards. */
export const headerPickIds = (items: NeedsYouItem[]) =>
  new Set(headerPicks(items).map((i) => i.threadId));

/**
 * The header: the picks above as lines with a deep link each, and how many more are in the
 * queue.
 */
export function needsYouHeader(
  items: NeedsYouItem[],
  now: Date,
  timeZone: string,
  threadUrl: (threadId: string) => string,
): { lines: { text: string; href: string }[]; more: number; empty: boolean } {
  const lines = headerPicks(items).map((i) => {
    const noun = categoryNoun(i.category);
    return {
      text: i.waitingSince ? `${noun} — ${waitedPhrase(i.waitingSince, now, timeZone)}` : noun,
      href: threadUrl(i.threadId),
    };
  });
  return {
    lines,
    more: Math.max(0, items.length - NEEDS_YOU_HEADER_MAX),
    empty: items.length === 0,
  };
}

export const NOTHING_NEEDS_YOU = "No emails need a decision from you today.";
export const moreInQueue = (n: number) => `+ ${n} more in your queue`;
