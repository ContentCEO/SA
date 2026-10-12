import { describe, expect, it } from "vitest";
import {
  averageMinutes,
  formatDuration,
  localWeekday,
  responseTimeSentence,
  timeSavedPhrase,
  weekBounds,
} from "@/server/scorecard-rules";

const iso = (d: Date) => d.toISOString();
const at = (s: string) => new Date(s);
const NY = "America/New_York";
const LA = "America/Los_Angeles";

describe("weekBounds (Monday 00:00 → next Monday 00:00, owner's zone)", () => {
  it("a Wednesday in New York", () => {
    const w = weekBounds(at("2026-10-07T15:00:00Z"), NY);
    expect(iso(w.start)).toBe("2026-10-05T04:00:00.000Z");
    expect(iso(w.end)).toBe("2026-10-12T04:00:00.000Z");
    expect(iso(w.lastStart)).toBe("2026-09-28T04:00:00.000Z");
  });

  it("Sunday 11:59pm is still last week; Monday 00:00 starts a new one", () => {
    expect(iso(weekBounds(at("2026-10-12T03:59:00Z"), NY).start)).toBe("2026-10-05T04:00:00.000Z");
    const monday = weekBounds(at("2026-10-12T04:00:00Z"), NY);
    expect(iso(monday.start)).toBe("2026-10-12T04:00:00.000Z");
    expect(iso(monday.lastStart)).toBe("2026-10-05T04:00:00.000Z");
    // 10pm Sunday in LA: already Monday in UTC (and in New York), still last week there.
    const la = weekBounds(at("2026-10-12T05:00:00Z"), LA);
    expect(iso(la.start)).toBe("2026-10-05T07:00:00.000Z");
    expect(iso(la.end)).toBe("2026-10-12T07:00:00.000Z");
  });

  it("DST weeks: fall back makes last week 169 hours, spring forward 167", () => {
    const fall = weekBounds(at("2026-11-04T15:00:00Z"), NY);
    expect(iso(fall.start)).toBe("2026-11-02T05:00:00.000Z"); // EST
    expect(iso(fall.lastStart)).toBe("2026-10-26T04:00:00.000Z"); // EDT
    expect(iso(fall.end)).toBe("2026-11-09T05:00:00.000Z");
    expect((fall.start.getTime() - fall.lastStart.getTime()) / 3_600_000).toBe(169);

    const spring = weekBounds(at("2026-03-09T15:00:00Z"), NY);
    expect(iso(spring.start)).toBe("2026-03-09T04:00:00.000Z"); // EDT
    expect(iso(spring.lastStart)).toBe("2026-03-02T05:00:00.000Z"); // EST
    expect((spring.start.getTime() - spring.lastStart.getTime()) / 3_600_000).toBe(167);
  });

  it("an invalid or missing zone falls back to Eastern without throwing", () => {
    const eastern = weekBounds(at("2026-10-07T15:00:00Z"), NY);
    expect(weekBounds(at("2026-10-07T15:00:00Z"), "Not/AZone")).toEqual(eastern);
    expect(weekBounds(at("2026-10-07T15:00:00Z"), "")).toEqual(eastern);
  });
});

describe("localWeekday (ISO: 1 = Monday … 7 = Sunday)", () => {
  it("is Monday in Tokyo while UTC is still Sunday", () => {
    const sundayUtc = at("2026-10-11T20:00:00Z"); // Sun 8pm UTC = Mon 5am JST
    expect(sundayUtc.getUTCDay()).toBe(0);
    expect(localWeekday(sundayUtc, "Asia/Tokyo")).toBe(1);
  });

  it("is Sunday in Los Angeles while UTC is already Monday", () => {
    const mondayUtc = at("2026-10-12T05:00:00Z"); // Mon 5am UTC = Sun 10pm PDT
    expect(mondayUtc.getUTCDay()).toBe(1);
    expect(localWeekday(mondayUtc, LA)).toBe(7);
    expect(localWeekday(mondayUtc, NY)).toBe(1);
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "under a minute"],
    [0.4, "under a minute"],
    [1, "1 min"],
    [45, "45 min"],
    [60, "1 h"],
    [120, "2 h"],
    [130, "2 h 10 min"],
    [1439, "23 h 59 min"],
    [1440, "1 day"],
    [1620, "1 day 3 h"],
    [4320, "3 days"],
    [3000, "2 days 2 h"],
  ])("%s minutes → %s", (m, words) => {
    expect(formatDuration(m)).toBe(words);
  });
});

