import { describe, expect, it } from "vitest";
import {
  formatDollars,
  mailboxLimitFor,
  PLAN_ORDER,
  planAbove,
  planHasAutopilot,
  planRank,
  pricing,
} from "@/config/pricing";

describe("pricing config", () => {
  it("matches the agreed commercial terms", () => {
    expect(pricing.setupFee.amountCents).toBe(49_900);
    expect(pricing.plans.solo.amountCents).toBe(9_900);
    expect(pricing.plans.crew.amountCents).toBe(19_900);
    expect(pricing.plans.company.amountCents).toBe(29_900);
    expect(pricing.evaluationDays).toBe(3);
  });

  it("sets mailbox limits per plan", () => {
    expect(pricing.plans.solo.mailboxLimit).toBe(1);
    expect(pricing.plans.crew.mailboxLimit).toBe(3);
    expect(pricing.plans.company.mailboxLimit).toBe(10);
  });

  it("formats whole and fractional dollars", () => {
    expect(formatDollars(49_900)).toBe("$499");
    expect(formatDollars(1_050)).toBe("$10.50");
  });
});

describe("plan order (plan #47: the plan above yours)", () => {
  it("runs from the smallest plan to the largest and covers every plan", () => {
    expect([...PLAN_ORDER].sort()).toEqual(Object.keys(pricing.plans).sort());
    for (let i = 1; i < PLAN_ORDER.length; i++) {
      const lower = pricing.plans[PLAN_ORDER[i - 1]!];
      const higher = pricing.plans[PLAN_ORDER[i]!];
      expect(higher.amountCents).toBeGreaterThan(lower.amountCents);
      expect(higher.mailboxLimit).toBeGreaterThan(lower.mailboxLimit);
    }
    expect(planRank(null)).toBe(-1);
  });

  it("one plan up stops at the top", () => {
    expect(planAbove("solo")).toBe("crew");
    expect(planAbove("crew")).toBe("company");
    expect(planAbove("company")).toBe("company");
  });

  it("inbox limits and autopilot per plan, one inbox before a plan", () => {
    expect(mailboxLimitFor(null)).toBe(1);
    expect(mailboxLimitFor("crew")).toBe(3);
    expect(planHasAutopilot("solo")).toBe(false);
    expect(planHasAutopilot("crew")).toBe(true);
    expect(planHasAutopilot(null)).toBe(false);
  });

  it("the referral reward is offer A, and the old cash credit is gone", async () => {
    const config = await import("@/config/pricing");
    expect(config.REFERRAL_REWARD).toBe("free_month_one_plan_up");
    expect("REFERRAL_CREDIT_CENTS" in config).toBe(false);
    expect("REFERRAL_CREDIT_TO" in config).toBe(false);
  });
});
