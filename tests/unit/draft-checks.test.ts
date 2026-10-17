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

describe("claims an owner has to stand behind (Check 23 P2, Check 36 P7, Check 38 P6)", () => {
  const customer = "Can you swap our water heater? Is that under warranty?";
  const ctx = (owner = "", licenses = {}) => ({
    sourceText: `${customer}\n${owner}`,
    ownerSourceText: owner,
    doNotPromise: [] as string[],
    phrasesAvoided: [] as string[],
    licenses,
  });

  it.each([
    ["No permit needed for that one.", "no permit needed"],
    ["No permit needed for a swap like this, so we can skip the inspection.", "no permit needed"],
    ["You don't need a permit for this.", "no permit needed"],
    ["From the photos it's all up to code.", "up to code"],
    ["I'll waive the trip fee for you.", "waived fee"],
    ["We'll match their price.", "price match"],
    ["I can squeeze you in.", "fit you in"],
  ])("“%s” is flagged as a soft promise", (body, label) => {
    const r = checkDraft(body, ctx());
    expect(r.hits).toContain("soft_promise");
    expect(r.flags.join(" ")).toContain(`“${label}”`);
    expect(REGENERATE_ON).not.toContain("soft_promise");
  });

  it("the owner's own words let the same claim pass", () => {
    expect(
      checkDraft("We pull permits for all water heater work, so we'll pull the permit.", ctx())
        .hits,
    ).toEqual([]);
    expect(
      checkDraft("Our work is always up to code.", ctx("Policies: all work up to code")).hits,
    ).not.toContain("soft_promise");
  });

  it("warranty words: the customer asking never makes it the owner's promise", () => {
    expect(checkDraft("That's covered under warranty, we'll swap it.", ctx()).hits).toContain(
      "commitment",
    );
    expect(
      checkDraft("That's covered under warranty, we'll swap it.", ctx("1-year warranty on labor"))
        .hits,
    ).not.toContain("commitment");
  });

  it.each([
    "Our HIC number is 198344.",
    "We're registered, HIC #198344.",
    "I hold a construction supervisor license, CS-104512.",
    "We're a lead-safe renovation contractor, license LR-004417.",
    "My license is MP-31872, and here's the insurance certificate.",
    "Sure. I'm a master plumber, license number 31872.",
  ])("an unsaved number is a license flag, never a price: %s", (body) => {
    const r = checkDraft(body, ctx());
    expect(r.hits).toContain("license");
    expect(r.hits).not.toContain("money");
    expect(r.flags).toContain(
      "Mentions a license or registration number you haven't saved. Check it.",
    );
    expect(r.confidenceCap).toBeLessThanOrEqual(0.3);
    expect(REGENERATE_ON).toContain("license");
  });

  it("saved numbers pass, however they're written", () => {
    const saved = {
      hic_number: "198344",
      csl_number: "CS-104512",
      lead_safe_license: "LR-004417",
      insurance_carrier: "Plymouth Rock",
    };
    const owner = "Registration and licenses: HIC 198344; CSL CS-104512; Lead-safe LR-004417";
    for (const body of [
      "Our HIC number is 198344.",
      "We're registered, HIC #198344.",
      "I hold a construction supervisor license, CS-104512.",
      "We're a lead-safe renovation contractor, license LR-004417.",
    ])
      expect(checkDraft(body, ctx(owner, saved)).hits, body).toEqual([]);
    // A number in the signature counts as the owner's.
    expect(checkDraft("My license is MP-31872.", ctx("Thanks,\nRosa\nLic. MP-31872")).hits).toEqual(
      [],
    );
  });

  it("ordinary numbers don't trip it", () => {
    for (const body of ["The bathroom is on the 2nd floor.", "Is that unit 3?"])
      expect(checkDraft(body, ctx()).hits, body).not.toContain("license");
  });

  it("registered / licensed / lead-safe / insured claims need the matching field", () => {
    const r = checkDraft("We're HIC registered and I hold a CSL.", ctx());
    expect(r.hits).toContain("credential");
    expect(r.flags).toContain(
      "Says you're registered and licensed. Add it in Settings or take it out.",
    );
    const lead = checkDraft("Yes, we're lead-safe certified and we test every older house.", ctx());
    expect(lead.flags).toContain(
      "Says you're lead-safe certified. Add it in Settings or take it out.",
    );
    expect(checkDraft("We're fully licensed and insured.", ctx()).flags).toContain(
      "Says you're licensed and insured. Add it in Settings or take it out.",
    );
    const saved = {
      hic_number: "198344",
      csl_number: "CS-104512",
      lead_safe_license: "LR-004417",
      insurance_carrier: "Plymouth Rock",
    };
    expect(
      checkDraft(
        "We're HIC registered, lead-safe certified, and fully licensed and insured.",
        ctx("", saved),
      ).hits,
    ).toEqual([]);
  });
});

