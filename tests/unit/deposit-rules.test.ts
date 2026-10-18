import { describe, expect, it } from "vitest";
import { checkDraft } from "@/ai/draft-checks";
import { MA_DEPOSIT_DRAFT_FLAG } from "@/config/ma-rules";
import { depositShare, overMaDepositCap } from "@/server/deposit-rules";

describe("depositShare (Check 38 P2)", () => {
  it.each([
    ["50% deposit, balance at completion", 0.5],
    ["40 percent down to book", 0.4],
    ["Half down to get on the schedule, balance at completion.", 0.5],
    ["half up front", 0.5],
    ["Two-thirds up front, the rest when done", 2 / 3],
    ["60/40 — sixty at signing, forty at the end", 0.6],
    ["50/50 split", 0.5],
    ["One-third at signing, one-third at rough-in, one-third at completion", 1 / 3],
    ["a third down", 1 / 3],
    ["33% deposit", 0.33],
    ["25% deposit to schedule", 0.25],
    ["We ask for 30% up front and 70% on completion", 0.3],
    ["Deposit: 75% of materials", 0.75],
    ["Payment in full up front", 1],
    ["100% up front for small jobs", 1],
    ["Retainer of 20 percent", 0.2],
    ["a quarter down", 0.25],
  ])("%s → %d", (text, share) => {
    expect(depositShare(text)).toBeCloseTo(share, 5);
  });

  it.each([
    "deposit at signing",
    "balance at completion",
    "net 30",
    "Due on receipt. Check or card.",
    "10% off for seniors",
    "We finish half the jobs in a day",
    "3/4 inch pipe",
    "",
  ])("states no share: %s", (text) => {
    expect(depositShare(text)).toBeNull();
  });

  it("only more than a third, only in Massachusetts", () => {
    expect(overMaDepositCap("MA", "Half down")).toBe(true);
    expect(overMaDepositCap("ma", "34% deposit")).toBe(true);
    expect(overMaDepositCap("MA", "33% deposit")).toBe(false);
    expect(overMaDepositCap("MA", "One-third at signing")).toBe(false);
    expect(overMaDepositCap("NH", "Half down")).toBe(false);
    expect(overMaDepositCap(null, "Half down")).toBe(false);
  });
});

describe("the draft check (Check 38 P2)", () => {
  const ctx = (state: string | null, checkTerms = false) => ({
    sourceText: "Let's do it. When can you start?",
    doNotPromise: [],
    phrasesAvoided: [],
    state,
    ...(checkTerms
      ? { checkTerms: true, termsSource: "Half down to get on the schedule.", ownerWrote: "" }
      : {}),
  });
  const body = "Great! Half down to get on the schedule, balance at completion.";

  it("an MA deposit note asking for half is flagged, never rewritten", () => {
    const r = checkDraft(body, ctx("MA", true));
    expect(r.flags).toContain(MA_DEPOSIT_DRAFT_FLAG);
    expect(r.hits).toContain("deposit_cap");
    expect(r.confidenceCap).toBeLessThanOrEqual(0.5);
  });

  it("any MA draft that states a deposit share is checked too", () => {
    expect(checkDraft("We'd need 50% down to book it.", ctx("MA")).hits).toContain("deposit_cap");
  });

  it("outside Massachusetts, or at one-third, nothing new", () => {
    expect(checkDraft(body, ctx("NH", true)).hits).not.toContain("deposit_cap");
    expect(checkDraft(body, ctx(null, true)).hits).not.toContain("deposit_cap");
    expect(
      checkDraft("One-third at signing, balance at completion.", ctx("MA")).hits,
    ).not.toContain("deposit_cap");
  });
});
