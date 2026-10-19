import { describe, expect, it } from "vitest";
import { applyOwnerRules } from "@/ai/classify";
import { LEAD_SOURCES, OPEN_SITE_HOSTS } from "@/config/lead-sources";
import { EMAIL_TO_TEXT_DOMAINS } from "@/config/phone-services";
import {
  findUsPhones,
  isCallableCustomerNumber,
  numberFromTextAddress,
  smsHref,
  telHref,
} from "@/lib/phone-numbers";
import {
  channelKind,
  channelOf,
  isEmailToTextAddress,
  looksLikePhoneAddress,
  openSiteUrl,
} from "@/server/channel-rules";
import { checkinDue, playbookApplies } from "@/server/complaint-rules";
import { customerPhone, firstNameOf, textPrefill } from "@/server/contact-rules";
import { EMERGENCY_REASON, inEmergencyLane } from "@/server/emergency-rules";
import { parseLeadSite } from "@/server/lead-site-rules";
import { leadPlatformOf } from "@/server/monthly-rules";
import { notAnsweredLine, waitingWords } from "@/server/never-answered-rules";
import { bestEarlier, repeatLine } from "@/server/repeat-customer-rules";
import {
  normalizeTown,
  outsideArea,
  OUTSIDE_AREA_REASON,
  suggestTowns,
  townFromAddress,
  townOnList,
} from "@/server/service-area-rules";
import { classification } from "../support/fake-model";

describe("lead sites config", () => {
  it("every site but Facebook has a fixed https link on an allow-listed host", () => {
    const keys = new Set<string>();
    // Check 40 P4: recognised for the label and the no-draft rule only, until a real sample
    // shows where the owner answers them.
    const labelOnly = ["Facebook", "Modernize", "eLocal", "Instant quote on your website"];
    for (const s of LEAD_SOURCES) {
      if (labelOnly.includes(s.label)) {
        expect(s.site).toBeNull();
        continue;
      }
      expect(s.site, s.label).not.toBeNull();
      const u = new URL(s.site!.openUrl);
      expect(u.protocol).toBe("https:");
      expect(OPEN_SITE_HOSTS).toContain(u.hostname);
      expect(keys.has(s.site!.key)).toBe(false);
      keys.add(s.site!.key);
      expect(openSiteUrl(s.site!.key)).toBe(u.toString());
    }
  });
  it("no link for an unknown key", () => {
    expect(openSiteUrl("evil")).toBeNull();
    expect(openSiteUrl(null)).toBeNull();
  });
});

describe("channelOf", () => {
  const fixtures = [
    "no-reply@thumbtack.com",
    "leads@mail.thumbtack.com",
    "no-reply@thumbtack.com.evil.test",
    "pro@notthumbtack.com",
    "notifications@angi.com",
    "x@homeadvisor.com",
    "x@houzz.com",
    "x@yelp.com",
    "x@nextdoor.com",
    "x@localservices.google.com",
    "x@sub.localservices.google.com",
    "x@facebook.com",
    "dana@example.com",
    "voice-noreply@google.com",
    "5085551234@vtext.com",
  ];
  it("is a site exactly when the shared platform matcher says so (and it has a site)", () => {
    for (const f of fixtures) {
      const label = leadPlatformOf(f);
      const site = LEAD_SOURCES.find((s) => s.label === label)?.site ?? null;
      expect(channelOf(f)?.kind === "site", f).toBe(site !== null);
    }
  });
  it("phones and texts", () => {
    expect(channelOf("Voice-Noreply@google.com")).toEqual({ key: "google_voice", kind: "phone" });
    expect(channelOf("15085551234.15085559876.abc@txt.voice.google.com")?.kind).toBe("phone_text");
    expect(channelOf("5085551234@vtext.com")).toEqual({ key: "phone_text", kind: "phone_text" });
    expect(channelOf("someone@google.com")).toBeNull();
    expect(channelKind("google_voice")).toBe("phone");
    expect(channelKind("thumbtack")).toBe("site");
    expect(channelKind("bogus")).toBeNull();
  });
  it("email-to-text gateways and phone-shaped addresses", () => {
    for (const d of EMAIL_TO_TEXT_DOMAINS)
      expect(isEmailToTextAddress(`5085551234@${d}`)).toBe(true);
    expect(isEmailToTextAddress("x@vtext.com.evil.test")).toBe(false);
    expect(isEmailToTextAddress("dana@example.com")).toBe(false);
    expect(looksLikePhoneAddress("5085551234@pics.carrier.example")).toBe(true);
    expect(looksLikePhoneAddress("15085551234@pics.carrier.example")).toBe(true);
    expect(looksLikePhoneAddress("25085551234@pics.carrier.example")).toBe(false);
    expect(looksLikePhoneAddress("5085551234@gmail.com")).toBe(false);
    expect(looksLikePhoneAddress("dana5085551234@x.example")).toBe(false);
  });
});

