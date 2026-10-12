import { describe, expect, it } from "vitest";
import { checkDraft, hasLink, REGENERATE_ON } from "@/ai/draft-checks";

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
      hits: [],
    });
  });
});

describe("payment terms check (deposit and review notes only — A4)", () => {
  const base = { doNotPromise: [], phrasesAvoided: [] };
  const terms = (termsSource: string) => ({
    ...base,
    sourceText: termsSource,
    termsSource,
    checkTerms: true,
  });

  it("no terms + '50% deposit by Zelle' → flagged, capped, and worth a retry", () => {
    const r = checkDraft("Great! A 50% deposit by Zelle locks in your spot.", terms(""));
    expect(r.flags).toEqual([
      "Mentions “50%”, “Zelle” — that isn't in your payment terms. Check it.",
    ]);
    expect(r.hits).toContain("terms");
    expect(r.confidenceCap).toBeLessThanOrEqual(0.3);
    expect(REGENERATE_ON).toContain("terms");
  });

  it("terms 'check or card' + a body saying Venmo → flagged", () => {
    const r = checkDraft(
      "You can send the deposit by Venmo.",
      terms("Due on completion; check or card"),
    );
    expect(r.flags[0]).toContain("“Venmo”");
  });

  it("what the terms say is fine, in the draft's own words", () => {
    const src = "50% deposit to book, by check or credit card";
    expect(
      checkDraft("A 50 % deposit books it — by check or credit card.", terms(src)).flags,
    ).toEqual([]);
    expect(
      checkDraft("Pay by check or debit card when we finish.", terms("check or card")).flags,
    ).toEqual([]);
  });

  it("incentives the owner never offered are flagged; 'feel free' is not one", () => {
    expect(checkDraft("Book now for 10% off your next job!", terms("")).flags[0]).toMatch(
      /“10%”.*“% off”.*“off your”/,
    );
    expect(checkDraft("Here's a gift card for your trouble.", terms("")).flags[0]).toContain(
      "gift card",
    );
    expect(checkDraft("Feel free to call with questions.", terms("")).flags).toEqual([]);
  });

  it("is off for ordinary replies: 'let me check' or a card never flags an everyday draft", () => {
    const everyday = "Let me check the schedule. We take cash, Zelle or card, and 50% is typical.";
    expect(checkDraft(everyday, { ...base, sourceText: "" }).hits).not.toContain("terms");
    // Even with the check on, "let me check" alone is not a payment method.
    expect(checkDraft("Let me check and get back to you.", terms("")).flags).toEqual([]);
  });

  it("the customer's own words never count as terms; the owner's do, said as a draft would", () => {
    const customer = "Great, let's do it. I'll send 50% by Venmo tonight. Any discount for cash?";
    const ctx = {
      ...base,
      sourceText: `${customer}\nDue on completion; check or card`,
      termsSource: "Due on completion; check or card",
      ownerWrote: "Hi Dana, let me check the schedule. The job is $3,100.",
      checkTerms: true,
    };
    const r = checkDraft("Perfect, 50% by Venmo works, and a discount for cash is fine.", ctx);
    expect(r.flags[0]).toMatch(/“50%”.*“Venmo”.*“cash”.*“discount”/);
    expect(r.hits).toContain("terms");
    // "let me check" in the owner's mail is not the owner offering to take a check.
    expect(checkDraft("You can pay the deposit by check.", ctx).flags).toEqual([]); // terms say check
    expect(
      checkDraft("You can pay the deposit by check.", { ...ctx, termsSource: "Card only" })
        .flags[0],
    ).toContain("“check”");
    // What the owner told this customer themselves is theirs to repeat.
    expect(
      checkDraft("As I said, a 25% deposit by Zelle books it.", {
        ...ctx,
        ownerWrote: "We take a 25% deposit by Zelle to book.",
      }).flags,
    ).toEqual([]);
  });

  it("card and check said the usual ways are caught; 'let me check' still isn't", () => {
    expect(
      checkDraft("You can pay by card when we start.", terms("Check only")).flags[0],
    ).toContain("“card”");
    expect(
      checkDraft("Pay with a card, whatever's easiest.", terms("Check only")).flags[0],
    ).toContain("“card”");
    expect(checkDraft("Just send a check to the shop.", terms("Card")).flags[0]).toContain(
      "“check”",
    );
    expect(checkDraft("Pay with a check when we start.", terms("Card")).flags[0]).toContain(
      "“check”",
    );
    expect(checkDraft("Let me check and get back to you.", terms("Card")).flags).toEqual([]);
    expect(checkDraft("I'll check with my supplier.", terms("Card")).flags).toEqual([]);
    // The terms allow it.
    expect(checkDraft("You can pay by card when we start.", terms("Card")).flags).toEqual([]);
    expect(checkDraft("Just send a check to the shop.", terms("Check only")).flags).toEqual([]);
  });

  it("an amount only the customer named isn't a term; the owner's own figures are", () => {
    const ctx = {
      ...base,
      sourceText: "I'll send a $500 deposit.\nCard\nThe panel upgrade is $3,100.",
      termsSource: "Card",
      ownerWrote: "The panel upgrade is $3,100.",
      checkTerms: true,
    };
    const r = checkDraft("Thanks! A $500 deposit by card works.", ctx);
    expect(r.flags).toEqual(["Mentions “$500” — that isn't in your payment terms. Check it."]);
    expect(r.hits).toEqual(["terms"]);
    expect(r.confidenceCap).toBeLessThanOrEqual(0.3);
    // The owner's quoted price is theirs to repeat.
    expect(checkDraft("The $3,100 by card is due on completion.", ctx).flags).toEqual([]);
    // Off for ordinary replies.
    expect(
      checkDraft("Thanks! A $500 deposit works.", { ...base, sourceText: ctx.sourceText }).flags,
    ).toEqual([]);
  });

  it("hasLink ignores a trailing slash or full stop", () => {
    expect(hasLink("Here: https://g.page/r/abc.", "https://g.page/r/abc/")).toBe(true);
    expect(hasLink("Here: https://g.page/r/abc/", "https://g.page/r/abc")).toBe(true);
    expect(hasLink("Here: https://g.page/r/abcd", "https://g.page/r/abc")).toBe(false);
    expect(hasLink("No link here.", "https://g.page/r/abc")).toBe(false);
  });

  it("review requests: only the owner's link, and nothing offered in return", () => {
    const url = "https://g.page/r/example/review";
    const review = (sourceText = "") => ({ ...terms(sourceText), review: { url } });
    expect(checkDraft(`Would you leave us a review?\n${url}`, review()).flags).toEqual([]);
    expect(checkDraft(`Would you leave us a review? ${url}/.`, review()).flags).toEqual([]);
    expect(
      checkDraft("Would you leave us a review? https://evil.example.com/r", review()).flags[0],
    ).toBe("Has a link that isn't your review link. Check it.");
    // Even a discount the profile mentions is never offered for a review.
    expect(
      checkDraft(`A review gets you a discount! ${url}`, review("Seniors discount 10%")).flags[0],
    ).toContain("never offers");
  });

  it("placeholders aren't terms", () => {
    expect(
      checkDraft("For the deposit:\n\n{{custom:deposit instructions}}", terms("")).flags,
    ).toEqual([]);
  });
});
