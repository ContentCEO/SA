import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  billingStatusLine,
  planEndingSoon,
  planEndsAtFrom,
  planEndsLine,
  SETUP_CALL_COVERS,
  SETUP_NOT_PAID_LINE,
  setupCallSentence,
} from "@/server/billing-rules";

const flat = (s: string) => s.replace(/\s+/g, " ");

/** Check 35 P3: what the one-time setup covers, said one way in every place. */
describe("the setup call sentence", () => {
  for (const kind of ["before", "after"] as const) {
    it(`"${kind}" names every item, in order, and ends the same way`, () => {
      const s = setupCallSentence(kind);
      let at = -1;
      for (const item of SETUP_CALL_COVERS) {
        const i = s.indexOf(item);
        expect(i, item).toBeGreaterThan(at);
        at = i;
      }
      expect(s).toMatch(/your drafts until they sound like you$/);
      expect(s).not.toContain("scheduling");
    });
  }

  it("the homepage and /billing use it before paying; /billing and the banner after", () => {
    expect(readFileSync("src/app/page.tsx", "utf8")).toContain(
      'A call with us to {setupCallSentence("before")}.',
    );
    const billing = flat(readFileSync("src/app/(app)/billing/page.tsx", "utf8"));
    expect(billing).toContain('a call with us to {setupCallSentence("before")}.');
    expect(billing).toContain('On the call, {davi} {setupCallSentence("after")}.');
    const banner = flat(readFileSync("src/components/app/status-banner.tsx", "utf8"));
    expect(banner).toContain('{setupCallSentence("after")}');
    expect(banner).not.toContain("scheduling and never-promise list");
  });
});

describe("a canceled plan says when it ends (Check 17 P3)", () => {
  const NOW = new Date("2026-11-01T15:00:00Z");
  const ENDS = new Date("2026-11-16T15:00:00Z");
  const w = (over: Record<string, unknown>) => ({
    status: "active" as const,
    evaluationEndsAt: null,
    setupPaidVia: "stripe" as const,
    planEndsAt: null as Date | null,
    ...over,
  });

  it("with a date: the end date instead of 'renews monthly'", () => {
    expect(billingStatusLine(w({ planEndsAt: ENDS }), NOW, "America/New_York")).toBe(
      "Your plan ends on Nov 16. Nothing is deleted. Changed your mind? Manage billing keeps it going.",
    );
    expect(billingStatusLine(w({ status: "setup_paid", planEndsAt: ENDS }), NOW)).toBe(
      planEndsLine("Nov 16"),
    );
    // The owner's zone decides the day (11pm Eastern on the 15th is the 16th in UTC).
    const late = new Date("2026-11-16T04:00:00Z");
    expect(billingStatusLine(w({ planEndsAt: late }), NOW, "America/New_York")).toContain("Nov 15");
    expect(billingStatusLine(w({ planEndsAt: late }), NOW, "Not/AZone")).toContain("Nov 15");
  });

  it("without a date: the old line comes back", () => {
    expect(billingStatusLine(w({}), NOW)).toBe("All set. Your plan renews monthly.");
  });

  it("an account that never really paid still gets SETUP_NOT_PAID_LINE", () => {
    expect(billingStatusLine(w({ setupPaidVia: null, planEndsAt: ENDS }), NOW)).toBe(
      SETUP_NOT_PAID_LINE,
    );
  });

  it("the end date comes from cancel_at, else the first item's period end", () => {
    const items = { data: [{ current_period_end: ENDS.getTime() / 1000 }] };
    expect(planEndsAtFrom({ status: "active", cancel_at: 1_800_000_000, items })).toEqual(
      new Date(1_800_000_000_000),
    );
    expect(planEndsAtFrom({ status: "active", cancel_at_period_end: true, items })).toEqual(ENDS);
    expect(planEndsAtFrom({ status: "active", cancel_at_period_end: false, items })).toBeNull();
    expect(planEndsAtFrom({ status: "canceled", cancel_at: 1_800_000_000, items })).toBeNull();
  });

  it("the banner reminder is for the last 7 days only", () => {
    expect(planEndingSoon(ENDS, NOW)).toBe(false);
    expect(planEndingSoon(ENDS, new Date(ENDS.getTime() - 6 * 86_400_000))).toBe(true);
    expect(planEndingSoon(ENDS, new Date(ENDS.getTime() + 1000))).toBe(false);
    expect(planEndingSoon(null, NOW)).toBe(false);
  });
});