describe("phone numbers (code only)", () => {
  it("finds the common shapes, drops extensions, de-duplicates", () => {
    expect(
      findUsPhones(
        "Call (978) 201-9763 or 978-201-9763 x12.\n978.201.9764 / 978 201 9765 / +1 978 201 9766 / 1-978-201-9767",
      ),
    ).toEqual(["+19782019763", "+19782019764", "+19782019765", "+19782019766", "+19782019767"]);
  });
  it("bare digits only after a label on the same line", () => {
    expect(findUsPhones("Order 9782019763 shipped")).toEqual([]);
    expect(findUsPhones("Cell: 9782019763")).toEqual(["+19782019763"]);
    expect(findUsPhones("m: 19782019763")).toEqual(["+19782019763"]);
  });
  it("labelled-only mode (machine mail)", () => {
    expect(findUsPhones("Support: 978-201-9763", { labelledOnly: true })).toEqual([]);
    expect(findUsPhones("Phone: 978-201-9763", { labelledOnly: true })).toEqual(["+19782019763"]);
  });
  it("refuses toll-free, N11 and fiction numbers", () => {
    expect(isCallableCustomerNumber("+19782019763")).toBe(true);
    for (const n of ["+18005551234", "+18885551234", "+18335551234", "+14115551234"])
      expect(isCallableCustomerNumber(n), n).toBe(false);
    expect(isCallableCustomerNumber("+19784111234")).toBe(false);
    expect(isCallableCustomerNumber("+19785550123")).toBe(false);
    expect(isCallableCustomerNumber("+19785550234")).toBe(true);
    expect(isCallableCustomerNumber("+11782019763")).toBe(false);
  });
  it("gateway addresses carry the number; Google Voice's don't count", () => {
    expect(numberFromTextAddress("9782019763@vtext.com")).toBe("+19782019763");
    expect(numberFromTextAddress("19782019763@tmomail.net")).toBe("+19782019763");
    expect(numberFromTextAddress("19785550000.19782019763.ab@txt.voice.google.com")).toBeNull();
  });
  it("links: tel and sms with the body encoded", () => {
    expect(telHref("+19782019763")).toBe("tel:+19782019763");
    expect(smsHref("+19782019763", "Hi D&J? #1\nok")).toBe(
      "sms:+19782019763?&body=Hi%20D%26J%3F%20%231%0Aok",
    );
  });
});

