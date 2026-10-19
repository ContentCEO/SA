import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Headline } from "@/components/brand/headline";
import { features } from "@/components/marketing/home-copy";
import { pricing } from "@/config/pricing";
import { siteConfig } from "@/config/site";
import { beforeSend, countedUrl } from "@/lib/analytics-rules";
import { growthStructuredData, jsonLd, structuredData } from "@/lib/structured-data";
import { GROWTH_SERVICES } from "@/config/growth";
import { QUOTE_STAGES, stageLabel } from "@/server/quote-rules";
import sitemap, { legalDate } from "@/app/sitemap";
import { TERMS_VERSION } from "@/config/legal";

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|jsx?)$/.test(p) ? [p] : [];
  });

describe("Web Analytics: public pages only", () => {
  it("counts only the homepage, /growth, /privacy and /terms, with only utm tags kept", () => {
    expect(countedUrl("https://x.app/")).toBe("https://x.app/");
    expect(countedUrl("https://x.app/growth/?ref=AbC123&utm_source=fb#growth-call")).toBe(
      "https://x.app/growth?utm_source=fb",
    );
    expect(countedUrl("https://x.app/?ref=secretcode")).toBe("https://x.app/");
    for (const path of [
      "/queue",
      "/admin",
      "/settings",
      "/record/1",
      "/welcome/terms",
      "/signin",
    ]) {
      expect(countedUrl(`https://x.app${path}`), path).toBeNull();
    }
    expect(countedUrl("not a url")).toBeNull();
  });

  it("page views only: custom events are dropped", () => {
    expect(beforeSend({ type: "event", url: "https://x.app/" })).toBeNull();
    expect(beforeSend({ type: "pageview", url: "https://x.app/terms?x=1" })).toEqual({
      type: "pageview",
      url: "https://x.app/terms",
    });
  });

  it("is never mounted in the root layout or the signed-in app", () => {
    const offLimits = [
      ...files("src/app/(app)"),
      "src/app/layout.tsx",
      ...files("src/app/welcome"),
    ];
    for (const f of offLimits) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/site-analytics|@vercel\/analytics/);
    }
    const users = files("src")
      .filter((f) => /@vercel\/analytics/.test(readFileSync(f, "utf8")))
      .sort();
    expect(users).toEqual(["src/components/marketing/site-analytics-client.tsx"]);
    const mounts = files("src")
      .filter((f) => /<SiteAnalytics \/>/.test(readFileSync(f, "utf8")))
      .sort();
    expect(mounts).toEqual([
      "src/app/growth/page.tsx",
      "src/app/page.tsx",
      "src/components/marketing/legal-page.tsx",
    ]);
    // Production only (dev mode would load a script from another host, which the CSP blocks).
    expect(readFileSync("src/components/marketing/site-analytics.tsx", "utf8")).toContain(
      'process.env.VERCEL_ENV !== "production"',
    );
  });
});

describe("serif-over-heavy headlines read with a space", () => {
  it("Headline renders 'your inbox, handled.' as text", () => {
    const html = renderToStaticMarkup(
      createElement(Headline, { serif: "your inbox,", heavy: "handled." }),
    );
    expect(html.replace(/<[^>]+>/g, "")).toBe("your inbox, handled.");
  });

  it("every hand-written serif span followed by a heavy span has a space between", () => {
    for (const f of files("src")) {
      const src = readFileSync(f, "utf8");
      if (f.endsWith("wordmark.tsx") || f.endsWith("queue-preview.tsx")) continue; // aria-hidden
      // A serif span closing straight into a heavy span, with only whitespace (a JSX line break,
      // which React drops) between them.
      const bad = src.match(
        /sa-headline-serif[^>]*>[^<]*(?:\{[^}]*\})?[^<]*<\/span>\s*<span[^>]*sa-headline-heavy/g,
      );
      expect(bad, f).toBeNull();
    }
  });
});

