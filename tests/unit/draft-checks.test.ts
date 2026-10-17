import { describe, expect, it } from "vitest";
import { checkDraft, hasLink, REGENERATE_ON } from "@/ai/draft-checks";
import { guardrailReasons } from "@/server/autopilot";

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

describe("days and times as whole words (Check 20 P1, Check 23 P3 + P4)", () => {
  const base = { doNotPromise: [] as string[], phrasesAvoided: [] as string[] };
  const when = (
    body: string,
    extra: Partial<Parameters<typeof checkDraft>[1]> & { sourceText: string },
  ) => checkDraft(body, { ...base, ...extra });

  it("the hours line never excuses a day the customer didn't name", () => {
    const convo = "Can you come look at the leak under the sink?";
    const r = when("How about Friday at 9?", {
      sourceText: `${convo}\nMonday to Friday, 7am to 4pm`,
      whenSourceText: convo,
      hoursText: "Monday to Friday, 7am to 4pm",
    });
    expect(r.hits).toContain("when");
    expect(r.flags[0]).toContain("friday");
    // The hours' times still count ("7am" is the owner's own).
    expect(
      when("We start at 7am.", {
        sourceText: convo,
        whenSourceText: convo,
        hoursText: "Mon–Fri 7am–4pm",
      }).hits,
    ).not.toContain("when");
  });

  it("a time the customer didn't give is flagged; one they wrote isn't", () => {
    const r = when("Thursday at 10:30 works.", { sourceText: "Can you come Thursday at 2?" });
    expect(r.hits).toContain("when");
    expect(r.flags[0]).toContain("10:30");
    expect(r.flags[0]).not.toContain("thursday");
    expect(
      when("10:30 is great, see you then.", { sourceText: "10:30 works for me" }).hits,
    ).toEqual([]);
    expect(when("8 am Thursday works.", { sourceText: "Could you do 8am Thursday?" }).hits).toEqual(
      [],
    );
    expect(when("I'll be there at 8.", { sourceText: "Could you do 8am?" }).hits).toEqual([]);
  });

  it.each([
    ["I can come Fri to replace the line.", "The fridge water line is leaking."],
    ["Mon works for me.", "It started leaking last month."],
    ["How's Sat?", "We weren't satisfied with the last guy."],
    ["Sun afternoon is open.", "The leak is in the sunroom."],
    ["Wednesday then.", "We're getting ready for a wedding."],
  ])("a substring never excuses a day: %s", (body, sourceText) => {
    expect(when(body, { sourceText }).hits).toContain("when");
  });

  it("“Tuesday works.” after “Can you come Tuesday?” still passes", () => {
    expect(when("Tuesday works.", { sourceText: "Can you come Tuesday?" }).flags).toEqual([]);
  });

  it("a seasonal note's end date counts", () => {
    expect(
      when("We're booked until Nov 27, sorry.", {
        sourceText: "x",
        whenSourceText: "Booked solid with roofs\nNovember 27",
      }).hits,
    ).toEqual([]);
  });

  it("the availability tweak may give the hours' days; otherwise they're flagged", () => {
    const body = "I'm around Monday to Friday, 7am to 4pm.";
    const src = {
      sourceText: "Need a quote",
      whenSourceText: "Need a quote",
      hoursText: "Mon–Fri 7am–4pm",
    };
    expect(when(body, { ...src, allowHours: true }).hits).toEqual([]);
    expect(when(body, src).hits).toContain("when");
  });

  it.each([
    "I'll be there at 10 a.m.",
    "I'll be there at 9 sharp",
    "We'll have someone there within the hour.",
    "We'll have it wrapped up before Thanksgiving.",
    "We're about three weeks out right now.",
    "I can come by 9 o'clock.",
    "Thursday in the morning works.",
  ])("dots, bare hours, holidays and lead time are seen: %s", (body) => {
    expect(
      when(body, {
        sourceText: "Can you come Thursday?",
        leadTimeText: "About two weeks out",
      }).hits,
    ).toContain("when");
  });

  it("the profile's own lead time is allowed; ordinary numbers stay clean", () => {
    const src = { sourceText: "Can you do the job?", leadTimeText: "About two weeks out" };
    expect(when("We're about two weeks out right now.", src).hits).toEqual([]);
    expect(when("The bathroom is on the 2nd floor.", src).hits).toEqual([]);
    expect(when("After three weeks of rain the roof needs a look.", src).hits).toEqual([]);
    expect(when("We'll use 1/2 inch pipe at 9 Elm St.", src).hits).toEqual([]);
    expect(when("I'll be there at 8am.", { sourceText: "8am works" }).hits).toEqual([]);
  });

  it("same-day words break a same-day never-promise item", () => {
    const r = when("I'll get a tech to you before the day is out.", {
      sourceText: "Water everywhere!",
      doNotPromise: ["same-day service"],
    });
    expect(r.hits).toContain("never_promise");
  });

  it("a “tomorrow” from an email written days ago is flagged; today's isn't", () => {
    const msg = "Can you come tomorrow?";
    const now = new Date("2026-10-16T15:00:00Z"); // a Friday
    const old = when("Tomorrow works.", {
      sourceText: msg,
      customerMessages: [{ text: msg, sentAt: new Date("2026-10-13T15:00:00Z") }],
      now,
      timeZone: "America/New_York",
    });
    expect(old.hits).toContain("when");
    expect(old.flags).toContain("Says “tomorrow”, but they wrote that on Tuesday. Check the day.");
    const fresh = when("Tomorrow works.", {
      sourceText: msg,
      customerMessages: [{ text: msg, sentAt: new Date("2026-10-16T13:00:00Z") }],
      now,
      timeZone: "America/New_York",
    });
    expect(fresh.hits).toEqual([]);
  });

  it("a draft with a day nobody named never gets an autopilot countdown", () => {
    const r = when("Thursday at 10:30 works.", { sourceText: "Can you come Thursday at 2?" });
    expect(
      guardrailReasons({
        category: "scheduling",
        needsOwner: false,
        kind: "reply",
        confidencePct: Math.round(r.confidenceCap * 100),
        flags: r.flags,
        amountsInEmail: [],
        draftBody: "Thursday at 10:30 works.",
        knownCustomer: true,
        purpose: null,
      }),
    ).toContain("Has things to check before sending.");
  });
});

