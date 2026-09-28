import { describe, expect, it } from "vitest";
import { formatDollars, pricing } from "@/config/pricing";

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