describe("search basics", () => {
  const data = structuredData("https://example.app/");

  it("names the business and the app, with the real prices and no ratings", () => {
    const [org, app] = data as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(org["@type"]).toBe("Organization");
    expect(org.telephone).toContain(siteConfig.phone);
    expect(app["@type"]).toBe("SoftwareApplication");
    const offers = app.offers as { name: string; price: string; priceCurrency: string }[];
    const prices = offers.map((o) => o.price).sort();
    const expected = [
      pricing.setupFee.amountCents,
      ...Object.values(pricing.plans).map((p) => p.amountCents),
    ]
      .map((c) => (c / 100).toFixed(2))
      .sort();
    expect(prices).toEqual(expected);
    for (const o of offers) {
      expect(o.priceCurrency).toBe("USD");
      expect(Number(o.price)).toBeGreaterThan(0);
      expect(o.name).not.toMatch(/trial|free/i);
    }
    const all = JSON.stringify(data);
    expect(all).not.toMatch(/aggregateRating|"review"|ratingValue/);
    expect(all).not.toMatch(/"price":"0(\.00)?"|"free"/i);
  });

  it("is safe to put in a script tag", () => {
    expect(jsonLd({ a: "</script><b>" })).not.toContain("<");
    expect(JSON.parse(jsonLd(data))).toEqual(data);
  });

  it("the sitemap lists /growth and the legal pages", () => {
    const urls = sitemap().map((e) => new URL(e.url).pathname);
    expect(urls).toEqual(["/", "/growth", "/privacy", "/terms"]);
  });

  it("Check 33 P4: every sitemap entry has a lastModified that is a real date, not in the future", () => {
    const entries = sitemap();
    for (const e of entries) {
      expect(e.lastModified, e.url).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const t = new Date(`${e.lastModified}T00:00:00Z`).getTime();
      expect(Number.isNaN(t), e.url).toBe(false);
      expect(t, e.url).toBeLessThanOrEqual(Date.now());
    }
    // The legal pages carry the terms' date, the date part only (a ".N" same-day suffix drops).
    const legal = entries.filter((e) => /\/(privacy|terms)$/.test(e.url));
    expect(legal.map((e) => e.lastModified)).toEqual([legalDate(), legalDate()]);
    expect(legalDate("2026-11-02.2")).toBe("2026-11-02");
    expect(legalDate()).toBe(TERMS_VERSION.slice(0, 10));
  });

  it("Check 33 P3: the homepage description fits a search result, and the Organization is complete", () => {
    const home = readFileSync("src/app/page.tsx", "utf8");
    const description = home.match(/const description =\s*"([^"]+)";/)![1]!;
    expect(description.length).toBeLessThanOrEqual(160);
    expect(description.length).toBeGreaterThanOrEqual(50);
    expect(description).toMatch(/^AI email help for contractors/);
    const [org] = structuredData("https://example.app/") as unknown as [Record<string, unknown>];
    expect(org.logo).toBe("https://example.app/app-icon/512");
    expect(org.address).toEqual({
      "@type": "PostalAddress",
      addressRegion: "MA",
      addressCountry: "US",
    });
    expect(org).not.toHaveProperty("email");
    const [withEmail] = structuredData("https://example.app/", {
      supportEmail: "help@example.com",
    }) as unknown as [Record<string, unknown>];
    expect(withEmail.email).toBe("help@example.com");
    const [blank] = structuredData("https://example.app/", { supportEmail: "  " }) as unknown as [
      Record<string, unknown>,
    ];
    expect(blank).not.toHaveProperty("email");
    // Never typed in: the only email comes from SUPPORT_EMAIL.
    expect(readFileSync("src/lib/structured-data.ts", "utf8")).not.toMatch(/[\w.]+@[\w.]+\.\w+/);
    expect(readFileSync("src/components/marketing/structured-data.tsx", "utf8")).toContain(
      "supportEmail: process.env.SUPPORT_EMAIL",
    );
  });

  it("the homepage title uses the words people search for, and every public page has a description", () => {
    const home = readFileSync("src/app/page.tsx", "utf8");
    // Absolute (Check 32 P6): the root template would otherwise add "· Squared Away" again.
    expect(home).toContain('title: { absolute: "Squared Away — AI email help for contractors" }');
    expect(home).toMatch(/const description =\s*"AI email help for contractors/);
    for (const f of [
      "src/app/growth/page.tsx",
      "src/app/privacy/page.tsx",
      "src/app/terms/page.tsx",
    ]) {
      expect(readFileSync(f, "utf8"), f).toMatch(/description/);
    }
  });
});

