import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TrialClock } from "@/components/app/trial-clock";
import { pricing } from "@/config/pricing";
import { capitalized, dayAdjective, daysPhrase, dayWord } from "@/lib/trial-words";
import {
  EVALUATION_MS,
  evaluationClock,
  sendingBlockedReason,
  sendingOffLabel,
  trialLengthDays,
} from "@/server/lifecycle";

/** Check 35 P1: the trial's length comes from the config (or the account's own clock). */
describe("trial words", () => {
  it("spells 1 to 10, digits above", () => {
    expect([1, 3, 6, 10, 14].map(dayWord)).toEqual(["one", "three", "six", "ten", "14"]);
    expect([1, 3, 6, 10, 14].map(daysPhrase)).toEqual([
      "one day",
      "three days",
      "six days",
      "ten days",
      "14 days",
    ]);
    expect([1, 3, 6, 10, 14].map(dayAdjective)).toEqual([
      "one-day",
      "three-day",
      "six-day",
      "ten-day",
      "14-day",
    ]);
    expect(capitalized("three-day")).toBe("Three-day");
  });
});

describe("an extended trial says its real length", () => {
  const DAY = 86_400_000;
  const started = new Date("2026-10-01T12:00:00Z");
  // Extended once in /admin: the end moves by the config's length.
  const extended = {
    status: "evaluating" as const,
    evaluationStartedAt: started,
    evaluationEndsAt: new Date(started.getTime() + 2 * EVALUATION_MS),
    setupPaidVia: null,
  };
  const now = new Date(started.getTime() + 2.5 * DAY);
  const html = (msLeft?: number) => {
    const clock = evaluationClock(extended, now)!;
    return renderToStaticMarkup(
      createElement(TrialClock, {
        clock: msLeft === undefined ? clock : { ...clock, msLeft },
        soFar: null,
      }),
    ).replace(/&#x27;/g, "'");
  };

  it("the banner: Day 3 of 6 with 'your six days', never 'three days'", () => {
    expect(pricing.evaluationDays).toBe(3); // the numbers below assume today's config
    const text = html();
    expect(text).toContain("Day 3 of 6");
    expect(text).toContain("six days");
    expect(text).not.toContain("three days");
  });

  it("the last-day box says the same length", () => {
    const text = html(3 * 3_600_000);
    expect(text).toContain("Your six days end in");
    expect(text).not.toContain("three days");
  });

  it("the Send reply note and the after-trial reason use the account's length", () => {
    expect(trialLengthDays(extended)).toBe(6);
    expect(sendingOffLabel(extended, now)).toBe("Send reply is off during your six days");
    const ended = new Date(extended.evaluationEndsAt.getTime() + DAY);
    expect(sendingBlockedReason(extended, ended)).toBe(
      "Your six days are up. Choose a plan to switch sending on.",
    );
    // An ordinary trial (or one with no start recorded) reads the config.
    expect(trialLengthDays({ evaluationEndsAt: new Date() })).toBe(pricing.evaluationDays);
  });
});

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(p) ? [p] : [];
  });

describe("no owner-facing string types the trial length by hand", () => {
  it("src/ outside the prompts", () => {
    // "Step 1 of 3" (setup steps) and "1 of 3" (checklist) aren't the trial, so only a day
    // clock ("Day 1 of 3") counts here.
    const typed = /three[- ]day|three days|\bday \d+ of 3\b|3 more days|\badd 3 days\b/i;
    const hits: string[] = [];
    for (const f of files("src")) {
      if (f.startsWith(join("src", "ai", "prompts"))) continue;
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const t = line.trim();
          if (/^(\/\/|\/?\*|\{\/\*)/.test(t)) return; // comments
          if (typed.test(t)) hits.push(`${f}:${i + 1}: ${t}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it("docs/terms.md follows the config, or Davi is asked to update it", () => {
    const terms = readFileSync("docs/terms.md", "utf8");
    if (pricing.evaluationDays !== 3 && terms.includes("three-day trial")) {
      throw new Error("docs/terms.md says three-day trial; ask Davi to update the terms");
    }
  });
});
