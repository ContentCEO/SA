import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Headline } from "@/components/brand/headline";
import { pricing } from "@/config/pricing";
import { siteConfig } from "@/config/site";
import { beforeSend, countedUrl } from "@/lib/analytics-rules";
import { jsonLd, structuredData } from "@/lib/structured-data";
import sitemap from "@/app/sitemap";

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

  it("the homepage title uses the words people search for, and every public page has a description", () => {
    const home = readFileSync("src/app/page.tsx", "utf8");
    expect(home).toContain('title: "Squared Away — AI email help for contractors"');
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
