/**
 * Plan #32 / #33: the weekly scorecard and response time, as pure rules. Weeks run Monday
 * 00:00 → next Monday 00:00 in the owner's time zone (DST-safe: built with atLocalHour).
 * Every sentence here is numbers and fixed words only — never a name or an email's text.
 */
import { MINUTES_PER_SENT_REPLY } from "@/config/drafting";
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
 * With nothing answered: "No quote requests answered yet this week (last week: 3 h 40 min on
 * average)." — so last week's figure is said either way. With none in at all (`answered` and
 * `unanswered` both 0): "No quote requests came in last week." Requests still waiting are always
 * said out loud, so a fast average can't hide them.
 */
export function responseTimeSentence(
  thisWeek: { avgMinutes: number | null; unanswered: number; answered?: number },
  lastWeek: { avgMinutes: number | null } | null,
  period: "this week" | "last week" = "this week",
): string {
  const before = period === "this week" ? "last week" : "the week before";
  const earlier = lastWeek?.avgMinutes != null ? formatDuration(lastWeek.avgMinutes) : null;
  // None came in at all (only known when `answered` is given): say so, rather than "none
  // answered", which reads as if the owner missed some.
  const noneCameIn = thisWeek.answered === 0 && Math.round(thisWeek.unanswered) <= 0;
  let s =
    thisWeek.avgMinutes == null
      ? (noneCameIn
          ? period === "this week"
            ? "No quote requests have come in yet this week"
            : "No quote requests came in last week"
          : period === "this week"
            ? "No quote requests answered yet this week"
            : "No quote requests answered last week") +
        (earlier ? ` (${before}: ${earlier} on average).` : ".")
      : `You answered quote requests in ${formatDuration(thisWeek.avgMinutes)} on average ${period}` +
        (earlier ? ` (${before}: ${earlier}).` : ".");
  const n = Math.max(0, Math.round(thisWeek.unanswered));
  if (n > 0) s += ` ${n} ${n === 1 ? "is" : "are"} still waiting for an answer.`;
  return s;
}

/** "1 quote request from last week is still waiting for an answer." (null when none are) */
export function stillWaitingSentence(
  unanswered: number,
  period: "this week" | "last week",
): string | null {
  const n = Math.max(0, Math.round(unanswered));
  if (n === 0) return null;
  return `${plural(n, "quote request")} from ${period} ${n === 1 ? "is" : "are"} still waiting for an answer.`;
}

/** The time-saved estimate in words: "about 9 minutes", "about 1.5 hours". */
export function timeSavedPhrase(minutes: number): string {
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round((minutes / 60) * 2) / 2;
  return `about ${hours} hour${hours === 1 ? "" : "s"}`;
}

/** A week's numbers (the shape `weeklyScorecard` returns), typed here so this file stays pure. */
export type ScorecardNumbers = {
  repliesSent: number;
  followupsSent: number;
  quotesOut: number;
  response: { avgMinutes: number | null; answered: number; unanswered: number };
  minutesSaved: number;
  /** Ideas C8: quote requests answered within a day, of those that can be judged yet. */
  speed?: QuoteSpeed;
  /** Ideas H8: drafts sent from the app exactly as written, of all sent from the app. */
  asWritten?: AsWritten;
};

/** Ideas C8: "within 24 hours" is calendar time — nights and weekends count. */
export const QUOTE_SPEED_HOURS = 24;
export type QuoteSpeed = { fast: number; counted: number };

/**
 * Of a week's quote requests: answered within 24 hours (`fast`) out of those that can be judged
 * (`counted`): every answered one, plus unanswered ones already older than 24 hours at `now`.
 * One still inside its first day isn't counted yet; one the owner settled without an email isn't
 * counted at all.
 */
export function quoteSpeed(
  pairs: readonly { from: Date; to: Date }[],
  waiting: readonly Date[],
  now: Date,
): QuoteSpeed {
  const limit = QUOTE_SPEED_HOURS * 3_600_000;
  const fast = pairs.filter((p) => p.to.getTime() - p.from.getTime() <= limit).length;
  const late = waiting.filter((w) => now.getTime() - w.getTime() > limit).length;
  return { fast, counted: pairs.length + late };
}

const pct = (n: number, d: number) => Math.round((n / d) * 100);

