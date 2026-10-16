import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { waitlist } from "@/db/schema";
import { landingSourceFrom } from "@/lib/landing-source";
import { growthInput, requestGrowthCall } from "@/server/growth";
import {
  cleanHost,
  cleanUtm,
  describeSource,
  firstTouch,
  NO_SOURCE,
  sourceFromForm,
} from "@/server/source-rules";
import { joinWaitlist, waitlistInput } from "@/server/waitlist";
import { joinWaitlistAction } from "@/app/waitlist-actions";
import { createTestDb } from "../support/db";

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({ "x-forwarded-for": "203.0.113.9", host: "sa-dac3.vercel.app" }),
}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: () => {},
}));

let database: Database;
beforeEach(async () => {
  database = await createTestDb();
});

describe("where a sign-up came from: the rules", () => {
  it("keeps a tidy utm tag, drops markup characters, control characters and overlong text", () => {
    expect(cleanUtm("  facebook  ")).toBe("facebook");
    expect(cleanUtm("fall\n flyer")).toBe("fall flyer");
    expect(cleanUtm('<script>"x"</script>')).toBe("scriptx/script");
    expect(cleanUtm("a‮b")).toBe("a b");
    expect(cleanUtm("x".repeat(500))).toHaveLength(100);
    for (const bad of ["", "   ", null, undefined, 42, ["a"]]) expect(cleanUtm(bad)).toBeNull();
  });

  it("keeps a host name only, never ours, never a URL or anything else", () => {
    expect(cleanHost("Facebook.com")).toBe("facebook.com");
    expect(cleanHost("l.facebook.com.")).toBe("l.facebook.com");
    expect(cleanHost("https://facebook.com/page")).toBeNull();
    expect(cleanHost("localhost")).toBeNull();
    expect(cleanHost("a b.com")).toBeNull();
    expect(cleanHost(`${"a".repeat(250)}.com`)).toBeNull();
    expect(cleanHost("sa-dac3.vercel.app", ["sa-dac3.vercel.app"])).toBeNull();
  });

  it("reads the four hidden fields and describes them for the admin card", () => {
    const fields: Record<string, string> = {
      utm_source: "facebook",
      utm_medium: "post",
      utm_campaign: "fall-flyer",
      referrer_host: "facebook.com",
    };
    const s = sourceFromForm((k) => fields[k] ?? null);
    expect(describeSource(s)).toBe("facebook · post · fall-flyer (via facebook.com)");
    expect(describeSource({ ...NO_SOURCE, referrerHost: "google.com" })).toBe("via google.com");
    expect(describeSource({ ...NO_SOURCE, utmSource: "flyer" })).toBe("flyer");
    expect(describeSource(NO_SOURCE)).toBeNull();
  });

  it("first touch: an entry that already has a source keeps it", () => {
    const incoming = { ...NO_SOURCE, utmSource: "google" };
    expect(firstTouch(NO_SOURCE, incoming)).toEqual(incoming);
    expect(firstTouch({ ...NO_SOURCE, referrerHost: "facebook.com" }, incoming)).toEqual({});
  });

  it("the browser side takes utm tags from the address and only the referrer's host", () => {
    expect(
      landingSourceFrom(
        "?utm_source=fb&utm_medium=post&ref=abc&utm_campaign=x",
        "https://l.facebook.com/l.php?u=secret",
        "sa-dac3.vercel.app",
      ),
    ).toEqual({
      utm_source: "fb",
      utm_medium: "post",
      utm_campaign: "x",
      referrer_host: "l.facebook.com",
    });
    expect(
      landingSourceFrom("", "https://sa-dac3.vercel.app/growth", "sa-dac3.vercel.app"),
    ).toMatchObject({ referrer_host: "" });
    expect(landingSourceFrom("", "not a url", "x.com")).toMatchObject({ referrer_host: "" });
  });
});

describe("where a sign-up came from: stored", () => {
  const good = { name: "Mike", email: "mike@shop.com", trade: "carpentry", teamSize: "2–5" };
  const form = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };
  const row = async (email = "mike@shop.com") =>
    (await database.select().from(waitlist).where(eq(waitlist.email, email)))[0]!;

  it("the waitlist form saves the tags and the referring host, and drops our own host", async () => {
    await joinWaitlistAction(
      { status: "idle" },
      form({
        ...good,
        utm_source: "facebook",
        utm_medium: "<post>",
        utm_campaign: "",
        referrer_host: "sa-dac3.vercel.app",
      }),
    );
    expect(await row()).toMatchObject({
      utmSource: "facebook",
      utmMedium: "post",
      utmCampaign: null,
      referrerHost: null,
    });
  });

  it("bad source data is dropped, never an error", async () => {
    const r = await joinWaitlistAction(
      { status: "idle" },
      form({ ...good, utm_source: "\u0000", referrer_host: "javascript:alert(1)" }),
    );
    expect(r).toEqual({ status: "joined" });
    expect(await row()).toMatchObject({ utmSource: null, referrerHost: null });
  });

  it("first touch across both forms: Growth first, then the app list keeps Growth's source", async () => {
    await requestGrowthCall(
      growthInput.parse({
        name: "Mike",
        phone: "617-555-0142",
        email: "mike@shop.com",
        trade: "carpentry",
        services: ["reviews"],
        note: null,
      }),
      new Date(),
      { ...NO_SOURCE, utmSource: "flyer" },
    );
    await joinWaitlist(waitlistInput.parse(good), { ...NO_SOURCE, utmSource: "google" });
    expect((await row()).utmSource).toBe("flyer");
  });

  it("an app entry with no source takes the first one a later Growth request brings", async () => {
    await joinWaitlist(waitlistInput.parse(good));
    const growth = growthInput.parse({
      name: "Mike",
      phone: "617-555-0142",
      email: "mike@shop.com",
      trade: "carpentry",
      services: ["reviews"],
      note: null,
    });
    await requestGrowthCall(growth, new Date(), { ...NO_SOURCE, referrerHost: "google.com" });
    await requestGrowthCall(growth, new Date(), { ...NO_SOURCE, referrerHost: "bing.com" });
    expect((await row()).referrerHost).toBe("google.com");
  });
});
