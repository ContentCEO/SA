import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { workspaceBlock, type WorkspaceContext } from "@/ai/prompts/draft.v4";
import { tradePromptFor, tradePrompts } from "@/ai/prompts/trades";
import { TRADES, tradeLabel } from "@/config/trades";
import { tradeEnum } from "@/db/schema";

describe("trades", () => {
  it("the database enum is the config list", () => {
    expect([...tradeEnum.enumValues]).toEqual([...TRADES]);
    expect(TRADES).toEqual(expect.arrayContaining(["hvac", "roofing", "painting", "landscaping"]));
    expect(TRADES.at(-1)).toBe("other");
  });

  it.each(TRADES)("%s has its own prompt file with words and quote questions", (t) => {
    expect(existsSync(`src/ai/prompts/trades/${t}.ts`)).toBe(true);
    expect(tradePrompts[t].vocabulary.length).toBeGreaterThanOrEqual(5);
    expect(tradePrompts[t].quoteQuestions.length).toBeGreaterThanOrEqual(4);
    expect(tradePrompts[t].quoteQuestions[0]).toMatch(/address/);
    expect(tradeLabel[t]).toBeTruthy();
  });

  it("drafts get the owner's trade questions; unknown trades fall back safely", () => {
    const ctx = {
      businessName: null,
      trade: "roofing",
      services: null,
      serviceArea: null,
      hours: null,
      leadTime: null,
      pricingNotes: null,
      paymentTerms: null,
      policies: null,
      signature: null,
      doNotPromise: [],
      neverSay: [],
      seasonalNotes: [],
      voice: null,
    } satisfies WorkspaceContext;
    const block = workspaceBlock(ctx);
    expect(block).toContain("tear-off vs. layover");
    expect(block).toContain("whether insurance is involved");
    expect(block).not.toContain("panel");
    expect(tradePromptFor(null)).toBe(tradePrompts.other);
    expect(tradePromptFor("blacksmith")).toBe(tradePrompts.other);
  });
});
