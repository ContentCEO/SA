import { describe, expect, it } from "vitest";
import {
  averageMinutes,
  formatDuration,
  medianMinutes,
  localWeekday,
  responseTimeSentence,
  scorecardIsEmpty,
  scorecardLines,
  timeSavedLine,
  timeSavedPhrase,
  timeSavedRule,
  weekBounds,
  type ScorecardNumbers,
} from "@/server/scorecard-rules";

const iso = (d: Date) => d.toISOString();
const RULE =
  "Our estimate: 3 minutes for each drafted reply or follow-up that went out, from the app, from Gmail or by autopilot.";
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

describe("medianMinutes (Check 14 P5)", () => {
  const from = at("2026-10-06T13:00:00Z");
  const p = (min: number) => ({ from, to: new Date(from.getTime() + min * 60_000) });
  it("0, 1, 2 and 5 pairs", () => {
    expect(medianMinutes([])).toBeNull();
    expect(medianMinutes([p(42)])).toBe(42);
    expect(medianMinutes([p(10), p(21)])).toBe(16); // 15.5 → 16
    expect(medianMinutes([p(300), p(5), p(60), p(4320), p(20)])).toBe(60);
  });

  it("one slow weekend can't drag a quick week: 10 min, 20 min and 3 days says 20 min", () => {
    const pairs = [p(10), p(20), p(3 * 1440)];
    expect(medianMinutes(pairs)).toBe(20);
    expect(averageMinutes(pairs)).toBe(1450); // the mean would say "1 day"
    expect(
      responseTimeSentence(
        { typicalMinutes: medianMinutes(pairs), answered: 3, unanswered: 0 },
        null,
      ),
    ).toBe("Your typical first answer to this week's quote requests: 20 min, the middle of 3.");
  });
});

