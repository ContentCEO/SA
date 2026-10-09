import { describe, expect, it } from "vitest";
import { checkDraft } from "@/ai/draft-checks";
import { DRAFT_INSTRUCTIONS, workspaceBlock, type WorkspaceContext } from "@/ai/prompts/draft.v3";

const base: WorkspaceContext = {
  businessName: "Leak Busters",
  trade: "plumbing",
  services: null,
  serviceArea: null,
  hours: null,
  leadTime: null,
  pricingNotes: "Service call: $95\nWater heater swap (40 gal): from $1,450 installed",
  paymentTerms: null,
  policies: null,
  signature: null,
  doNotPromise: [],
  voice: null,
};

describe("price list", () => {
  it("puts each listed price in front of the model, one per line", () => {
    const block = workspaceBlock(base);
    expect(block).toContain("  Service call: $95");
    expect(block).toContain("  Water heater swap (40 gal): from $1,450 installed");
    expect(DRAFT_INSTRUCTIONS).toContain("exactly as written");
  });

  it("says plainly when there's no list", () => {
    expect(workspaceBlock({ ...base, pricingNotes: null })).toContain("never state a price");
  });

  it("listed prices pass the check; anything else is still flagged", () => {
    const ctx = { sourceText: base.pricingNotes!, doNotPromise: [], phrasesAvoided: [] };
    expect(checkDraft("A swap is from $1,450 installed.", ctx).flags).toEqual([]);
    const r = checkDraft("A swap is $1,300.", ctx);
    expect(r.flags[0]).toContain("$1,300");
    expect(r.confidenceCap).toBeLessThan(0.5);
  });
});
