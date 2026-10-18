import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { Database } from "@/db";
import { messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { classifyPending } from "@/server/classification";
import { saveConnectedMailbox } from "@/server/mailboxes";
import {
  AMOUNT_BLANK_MESSAGE,
  AMOUNT_MESSAGE,
  businessProfileInput,
  digestSettingsInput,
  followupSettingsInput,
  voiceEditInput,
  crewAddressesSchema,
  describeVoice,
  getBusinessProfile,
  MAX_CREW_ADDRESSES,
  REVIEW_URL_MESSAGE,
  saveBusinessProfile,
} from "@/server/profile";
import { profileDefaults } from "@/server/profile-defaults";
import { hicExpiryLine, licenseFacts } from "@/config/licenses";
import { MA_DEPOSIT_SETTINGS_LINE } from "@/config/ma-rules";
import { depositTermsWarning } from "@/server/deposit-rules";
import { createTestDb } from "../support/db";
import { classification, fakeTransport } from "../support/fake-model";

const valid = {
  businessName: "Elm Electric",
  trade: "electrical",
  services: "Service calls, panel upgrades",
  serviceArea: "",
  hours: "",
  leadTime: "",
  pricingNotes: "",
  paymentTerms: "",
  policies: "",
  signature: "",
  doNotPromise: "Same-day service\n\n  A price over email  \nSame-day service",
  vipSenders: "Boss@GC.com\n",
  amountThresholdDollars: "5000",
};

describe("business profile form", () => {
  it("cleans up list fields and coerces the threshold", () => {
    const r = businessProfileInput.parse(valid);
    expect(r.doNotPromise).toEqual(["Same-day service", "A price over email"]);
    expect(r.vipSenders).toEqual(["boss@gc.com"]);
    expect(r.amountThresholdDollars).toBe(5000);
    expect(r.serviceArea).toBeNull();
  });

  it("explains what's missing in plain words", () => {
    const r = businessProfileInput.safeParse({
      ...valid,
      businessName: " ",
      services: "",
      vipSenders: "not an email",
    });
    expect(r.success).toBe(false);
    const msgs = r.error!.issues.map((i) => i.message);
    expect(msgs).toContain("What's the business called?");
    expect(msgs).toContain("Tell us what work you do.");
    expect(msgs).toContain("This line isn't an email address: “not an email”.");
  });

  it("rejects a non-number threshold", () => {
    expect(
      businessProfileInput.safeParse({ ...valid, amountThresholdDollars: "lots" }).success,
    ).toBe(false);
  });
});

describe("the money box (Check 15 P1)", () => {
  const amountIssues = (amountThresholdDollars: string) => {
    const r = businessProfileInput.safeParse({ ...valid, amountThresholdDollars });
    expect(r.success, amountThresholdDollars).toBe(false);
    return r
      .error!.issues.filter((i) => i.path[0] === "amountThresholdDollars")
      .map((i) => i.message);
  };
  const amountOf = (amountThresholdDollars: string) =>
    businessProfileInput.parse({ ...valid, amountThresholdDollars }).amountThresholdDollars;

  it("refuses a blank box (it would save $0) with a message saying why", () => {
    expect(amountIssues("")).toEqual([AMOUNT_BLANK_MESSAGE]);
    expect(amountIssues("  ")).toEqual([AMOUNT_BLANK_MESSAGE]);
    expect(amountIssues("$")).toEqual([AMOUNT_BLANK_MESSAGE]);
    const missing: Partial<typeof valid> = { ...valid };
    delete missing.amountThresholdDollars;
    expect(businessProfileInput.safeParse(missing).success).toBe(false);
  });

  it("reads money the way people type it", () => {
    expect(amountOf("2,500")).toBe(2500);
    expect(amountOf("$2,500")).toBe(2500);
    expect(amountOf(" $ 2500 ")).toBe(2500);
    expect(amountOf("1,250,000")).toBe(1_250_000);
    expect(amountOf("0")).toBe(0); // typed on purpose, not a blank box
  });

  it("refuses decimals, negatives, words, odd commas and huge numbers in plain words", () => {
    expect(amountIssues("2500.50")).toEqual(["Whole dollars, please."]);
    expect(amountIssues("-5")).toEqual([AMOUNT_MESSAGE]);
    expect(amountIssues("abc")).toEqual([AMOUNT_MESSAGE]);
    expect(amountIssues("25,00")).toEqual([AMOUNT_MESSAGE]);
    expect(amountIssues("20000000")).toEqual([
      "That's more than we can check. Try a smaller amount.",
    ]);
  });
});

describe("plain words for every Settings form error (Check 15 P2)", () => {
  const voiceValid = {
    greetingStyle: "Hey",
    signoffStyle: "Thanks, Mike",
    formality: "casual",
    avgLengthWords: "60",
    phrasesUsed: "",
    phrasesAvoided: "",
    summary: "",
  };
  const zodWording = (m: string) =>
    /^(Too big|Too small|Invalid)/.test(m) || m.includes("expected");
  const bad: Array<
    [string, { safeParse: (v: unknown) => { error?: { issues: { message: string }[] } } }, unknown]
  > = [
    ["business name too long", businessProfileInput, { ...valid, businessName: "x".repeat(121) }],
    ["business name missing", businessProfileInput, { ...valid, businessName: undefined }],
    ["services too long", businessProfileInput, { ...valid, services: "x".repeat(2001) }],
    ["services empty", businessProfileInput, { ...valid, services: "" }],
    ["wrong trade", businessProfileInput, { ...valid, trade: "astronaut" }],
    ["wrong extra trade", businessProfileInput, { ...valid, extraTrades: "astronaut" }],
    [
      "too many extra trades",
      businessProfileInput,
      { ...valid, extraTrades: "plumbing,hvac,roofing" },
    ],
    ["long area", businessProfileInput, { ...valid, serviceArea: "x".repeat(2001) }],
    ["long hours", businessProfileInput, { ...valid, hours: "x".repeat(501) }],
    ["long promise line", businessProfileInput, { ...valid, doNotPromise: "x".repeat(201) }],
    ["wrong state", businessProfileInput, { ...valid, state: "ZZ" }],
    ["long license", businessProfileInput, { ...valid, hicNumber: "x".repeat(200) }],
    ["bad license date", businessProfileInput, { ...valid, hicExpiresOn: "soon" }],
    ["NaN amount", businessProfileInput, { ...valid, amountThresholdDollars: "abc" }],
    ["decimal amount", businessProfileInput, { ...valid, amountThresholdDollars: "1.5" }],
    ["huge amount", businessProfileInput, { ...valid, amountThresholdDollars: "99999999" }],
    ["greeting too long", voiceEditInput, { ...voiceValid, greetingStyle: "x".repeat(120) }],
    ["sign-off too long", voiceEditInput, { ...voiceValid, signoffStyle: "x".repeat(120) }],
    ["blank word count", voiceEditInput, { ...voiceValid, avgLengthWords: "" }],
    ["NaN word count", voiceEditInput, { ...voiceValid, avgLengthWords: "abc" }],
    ["decimal word count", voiceEditInput, { ...voiceValid, avgLengthWords: "60.5" }],
    ["small word count", voiceEditInput, { ...voiceValid, avgLengthWords: "5" }],
    ["big word count", voiceEditInput, { ...voiceValid, avgLengthWords: "500" }],
    ["wrong formality", voiceEditInput, { ...voiceValid, formality: "shouty" }],
    ["summary too long", voiceEditInput, { ...voiceValid, summary: "x".repeat(601) }],
    ["long phrase", voiceEditInput, { ...voiceValid, phrasesUsed: "x".repeat(121) }],
    ["wrong follow-up days", followupSettingsInput, { days: "6" }],
    ["NaN follow-up days", followupSettingsInput, { days: "abc" }],
    ["wrong follow-up switch", followupSettingsInput, { enabled: "yes", days: "3" }],
    ["wrong digest hour", digestSettingsInput, { hour: "3" }],
    ["NaN digest hour", digestSettingsInput, { hour: "abc" }],
    ["wrong digest switch", digestSettingsInput, { enabled: "yes", hour: "7" }],
    ["wrong time zone", digestSettingsInput, { hour: "7", timeZone: "Mars/Base" }],
    ["crew line", crewAddressesSchema, "not an email"],
  ];

  it.each(bad)("%s: refused in plain words", (_name, schema, input) => {
    const r = schema.safeParse(input);
    expect(r.error, _name).toBeDefined();
    for (const { message } of r.error!.issues) expect(zodWording(message), message).toBe(false);
  });

  it("the voice form's messages", () => {
    const msg = (input: Record<string, unknown>) =>
      voiceEditInput.safeParse({ ...voiceValid, ...input }).error!.issues[0]!.message;
    expect(msg({ greetingStyle: "x".repeat(120) })).toBe("Keep this under 100 characters.");
    expect(msg({ avgLengthWords: "" })).toBe("Type a number of words, like 60.");
    expect(msg({ avgLengthWords: "abc" })).toBe("Type a number of words, like 60.");
    expect(msg({ avgLengthWords: "60.5" })).toBe("A whole number, like 60.");
    expect(msg({ avgLengthWords: "5" })).toBe("At least 10 words.");
    expect(msg({ avgLengthWords: "500" })).toBe("Up to 400 words.");
    expect(msg({ formality: "shouty" })).toBe("Pick how formal you are.");
    expect(msg({ summary: "x".repeat(601) })).toBe("Keep this under 600 characters.");
    expect(
      businessProfileInput.safeParse({ ...valid, businessName: "x".repeat(121) }).error!.issues[0]!
        .message,
    ).toBe("Keep the name under 120 characters.");
  });

  it("“People who always need you” takes addresses pasted from Gmail", () => {
    const vip = (vipSenders: string) =>
      businessProfileInput.parse({ ...valid, vipSenders }).vipSenders;
    expect(vip("Sue Smith <sue@example.com>")).toEqual(["sue@example.com"]);
    expect(vip("a@x.com, b@y.com")).toEqual(["a@x.com", "b@y.com"]);
    expect(vip("a@x.com; B@Y.com\nSmith, Sue <Sue@Example.com>")).toEqual([
      "a@x.com",
      "b@y.com",
      "sue@example.com",
    ]);
    const r = businessProfileInput.safeParse({ ...valid, vipSenders: "ok@x.com\nSue Smith" });
    expect(r.error!.issues.map((i) => i.message)).toEqual([
      "This line isn't an email address: “Sue Smith”.",
    ]);
    for (const i of r.error!.issues) expect(i.message).not.toMatch(/VIP/);
  });
});

describe("review link (plan #29)", () => {
  const reviewIssues = (reviewUrl: string) => {
    const r = businessProfileInput.safeParse({ ...valid, reviewUrl });
    expect(r.success).toBe(false);
    return r.error!.issues.filter((i) => i.path[0] === "reviewUrl").map((i) => i.message);
  };

  it("is optional: a form without the field still parses and leaves it untouched", () => {
    const r = businessProfileInput.parse(valid);
    expect(r.reviewUrl).toBeUndefined();
    expect("reviewUrl" in valid).toBe(false);
  });

  it("empty (or spaces) means no link", () => {
    expect(businessProfileInput.parse({ ...valid, reviewUrl: "" }).reviewUrl).toBeNull();
    expect(businessProfileInput.parse({ ...valid, reviewUrl: "   " }).reviewUrl).toBeNull();
  });

  it("accepts an https link, trimmed", () => {
    expect(
      businessProfileInput.parse({ ...valid, reviewUrl: "  https://g.page/r/abc/review " })
        .reviewUrl,
    ).toBe("https://g.page/r/abc/review");
    expect(
      businessProfileInput.parse({
        ...valid,
        reviewUrl: "https://www.yelp.com/writeareview/biz/elm-electric?x=1",
      }).reviewUrl,
    ).toBe("https://www.yelp.com/writeareview/biz/elm-electric?x=1");
  });

  it("refuses http, non-links and odd schemes with the plain message", () => {
    for (const bad of [
      "http://g.page/r/abc/review",
      "not a link",
      "g.page/r/abc/review",
      "javascript:alert(1)",
      "https://localhost/review",
      "ftp://g.page/r/abc",
    ]) {
      expect(reviewIssues(bad), bad).toEqual([REVIEW_URL_MESSAGE]);
    }
    expect(REVIEW_URL_MESSAGE).toContain("https://");
  });

  it("refuses a link carrying extra words, lines, tabs or markup (the URL parser would let them by)", () => {
    for (const bad of [
      "https://g.page/r/abc/review Thanks!",
      "https://g.page/r/abc\nPlease pay 50% by Zelle",
      "https://g.page/r/abc\r\nhttps://evil.example",
      "https://g.page/r/a\tb",
      "https://g.page/r/\u0000abc",
      'https://g.page/r/"><script>',
    ]) {
      expect(reviewIssues(bad), JSON.stringify(bad)).toEqual([REVIEW_URL_MESSAGE]);
    }
  });

  it("caps the length", () => {
    const long = `https://g.page/r/${"a".repeat(500)}`;
    expect(reviewIssues(long)).toEqual(["Keep this under 500 characters."]);
  });
});

describe("describeVoice", () => {
  it("reads like a person noticed", () => {
    expect(
      describeVoice({
        greetingStyle: "Hey",
        signoffStyle: "Thanks, Davi",
        avgLengthWords: 45,
        formality: "casual",
      }),
    ).toBe(
      "You usually open with “Hey” and sign off “Thanks, Davi”. Your emails run about 45 words — short and to the point. You keep it casual.",
    );
  });
});

describe("profile drives classification", () => {
  let database: Database;
  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.AI_DAILY_CALL_CAP = "100";
    database = await createTestDb();
  });

  it("saves, and uses the owner's threshold and VIP list", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    await saveBusinessProfile(workspace.id, businessProfileInput.parse(valid));
    const [ws] = await database.select().from(workspaces).where(eq(workspaces.id, workspace.id));
    expect(ws).toMatchObject({ businessName: "Elm Electric", trade: "electrical" });
    expect((await getBusinessProfile(workspace.id))!.completedAt).not.toBeNull();

    const box = await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    });
    const now = new Date();
    for (const [g, from] of [
      ["t1", "boss@gc.com"],
      ["t2", "someone@x.com"],
    ] as const) {
      const [t] = await database
        .insert(threads)
        .values({ mailboxId: box.id, gmailThreadId: g, inInbox: true })
        .returning();
      await database.insert(messages).values({
        threadId: t!.id,
        mailboxId: box.id,
        gmailMessageId: `m-${g}`,
        direction: "in",
        fromAddress: from,
        bodyText: "hello",
        labelIds: ["INBOX"],
        sentAt: new Date(now.getTime() - 3600_000),
      });
    }
    const amount = { ...classification().extracted, dollar_amounts: [4000] };
    const { transport, calls } = fakeTransport([
      classification(),
      classification({ extracted: amount }),
    ]);
    setModelTransportForTests(transport);
    await classifyPending(box.id, { now });

    expect(calls[0]!.system.at(-1)!.text).toContain("more than $5,000");
    expect(calls[0]!.system.at(-1)!.text).toContain("boss@gc.com");
    const rows = Object.fromEntries(
      (await database.select().from(threads)).map((t) => [t.gmailThreadId, t]),
    );
    expect(rows.t1!.needsOwner).toBe(true); // VIP
    expect(rows.t2!.needsOwner).toBe(false); // $4,000 is under the owner's $5,000
  });

  it("a blank money box never reaches the saved profile as $0 (Check 15 P1)", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    await saveBusinessProfile(workspace.id, businessProfileInput.parse(valid));
    // The action only saves what parses; a cleared box doesn't.
    for (const blank of ["", "   ", "$"]) {
      expect(
        businessProfileInput.safeParse({ ...valid, amountThresholdDollars: blank }).success,
      ).toBe(false);
    }
    expect((await getBusinessProfile(workspace.id))!.amountThresholdDollars).toBe(5000);
    await saveBusinessProfile(
      workspace.id,
      businessProfileInput.parse({ ...valid, amountThresholdDollars: "$2,500" }),
    );
    expect((await getBusinessProfile(workspace.id))!.amountThresholdDollars).toBe(2500);
  });

  it("saves the review link, shows it in the form defaults, and clears it when emptied", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    const ws = async () =>
      (await database.select().from(workspaces).where(eq(workspaces.id, workspace.id)))[0]!;

    expect((await profileDefaults(await ws())).reviewUrl).toBeNull();

    const link = "https://g.page/r/abc/review";
    await saveBusinessProfile(
      workspace.id,
      businessProfileInput.parse({ ...valid, reviewUrl: link }),
    );
    expect((await getBusinessProfile(workspace.id))!.reviewUrl).toBe(link);
    expect((await profileDefaults(await ws())).reviewUrl).toBe(link);

    // A save that doesn't carry the field never wipes the link.
    await saveBusinessProfile(workspace.id, businessProfileInput.parse(valid));
    expect((await getBusinessProfile(workspace.id))!.reviewUrl).toBe(link);

    // Emptying the field in the form clears it.
    await saveBusinessProfile(
      workspace.id,
      businessProfileInput.parse({ ...valid, reviewUrl: "" }),
    );
    expect((await getBusinessProfile(workspace.id))!.reviewUrl).toBeNull();
  });
});