describe("customerPhone", () => {
  const owner = new Set(["+19785550234"]);
  it("skips the owner's own number (a quoted signature) and takes the newest email first", () => {
    expect(
      customerPhone({
        messages: [
          { subject: "Re: faucet", body: "Sure, call me 978-201-9763\n> Mike 978-555-0234" },
          { subject: "faucet", body: "My cell is 978-201-9999" },
        ],
        ownerNumbers: owner,
        machine: false,
      }),
    ).toBe("+19782019763");
    expect(
      customerPhone({
        messages: [{ subject: null, body: "Reach Mike at 978-555-0234" }],
        ownerNumbers: owner,
        machine: false,
      }),
    ).toBeNull();
  });
  it("machine mail needs a label; a voicemail's subject names the caller", () => {
    expect(
      customerPhone({
        messages: [{ subject: "New lead", body: "Questions? 978-201-1111\nPhone: 978-201-9763" }],
        ownerNumbers: owner,
        machine: true,
      }),
    ).toBe("+19782019763");
    expect(
      customerPhone({
        messages: [{ subject: "New voicemail from (978) 201-9763", body: "Transcript: hi" }],
        ownerNumbers: owner,
        machine: true,
        subjectNamesCaller: true,
      }),
    ).toBe("+19782019763");
    expect(
      customerPhone({
        messages: [{ subject: "Toll free (800) 201-9763", body: null }],
        ownerNumbers: owner,
        machine: false,
      }),
    ).toBeNull();
  });
  it("empty after the purge", () => {
    expect(
      customerPhone({
        messages: [{ subject: null, body: null }],
        ownerNumbers: owner,
        machine: false,
      }),
    ).toBeNull();
  });
  it("names and the prefilled text", () => {
    expect(firstNameOf("Dana Ruiz")).toBe("Dana");
    expect(firstNameOf("Ruiz, Dana")).toBe("Dana");
    expect(firstNameOf("dana@example.com")).toBeNull();
    expect(textPrefill({ firstName: "Dana", businessName: "Ruiz Plumbing" })).toBe(
      "Hi Dana, this is Ruiz Plumbing. I got your message.",
    );
    expect(textPrefill({ firstName: null, businessName: null })).toBe("Hi, I got your message.");
  });
});

describe("lead-site parser (invented samples)", () => {
  it("Thumbtack-style labelled notice", () => {
    expect(
      parseLeadSite({
        subject: "You have a new lead",
        body: "New request\nCustomer: Dana R.\nService: Faucet repair\nLocation: Lowell, MA 01852\nRespond on Thumbtack",
      }),
    ).toEqual({ customerName: "Dana R.", service: "Faucet repair", town: "Lowell, MA" });
  });
  it("Angi-style notice with a street address gives no town", () => {
    expect(
      parseLeadSite({
        subject: "New Angi lead",
        body: "Name: Sam Lee\nJob type: Water heater replacement\nLocation: 12 Elm St, Nashua, NH",
      }),
    ).toEqual({ customerName: "Sam Lee", service: "Water heater replacement", town: null });
  });
  it("anything odd gives nothing", () => {
    expect(
      parseLeadSite({
        subject: null,
        body: "Customer: <script>\nService: https://evil.test\nCity: 01852",
      }),
    ).toEqual({ customerName: null, service: null, town: null });
  });
});

describe("towns (B9)", () => {
  it("reads a town only from a clear address", () => {
    expect(townFromAddress("12 Elm St, Lowell, MA 01852")).toBe("Lowell, MA");
    expect(townFromAddress("Lowell, MA")).toBe("Lowell, MA");
    expect(townFromAddress("12 Elm St, nashua")).toBe("Nashua");
    expect(townFromAddress("12 Elm St")).toBeNull();
    expect(townFromAddress("Apt 4, 12 Elm St")).toBeNull();
    expect(townFromAddress("5 Main Street, Unit 2")).toBeNull();
  });
  it("normalizes and matches", () => {
    expect(normalizeTown("St. Paul, MN")).toEqual({ name: "saint paul", state: "mn" });
    expect(townOnList("Lowell, MA", ["lowell"])).toBe(true);
    expect(townOnList("Lowell, MA", ["Lowell, NH"])).toBe(false);
    expect(townOnList("Nashua, NH", ["Lowell, MA", "Dracut"])).toBe(false);
  });
  it("outside area only for quote requests with a list", () => {
    const address = "3 Pine Rd, Nashua, NH";
    expect(outsideArea({ category: "quote_request", address, towns: ["Lowell"] })).toBe(
      "Nashua, NH",
    );
    expect(outsideArea({ category: "quote_request", address, towns: [] })).toBeNull();
    expect(outsideArea({ category: "scheduling", address, towns: ["Lowell"] })).toBeNull();
    expect(outsideArea({ category: "quote_request", address, towns: ["Nashua"] })).toBeNull();
  });
  it("suggests towns from the free text", () => {
    expect(suggestTowns("Lowell, Dracut, Chelmsford and surrounding towns\nTewksbury")).toEqual([
      "Lowell",
      "Dracut",
      "Tewksbury",
    ]);
    expect(suggestTowns("Lowell, MA")).toEqual(["Lowell"]);
  });
});

