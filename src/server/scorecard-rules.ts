/**
 * Plan #32 / #33: the weekly scorecard and response time, as pure rules. Weeks run Monday
 * 00:00 → next Monday 00:00 in the owner's time zone (DST-safe: built with atLocalHour).
 * Every sentence here is numbers and fixed words only — never a name or an email's text.
 */
import { atLocalHour, localWeekday, usableTimeZone } from "./snooze-rules";

export { localWeekday } from "./snooze-rules";

/** This week (Monday 00:00 local → next Monday 00:00 local) and when last week began. */
export function weekBounds(
  now: Date,
  timeZone: string,
): { start: Date; end: Date; lastStart: Date } {
  const tz = usableTimeZone(timeZone);
  const back = localWeekday(now, tz) - 1;
  return {
    start: atLocalHour(now, tz, -back, 0),
    end: atLocalHour(now, tz, 7 - back, 0),
    lastStart: atLocalHour(now, tz, -back - 7, 0),
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A duration in plain words: "under a minute", "45 min", "2 h 10 min", "1 day 3 h", "3 days". */
export function formatDuration(minutes: number): string {
  const m = Math.round(Math.max(0, minutes));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }
  const totalHours = Math.round(m / 60);
  const days = Math.floor(totalHours / 24);
  const h = totalHours % 24;
  return h ? `${plural(days, "day")} ${h} h` : plural(days, "day");
}

/** The average gap in whole minutes, or null when there is nothing to average. */
export function averageMinutes(pairs: { from: Date; to: Date }[]): number | null {
  if (pairs.length === 0) return null;
  const total = pairs.reduce(
    (sum, p) => sum + Math.max(0, p.to.getTime() - p.from.getTime()) / 60_000,
    0,
  );
  return Math.round(total / pairs.length);
}

/**
 * "You answered quote requests in 2 h 10 min on average this week (last week: 3 h 40 min)."
 * With nothing answered: "No quote requests answered yet this week." Requests still
 * waiting are always said out loud, so a fast average can't hide them.
 */
export function responseTimeSentence(
  thisWeek: { avgMinutes: number | null; unanswered: number },
  lastWeek: { avgMinutes: number | null } | null,
  period: "this week" | "last week" = "this week",
): string {
  const before = period === "this week" ? "last week" : "the week before";
  let s =
    thisWeek.avgMinutes == null
      ? period === "this week"
        ? "No quote requests answered yet this week."
        : "No quote requests answered last week."
      : `You answered quote requests in ${formatDuration(thisWeek.avgMinutes)} on average ${period}` +
        (lastWeek?.avgMinutes != null
          ? ` (${before}: ${formatDuration(lastWeek.avgMinutes)}).`
          : ".");
  const n = Math.max(0, Math.round(thisWeek.unanswered));
  if (n > 0) s += ` ${n} ${n === 1 ? "is" : "are"} still waiting for an answer.`;
  return s;
}

/** The time-saved estimate in words: "about 9 minutes", "about 1.5 hours". */
export function timeSavedPhrase(minutes: number): string {
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round((minutes / 60) * 2) / 2;
  return `about ${hours} hour${hours === 1 ? "" : "s"}`;
}
