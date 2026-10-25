import { describe, expect, it } from "vitest";
import { MODEL_DEPRECATIONS_PAGE, modelFallbacks, modelLifecycle, models } from "@/config/models";

/**
 * Check 48 P2: every model we call has a keep-until date from Anthropic's model deprecations
 * page. When a date is within 30 days (or past) the page must have been read in the last 14
 * days, or this fails: re-read the page, update the row (`notBefore`, and `checkedOn` to today),
 * and if a retirement is announced follow docs/SETUP.md "When Anthropic emails about a model".
 */

const DAY = 86_400_000;
const NEAR_DAYS = 30;
const RECHECK_DAYS = 14;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function lifecycleProblems(
  rows: Record<string, { notBefore: string; checkedOn: string; source: string }>,
  ids: readonly string[],
  now: Date,
): string[] {
  const problems: string[] = [];
  for (const id of ids) {
    const row = rows[id];
    if (!row) {
      problems.push(`${id}: no lifecycle row in src/config/models.ts`);
      continue;
    }
    if (!ISO_DAY.test(row.checkedOn)) problems.push(`${id}: checkedOn isn't a YYYY-MM-DD date`);
    const checkedAgo = (now.getTime() - Date.parse(`${row.checkedOn}T00:00:00Z`)) / DAY;
    // A date the page doesn't give is written as words ("none announced") and is never "near".
    if (!ISO_DAY.test(row.notBefore)) continue;
    const daysLeft = (Date.parse(`${row.notBefore}T00:00:00Z`) - now.getTime()) / DAY;
    if (daysLeft <= NEAR_DAYS && checkedAgo > RECHECK_DAYS) {
      problems.push(
        `${id}: Anthropic's keep-until date ${row.notBefore} is ${daysLeft < 0 ? "past" : "within 30 days"} and the page was last read on ${row.checkedOn}. Re-check ${row.source}, then update notBefore and checkedOn in src/config/models.ts.`,
      );
    }
  }
  return problems;
}

const pinned = [
  ...new Set<string>([
    ...Object.values(models),
    ...Object.values(modelFallbacks).map((f) => f.model),
  ]),
];

describe("model keep-until dates", () => {
  it("every pinned model's date has been checked recently enough", () => {
    expect(lifecycleProblems(modelLifecycle, pinned, new Date())).toEqual([]);
  });

  it("each row names the deprecations page and real dates", () => {
    for (const id of pinned) {
      const row = modelLifecycle[id as keyof typeof modelLifecycle];
      expect(row.source, id).toBe(MODEL_DEPRECATIONS_PAGE);
      expect(row.checkedOn, id).toMatch(ISO_DAY);
      expect(row.notBefore.length, id).toBeGreaterThan(0);
    }
  });

  it("a passed date that was re-checked is allowed; a forgotten one is not", () => {
    const now = new Date("2026-11-20T12:00:00Z");
    const rows = {
      fresh: { notBefore: "2026-10-15", checkedOn: "2026-11-10", source: "x" },
      stale: { notBefore: "2026-10-15", checkedOn: "2026-10-01", source: "x" },
      soon: { notBefore: "2026-12-01", checkedOn: "2026-10-01", source: "x" },
      far: { notBefore: "2027-06-30", checkedOn: "2026-01-01", source: "x" },
      unannounced: { notBefore: "none announced", checkedOn: "2026-01-01", source: "x" },
    };
    const problems = lifecycleProblems(rows, Object.keys(rows), now);
    expect(problems.map((p) => p.split(":")[0])).toEqual(["stale", "soon"]);
    expect(problems[0]).toContain("Re-check");
    expect(lifecycleProblems(rows, ["missing"], now)).toEqual([
      "missing: no lifecycle row in src/config/models.ts",
    ]);
  });
});