describe("/growth's own share card", () => {
  it("uses Growth's words, not the app's", () => {
    const og = readFileSync("src/app/growth/opengraph-image.tsx", "utf8");
    expect(og).toContain("growthCopy.opener.serif");
    expect(og).not.toMatch(/serif: "your inbox|heavy: "handled/);
    expect(readFileSync("src/app/growth/page.tsx", "utf8")).not.toContain("/opengraph-image");
  });
});

describe("homepage feature cards (Check 34 P2, Check 6 P5, Check 34 P3)", () => {
  const titles = () => features.map((f) => f.title);

  it("leads with what a trade inbox tool does, and keeps the grid at nine cards", () => {
    expect(titles().slice(0, 2)).toEqual(["Knows your trade", "Won't take orders from strangers"]);
    expect(features.length).toBeLessThanOrEqual(9);
    // Phone alerts wait on their keys (not live), so no card claims them yet.
    expect(titles()).not.toContain("Buzzes you when it matters");
  });

  it("tells visitors about Quotes, Money and Customers", () => {
    for (const t of ["Every quote in one list", "Who owes you", "Your customers, in one place"])
      expect(titles()).toContain(t);
    const quotes = features.find((f) => f.title === "Every quote in one list")!.body;
    for (const s of QUOTE_STAGES) expect(quotes).toContain(stageLabel[s].toLowerCase());
  });

  it("no card brags", () => {
    for (const f of features) expect(f.body, f.title).not.toMatch(/only one|unlike|best/i);
  });

  it("the follow-up card names the two limits the scan keeps", () => {
    const body = features.find((f) => f.title === "Chases quiet quotes")!.body;
    expect(body).toContain("emailed you");
    expect(body).toContain("other software");
    expect(body).toContain("I called them");
  });
});

describe("plain words on the public pages (Check 6 P9, P10, Check 34 P5)", () => {
  const home = () => readFileSync("src/app/page.tsx", "utf8").replace(/\s+/g, " ");

  it("the app is added to the home screen; no app store is named", () => {
    expect(home()).toContain("add it to your phone&apos;s home screen");
    expect(home()).not.toMatch(/App Store|as an app on your phone/);
    for (const f of files("src")) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/\bApp Store\b|download the app/i);
    }
  });

  it("one name for the join action, and no office jargon", () => {
    expect(home()).not.toContain("Get on the list");
    expect(home()).toContain("Join the waitlist");
    expect(home()).not.toContain("onboard");
  });

  it("sign-in says what we keep from Google", () => {
    const signin = readFileSync("src/app/signin/page.tsx", "utf8").replace(/\s+/g, " ");
    expect(signin).toContain("From your Google sign-in we keep only your name and email address.");
    expect(signin).not.toContain("only shares your name");
  });
});

describe("Check 33 P2: /growth's structured data", () => {
  it("is one Service with the service labels, and no rating, review, price or area", () => {
    const d = growthStructuredData("https://example.app");
    expect(d["@type"]).toBe("Service");
    expect(d.url).toBe("https://example.app/growth");
    expect(growthStructuredData("https://example.app/").url).toBe("https://example.app/growth");
    expect(d.serviceType).toEqual(GROWTH_SERVICES.map((s) => s.label));
    expect(d.provider.founder.name).toBe(siteConfig.operator);
    expect(JSON.stringify(d)).not.toMatch(
      /aggregateRating|"review"|ratingValue|"price"|areaServed/,
    );
  });
});