/**
 * "You answered 4 of 5 quote requests within 24 hours this week (80%) (last week: 3 of 6)."
 * The percent only from 5 counted. Null when nothing can be counted.
 */
export function quoteSpeedSentence(
  week: QuoteSpeed | undefined,
  before: QuoteSpeed | null | undefined,
  period: "this week" | "last week",
): string | null {
  if (!week || week.counted === 0) return null;
  const earlier = period === "this week" ? "last week" : "the week before";
  return (
    `You answered ${week.fast} of ${plural(week.counted, "quote request")} within ${QUOTE_SPEED_HOURS} hours ${period}` +
    (week.counted >= 5 ? ` (${pct(week.fast, week.counted)}%)` : "") +
    (before && before.counted > 0 ? ` (${earlier}: ${before.fast} of ${before.counted})` : "") +
    "."
  );
}

/** Ideas H8: below this many sent from the app, no line (too few to mean anything). */
export const AS_WRITTEN_MIN_SENT = 5;
export type AsWritten = { asWritten: number; counted: number };

/**
 * "7 of 9 drafts went out without changes this week (78%), up from 61% last week." The
 * comparison only when the earlier week also had 5. Null under 5.
 */
export function asWrittenSentence(
  week: AsWritten | undefined,
  before: AsWritten | null | undefined,
  period: "this week" | "last week",
): string | null {
  if (!week || week.counted < AS_WRITTEN_MIN_SENT) return null;
  const now = pct(week.asWritten, week.counted);
  let s = `${week.asWritten} of ${week.counted} drafts went out without changes ${period} (${now}%)`;
  if (before && before.counted >= AS_WRITTEN_MIN_SENT) {
    const then = pct(before.asWritten, before.counted);
    const earlier = period === "this week" ? "last week" : "the week before";
    s +=
      now > then
        ? `, up from ${then}% ${earlier}`
        : now < then
          ? `, down from ${then}% ${earlier}`
          : `, the same as ${earlier}`;
  }
  return `${s}.`;
}

/** Nothing sent, no quotes out and no quote requests in: a week not worth a line. */
export function scorecardIsEmpty(s: ScorecardNumbers): boolean {
  return (
    s.repliesSent === 0 &&
    s.followupsSent === 0 &&
    s.quotesOut === 0 &&
    s.response.answered === 0 &&
    s.response.unanswered === 0
  );
}

/** "Last week: 12 replies sent, 3 follow-ups sent, 4 quotes out." */
export function scorecardCountsLine(
  s: ScorecardNumbers,
  period: "This week" | "Last week",
): string {
  const replies = `${s.repliesSent} ${s.repliesSent === 1 ? "reply" : "replies"}`;
  return `${period}: ${replies} sent, ${plural(s.followupsSent, "follow-up")} sent, ${plural(
    s.quotesOut,
    "quote",
  )} out.`;
}

/** "Time saved: about 45 minutes (an estimate: 3 minutes per reply sent from the app)." */
export function timeSavedLine(minutes: number): string {
  return `Time saved: ${timeSavedPhrase(minutes)} (an estimate: ${MINUTES_PER_SENT_REPLY} minutes per reply sent from the app).`;
}

/**
 * The week in plain sentences — counts and fixed words only, never a name, an address or
 * an email's text: the counts line, the response-time sentence and time saved. With
 * `{ average: false }` (where the average is already said beside this week's) the
 * response-time sentence shrinks to the requests still waiting, which are never dropped.
 */
export function scorecardLines(
  s: ScorecardNumbers,
  period: "This week" | "Last week",
  options: { average?: boolean } = {},
): string[] {
  const lower = period === "This week" ? "this week" : "last week";
  const lines = [scorecardCountsLine(s, period)];
  if (options.average !== false) lines.push(responseTimeSentence(s.response, null, lower));
  else {
    const waiting = stillWaitingSentence(s.response.unanswered, lower);
    if (waiting) lines.push(waiting);
  }
  const speed = quoteSpeedSentence(s.speed, null, lower);
  if (speed) lines.push(speed);
  const written = asWrittenSentence(s.asWritten, null, lower);
  if (written) lines.push(written);
  lines.push(timeSavedLine(s.minutesSaved));
  return lines;
}
