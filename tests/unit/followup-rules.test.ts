import { describe, expect, it } from "vitest";
import { addDays, nudgeDueDate, quietCutoff } from "@/server/followup-rules";
import { localDayStart } from "@/server/growth-client-rules";
import { localParts } from "@/server/snooze-rules";

/** A wall-clock time in a zone (never on a time-change day itself). */
function at(date: string, hm: string, timeZone: string): Date {
  const [h, m] = hm.split(":").map(Number) as [number, number];
  return new Date(localDayStart(date, timeZone).getTime() + (h * 60 + m) * 60_000);
}

const ZONES = ["America/New_York", "America/Chicago", "America/Los_Angeles", "Pacific/Honolulu"];

describe("nudgeDueDate (Check 21 P3)", () => {
  it.each(ZONES)(
    "Friday 8:30am, 2:00pm and 11:30pm with a 3-day wait are all due Monday (%s)",
    (tz) => {
      for (const hm of ["08:30", "14:00", "23:30"]) {
        const due = nudgeDueDate(at("2026-10-23", hm, tz), 3, tz);
        expect(due.date).toBe("2026-10-26");
        expect(localParts(due.startsAt, tz)).toEqual({ date: "2026-10-26", hour: 0 });
      }
    },
  );

  it.each(ZONES)("across the Nov 1 2026 time change (%s)", (tz) => {
    const due = nudgeDueDate(at("2026-10-30", "14:00", tz), 3, tz);
    expect(due.date).toBe("2026-11-02");
    expect(localParts(due.startsAt, tz)).toEqual({ date: "2026-11-02", hour: 0 });
    // Saturday 11:30pm before the change, 2-day wait → Monday.
    expect(nudgeDueDate(at("2026-10-31", "23:30", tz), 2, tz).date).toBe("2026-11-02");
  });

  it("the local date counts, not UTC: Los Angeles Monday 7pm is Tuesday in UTC", () => {
    const tz = "America/Los_Angeles";
    expect(nudgeDueDate(at("2026-10-19", "19:00", tz), 3, tz).date).toBe("2026-10-22");
  });

  it("the scan cutoff agrees with the due date", () => {
    for (const tz of ZONES) {
      const sent = at("2026-10-23", "14:00", tz);
      const days = 3;
      const sunday4am = at("2026-10-25", "04:00", tz);
      const monday4am = at("2026-10-26", "04:00", tz);
      expect(sent < quietCutoff(sunday4am, days, tz)).toBe(false);
      expect(sent < quietCutoff(monday4am, days, tz)).toBe(true);
    }
  });

  it("adds calendar days", () => {
    expect(addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
  });
});
