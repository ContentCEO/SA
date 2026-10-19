import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { growthCopy } from "@/components/marketing/growth/growth-copy";
import { GROWTH_OWNED, GROWTH_SERVICES } from "@/config/growth";
import { siteConfig } from "@/config/site";

/** Squared Away Growth copy guard: what the page may and may not say. */
const SOURCES = [
  "src/components/marketing/growth/growth-copy.ts",
  "src/components/marketing/growth/growth-chapter.tsx",
  "src/components/marketing/growth/growth-chapter-bar.tsx",
  "src/components/marketing/growth/growth-bridge.tsx",
  "src/components/marketing/growth/growth-switch.tsx",
  "src/components/marketing/growth/switch-rules.ts",
  "src/components/marketing/growth/big-words.tsx",
  "src/components/marketing/growth/big-words-rules.ts",
  "src/components/marketing/growth/growth-call-form.tsx",
  "src/components/marketing/growth/growth-proof.tsx",
  "src/config/growth-proof.ts",
  "src/config/growth.ts",
  "src/app/growth/page.tsx",
  "src/app/growth-actions.ts",
  "src/server/growth.ts",
  "src/components/app/growth-mention.tsx",
];
const source = SOURCES.map((f) => readFileSync(f, "utf8")).join("\n");

/** Every string the copy file produces, with the functions called on sample values. */
function rendered(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function") {
    const fn = value as (arg: unknown) => unknown;
    try {
      return rendered(fn("617-555-0142"));
    } catch {
      return rendered(fn(["Google ads", "Reviews"]));
    }
  }
  if (Array.isArray(value)) return value.flatMap(rendered);
  if (value && typeof value === "object") return Object.values(value).flatMap(rendered);
  return [];
}
const words = rendered(growthCopy).join("\n");