describe("owner rules (leads package)", () => {
  const ctx = { firstTimeSender: false, senderIsVip: false, amountThresholdDollars: 2500 };
  it("an emergency from someone with a job: needs you, high, fixed words", () => {
    const m = classification({
      category: "customer_question",
      needs_owner: true,
      needs_owner_reason: "Dana at 12 Elm St in Lowell has water everywhere",
    });
    m.extracted = { ...m.extracted, urgency: "emergency" };
    expect(applyOwnerRules(m, ctx)).toEqual({
      needsOwner: true,
      needsOwnerReason: EMERGENCY_REASON,
      priority: "high",
      hits: ["emergency", "model"],
      needsOwnerCode: "emergency",
    });
  });
  it("noise or a supplier marked emergency doesn't count", () => {
    for (const category of ["noise", "supplier_vendor"] as const) {
      const m = classification({ category });
      m.extracted = { ...m.extracted, urgency: "emergency" };
      expect(applyOwnerRules(m, ctx).hits).not.toContain("emergency");
    }
  });
  it("a complaint keeps its own words first but records every hit", () => {
    const m = classification({ category: "complaint" });
    m.extracted = { ...m.extracted, urgency: "emergency" };
    const r = applyOwnerRules(m, { ...ctx, outsideArea: true });
    expect(r.needsOwnerReason).toBe("A complaint. You'll want to answer this one yourself.");
    expect(r.hits).toEqual(["complaint", "emergency"]);
  });
  it("outside area on a quote request; the model's reason never wins over it", () => {
    const m = classification({
      category: "quote_request",
      needs_owner: true,
      needs_owner_reason: "Lives in Nashua",
    });
    expect(applyOwnerRules(m, { ...ctx, outsideArea: true })).toMatchObject({
      needsOwnerReason: OUTSIDE_AREA_REASON,
      hits: ["outside_area", "model"],
    });
    expect(applyOwnerRules(classification(), { ...ctx, outsideArea: true }).hits).toEqual([
      "outside_area",
    ]);
  });
  it("lead channels", () => {
    const site = { kind: "site" as const, name: "Thumbtack" };
    expect(applyOwnerRules(classification(), { ...ctx, channel: site })).toMatchObject({
      needsOwner: true,
      needsOwnerReason: "Came through Thumbtack. Answer them there.",
    });
    expect(
      applyOwnerRules(classification({ category: "noise" }), { ...ctx, channel: site }).needsOwner,
    ).toBe(false);
    expect(
      applyOwnerRules(classification({ category: "invoice_payment" }), {
        ...ctx,
        channel: { kind: "phone_text", name: "Text message" },
      }).needsOwnerReason,
    ).toBe("Text message. Text them back from your phone.");
  });
  it("injection never enters the lane", () => {
    const m = classification({ category: "quote_request" });
    m.extracted = { ...m.extracted, urgency: "emergency" };
    expect(applyOwnerRules(m, { ...ctx, injection: true }).hits).toEqual(["injection"]);
    expect(
      inEmergencyLane({ category: "quote_request", extracted: { urgency: "emergency" } }),
    ).toBe(true);
    expect(
      inEmergencyLane({
        category: "quote_request",
        extracted: { urgency: "emergency", injection: true },
      }),
    ).toBe(false);
    expect(inEmergencyLane({ category: "noise", extracted: { urgency: "emergency" } })).toBe(false);
  });
});

