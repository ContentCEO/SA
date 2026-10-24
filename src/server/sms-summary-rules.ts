/**
 * Plan #50 (remaining parts): the morning summary by text and leads at risk by text, as pure
 * rules (no database), so the words and the "when" are tested on their own.
 *
 * Content-free like the morning email: every body is built from whole numbers, fixed words and
 * one of our own links — never a customer's name, address, subject, amount or words. The
 * functions take numbers only, so nothing else can reach a text.
 */
import { atRiskPushPart } from "./leads-at-risk-rules";
import { hourWord } from "./sms-delivery-rules";

/** Check 19 P7: the sentence added to the day's tenth (last) text. */
export const LAST_TEXT_OF_DAY = " That's today's last text; the rest wait in the app.";

/**
 * The morning text goes out at the owner's morning-email hour or a later run that morning —
 * never from noon on (a "this morning" text in the afternoon is noise; the app has it all).
 */
export const SUMMARY_TEXT_LAST_HOUR = 12;

export type SummaryTextCounts = {
  /** Drafted replies waiting for the owner's okay. */
  replies: number;
  /** Follow-up nudges waiting for the owner's okay. */
  followups: number;
  /** Needs-you cards, plus waiting leads with no card (they wait on the owner too). */
  needsYou: number;
};

const whole = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * "Squared Away: 3 replies ready, 1 needs you. Open: <url>". Null on a quiet morning (nothing
 * waiting): no text at all.
 */
export function summaryTextBody(
  c: SummaryTextCounts,
  url: string,
  o: { lastToday?: boolean } = {},
): string | null {
  const replies = whole(c.replies);
  const followups = whole(c.followups);
  const needsYou = whole(c.needsYou);
  const parts = [
    replies ? `${replies} ${replies === 1 ? "reply" : "replies"} ready` : null,
    followups ? `${followups} follow-up${followups === 1 ? "" : "s"} ready` : null,
    needsYou ? `${needsYou} need${needsYou === 1 ? "s" : ""} you` : null,
  ].filter((p): p is string => !!p);
  if (!parts.length) return null;
  return `Squared Away: ${parts.join(", ")}. Open: ${url}${o.lastToday ? LAST_TEXT_OF_DAY : ""}`;
}

/** "Squared Away: 2 quote requests have waited over 4 hours. Open: <url>". */
export function atRiskTextBody(n: number, url: string, o: { lastToday?: boolean } = {}): string {
  return `Squared Away: ${atRiskPushPart(Math.max(1, whole(n)))}. Open: ${url}${
    o.lastToday ? LAST_TEXT_OF_DAY : ""
  }`;
}

/**
 * Due once a local day, at/after the owner's morning-email hour and before noon; independent
 * of the morning email's own on/off (a separate switch). Quiet hours are checked by the caller.
 */
export function summaryTextDue(
  s: { digestHour: number; lastSentOn: string | null },
  local: { date: string; hour: number },
): boolean {
  return (
    local.hour >= s.digestHour && local.hour < SUMMARY_TEXT_LAST_HOUR && s.lastSentOn !== local.date
  );
}

/**
 * The two switches' words on the Text alerts screen, built from the limits in code (never
 * typed), so the screen can't promise a number the code doesn't keep.
 */
export function extraTextsCopy(limits: {
  dailyCap: number;
  quietStartHour: number;
  quietEndHour: number;
  atRiskHours: number;
  atRiskPerDay: number;
  digestHour: number;
}) {
  const cap =
    `Counts toward the ${limits.dailyCap} texts a day, never between ` +
    `${hourWord(limits.quietStartHour)} and ${hourWord(limits.quietEndHour)}. ` +
    "Msg & data rates may apply.";
  return {
    summary: {
      title: "Morning summary by text",
      what:
        `One text a day around ${hourWord(limits.digestHour)} (your morning email's hour), ` +
        'only when something is waiting: "3 replies ready, 1 needs you" and a link. ' +
        "Counts only, never a customer's name or words. Works whether the morning email is on or off.",
      cap,
      on: "Turn on morning summary texts",
      off: "Turn off morning summary texts",
    },
    atRisk: {
      title: "Waiting quote requests by text",
      what:
        `A text when a quote request has waited over ${limits.atRiskHours} work hours ` +
        `with no answer: "2 quote requests have waited over ${limits.atRiskHours} hours" and a link. ` +
        `At most ${limits.atRiskPerDay} a day, during your work hours, once per wait.`,
      cap,
      on: "Turn on waiting-quote texts",
      off: "Turn off waiting-quote texts",
    },
  };
}