describe("spoken prices and “for free” (Check 23 P1, Check 20 P11)", () => {
  const ctx = {
    sourceText: "How much to swap the water heater?",
    doNotPromise: [],
    phrasesAvoided: [],
  };
  it.each(["Ballpark 3-4k depending on access.", "It's fourteen fifty for the swap."])(
    "%s → money, capped at 0.3",
    (body) => {
      const r = checkDraft(body, ctx);
      expect(r.hits).toContain("money");
      expect(r.confidenceCap).toBeLessThanOrEqual(0.3);
    },
  );
  it("a rough price asks the owner to check", () => {
    const r = checkDraft("Usually low four figures.", ctx);
    expect(r.hits).toContain("money");
    expect(r.flags).toContain(
      "Gives a rough price (“low four figures”). Check you want to name a number.",
    );
  });
  it("“for free” is a promise; “feel free” and the owner's free estimates aren't", () => {
    expect(checkDraft("I'll come fix it for free.", ctx).hits).toContain("soft_promise");
    expect(checkDraft("We'll cover the cost.", ctx).hits).toContain("soft_promise");
    expect(checkDraft("Feel free to call me.", ctx).hits).toEqual([]);
    expect(
      checkDraft("Estimates are for free, so happy to come look.", {
        ...ctx,
        ownerSourceText: "Free estimates",
      }).hits,
    ).toEqual([]);
  });
});
