import { localParts, usableTimeZone } from "./snooze-rules";

/**
 * Check 43 P7: a draft is written with that day's date in mind, but it can wait in the queue for
 * days. "Tomorrow works" written on Friday and sent on Monday reads as Tuesday; "I'll call you in
 * a few minutes" sent two hours later is a call that never came. Pure: no database, no clock.
 */

/** Words about the day: stale once the owner's local day has moved on since it was written. */
const DAY_WORDS = [
  "later today",
  "this morning",
  "this afternoon",
  "this evening",
  "this weekend",
  "this week",
  "next week",
  "today",
  "tonight",
  "tomorrow",
  // Spanish and Portuguese (drafts follow the customer's language).
  "esta tarde",
  "hoy",
  "mañana",
  "hoje",
  "amanhã",
];
/** Words about minutes or hours: stale after STALE_SOON_MS, or once the day has moved on. */
const SOON_WORDS = ["in a few minutes", "in a few mins", "in an hour", "shortly", "right away"];
/** The words that name the next day, for "that was Saturday". */
const NEXT_DAY_WORDS = new Set(["tomorrow", "mañana", "amanhã"]);

export const STALE_SOON_MS = 2 * 60 * 60 * 1000;

const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
const found = (body: string, words: readonly string[]) => {
  const hits = words.filter((w) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${escape(w)}(?![\\p{L}\\p{N}])`, "iu").test(body),
  );
  // "later today" already says "today": name the longer phrase only.
  return hits.filter((w) => !hits.some((o) => o !== w && o.includes(w)));
};

export type StaleTiming = {
  /** The time words found, as written in our list ("tomorrow", "in a few minutes"). */
  words: string[];
  /** When it was written, in the owner's words: a weekday, or a clock time on the same day. */
  writtenOn: string;
  /** The weekday "tomorrow" pointed at when it was written; null when no such word is found. */
  meant: string | null;
};

const weekday = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(d);

/** The weekday after a local date ('YYYY-MM-DD'). Calendar math in UTC: no DST to trip on. */
const dayAfter = (localDate: string) => {
  const [y, m, d] = localDate.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(y!, m! - 1, d! + 1, 12)),
  );
};

/**
 * The time words in `body` that may no longer be true now, or null. Day words count when the
 * draft's local day (owner's time zone) is earlier than today's; minute/hour words also when
 * the draft is over two hours old.
 */
export function staleTiming(
  body: string,
  draftCreatedAt: Date,
  now: Date,
  timeZone: string,
): StaleTiming | null {
  const tz = usableTimeZone(timeZone);
  const written = localParts(draftCreatedAt, tz).date;
  const dayMoved = written < localParts(now, tz).date;
  const old = now.getTime() - draftCreatedAt.getTime() > STALE_SOON_MS;
  const words = [
    ...(dayMoved ? found(body, DAY_WORDS) : []),
    ...(dayMoved || old ? found(body, SOON_WORDS) : []),
  ];
  if (!words.length) return null;
  return {
    words,
    writtenOn: dayMoved
      ? weekday(draftCreatedAt, tz)
      : `at ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })
          .format(draftCreatedAt)
          .replace(/\s?([AP])M$/, (_, x: string) => `${x.toLowerCase()}m`)}`,
    meant: words.some((w) => NEXT_DAY_WORDS.has(w)) ? dayAfter(written) : null,
  };
}

/** The card's note: "Written Friday. It says “tomorrow”, which meant Saturday. Check the timing." */
export function timingNote(t: StaleTiming): string {
  const said = t.words.map((w) => `“${w}”`).join(" and ");
  return `Written ${t.writtenOn}. It says ${said}${t.meant ? `, which meant ${t.meant}` : ""}. Check the timing.`;
}
