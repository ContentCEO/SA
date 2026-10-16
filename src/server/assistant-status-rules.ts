/**
 * What the owner is told when the assistant can't keep up (review C6, C7), as pure rules.
 * Counts only: never a sender, a subject or any email text.
 */
import { usableTimeZone } from "./snooze-rules";

/** New mail unsorted for longer than this gets a plain line (C7). */
export const UNSORTED_NOTICE_MS = 15 * 60_000;
/** The sweep re-sorts mail that has waited this long (review D4). */
export const UNSORTED_SWEEP_MS = 10 * 60_000;
/** At this share of the daily limit the owner hears about it before it runs out (C6). */
export const AI_LIMIT_WARN_SHARE = 0.8;

export type AssistantNotice = { title: string; body: string };

/** When today's limit starts again: the next midnight UTC, as the owner's clock reads it. */
export function limitResetsAt(now: Date, timeZone: string | null | undefined): string {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
  );
  return new Intl.DateTimeFormat("en-US", {
    timeZone: usableTimeZone(timeZone),
    hour: "numeric",
    minute: "2-digit",
  })
    .format(next)
    .replace(":00", "")
    .replace(" AM", "am")
    .replace(" PM", "pm");
}

/**
 * The one note at the top of every signed-in screen, or null when all's well. A read-only
 * account sorts nothing, so it is never told mail is waiting to be sorted.
 */
export function assistantNotice(o: {
  calls: number;
  cap: number;
  unsorted: number;
  readOnly: boolean;
  now: Date;
  timeZone: string | null | undefined;
}): AssistantNotice | null {
  if (o.readOnly) return null;
  const at = limitResetsAt(o.now, o.timeZone);
  if (o.cap > 0 && o.calls >= o.cap) {
    return {
      title: "Today's assistant limit is used up.",
      body: `Sorting and drafting stop until ${at}, then catch up on their own. New email is safe in Gmail, and anything you've already got here still works.`,
    };
  }
  if (o.unsorted > 0) {
    return {
      title:
        o.unsorted === 1
          ? "1 new email isn't sorted yet."
          : `${o.unsorted} new emails aren't sorted yet.`,
      body: "They're safe in Gmail. We try again every 15 minutes and catch up on our own.",
    };
  }
  if (o.cap > 0 && o.calls >= Math.ceil(o.cap * AI_LIMIT_WARN_SHARE)) {
    return {
      title: "Most of today's assistant limit is used.",
      body: `If it runs out, sorting and drafting stop until ${at}. Nothing is lost; they catch up on their own.`,
    };
  }
  return null;
}
