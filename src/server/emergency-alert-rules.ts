/**
 * Replies package (B5 part 2): emergency alerts on the owner's phone, as pure rules. Which
 * emails count is the leads package's emergency lane (`inEmergencyLane`, a gas smell
 * included: the gas rule marks it urgent); this file holds the limits, the night window and
 * the words. Content-free: counts and thread ids only — never a name, an address, a subject
 * or what anyone wrote. No database here (`*-rules.ts` stay pure).
 */
import { inEmergencyLane } from "./emergency-rules";
import { atLocalHour, localParts, usableTimeZone } from "./snooze-rules";

export const EMERGENCY_ALERTS = {
  /** At most this many between 9pm and 7am (the owner's quiet hours). */
  nightCap: 3,
  /** At most this many in the owner's local day (midnight to midnight). */
  dayCap: 6,
  /** Night = these local hours: from 9pm up to 7am, the same as texts' quiet hours. */
  nightStartHour: 21,
  nightEndHour: 7,
  /**
   * Only an email the customer wrote in the last hour is worth waking someone for. Older
   * ones (a backfill, an outage) reach the owner the ordinary way: the queue, the 7am alert,
   * the morning email.
   */
  freshMs: 60 * 60 * 1000,
  /** How long after an emergency alert the phone's notification still says so. */
  summaryWindowMs: 30 * 60 * 1000,
} as const;

/** The categories and marks the alert reads: the queue's own lane rule, unchanged. */
export function emergencyAlertable(t: {
  category: string | null;
  urgency: string | null;
  injection: boolean;
}): boolean {
  return inEmergencyLane({
    category: t.category,
    extracted: { urgency: t.urgency, injection: t.injection },
  });
}

/** Between 9pm and 7am in the owner's time zone. */
export function inNight(now: Date, timeZone: string): boolean {
  const { hour } = localParts(now, timeZone);
  return hour >= EMERGENCY_ALERTS.nightStartHour || hour < EMERGENCY_ALERTS.nightEndHour;
}

/**
 * When the night `now` falls in began (9pm local, today or yesterday). Null outside the night.
 * DST-safe: `atLocalHour` corrects for the zone's offset on that day.
 */
export function nightStart(now: Date, timeZone: string): Date | null {
  const tz = usableTimeZone(timeZone);
  if (!inNight(now, tz)) return null;
  const { hour } = localParts(now, tz);
  return atLocalHour(now, tz, hour >= EMERGENCY_ALERTS.nightStartHour ? 0 : -1, 21);
}

/** Midnight at the start of the owner's local day. */
export function dayStart(now: Date, timeZone: string): Date {
  return atLocalHour(now, usableTimeZone(timeZone), 0, 0);
}

/** Room for one more emergency alert: under the day's cap and, at night, under the night's. */
export function emergencyAllowed(c: {
  sentToday: number;
  sentTonight: number;
  night: boolean;
}): boolean {
  if (c.sentToday >= EMERGENCY_ALERTS.dayCap) return false;
  return !(c.night && c.sentTonight >= EMERGENCY_ALERTS.nightCap);
}

/** What the phone shows: "An emergency email just came in. Open Squared Away." */
export function emergencyAlertText(n: number): string {
  return n > 1
    ? `${n} emergency emails just came in. Open Squared Away.`
    : "An emergency email just came in. Open Squared Away.";
}

/** The text message: the same words and one link into the app (no name, no subject). */
export function emergencySmsBody(n: number, url: string): string {
  const what = n > 1 ? `${n} emergency emails just came in.` : "An emergency email just came in.";
  return `Squared Away: ${what} Open: ${url}`;
}

/** Activity: "Let you know right away about an emergency email". */
export function emergencyActivityLine(emergencies: unknown): string {
  const n =
    typeof emergencies === "number" && Number.isInteger(emergencies) && emergencies > 1
      ? emergencies
      : 1;
  return n === 1
    ? "Let you know right away about an emergency email"
    : `Let you know right away about ${n} emergency emails`;
}

/**
 * The phone's notification right after an emergency alert: the emergency words while the
 * newest emergency alert is the last push that went out (a later new-lead push shows its own
 * counts) and is under half an hour old. Null = the ordinary summary.
 */
export function emergencySummaryApplies(p: {
  newestEmergencyAlertAt: Date | null;
  lastPushAt: Date | null;
  now: Date;
}): boolean {
  const at = p.newestEmergencyAlertAt;
  if (!at) return false;
  if (p.now.getTime() - at.getTime() > EMERGENCY_ALERTS.summaryWindowMs) return false;
  return !p.lastPushAt || at.getTime() >= p.lastPushAt.getTime();
}
