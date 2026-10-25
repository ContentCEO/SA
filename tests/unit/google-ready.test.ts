import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatChecks,
  googleReadyChecks,
  htmlToText,
  limitedUseSentenceFrom,
  linksTo,
  markdownToText,
  type FetchedPage,
  type ReadyInput,
} from "@/lib/google-ready-rules";
import { fetchPage, runGoogleReady } from "../../scripts/google-ready";

/**
 * Check 28 P6: the pre-submit check reads the public pages like Google's reviewer. Each rule is
 * tried with a small page that passes and one that fails, with no network.
 */
const doc = readFileSync("docs/google-verification.md", "utf8");
const sentence = limitedUseSentenceFrom(doc);

const ok = (body: string, headers: Record<string, string> = {}): FetchedPage => ({
  status: 200,
  headers,
  body,
  redirectedTo: null,
});

const goodHome = ok(
  '<html><body><nav aria-label="Legal"><a href="/privacy">Privacy</a> <a href="/terms">Terms</a></nav></body></html>',
);
const goodPrivacy = ok(
  `<main><h2>Google API Services: Limited Use</h2><p>Squared Away&apos;s use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p><p>Email: <a href="mailto:help@example.com">help@example.com</a></p></main>`,
);
const goodTerms = ok(
  '<main><p>Terms.</p><p>Email: <a href="mailto:help@example.com">x</a></p></main>',
);
const goodHealth = ok('{"ok":true,"service":"squared-away","commit":"abc1234"}');

const good: ReadyInput = {
  base: "https://example.com",
  pages: { home: goodHome, privacy: goodPrivacy, terms: goodTerms, health: goodHealth },
  limitedUseSentence: sentence,
};

const failures = (input: ReadyInput) => googleReadyChecks(input).filter((c) => !c.ok);

describe("googleReadyChecks (Check 28 P6)", () => {
  it("passes every line on a ready site", () => {
    const checks = googleReadyChecks(good);
    expect(failures(good)).toEqual([]);
    expect(checks.length).toBeGreaterThanOrEqual(14);
    expect(formatChecks(checks).every((l) => l.startsWith("PASS "))).toBe(true);
    expect(formatChecks(checks)).toContain("PASS /api/health answers (commit abc1234)");
  });

  it("reads the Limited Use sentence from the doc and compares it as text, not Markdown", () => {
    expect(sentence).toContain("including the Limited Use requirements.");
    expect(markdownToText(sentence)).not.toContain("](");
    expect(htmlToText(goodPrivacy.body)).toContain(markdownToText(sentence));
  });

  it("fails a page that needs sign-in, answers an error, or sends people to another host", () => {
    const signin = {
      ...good,
      pages: {
        ...good.pages,
        privacy: {
          ...goodPrivacy,
          status: 307,
          body: "",
          redirectedTo: "https://example.com/signin",
        },
      },
    };
    // A same-host redirect is followed by the script; here it was recorded unfollowed (3 hops).
    expect(failures(signin).map((c) => c.name)).toContain("/privacy opens without sign-in");
    const elsewhere = {
      ...good,
      pages: {
        ...good.pages,
        home: { ...goodHome, status: 308, redirectedTo: "https://other.example/" },
      },
    };
    const f = failures(elsewhere).find((c) => c.name === "/ opens without sign-in")!;
    expect(f.reason).toContain("other.example");
    const broken = { ...good, pages: { ...good.pages, terms: { ...goodTerms, status: 500 } } };
    expect(
      failures(broken).find((c) => c.name === "/terms opens without sign-in")!.reason,
    ).toContain("500");
  });

  it("fails when the homepage doesn't link to the legal pages on this host", () => {
    const off = {
      ...good,
      pages: {
        ...good.pages,
        home: ok('<a href="https://other.example/privacy">p</a><a href="/terms">t</a>'),
      },
    };
    expect(failures(off).map((c) => c.name)).toEqual([
      "the homepage links to /privacy and /terms on this host",
    ]);
    expect(
      linksTo('<a href="https://example.com/privacy?x=1">p</a>', "/privacy", "https://example.com"),
    ).toBe(true);
    expect(linksTo('<a href="/privacy-x">p</a>', "/privacy", "https://example.com")).toBe(false);
  });

  it("fails when the Limited Use sentence or the Google user data words are missing", () => {
    const noSentence = {
      ...good,
      pages: {
        ...good.pages,
        privacy: ok('<p>We use Google user data well.</p><a href="mailto:a@b.c">a</a>'),
      },
    };
    expect(failures(noSentence).map((c) => c.name)).toEqual([
      "/privacy has Google's Limited Use sentence, word for word",
    ]);
    const noWords = {
      ...good,
      pages: {
        ...good.pages,
        privacy: ok(
          `<p>${markdownToText(sentence).replace("Google API Services", "Google Services")}</p><a href="mailto:a@b.c">a</a>`,
        ),
      },
    };
    expect(failures(noWords).map((c) => c.name)).toEqual([
      "/privacy has Google's Limited Use sentence, word for word",
      "/privacy describes Google user data",
    ]);
  });

  it("fails on [To confirm], a missing contact email, a vercel.app host, noindex, x-powered-by and a dead health route", () => {
    const toConfirm = {
      ...good,
      pages: {
        ...good.pages,
        terms: ok('<p>[To confirm] refunds</p><a href="mailto:a@b.c">a</a>'),
      },
    };
    expect(failures(toConfirm).map((c) => c.name)).toEqual(["/terms has no [To confirm] left"]);
    const noEmail = { ...good, pages: { ...good.pages, terms: ok("<p>Phone: 978</p>") } };
    expect(failures(noEmail).map((c) => c.name)).toEqual(["/terms shows a contact email"]);
    const vercel = { ...good, base: "https://sa-dac3.vercel.app" };
    expect(failures(vercel).map((c) => c.name)).toEqual(["the site is on a domain you own"]);
    const hidden = {
      ...good,
      pages: {
        ...good.pages,
        home: { ...goodHome, headers: { "x-robots-tag": "noindex", "x-powered-by": "Next.js" } },
      },
    };
    expect(failures(hidden).map((c) => c.name)).toEqual([
      "/ isn't hidden from search",
      "/ doesn't announce its framework",
    ]);
    const dead = {
      ...good,
      pages: { ...good.pages, health: { ...goodHealth, status: 503, body: "" } },
    };
    expect(failures(dead).map((c) => c.name)).toEqual(["/api/health answers"]);
    const noCommit = { ...good, pages: { ...good.pages, health: ok('{"ok":true}') } };
    expect(failures(noCommit)[0]!.reason).toBe("no commit in the answer");
  });

  it("the lines carry no page text, only names and reasons", () => {
    const lines = formatChecks(googleReadyChecks(good));
    for (const l of lines) expect(l).not.toMatch(/<|Squared Away&apos;s|help@example.com/);
  });
});