describe("licenses and registrations (Check 38 P6)", () => {
  let database: Database;
  beforeEach(async () => {
    database = await createTestDb();
  });
  it("saves the numbers, keeps them when a form doesn't carry them, clears an emptied line", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    const ws = async () =>
      (await database.select().from(workspaces).where(eq(workspaces.id, workspace.id)))[0]!;
    await saveBusinessProfile(
      workspace.id,
      businessProfileInput.parse({
        ...valid,
        hicNumber: " 198344 ",
        hicExpiresOn: "2026-11-01",
        cslNumber: "CS-104512",
        leadSafeLicense: "",
        insuranceCarrier: "Plymouth Rock",
      }),
    );
    expect((await getBusinessProfile(workspace.id))!.licenses).toEqual({
      hic_number: "198344",
      hic_expires_on: "2026-11-01",
      csl_number: "CS-104512",
      insurance_carrier: "Plymouth Rock",
    });
    expect((await profileDefaults(await ws())).licenses.csl_number).toBe("CS-104512");
    // A save without the fields leaves them alone.
    await saveBusinessProfile(workspace.id, businessProfileInput.parse(valid));
    expect((await getBusinessProfile(workspace.id))!.licenses.hic_number).toBe("198344");
    // Emptied in the form: gone.
    await saveBusinessProfile(
      workspace.id,
      businessProfileInput.parse({
        ...valid,
        hicNumber: "",
        hicExpiresOn: "",
        cslNumber: "CS-104512",
        leadSafeLicense: "",
        insuranceCarrier: "",
      }),
    );
    expect((await getBusinessProfile(workspace.id))!.licenses).toEqual({ csl_number: "CS-104512" });
  });

  it("one line each, 40 characters at most, and a real date", () => {
    const long = businessProfileInput.safeParse({ ...valid, hicNumber: "x".repeat(41) });
    expect(long.error!.issues[0]!.message).toBe("Keep this under 40 characters.");
    const date = businessProfileInput.safeParse({ ...valid, hicExpiresOn: "next year" });
    expect(date.error!.issues[0]!.message).toBe("Pick the date it runs out.");
  });

  it("Settings shows one line when the HIC runs out within 30 days", () => {
    const l = { hic_number: "198344", hic_expires_on: "2026-11-10" };
    expect(hicExpiryLine(l, "2026-10-01")).toBeNull();
    expect(hicExpiryLine(l, "2026-10-11")).toBe(
      "Your HIC registration runs out in 30 days. Renew it with the state.",
    );
    expect(hicExpiryLine(l, "2026-11-09")).toBe(
      "Your HIC registration runs out in 1 day. Renew it with the state.",
    );
    expect(hicExpiryLine(l, "2026-11-12")).toMatch(/has passed/);
    expect(hicExpiryLine({}, "2026-11-12")).toBeNull();
  });

  it("the drafting block lists only the filled ones, and says so when there are none", () => {
    expect(licenseFacts({ hic_number: "198344", lead_safe_license: " " })).toBe(
      "Home improvement registration (HIC) number: 198344",
    );
    expect(licenseFacts({})).toBeNull();
  });
});