describe("Squared Away Growth copy", () => {
  it("names no price and no promise we can't keep", () => {
    for (const text of [source, words]) {
      expect(text).not.toMatch(/\$\s?\d/);
      expect(text).not.toMatch(/\bGC\b/);
      expect(text).not.toMatch(/can'?t send|cannot send|nothing can send|switched off entirely/i);
      for (const banned of [
        "testimonial",
        "guarantee",
        "first group",
        "call booked",
        // Check 2 P1: nothing is booked; Davi calls them back, and that call is the free call.
        "book a free call",
        "booking",
        "find a time",
        // Check 3 P7: results we can't promise.
        "first page",
        "page one",
        "#1",
        "number one",
        "more leads",
        // Check 3 P7: Local Services badge names Google retired on 2025-10-20 ("Google
        // Guaranteed" is caught by "guarantee" above).
        "google screened",
        "license verified",
      ]) {
        expect(text.toLowerCase(), banned).not.toContain(banned);
      }
      // "rank" as a whole word only, so "frank" or "cranky" can't trip it.
      expect(text).not.toMatch(/\brank(?:s|ed|ing)?\b/i);
    }
  });

  it("mentions no app feature that isn't live", () => {
    for (const feature of [
      "money owed",
      "win rate",
      "win/loss",
      "price memory",
      "undo send",
      "scorecard",
      "response time",
      "lead alert",
      "monthly summary",
      "lead source",
    ]) {
      expect(words.toLowerCase()).not.toContain(feature);
      expect(source.toLowerCase()).not.toContain(feature);
    }
  });

  it("uses no pronouns for Davi and never says builder", () => {
    expect(source).not.toMatch(/\b(he|him|his|himself|builder)\b/i);
    expect(words).not.toMatch(/\b(he|him|his|himself|builder)\b/i);
  });

  it("asks every customer for reviews, never only happy ones (no review gating)", () => {
    const reviews = GROWTH_SERVICES.find((s) => s.value === "reviews")!;
    expect(reviews.blurb).toBe(
      "Your Google review link and a short message you send to every customer yourself, plus help answering the reviews you get. We never write fake ones, and we never message your customers.",
    );
    expect(reviews.blurb).toContain("every customer");
    expect(reviews.blurb).toContain("yourself");
    for (const said of [
      "we'll text your customers",
      "we text your customers",
      "we email your customers",
    ]) {
      expect(`${source}\n${words}`.toLowerCase()).not.toContain(said);
    }
    expect(growthCopy.rules.items[1].body).toContain("offer anything in return for a review");
    expect(`${source}\n${words}`.toLowerCase()).not.toContain("happy customer");
  });

  it("takes names, the company and the phone number from siteConfig", () => {
    expect(source).not.toContain("978");
    expect(source).not.toContain("A&C");
    // Names come from siteConfig too ("Davi" may appear in comments only).
    expect(source).not.toMatch(/"[^"\n]*Davi[^"\n]*"|`[^`]*Davi[^`]*`/);
    expect(words).toContain("Call 978-201-9763");
    expect(growthCopy.who.body).toContain("A&C Construction");
    expect(growthCopy.opener.homeOnly).toBe(
      "For now, Davi Chaves does every job personally — the same person who builds the app.",
    );
    expect(growthCopy.how.steps[1].body).toBe(
      "Davi looks at what you have today — your Google listing, your pages, your site, your reviews — and tells you plainly what to do first and what it costs.",
    );
    expect(growthCopy.who.heavy).toBe("Davi, personally.");
    expect(growthCopy.faq.items.find((i) => i.q === "Who will I be dealing with?")?.a).toBe(
      "Davi Chaves, directly. For now, Davi does the work personally.",
    );
  });

  it("stays two-tone and adds no tracking", () => {
    expect(source).not.toMatch(
      /\b(?:bg|text|border|ring|outline|fill|stroke)-(?:red|green|blue)\b/,
    );
    expect(source).not.toMatch(/-(?:red|green|blue)-\d/);
    // The one exception: cookie-free Vercel Web Analytics page views, mounted through the shared
    // SiteAnalytics component (src/components/marketing/site-analytics.tsx), nothing else.
    const withoutSiteAnalytics = source
      .replace(/import \{ SiteAnalytics \} from "@\/components\/marketing\/site-analytics";/g, "")
      .replace(/<SiteAnalytics \/>/g, "");
    expect(withoutSiteAnalytics).not.toMatch(
      /fbq|gtag|googletagmanager|facebook\.net|analytics|pixel/i,
    );
  });

  it("the FAQ says a support look is never used for Growth (Check 2 P5)", () => {
    const answer = growthCopy.faq.items.find((i) => i.q === "Will you see my customers' emails?");
    expect(answer && typeof answer.a !== "string" ? answer.a.after : "").toBe(
      " explains the few times a person might look, such as when you ask us for help. Even when Davi looks at your app account because you asked for help, nothing seen there is used for Growth.",
    );
  });

  it("the pledge names what the client owns for every service, and takes no percentage", () => {
    const pledge = `${growthCopy.pledge.body} ${growthCopy.pledge.percent}`.toLowerCase();
    for (const s of GROWTH_SERVICES) {
      expect(GROWTH_OWNED[s.value], s.value).toBeTruthy();
      expect(pledge, s.value).toContain(GROWTH_OWNED[s.value].toLowerCase());
    }
    expect(growthCopy.pledge.heavy).toBe("you own everything.");
    expect(pledge).toContain("never take a percentage of your jobs");
    expect(pledge).toContain("photos");
    expect(pledge).toContain("in your name");
    // Shown on /growth and the homepage Growth half (both render GrowthChapter).
    const chapter = readFileSync("src/components/marketing/growth/growth-chapter.tsx", "utf8");
    expect(chapter).toContain("c.pledge.body");
    expect(chapter).toContain("c.pledge.percent");
  });

  it("the in-app mention says Growth is separate and uses nothing from email", () => {
    expect(growthCopy.appMention.line).toContain("separate service");
    expect(growthCopy.appMention.line).toContain("Nothing from your email is used for it.");
  });

  it("labels the decorative switch plainly", () => {
    expect(growthCopy.switch).toEqual({ from: "Your inbox", to: "Your marketing" });
  });

  it("the homepage hero link and header link come from the copy file", () => {
    const home = readFileSync("src/app/page.tsx", "utf8");
    expect(growthCopy.hero.link).toBe(
      "Want more work coming in? We also run ads, your Google listing and reviews",
    );
    // Check 6 P6: the hero link names at least two services.
    const named = GROWTH_SERVICES.filter((s) =>
      growthCopy.hero.link.toLowerCase().includes(s.label.toLowerCase()),
    );
    const words2 = ["ads", "google listing", "reviews", "website"].filter((w) =>
      growthCopy.hero.link.toLowerCase().includes(w),
    );
    expect(Math.max(named.length, words2.length)).toBeGreaterThanOrEqual(2);
    expect(home).toContain("{growthCopy.hero.link}");
    expect(home).toContain("{growthCopy.header.link}");
  });
});

describe("Check 5 P5: a Growth card for an existing app owner says they use the app", () => {
  it("picks the line from inviteState only", () => {
    const a = growthCopy.admin;
    expect(a.growthOnlyLine("has_account")).toBe("Also uses the app.");
    expect(a.growthOnlyLine("invited")).toBe("Invited to the app, not signed in yet.");
    expect(a.growthOnlyLine("not_invited")).toBe(a.growthOnly);
    expect(a.growthOnlyLine("invite_gone")).toBe(a.growthOnly);
    expect(a.growthOnlyLine("has_account")).toBe(a.growthOnlyHasAccount);
    expect(a.growthOnlyLine("invited")).toBe(a.growthOnlyInvited);
  });
});

describe("Check 2 P4 / Check 3 P2: ad reach matches Meta's housing rules", () => {
  it("pins both ad blurbs to 'in and around'", () => {
    const blurb = (v: string) => GROWTH_SERVICES.find((s) => s.value === v)!.blurb;
    expect(blurb("facebook_ads")).toBe(
      "Ads shown to people in and around the towns you work in. Your own photos, plain words, and a clear way to reach you.",
    );
    expect(blurb("instagram_ads")).toBe(
      "Your finished work, shown to people in and around the towns you work in. Built from your own photos, never stock pictures.",
    );
  });

  it("never promises town-only targeting", () => {
    const og = readFileSync("src/app/growth/opengraph-image.tsx", "utf8");
    for (const text of [source, words, og]) {
      expect(text.toLowerCase()).not.toContain("actually work in");
      expect(text.toLowerCase()).not.toContain("only in your town");
    }
    for (const s of GROWTH_SERVICES) {
      if (/\bads\b/i.test(`${s.label} ${s.blurb}`) && /\btowns?\b/i.test(s.blurb)) {
        expect(s.blurb, s.value).toContain("in and around");
      }
    }
  });

  it("explains the radius in the FAQ", () => {
    const item = growthCopy.faq.items.find(
      (i) => i.q === "Can my Facebook ads show only in my town?",
    );
    expect(item?.a).toContain("at least 15 miles");
  });
});

describe("Check 2 P1 / Check 3 P7: the banned list catches what it should", () => {
  it("matches 'rank' only as a whole word", () => {
    const rank = /\brank(?:s|ed|ing)?\b/i;
    expect("We rank you first").toMatch(rank);
    expect("Frank was cranky").not.toMatch(rank);
  });
});

describe("Check 3 P1: every service card says what you get", () => {
  it("2 to 4 short lines per service, in the copy file's items", () => {
    for (const s of GROWTH_SERVICES) {
      expect(s.includes.length, s.value).toBeGreaterThanOrEqual(2);
      expect(s.includes.length, s.value).toBeLessThanOrEqual(4);
      for (const line of s.includes) expect(line.length, line).toBeLessThan(70);
    }
    expect(growthCopy.services.items.map((i) => i.includes)).toEqual(
      GROWTH_SERVICES.map((s) => s.includes),
    );
    // The lines are in `words` and in src/config/growth.ts, so every ban above covers them.
    expect(words).toContain("A monthly cap on ad money that you set");
  });
});

describe("Check 3 P6 + Check 34 P4: two more FAQs", () => {
  it("says who pays for the ads, separate from the fee, with a limit the owner sets", () => {
    const item = growthCopy.faq.items.find((i) => /pays for the ads/i.test(i.q));
    expect(typeof item?.a).toBe("string");
    expect(item?.a).toContain("separate");
    expect(item?.a).toContain("limit");
  });

  it("says how Growth differs from an agency, second in the list, with nothing we can't back", () => {
    const item = growthCopy.faq.items[1];
    expect(item.q).toBe("How is this different from a marketing agency?");
    expect(item.a).not.toMatch(/guarantee|rank|#1|best/i);
    // The two commercial sentences wait for the operator's answer.
    expect(item.a).not.toContain("Month to month");
    expect(item.a).not.toContain("stay in your name");
  });
});

describe("Check 2 P7 + Check 6 P6: the first ground rule and the homepage hand-off", () => {
  it("the inbox rule gives examples, not a complete list", () => {
    expect(growthCopy.rules.items[0].body).toBe(
      "Growth never touches your inbox. If you use the Squared Away app, your email is used only to run the app for you, like sorting, drafts and follow-ups, and never for Growth ads, posts or anything else outside the app.",
    );
  });

  it("the bridge says what Growth is", () => {
    expect(growthCopy.bridge.heavy).toBe("Need more jobs? We'll do the marketing for you.");
    expect(growthCopy.bridge.body).toBe(
      "Squared Away Growth is a separate service for anyone in the trades: ads, your Google listing, reviews and your website. It never touches your inbox, and you don't need the app to use it.",
    );
  });
});

describe("Check 3 P4: Not sure yet is a form choice, not a card", () => {
  it("the services section still lists exactly GROWTH_SERVICES", async () => {
    const { GROWTH_REQUEST_OPTIONS } = await import("@/config/growth");
    expect(growthCopy.services.items.map((i) => i.title)).toEqual(
      GROWTH_SERVICES.map((s) => s.label),
    );
    expect(words).not.toContain("Not sure yet — tell me");
    expect(GROWTH_REQUEST_OPTIONS.at(-1)).toEqual({
      value: "not_sure",
      label: "Not sure yet — tell me what to do first",
    });
    // A stored request's services are comma-separated: no label may hold a comma.
    for (const o of GROWTH_REQUEST_OPTIONS) expect(o.label).not.toContain(",");
  });
});

describe("Check 33 P2: /growth says what owners search", () => {
  it("title, description and eyebrow", () => {
    expect(growthCopy.meta.title).toContain("Contractor marketing");
    expect(growthCopy.meta.description.length).toBeLessThanOrEqual(160);
    expect(growthCopy.meta.description).toContain(siteConfig.operator);
    expect(growthCopy.opener.eyebrow).toContain("Massachusetts");
    expect(growthCopy.opener.eyebrow).toBe(
      "Squared Away Growth · marketing for contractors, run from Massachusetts",
    );
  });
});
