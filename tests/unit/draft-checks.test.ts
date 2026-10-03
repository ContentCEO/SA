import { describe, expect, it } from "vitest";
import { checkDraft } from "@/ai/draft-checks";

const ctx = {
  sourceText: "Can you come Tuesday? Service call is $95 per my pricing.",
  doNotPromise: ["Same-day service", "A price over email"],
  phrasesAvoided: ["circle back"],
};

describe("draft spot checks", () => {
  it("flags a price that appears nowhere in the email or profile", () => {
    const r = checkDraft("The panel upgrade will be $2,400.", ctx);
    expect(r.flags[0]).toContain("$2,400");
    expect(r.confidenceCap).toBeLessThanOrEqual(0.3);
  });

  it("allows prices the owner already stated", () => {
    expect(checkDraft("The service call is $95.", ctx).flags).toEqual([]);
  });

  it("flags days and times the customer didn't raise", () => {
    expect(checkDraft("Tuesday works.", ctx).flags).toEqual([]);
    const r = checkDraft("I can be there Thursday at 8am.", ctx);
    expect(r.flags[0]).toContain("thursday");
    expect(r.flags[0]).toContain("8am");
  });

  it("flags anything on the never-promise list", () => {
    const r = checkDraft("We offer same-day service, no problem.", ctx);
    expect(r.flags.some((f) => f.includes("never-promise"))).toBe(true);
    expect(r.confidenceCap).toBeLessThanOrEqual(0.2);
  });

  it("flags filler and phrases the owner avoids", () => {
    expect(checkDraft("I hope this email finds you well.", ctx).flags[0]).toContain(
      "doesn't sound like you",
    );
    expect(checkDraft("Let me circle back.", ctx).flags[0]).toContain("circle back");
  });

  it("leaves a clean draft alone", () => {
    expect(checkDraft("Hey Dana, what's the address? Thanks, Davi", ctx)).toEqual({
      flags: [],
      confidenceCap: 1,
    });
  });
});
