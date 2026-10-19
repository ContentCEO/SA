/**
 * Plan #34: business hours as pure rules, in the owner's time zone. A lead is "at risk"
 * after LEAD_AT_RISK_HOURS of business time, so a Friday-evening request isn't late on
 * Sunday. Day edges are built with atLocalHour, so DST days are 23 or 25 hours long.
 */
import { BUSINESS_HOURS, type BusinessHours } from "@/config/business-hours";
import { atLocalHour, localParts, localWeekday, usableTimeZone } from "./snooze-rules";

/** Longest span counted, in local days (older leads aren't "at risk" anyway). */
const MAX_DAYS = 60;

/** Business minutes in [from, to): the parts of each open day's hours that fall inside it. */
export function businessMinutesBetween(
  from: Date,
  to: Date,
  timeZone: string,
  hours: BusinessHours = BUSINESS_HOURS,
): number {
  if (to.getTime() <= from.getTime()) return 0;
  const tz = usableTimeZone(timeZone);
  let ms = 0;
  for (let d = 0; d <= MAX_DAYS; d++) {
    const dayStart = atLocalHour(from, tz, d, 0);
    if (dayStart.getTime() >= to.getTime()) break;
    // Noon is always on the right local day, whatever the DST jump.
    if (!hours.days.includes(localWeekday(atLocalHour(from, tz, d, 12), tz))) continue;
    const open = Math.max(atLocalHour(from, tz, d, hours.startHour).getTime(), from.getTime());
    const close = Math.min(atLocalHour(from, tz, d, hours.endHour).getTime(), to.getTime());
    if (close > open) ms += close - open;
  }
  return Math.floor(ms / 60_000);
}

/** Whether `now` is inside business hours in the owner's time zone. */
export function inBusinessHours(
  now: Date,
  timeZone: string,
  hours: BusinessHours = BUSINESS_HOURS,
): boolean {
  const tz = usableTimeZone(timeZone);
  const { hour } = localParts(now, tz);
  return (
    hours.days.includes(localWeekday(now, tz)) && hour >= hours.startHour && hour < hours.endHour
  );
}

/**
 * Check 15 P8: the owner's own working days and hours (Settings → Your business), or the
 * default schedule when a value is missing or doesn't make sense (no day, start ≥ end).
 */
export function workHoursOf(
  p:
    | {
        workDays?: readonly number[] | null;
        workStartHour?: number | null;
        workEndHour?: number | null;
      }
    | null
    | undefined,
): BusinessHours {
  const days = (p?.workDays ?? []).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  const start = p?.workStartHour;
  const end = p?.workEndHour;
  if (
    !days.length ||
    typeof start !== "number" ||
    typeof end !== "number" ||
    start < 0 ||
    end > 24 ||
    start >= end
  )
    return BUSINESS_HOURS;
  return { days: [...new Set(days)].sort((a, b) => a - b), startHour: start, endHour: end };
}

/** "7am", "noon", "midnight" for the hour selects. */
export function hourLabel(h: number): string {
  if (h === 0 || h === 24) return "midnight";
  if (h === 12) return "noon";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}