describe("the script's fetch (no network: a fake fetch)", () => {
  const fake = (
    routes: Record<string, { status: number; headers?: Record<string, string>; body?: string }>,
  ) =>
    (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      const r = routes[u.pathname] ?? { status: 404 };
      return new Response(r.body ?? "", { status: r.status, headers: r.headers ?? {} });
    }) as typeof fetch;

  it("follows a same-host redirect but records one to another host", async () => {
    const f = fake({
      "/": { status: 308, headers: { location: "/home" } },
      "/home": { status: 200, body: "<p>home</p>", headers: { "x-robots-tag": "noindex" } },
      "/privacy": { status: 307, headers: { location: "https://other.example/privacy" } },
    });
    const home = await fetchPage("https://example.com", "/", f);
    expect(home).toMatchObject({ status: 200, body: "<p>home</p>", redirectedTo: null });
    expect(home.headers["x-robots-tag"]).toBe("noindex");
    const privacy = await fetchPage("https://example.com", "/privacy", f);
    expect(privacy).toMatchObject({
      status: 307,
      body: "",
      redirectedTo: "https://other.example/privacy",
    });
  });

  it("runGoogleReady fetches the four pages and lists today's failures for a vercel.app host", async () => {
    const f = fake({
      "/": {
        status: 200,
        body: goodHome.body,
        headers: { "x-robots-tag": "noindex", "x-powered-by": "Next.js" },
      },
      "/privacy": { status: 200, body: goodPrivacy.body.replace(/<p>Email:.*<\/p>/, "") },
      "/terms": { status: 200, body: "<p>[To confirm]</p>" },
      "/api/health": { status: 200, body: '{"ok":true,"commit":"c1bf580"}' },
    });
    const checks = await runGoogleReady("https://sa-dac3.vercel.app", f);
    expect(checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([
      "/terms has no [To confirm] left",
      "/privacy shows a contact email",
      "/terms shows a contact email",
      "the site is on a domain you own",
      "/ isn't hidden from search",
      "/ doesn't announce its framework",
    ]);
  });
});