describe("which state (Check 38 P2)", () => {
  it("two letters from the list, '' clears it, left out leaves it", () => {
    expect(businessProfileInput.parse({ ...valid, state: "MA" }).state).toBe("MA");
    expect(businessProfileInput.parse({ ...valid, state: "" }).state).toBeNull();
    expect(businessProfileInput.parse(valid).state).toBeUndefined();
    expect(
      businessProfileInput.safeParse({ ...valid, state: "Mass" }).error!.issues[0]!.message,
    ).toBe("Pick your state from the list.");
  });

  it("an MA shop asking for half down still saves, and sees the warning", async () => {
    await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    const terms = "Half down to get on the schedule, balance at completion.";
    await saveBusinessProfile(
      workspace.id,
      businessProfileInput.parse({ ...valid, state: "MA", paymentTerms: terms }),
    );
    const p = (await getBusinessProfile(workspace.id))!;
    expect(p).toMatchObject({ state: "MA", paymentTerms: terms });
    expect(depositTermsWarning(p.state, p.paymentTerms)).toBe(MA_DEPOSIT_SETTINGS_LINE);
    expect(depositTermsWarning("NH", p.paymentTerms)).toBeNull();
    expect(depositTermsWarning("MA", "One-third at signing")).toBeNull();
    expect(depositTermsWarning(null, p.paymentTerms)).toBeNull();
  });
});

describe("crew addresses rule (Check 50 P3, not in a form yet)", () => {
  it("lowercases, trims and de-duplicates emails", () => {
    expect(crewAddressesSchema.parse(" Mike@Shop.com\nmike@shop.com\n\nana@shop.com ")).toEqual([
      "mike@shop.com",
      "ana@shop.com",
    ]);
  });

  it("refuses a line that isn't an email, and more than 30 addresses", () => {
    expect(crewAddressesSchema.safeParse("mike at shop").success).toBe(false);
    const many = Array.from({ length: MAX_CREW_ADDRESSES + 1 }, (_, i) => `c${i}@shop.com`);
    expect(crewAddressesSchema.safeParse(many.join("\n")).success).toBe(false);
    expect(crewAddressesSchema.safeParse(many.slice(1).join("\n")).success).toBe(true);
  });
});
