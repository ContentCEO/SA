import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { growthCopy } from "@/components/marketing/growth/growth-copy";
import { GROWTH_SERVICES } from "@/config/growth";

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
  "src/config/growth.ts",
  "src/app/growth/page.tsx",
  "src/app/growth-actions.ts",
  "src/server/growth.ts",
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
      for (const banned of ["testimonial", "guarantee", "first group", "call booked"]) {
        expect(text.toLowerCase()).not.toContain(banned);
      }
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
      "A simple way to ask your customers for a Google review, and help answering the reviews you get. We never write fake ones.",
    );
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
    expect(growthCopy.faq.items[4].a).toBe(
      "Davi Chaves, directly. For now, Davi does the work personally.",
    );
  });

  it("stays two-tone and adds no tracking", () => {
    expect(source).not.toMatch(
      /\b(?:bg|text|border|ring|outline|fill|stroke)-(?:red|green|blue)\b/,
    );
    expect(source).not.toMatch(/-(?:red|green|blue)-\d/);
    expect(source).not.toMatch(/fbq|gtag|googletagmanager|facebook\.net|analytics|pixel/i);
  });

  it("labels the decorative switch plainly", () => {
    expect(growthCopy.switch).toEqual({ from: "The app", to: "One-on-one" });
  });

  it("the homepage hero link and header link come from the copy file", () => {
    const home = readFileSync("src/app/page.tsx", "utf8");
    expect(growthCopy.hero.link).toBe("Want more work coming in? See Squared Away Growth");
    expect(home).toContain("{growthCopy.hero.link}");
    expect(home).toContain("{growthCopy.header.link}");
  });
});