describe("“that's covered” and “we'll add it to the bill” (Check 38 P7)", () => {
  const ctx = {
    sourceText: "The shower you did last year is leaking again. Also the tile came in $1,100 over.",
    ownerSourceText: "",
    doNotPromise: [] as string[],
    phrasesAvoided: [] as string[],
  };
  it.each([
    ["Sorry to hear that. That's covered, we'll come fix it. What days work?", "that's covered"],
    ["That's fine, we'll add it to the final bill.", "add it to the bill"],
    ["We'll fix it for free.", "fix it for free"],
    ["That's fine, $1,100 over is no problem.", "that's fine"],
    ["No extra charge for the second visit.", "no extra charge"],
  ])("%s", (body, label) => {
    const r = checkDraft(body, ctx);
    expect(r.hits).toContain("soft_promise");
    expect(r.flags.join(" ")).toContain(`“${label}”`);
    expect(r.flags.join(" ")).toContain("make sure you stand behind that");
  });
  it.each([
    "The floor is covered with plastic while we work.",
    "You're covered for Tuesday, see you then.",
    "That's fine, see you then.",
  ])("everyday words stay clean: %s", (body) => {
    expect(checkDraft(body, { ...ctx, sourceText: "Tuesday works" }).hits).not.toContain(
      "soft_promise",
    );
  });
});

describe("light payment-terms check on every reply (Check 23 P5)", () => {
  const reply = (termsSource: string, ownerWrote = "") => ({
    sourceText: "Can we pay by Venmo? When can you start?",
    ownerSourceText: "",
    doNotPromise: [] as string[],
    phrasesAvoided: [] as string[],
    termsSource,
    ownerWrote,
  });
  const TERMS = "Due on receipt. Check or card.";

  it.each([
    ["We just need half down to get on the schedule.", "half down"],
    ["Net 30 is fine.", "Net 30"],
    ["Venmo works fine.", "Venmo"],
  ])("%s → flagged, never rewritten", (body, label) => {
    const r = checkDraft(body, reply(TERMS));
    expect(r.hits).toContain("payment_terms");
    expect(r.flags).toContain(`Mentions “${label}” — that isn't in your payment terms. Check it.`);
    expect(REGENERATE_ON).not.toContain("payment_terms");
  });

  it("what the terms or the owner's own emails say is fine; everyday words stay clean", () => {
    expect(checkDraft("Check or card is fine.", reply("Check or card")).hits).toEqual([]);
    expect(checkDraft("You can pay by check on the day.", reply(TERMS)).hits).toEqual([]);
    expect(checkDraft("Venmo works fine.", reply(TERMS, "Venmo is easiest for me")).hits).toEqual(
      [],
    );
    expect(checkDraft("Let me check the schedule.", reply(TERMS)).hits).toEqual([]);
    expect(checkDraft("I'll card it on my list.", reply(TERMS)).hits).toEqual([]);
    expect(
      checkDraft("Half down, balance at completion.", reply("Half down, balance at completion"))
        .hits,
    ).toEqual([]);
  });

  it("is off when the caller gives no terms (as before)", () => {
    expect(
      checkDraft("Net 30 is fine.", {
        sourceText: "",
        doNotPromise: [],
        phrasesAvoided: [],
      }).hits,
    ).toEqual([]);
  });
});

