/**
 * Plan #6 snooze, as pure rules. "Remind me" hides a queue item until a time
 * in the owner's own time zone; it then comes back on top.
 */

export const SNOOZE_CHOICES = ["tonight", "tomorrow", "after_job"] as const;
export type SnoozeChoice = (typeof SNOOZE_CHOICES)[number];
export const isSnoozeChoice = (v: unknown): v is SnoozeChoice =>
  typeof v === "string" && (SNOOZE_CHOICES as readonly string[]).includes(v);

export const SNOOZE_LABELS: Record<SnoozeChoice, string> = {
  tonight: "Tonight (6pm)",
  tomorrow: "Tomorrow morning (7am)",
  after_job: "After this job (3 hours)",
};

const TONIGHT_HOUR = 18;
const MORNING_HOUR = 7;
const AFTER_JOB_MS = 3 * 60 * 60_000;
/** How long a returned item stays pinned to the top. */
export const BACK_ON_TOP_MS = 24 * 60 * 60_000;

function parts(at: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(at)
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  return { y: p.year!, m: p.month!, d: p.day!, h: p.hour!, min: p.minute!, s: p.second! };
}

/** The instant that is `hour`:00 local time, `dayOffset` days after `now`'s local date. */
export function atLocalHour(now: Date, timeZone: string, dayOffset: number, hour: number): Date {
  const { y, m, d } = parts(now, timeZone);
  const wall = Date.UTC(y, m - 1, d + dayOffset, hour);
  // Correct for the zone's offset at that moment (twice, for DST edges).
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(guess), timeZone);
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
    guess += wall - seen;
  }
  return new Date(guess);
}

/** The zone used when the owner's is missing or not a real IANA zone. */
export const FALLBACK_TIME_ZONE = "America/New_York";

/** The owner's time zone if it's a real one, Eastern otherwise (as everywhere else). */
export function usableTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return FALLBACK_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

/** The owner's local date ('YYYY-MM-DD') and hour, from an IANA time zone. Falls back to Eastern. */
export function localParts(now: Date, timeZone: string): { date: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: usableTimeZone(timeZone),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const ISO_WEEKDAY: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** The owner's local day of the week, ISO style: 1 = Monday … 7 = Sunday. */
export function localWeekday(now: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: usableTimeZone(timeZone),
    weekday: "short",
  }).format(now);
  return ISO_WEEKDAY[name] ?? 1;
}

/**
 * The instant the owner's current calendar month began: midnight on the 1st, in their time
 * zone. A Pacific owner at 6pm on Oct 31 is still in October, though it's November in UTC.
 */
export function localMonthStart(now: Date, timeZone: string): Date {
  const tz = usableTimeZone(timeZone);
  const day = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(now),
  );
  return atLocalHour(now, tz, 1 - day, 0);
}

/** The owner's current month by name ("October"), in their time zone. */
export function localMonthName(now: Date, timeZone: string): string {
  return now.toLocaleString("en-US", { month: "long", timeZone: usableTimeZone(timeZone) });
}

/** Emergencies (high priority and needs the owner) can't be put off past tonight. */
export const isEmergency = (t: { priority: string | null; needsOwner: boolean }) =>
  t.priority === "high" && t.needsOwner;

/** Which choices to offer right now, with the time each one means. */
export function snoozeOptions(
  now: Date,
  timeZone: string,
  emergency: boolean,
): { choice: SnoozeChoice; until: Date }[] {
  const endOfToday = atLocalHour(now, timeZone, 1, 0);
  const all: { choice: SnoozeChoice; until: Date }[] = [
    { choice: "tonight", until: atLocalHour(now, timeZone, 0, TONIGHT_HOUR) },
    { choice: "tomorrow", until: atLocalHour(now, timeZone, 1, MORNING_HOUR) },
    { choice: "after_job", until: new Date(now.getTime() + AFTER_JOB_MS) },
  ];
  return all.filter(
    (o) => o.until > now && (!emergency || o.until.getTime() <= endOfToday.getTime()),
  );
}

/** The time for a choice, or null if it isn't allowed now. Server-side check. */
export function snoozeUntil(
  choice: SnoozeChoice,
  now: Date,
  timeZone: string,
  emergency: boolean,
): Date | null {
  return snoozeOptions(now, timeZone, emergency).find((o) => o.choice === choice)?.until ?? null;
}