describe("repeat customers (B14)", () => {
  const now = new Date("2026-10-16T15:00:00Z");
  const march = new Date("2026-03-10T15:00:00Z");
  const may = new Date("2026-05-10T15:00:00Z");
  it("won beats quoted beats asked; newest within each", () => {
    expect(
      bestEarlier([
        { kind: "asked", service: null, at: may },
        { kind: "won", service: "water heater replacement", at: march },
        { kind: "quoted", service: null, at: may },
      ])?.kind,
    ).toBe("won");
    expect(
      bestEarlier([
        { kind: "asked", service: "a", at: march },
        { kind: "asked", service: "b", at: may },
      ])?.service,
    ).toBe("b");
    expect(bestEarlier([])).toBeNull();
  });
  it("says only what the records show", () => {
    const tz = "America/New_York";
    expect(
      repeatLine({ kind: "won", service: "Water heater replacement", at: march }, now, tz),
    ).toBe(
      "Repeat customer: they said yes to your quote for their water heater replacement in March.",
    );
    expect(repeatLine({ kind: "quoted", service: "deck repair", at: may }, now, tz)).toBe(
      "Repeat customer: you quoted their deck repair in May.",
    );
    expect(repeatLine({ kind: "asked", service: null, at: may }, now, tz)).toBe(
      "Repeat customer: they asked you for a quote in May.",
    );
    expect(
      repeatLine({ kind: "won", service: null, at: new Date("2025-07-01T15:00:00Z") }, now, tz),
    ).toBe("Repeat customer: they said yes to a quote from you in July 2025.");
  });
});

describe("complaint playbook (G5)", () => {
  const now = new Date("2026-10-16T15:00:00Z");
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
  it("only for complaints that aren't legal threats", () => {
    expect(playbookApplies({ category: "complaint", extracted: {} })).toBe(true);
    expect(
      playbookApplies({
        category: "complaint",
        extracted: { owner_rule_hits: ["complaint", "legal"] },
      }),
    ).toBe(false);
    expect(playbookApplies({ category: "quote_request", extracted: {} })).toBe(false);
  });
  it("check-in due at 2 days, once, cancelled by a new email", () => {
    const base = { complaintCheckinDoneAt: null, lastInboundAt: days(5) };
    expect(checkinDue({ ...base, complaintFixedAt: days(1.9) }, now)).toBe(false);
    expect(checkinDue({ ...base, complaintFixedAt: days(2) }, now)).toBe(true);
    expect(checkinDue({ ...base, complaintFixedAt: days(31) }, now)).toBe(false);
    expect(
      checkinDue({ ...base, complaintFixedAt: days(3), complaintCheckinDoneAt: days(1) }, now),
    ).toBe(false);
    expect(checkinDue({ ...base, complaintFixedAt: days(3), lastInboundAt: days(1) }, now)).toBe(
      false,
    );
  });
});

describe("not answered yet (B6)", () => {
  it("plain words", () => {
    const now = new Date("2026-10-16T15:00:00Z");
    expect(waitingWords(new Date(now.getTime() - 3.2 * 86_400_000), now)).toBe("waiting 3 days");
    expect(waitingWords(new Date(now.getTime() - 25 * 3_600_000), now)).toBe("waiting 1 day");
    expect(notAnsweredLine(2)).toBe("2 customers have waited more than a day for an answer");
  });
});

describe("lead actions put only fixed words in URLs", () => {
  it("every ?done= / ?error= code in the lead actions is [a-z_]", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of [
      "src/app/(app)/queue/leads-actions.ts",
      "src/app/(app)/queue/first-week-actions.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      const codes = [...src.matchAll(/[?&](?:done|error)=([^"`&\s)]+)/g)].map((m) => m[1]!);
      expect(codes.length, f).toBeGreaterThan(0);
      for (const c of codes) expect(c, `${f}: ${c}`).toMatch(/^([a-z_]+|\$\{done\})$/);
    }
    const first = readFileSync("src/app/(app)/queue/first-week-actions.ts", "utf8");
    expect(first).toContain('const done = formData.get("as") === "done" ? "done" : "called";');
  });
});

describe("the owner's own numbers", () => {
  it("bare runs (an alert phone stored as +1…) count when looking for the owner's numbers", () => {
    expect(findUsPhones("+19785550234")).toEqual([]);
    expect(findUsPhones("+19785550234", { anyBare: true })).toEqual(["+19785550234"]);
    expect(findUsPhones("Mike 9785550234", { anyBare: true })).toEqual(["+19785550234"]);
  });
});