describe("phone numbers, links and names nobody gave (Check 23 P6)", () => {
  const ctx = {
    sourceText:
      "Hi, the vanity drain at 12 Main St is slow.\nThanks,\nAlex Rivera\nRivera Plumbing · (508) 555-0199\nBook online: https://riveraplumbing.test/book",
    ownerSourceText: "",
    doNotPromise: [] as string[],
    phrasesAvoided: [] as string[],
    knownNames: ["Dana Ruiz"],
  };
  it.each([
    ["Call me at 978-555-0142 anytime.", "Has the number 978-555-0142"],
    [
      "Book here: https://exampleplumbing.test/book",
      "Has the link https://exampleplumbing.test/book",
    ],
    ["My guy Pete will handle it, he's great with old copper.", "Mentions “Pete”"],
    ["We did the same vanity for the Hendersons on Elm, ran them $650.", "Mentions “Henderson”"],
    ["Write to bookings@exampleplumbing.test.", "Has the address bookings@exampleplumbing.test"],
  ])("%s", (body, flag) => {
    const r = checkDraft(body, ctx);
    expect(r.hits).toContain("contact");
    expect(r.flags.join(" ")).toContain(flag);
    expect(r.confidenceCap).toBeLessThanOrEqual(0.3);
    expect(REGENERATE_ON).toContain("contact");
  });
  it("the owner's real number and link, the customer's name and the thread's street pass", () => {
    for (const body of [
      "Call me at 508-555-0199 anytime.",
      "Call me at (508) 555-0199.",
      "Book here: https://riveraplumbing.test/book",
      "Hi Dana, I can stop by 12 Main St to take a look.",
      "Thanks for Dana, I mean, thanks Dana.",
      "Mass Save has a program for Eversource customers.",
    ])
      expect(checkDraft(body, ctx).hits, body).not.toContain("contact");
  });
  it("a contact flag keeps a draft from autopilot", () => {
    const body = "Call me at 978-555-0142 anytime.";
    const r = checkDraft(body, ctx);
    expect(
      guardrailReasons({
        category: "scheduling",
        needsOwner: false,
        kind: "reply",
        confidencePct: 95,
        flags: r.flags,
        amountsInEmail: [],
        draftBody: body,
        knownCustomer: true,
        purpose: null,
      }),
    ).toContain("Has things to check before sending.");
  });
});

describe("never-say and avoided phrases as whole words (Check 23 P10)", () => {
  const ctx = (neverSay: string[]) => ({
    sourceText: "",
    doNotPromise: [] as string[],
    phrasesAvoided: ["circle back"],
    neverSay,
  });
  it("no false alarms inside longer words", () => {
    expect(
      checkDraft("I'll hunt down the right flapper and let you know.", ctx(["hun"])).hits,
    ).not.toContain("never_say");
    expect(
      checkDraft("If you desire one out back too, just say.", ctx(["sir"])).hits,
    ).not.toContain("never_say");
  });
  it("real matches still flag, across a line break and with punctuation", () => {
    expect(checkDraft("Thanks hun!", ctx(["hun"])).hits).toContain("never_say");
    expect(
      checkDraft("No problem\nat all, see you then.", ctx(["no problem at all"])).hits,
    ).toContain("never_say");
    expect(checkDraft("Sure, no problem! See you.", ctx(["no problem!"])).hits).toContain(
      "never_say",
    );
    expect(checkDraft("I'll get it done a.s.a.p. for you", ctx(["a.s.a.p."])).hits).toContain(
      "never_say",
    );
    expect(checkDraft("Let me circle back.", ctx([])).flags[0]).toContain("circle back");
    expect(checkDraft("Don’t worry, sweetie.", ctx(["don't worry"])).hits).toContain("never_say");
  });
});
