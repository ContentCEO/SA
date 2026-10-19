/**
 * Check 19 P6: what the Text alerts screen and Activity say about Twilio's delivery reports.
 * Pure (no database), so the wording is tested on its own.
 */

/** Twilio error codes that mean texts to this number can't work. */
export const SMS_ERROR = {
  optedOut: 21610,
  notMobile: 30006,
  carrierFiltered: 30007,
  unregistered: 30034,
} as const;

export type SmsStoppedReason = "opted_out" | "not_mobile";

/** Texts switch themselves off on these codes (the owner replied STOP, or not a mobile). */
export function stopReasonFor(errorCode: number | null | undefined): SmsStoppedReason | null {
  if (errorCode === SMS_ERROR.optedOut) return "opted_out";
  if (errorCode === SMS_ERROR.notMobile) return "not_mobile";
  return null;
}

/** Twilio's statuses in the order they happen; a late, earlier one never overwrites a later one. */
const RANK: Record<string, number> = {
  accepted: 0,
  scheduled: 0,
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  undelivered: 3,
  failed: 3,
  read: 4,
  canceled: 3,
};
export const statusRank = (status: string) => RANK[status] ?? -1;

export function deliveryFailed(status: string | null | undefined): boolean {
  return status === "undelivered" || status === "failed";
}

export const STOPPED_LINES: Record<SmsStoppedReason, string> = {
  // Check 27 P6: START at the carrier lifts the block; the switch here turns them back on.
  opted_out:
    "You replied STOP, so texts are off. Text START to the number, then turn them on here.",
  not_mobile: "That number can't get texts. Use a mobile number.",
};

/**
 * The one line about the last text: delivered (with its local time), didn't arrive (and why,
 * when we know), or nothing while Twilio hasn't said. A stop reason wins.
 */
export function lastTextLine(p: {
  stoppedReason: string | null | undefined;
  last: { status: string; errorCode: number | null; updatedAt: Date } | null;
  timeZone: string;
  now: Date;
}): string | null {
  if (p.stoppedReason === "opted_out" || p.stoppedReason === "not_mobile")
    return STOPPED_LINES[p.stoppedReason];
  const last = p.last;
  if (!last) return null;
  const reason = stopReasonFor(last.errorCode);
  if (reason) return STOPPED_LINES[reason];
  if (last.status === "delivered" || last.status === "read")
    return `Last text delivered ${when(last.updatedAt, p.timeZone, p.now)}.`;
  if (deliveryFailed(last.status)) {
    if (last.errorCode === SMS_ERROR.unregistered)
      return "Your last text didn't arrive. Carriers haven't approved our texting number yet.";
    if (last.errorCode === SMS_ERROR.carrierFiltered)
      return "Your last text didn't arrive. Your carrier blocked it.";
    return "Your last text didn't arrive.";
  }
  return null;
}

/** "at 9:42am" today, else "Oct 12 at 9:42am", in the owner's zone. */
function when(at: Date, timeZone: string, now: Date): string {
  const day = (d: Date) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).format(d);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  })
    .format(at)
    .replace(/\s?([AP])M$/i, (_, m: string) => `${m.toLowerCase()}m`);
  if (day(at) === day(now)) return `at ${time}`;
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
  }).format(at);
  return `${date} at ${time}`;
}

/** 21 → "9pm", 7 → "7am", 0 → "12am", 12 → "12pm". */
export function hourWord(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${hour < 12 ? "am" : "pm"}`;
}

/**
 * Check 27 P6: the opt-in screen's words, built from the SMS limits in code (never typed), with
 * what carriers' A2P 10DLC review looks for: the frequency, "Msg & data rates may apply", HELP
 * and STOP, and consent to the texts and to the Terms and Privacy Policy under the button.
 */
export function textsConsentCopy(
  limits: { dailyCap: number; quietStartHour: number; quietEndHour: number },
  zoneName: string,
) {
  return {
    intro:
      "Squared Away texts you when a new quote request or an email that needs you comes in: " +
      "just the count and a link, never a customer's name or words. " +
      `Up to ${limits.dailyCap} texts a day, none between ${hourWord(limits.quietStartHour)} and ` +
      `${hourWord(limits.quietEndHour)} ${zoneName} (except emergencies, if you leave that on ` +
      "below). Msg & data rates may apply. Reply HELP for help, STOP to stop.",
    consent: "By tapping Text me a code you agree to these texts and to our",
    consentEnd: "and",
    button: "Text me a code",
  };
}

/** Activity's line for a new-lead text: "Texted you" only once Twilio says it arrived. */
export function smsAlertActivityLine(delivery: string | null | undefined): string {
  if (delivery === "delivered" || delivery === "read")
    return "Texted you about new emails that need you";
  if (deliveryFailed(delivery))
    return "Tried to text you about new emails that need you, but it didn't arrive";
  return "Sent a text to your phone about new emails that need you";
}
