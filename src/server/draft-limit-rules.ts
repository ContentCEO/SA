/**
 * Check 40 P3: what the owner reads when their hourly "Draft a reply" limit is reached — the
 * true time they can ask again, in their own time zone (the window ends on the hour).
 */
export const DRAFT_LIMIT_ERROR = "draft_limit";

/** When the window ends, as epoch milliseconds for the URL (`until`). */
export function draftLimitUntil(retryAfterSec: number | undefined, now: Date = new Date()): number {
  return now.getTime() + Math.max(1, retryAfterSec ?? 60 * 60) * 1000;
}

/** "You've asked for a lot of drafts this hour. You can ask again at 10:00am." */
export function draftLimitText(until: unknown, timeZone: string, now: Date = new Date()): string {
  const first = "You've asked for a lot of drafts this hour.";
  const ms = Number(until);
  // A missing, garbled or far-off time (the URL is only a hint): no time, still true.
  if (!Number.isFinite(ms) || ms <= now.getTime() || ms - now.getTime() > 2 * 60 * 60_000)
    return `${first} Try again in a little while.`;
  const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone })
    .format(new Date(ms))
    .replace(/\s?([AP])M$/, (_, m: string) => `${m.toLowerCase()}m`);
  return `${first} You can ask again at ${clock}.`;
}