describe("averageMinutes", () => {
  it("is null with nothing to average", () => {
    expect(averageMinutes([])).toBeNull();
  });

  it("averages the gaps and rounds to whole minutes", () => {
    const from = at("2026-10-06T13:00:00Z");
    const plus = (min: number) => new Date(from.getTime() + min * 60_000);
    expect(averageMinutes([{ from, to: plus(60) }])).toBe(60);
    expect(
      averageMinutes([
        { from, to: plus(60) },
        { from, to: plus(121) },
      ]),
    ).toBe(91); // 90.5 → 91
    expect(
      averageMinutes([
        { from, to: plus(10) },
        { from, to: plus(20) },
        { from, to: plus(20) },
      ]),
    ).toBe(17); // 16.67 → 17
  });
});

describe("responseTimeSentence", () => {
  const SAFE = /^[A-Za-z0-9 :().,·-]+$/;

  it("this week with last week alongside", () => {
    expect(responseTimeSentence({ avgMinutes: 130, unanswered: 0 }, { avgMinutes: 220 })).toBe(
      "You answered quote requests in 2 h 10 min on average this week (last week: 3 h 40 min).",
    );
  });

  it("without last week's figure", () => {
    expect(responseTimeSentence({ avgMinutes: 45, unanswered: 0 }, null)).toBe(
      "You answered quote requests in 45 min on average this week.",
    );
    expect(responseTimeSentence({ avgMinutes: 45, unanswered: 0 }, { avgMinutes: null })).toBe(
      "You answered quote requests in 45 min on average this week.",
    );
  });

  it("no answers yet, and the requests still waiting are always said", () => {
    expect(responseTimeSentence({ avgMinutes: null, unanswered: 0 }, null)).toBe(
      "No quote requests answered yet this week.",
    );
    expect(responseTimeSentence({ avgMinutes: null, unanswered: 1 }, null)).toBe(
      "No quote requests answered yet this week. 1 is still waiting for an answer.",
    );
    expect(responseTimeSentence({ avgMinutes: 30, unanswered: 3 }, { avgMinutes: 60 })).toBe(
      "You answered quote requests in 30 min on average this week (last week: 1 h). 3 are still waiting for an answer.",
    );
  });

  it("last week, for the Monday digest", () => {
    expect(
      responseTimeSentence({ avgMinutes: 1620, unanswered: 0 }, { avgMinutes: 60 }, "last week"),
    ).toBe("You answered quote requests in 1 day 3 h on average last week (the week before: 1 h).");
    expect(responseTimeSentence({ avgMinutes: null, unanswered: 0 }, null, "last week")).toBe(
      "No quote requests answered last week.",
    );
  });

  it("is only numbers and fixed words", () => {
    for (const avg of [null, 0, 0.3, 7, 59, 61, 600, 1441, 99_999])
      for (const last of [null, { avgMinutes: null }, { avgMinutes: 125 }])
        for (const unanswered of [0, 1, 12])
          for (const period of ["this week", "last week"] as const)
            expect(responseTimeSentence({ avgMinutes: avg, unanswered }, last, period)).toMatch(
              SAFE,
            );
  });
});

describe("timeSavedPhrase", () => {
  /** The Activity page's own helper before it moved here — the wording must not change. */
  function oldTimeSaved(minutes: number) {
    if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = Math.round((minutes / 60) * 2) / 2;
    return `about ${hours} hour${hours === 1 ? "" : "s"}`;
  }

  it.each([
    [9, "about 9 minutes"],
    [1, "about 1 minute"],
    [60, "about 1 hour"],
    [75, "about 1.5 hours"],
    [200, "about 3.5 hours"],
  ])("%s minutes → %s", (m, words) => {
    expect(timeSavedPhrase(m)).toBe(words);
  });

  it("matches the old wording everywhere", () => {
    for (let m = 0; m <= 3000; m += 3) expect(timeSavedPhrase(m)).toBe(oldTimeSaved(m));
  });
});
