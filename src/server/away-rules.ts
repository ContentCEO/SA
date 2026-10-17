/**
 * Ideas E7: away mode — pure rules (no database).
 *
 * The owner picks the day they're back. Until then follow-up nudges pause and one seasonal note
 * ("Away until … Back …") goes into the drafts' facts, so a reply can say when they're back.
 * Nothing else changes: drafts still wait for the owner's tap, autopilot keeps to the kinds
 * the owner switched on, and the morning email and alerts keep coming. Never an automatic reply.
 */

/** Away mode can be set this far ahead at most. */
export const AWAY_MAX_DAYS = 90;

export type BackOnCheck = "ok" | "invalid" | "past" | "too_far";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date as YYYY-MM-DD (2026-02-30 is not one). */
export function isYmd(v: unknown): v is string {
  if (typeof v !== "string" || !YMD.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The first day back must be after today (the owner's local date) and within 90 days. */
export function validateBackOn(backOn: unknown, today: string): BackOnCheck {
  if (!isYmd(backOn)) return "invalid";
  if (backOn <= today) return "past";
  if (backOn > addDays(today, AWAY_MAX_DAYS)) return "too_far";
  return "ok";
}

/** Away while the day back hasn't come yet. Read at use: nothing has to turn it off. */
export function awayActive(backOn: string | null | undefined, today: string): boolean {
  return isYmd(backOn) && backOn > today;
}

/** The last day away (the day before they're back) — the away note's `ends_on`. */
export const awayEndsOn = (backOn: string) => addDays(backOn, -1);

function words(ymd: string) {
  const d = new Date(`${ymd}T12:00:00Z`);
  const f = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...o }).format(d);
  return {
    long: `${f({ weekday: "long" })}, ${f({ month: "long", day: "numeric" })}`,
    short: f({ month: "short", day: "numeric" }),
    weekdayShort: f({ weekday: "short" }),
  };
}

/**
 * The away note drafts read. It names each day both ways ("October 10" and "Oct 10"), so a
 * draft that says either is seen as using a date the owner gave (draft checks match the text).
 */
export function awayNoteText(backOn: string): string {
  const last = words(awayEndsOn(backOn));
  const back = words(backOn);
  return `Away until ${last.long} (${last.short}). Back ${back.long} (${back.short}).`;
}

/** "Thursday, October 9" — the last day away, for the screens. */
export const awayUntilWords = (backOn: string) => words(awayEndsOn(backOn)).long;
/** "Friday, October 10" — the day back. */
export const backOnWords = (backOn: string) => words(backOn).long;
/** "Thu, Oct 9" — short, for the Settings row and the queue line. */
export const awayUntilShort = (backOn: string) => {
  const w = words(awayEndsOn(backOn));
  return `${w.weekdayShort}, ${w.short}`;
};

/** The last line of the away screen depends on whether autopilot sends anything. */
export function awayLastLine(autopilotOn: boolean): string {
  return autopilotOn
    ? "Autopilot keeps sending the kinds of replies you turned on. Everything else waits for you."
    : "Everything else keeps working. Nothing goes out without your okay, as always.";
}

export const AWAY_REFUSALS: Record<Exclude<BackOnCheck, "ok">, string> = {
  invalid: "Pick the day you're back.",
  past: "Pick a day after today.",
  too_far: `Pick a day in the next ${AWAY_MAX_DAYS} days.`,
};