describe("responseTimeSentence", () => {
  const SAFE = /^[A-Za-z0-9 :().,·'-]+$/;

  it("this week with last week alongside", () => {
    expect(
      responseTimeSentence(
        { typicalMinutes: 130, answered: 4, unanswered: 0 },
        { typicalMinutes: 220 },
      ),
    ).toBe(
      "Your typical first answer to this week's quote requests: 2 h 10 min, the middle of 4 (last week: 3 h 40 min).",
    );
  });

  it("one answered request says its own time", () => {
    expect(responseTimeSentence({ typicalMinutes: 130, answered: 1, unanswered: 0 }, null)).toBe(
      "1 of this week's quote requests answered, in 2 h 10 min.",
    );
  });

  it("without last week's figure", () => {
    expect(responseTimeSentence({ typicalMinutes: 45, unanswered: 0 }, null)).toBe(
      "Your typical first answer to this week's quote requests: 45 min.",
    );
    expect(
      responseTimeSentence({ typicalMinutes: 45, unanswered: 0 }, { typicalMinutes: null }),
    ).toBe("Your typical first answer to this week's quote requests: 45 min.");
  });

  it("no answers yet, and the requests still waiting are always said", () => {
    expect(responseTimeSentence({ typicalMinutes: null, unanswered: 0 }, null)).toBe(
      "Of this week's quote requests: none answered yet.",
    );
    expect(responseTimeSentence({ typicalMinutes: null, unanswered: 1 }, null)).toBe(
      "Of this week's quote requests: none answered yet. 1 is still waiting.",
    );
    // Nothing answered yet this week (every Monday morning): last week's figure still shows.
    expect(
      responseTimeSentence({ typicalMinutes: null, unanswered: 0 }, { typicalMinutes: 220 }),
    ).toBe(
      "Of this week's quote requests: none answered yet (last week's typical answer: 3 h 40 min).",
    );
    expect(
      responseTimeSentence({ typicalMinutes: null, unanswered: 2 }, { typicalMinutes: 220 }),
    ).toBe(
      "Of this week's quote requests: none answered yet (last week's typical answer: 3 h 40 min). 2 are still waiting.",
    );
    expect(
      responseTimeSentence(
        { typicalMinutes: 30, answered: 2, unanswered: 3 },
        { typicalMinutes: 60 },
      ),
    ).toBe(
      "Your typical first answer to this week's quote requests: 30 min, the middle of 2 (last week: 1 h). 3 are still waiting.",
    );
  });

  it("last week, for the Monday digest", () => {
    expect(
      responseTimeSentence(
        { typicalMinutes: 1620, answered: 1, unanswered: 0 },
        { typicalMinutes: 60 },
        "last week",
      ),
    ).toBe("1 of last week's quote requests answered, in 1 day 3 h (the week before: 1 h).");
    expect(responseTimeSentence({ typicalMinutes: null, unanswered: 0 }, null, "last week")).toBe(
      "Of last week's quote requests: none answered.",
    );
    expect(
      responseTimeSentence(
        { typicalMinutes: null, unanswered: 0 },
        { typicalMinutes: 60 },
        "last week",
      ),
    ).toBe("Of last week's quote requests: none answered (the week before's typical answer: 1 h).");
    expect(
      responseTimeSentence(
        { typicalMinutes: null, answered: 0, unanswered: 0 },
        { typicalMinutes: 60 },
        "last week",
      ),
    ).toBe("No quote requests came in last week (the week before's typical answer: 1 h).");
  });

  it("is only numbers and fixed words", () => {
    for (const typ of [null, 0, 0.3, 7, 59, 61, 600, 1441, 99_999])
      for (const last of [null, { typicalMinutes: null }, { typicalMinutes: 125 }])
        for (const unanswered of [0, 1, 12])
          for (const answered of [undefined, 0, 1, 5])
            for (const period of ["this week", "last week"] as const)
              expect(
                responseTimeSentence({ typicalMinutes: typ, answered, unanswered }, last, period),
              ).toMatch(SAFE);
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

  it("matches the old wording everywhere above zero", () => {
    for (let m = 3; m <= 3000; m += 3) expect(timeSavedPhrase(m)).toBe(oldTimeSaved(m));
  });

  it("nothing sent says none yet, never 'about 0 minutes' (Check 14 P3)", () => {
    expect(timeSavedPhrase(0)).toBe("none yet");
  });
});

describe("scorecardIsEmpty / scorecardLines (#32)", () => {
  const zero: ScorecardNumbers = {
    repliesSent: 0,
    followupsSent: 0,
    quotesOut: 0,
    response: { avgMinutes: null, typicalMinutes: null, answered: 0, unanswered: 0 },
    minutesSaved: 0,
  };

  it("an all-zero week is empty; any count, or a request still waiting, is not", () => {
    expect(scorecardIsEmpty(zero)).toBe(true);
    expect(scorecardIsEmpty({ ...zero, repliesSent: 1 })).toBe(false);
    expect(scorecardIsEmpty({ ...zero, followupsSent: 1 })).toBe(false);
    expect(scorecardIsEmpty({ ...zero, quotesOut: 1 })).toBe(false);
    expect(
      scorecardIsEmpty({
        ...zero,
        response: { avgMinutes: 30, typicalMinutes: 30, answered: 1, unanswered: 0 },
      }),
    ).toBe(false);
    expect(
      scorecardIsEmpty({
        ...zero,
        response: { avgMinutes: null, typicalMinutes: null, answered: 0, unanswered: 1 },
      }),
    ).toBe(false);
  });

  it("says the week in plain sentences", () => {
    const s: ScorecardNumbers = {
      repliesSent: 12,
      followupsSent: 3,
      quotesOut: 4,
      response: { avgMinutes: 130, typicalMinutes: 130, answered: 4, unanswered: 1 },
      minutesSaved: 45,
    };
    expect(scorecardLines(s, "Last week")).toEqual([
      "Last week: 12 replies sent, 3 follow-ups sent, 4 quote requests answered.",
      "Your typical first answer to last week's quote requests: 2 h 10 min, the middle of 4. 1 is still waiting.",
      `Time saved: about 45 minutes. ${RULE}`,
    ]);
    expect(
      scorecardLines(
        { ...s, repliesSent: 1, followupsSent: 1, quotesOut: 1, minutesSaved: 6 },
        "This week",
        { average: false },
      ),
    ).toEqual([
      "This week: 1 reply sent, 1 follow-up sent, 1 quote request answered.",
      "1 quote request from this week is still waiting for an answer.",
      `Time saved: about 6 minutes. ${RULE}`,
    ]);
    // Without the average, a week with nothing waiting is just counts and time saved.
    expect(
      scorecardLines(
        { ...s, response: { avgMinutes: 130, typicalMinutes: 130, answered: 4, unanswered: 0 } },
        "Last week",
        {
          average: false,
        },
      ),
    ).toEqual([
      "Last week: 12 replies sent, 3 follow-ups sent, 4 quote requests answered.",
      `Time saved: about 45 minutes. ${RULE}`,
    ]);
    // None came in at all: said as that, not as "none answered".
    expect(scorecardLines(zero, "This week")[1]).toBe(
      "No quote requests have come in yet this week.",
    );
    expect(scorecardLines({ ...zero, repliesSent: 2 }, "Last week")[1]).toBe(
      "No quote requests came in last week.",
    );
    // Some came in and none were answered: that's still said plainly.
    expect(
      scorecardLines(
        {
          ...zero,
          response: { avgMinutes: null, typicalMinutes: null, answered: 0, unanswered: 2 },
        },
        "Last week",
      )[1],
    ).toBe("Of last week's quote requests: none answered. 2 are still waiting.");
  });

  it("the Activity card: last week's response time and its waiting requests are always said", () => {
    // What the page renders: this week's sentence (with last week alongside) + last week's lines.
    const card = (thisWeek: ScorecardNumbers, lastWeek: ScorecardNumbers) =>
      [
        responseTimeSentence(thisWeek.response, lastWeek.response),
        ...scorecardLines(lastWeek, "Last week", { average: false }),
      ].join(" ");
    const lastWeek: ScorecardNumbers = {
      ...zero,
      repliesSent: 3,
      quotesOut: 2,
      response: { avgMinutes: 220, typicalMinutes: 220, answered: 2, unanswered: 0 },
      minutesSaved: 9,
    };
    // Monday morning: nothing answered yet this week.
    expect(card(zero, lastWeek)).toContain("3 h 40 min");
    // Last week had only a request nobody answered: it is said, not "0 replies sent" alone.
    const waitingOnly: ScorecardNumbers = {
      ...zero,
      response: { avgMinutes: null, typicalMinutes: null, answered: 0, unanswered: 1 },
    };
    expect(scorecardIsEmpty(waitingOnly)).toBe(false);
    expect(card(zero, waitingOnly)).toContain(
      "1 quote request from last week is still waiting for an answer.",
    );
  });

  it("lines contain only numbers and fixed words", () => {
    const SAFE_LINE = /^[A-Za-z0-9 .,:()'\-]+$/;
    for (const n of [0, 1, 2, 17, 1000])
      for (const avg of [null, 0, 59, 61, 1500, 90_000])
        for (const period of ["This week", "Last week"] as const)
          for (const line of scorecardLines(
            {
              repliesSent: n,
              followupsSent: n,
              quotesOut: n,
              response: { avgMinutes: avg, typicalMinutes: avg, answered: n, unanswered: n },
              minutesSaved: n * 3,
            },
            period,
            { average: n % 2 === 0 },
          ))
            expect(line).toMatch(SAFE_LINE);
  });
});

describe("time saved said the way the math does it (Check 14 P3)", () => {
  it("one rule sentence, from MINUTES_PER_SENT_REPLY", () => {
    expect(timeSavedRule()).toBe(RULE);
  });

  it("the line carries the rule unless the box already says it", () => {
    expect(timeSavedLine(45)).toBe(`Time saved: about 45 minutes. ${RULE}`);
    expect(timeSavedLine(45, { rule: false })).toBe("Time saved: about 45 minutes.");
    expect(timeSavedLine(0, { rule: false })).toBe("Time saved: none, as nothing went out.");
  });

  it("autopilot sends are named apart in the counts line and counted in an empty check", () => {
    const s: ScorecardNumbers = {
      repliesSent: 11,
      followupsSent: 2,
      autopilotSent: 3,
      quotesOut: 0,
      response: { avgMinutes: null, typicalMinutes: null, answered: 0, unanswered: 0 },
      minutesSaved: 48,
    };
    expect(scorecardLines(s, "Last week")[0]).toBe(
      "Last week: 14 replies sent (3 by autopilot), 2 follow-ups sent, 0 quote requests answered.",
    );
    expect(
      scorecardIsEmpty({
        ...s,
        repliesSent: 0,
        followupsSent: 0,
        minutesSaved: 9,
      }),
    ).toBe(false);
  });

  it("the rule appears once in the Activity week box (last week's line leaves it out)", () => {
    const lastWeek: ScorecardNumbers = {
      repliesSent: 2,
      followupsSent: 0,
      quotesOut: 1,
      response: { avgMinutes: 30, typicalMinutes: 30, answered: 1, unanswered: 0 },
      minutesSaved: 6,
    };
    const box = [
      ...scorecardLines(lastWeek, "Last week", { average: false, rule: false }),
      timeSavedRule(),
    ].join(" ");
    expect(box.split(RULE).length - 1).toBe(1);
  });
});
