/**
 * Check 45 P1 / 44 P5 / 15 P7: the owner's time zone in plain words. Pure (no `server-only`, no
 * database), so the Settings screens, the client button and the tests share one list.
 */
import { FALLBACK_TIME_ZONE } from "./snooze-rules";

/** The US zones the owner can pick on Settings → Morning email. */
export const US_TIME_ZONES = [
  { value: "America/New_York", label: "Eastern", places: "New York, Boston" },
  { value: "America/Chicago", label: "Central", places: "Chicago, Dallas" },
  { value: "America/Denver", label: "Mountain", places: "Denver, Salt Lake City" },
  { value: "America/Phoenix", label: "Arizona", places: "Phoenix" },
  { value: "America/Los_Angeles", label: "Pacific", places: "Los Angeles, Seattle" },
  { value: "America/Anchorage", label: "Alaska", places: "Anchorage" },
  { value: "Pacific/Honolulu", label: "Hawaii", places: "Honolulu" },
] as const;

/** Other names browsers report for the same US clocks. */
const SAME_CLOCK: Record<string, string> = {
  "US/Eastern": "America/New_York",
  "America/Detroit": "America/New_York",
  "America/Indiana/Indianapolis": "America/New_York",
  "America/Kentucky/Louisville": "America/New_York",
  "US/Central": "America/Chicago",
  "US/Mountain": "America/Denver",
  "America/Boise": "America/Denver",
  "US/Arizona": "America/Phoenix",
  "US/Pacific": "America/Los_Angeles",
  "US/Alaska": "America/Anchorage",
  "US/Hawaii": "Pacific/Honolulu",
};

/** A real IANA zone name (what `Intl` accepts). */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.trim() === "" || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function listed(tz: string) {
  const key = SAME_CLOCK[tz] ?? tz;
  return US_TIME_ZONES.find((z) => z.value === key);
}

/** "Eastern", "Central"…, or the zone's own name when it isn't a US one we list. */
export function zoneShortName(tz: string | null | undefined): string {
  const zone = tz && isTimeZone(tz) ? tz : FALLBACK_TIME_ZONE;
  return listed(zone)?.label ?? zone;
}

/** "Eastern time" / "Europe/London time". */
export function zoneTimeName(tz: string | null | undefined): string {
  return `${zoneShortName(tz)} time`;
}

/** "Times are in Eastern time (New York, Boston)." */
export function zoneLine(tz: string | null | undefined): string {
  const zone = tz && isTimeZone(tz) ? tz : FALLBACK_TIME_ZONE;
  const l = listed(zone);
  return l ? `Times are in ${l.label} time (${l.places}).` : `Times are in ${zone} time.`;
}

/** "It's 7:42 am there now." in the saved zone. */
export function nowLine(now: Date, tz: string | null | undefined): string {
  const zone = tz && isTimeZone(tz) ? tz : FALLBACK_TIME_ZONE;
  const t = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(now)
    .replace(/\s?AM$/, " am")
    .replace(/\s?PM$/, " pm");
  return `It's ${t} there now.`;
}

/** Two zone names that keep the same clock ("US/Eastern" and "America/New_York"). */
export function sameClock(a: string, b: string): boolean {
  return (SAME_CLOCK[a] ?? a) === (SAME_CLOCK[b] ?? b);
}

/**
 * The select's choices: the US list, plus the saved zone when it isn't on it (so saving the
 * screen never moves an owner off a zone we don't list).
 */
export function zoneChoices(saved: string | null | undefined) {
  const choices: Array<{ value: string; label: string }> = US_TIME_ZONES.map((z) => ({
    value: z.value,
    label: `${z.label} (${z.places})`,
  }));
  if (saved && isTimeZone(saved) && !choices.some((c) => c.value === saved)) {
    choices.push({ value: saved, label: listed(saved)?.label ?? saved });
  }
  return choices;
}
