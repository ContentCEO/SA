import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRAND } from "@/config/brand";
import { brandEmail, emailShell } from "@/lib/email-layout";
import { buildDigest } from "@/server/digest";
import { buildMonthlySummary } from "@/server/monthly-rules";
import { queueThreadUrl } from "@/server/digest-rules";

/**
 * Check 7 P10 / Check 18 P7: one place for the brand's hex colors and one email shell.
 * public/offline.html and src/app/icon.svg can't import, so they keep their own copies (they
 * are outside src/**.ts(x) and are the only allowed ones).
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("brand colors live in one file", () => {
  it("theme.css's --sa-k-* constants equal BRAND", () => {
    const css = readFileSync("src/styles/theme.css", "utf8");
    for (const [name, hex] of Object.entries(BRAND)) {
      expect(css).toContain(`--sa-k-${name}: ${hex};`);
    }
    // Every non-sunlight constant in the CSS is in BRAND (and nothing else).
    const names = [...css.matchAll(/--sa-k-(?!hc-)([a-z]+): (#[0-9a-f]{6});/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(Object.fromEntries(names)).toEqual(BRAND);
  });

  it("no hex color is typed anywhere else in src (allow-list: none)", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      if (file === join("src", "config", "brand.ts")) continue;
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b(?![0-9a-fA-F])/g)) {
        // "#1043" (an invoice number) is not a color; neither is a `#t-` anchor.
        if (
          /^#[0-9]{3,4}$/.test(m[0]) &&
          /invoice|Inv/i.test(text.slice(Math.max(0, m.index! - 40), m.index!))
        )
          continue;
        offenders.push(`${file}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("one email shell (Check 18 P7)", () => {
  const T1 = "11111111-1111-4111-8111-111111111111";
  const links = {
    queueUrl: "https://app/queue",
    quotesUrl: "https://app/quotes",
    settingsUrl: "https://app/settings",
    threadUrl: (id: string) => queueThreadUrl("https://app/queue", id),
  };
  const digest = buildDigest(
    {
      repliesReady: 2,
      nudgesReady: 0,
      needsYou: [
        {
          threadId: T1,
          category: "complaint",
          priority: "high",
          waitingSince: new Date("2026-10-06T09:00:00Z"),
        },
      ],
      sentYesterday: 1,
      sortedYesterday: 3,
      leadsAtRisk: 0,
      leadsAtRiskOffQueue: 0,
    },
    links,
    { now: new Date("2026-10-06T11:30:00Z"), timeZone: "America/New_York" },
  );
  const monthly = buildMonthlySummary(
    {
      quoteRequests: 7,
      jobKinds: [{ label: "Decks", count: 4 }],
      leadSources: [{ label: "Direct email", count: 7 }],
      repeatCustomers: 1,
      won: 3,
      lost: 1,
      noAnswer: 1,
      ratePct: 60,
    },
    "October",
    { activityUrl: "https://app/activity", settingsUrl: "https://app/settings" },
  );
  const brand = brandEmail({
    serif: "heads up,",
    heavy: "reconnect gmail.",
    lines: ["Line one.", "Line two."],
    button: { label: "Reconnect Gmail", url: "https://app/settings/gmail" },
    footer: "A footer.",
    stopLink: { label: "Stop these emails", url: "https://app/api/emails/stop?w=1&s=2" },
  });
  const all = { digest: digest.html, monthly: monthly.html, brand: brand.html };
  const head = emailShell({ preheader: "x", bodyHtml: "" }).split("<body")[0]!;

  it("every template starts with the same head: lang, charset, viewport and light-only color scheme", () => {
    for (const [name, html] of Object.entries(all)) {
      expect(html.startsWith(head), name).toBe(true);
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('<meta charset="utf-8">');
      expect(html).toContain(
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
      );
      expect(html).toContain('<meta name="color-scheme" content="light only">');
      expect(html).toContain('<meta name="supported-color-schemes" content="light only">');
      // The background sits on an outer table with bgcolor as well as style.
      expect(html).toContain(`bgcolor="${BRAND.paper}" style="background:${BRAND.paper}`);
      // Exactly one hidden preheader.
      expect(html.match(/display:none;max-height:0/g)).toHaveLength(1);
      // The button's light edge.
      expect(html).toContain(`border:2px solid ${BRAND.offwhite}`);
    }
  });

  it("the preheader is content-free and the footer links are 44px blocks at 14px", () => {
    expect(digest.html).toContain(">3 things waiting on you</div>");
    expect(monthly.html).toContain(">Your October in numbers</div>");
    expect(brand.html).toContain(">Line one.</div>");
    for (const html of Object.values(all)) {
      for (const m of html.matchAll(
        /<a href="[^"]*" style="display:block;padding:13px 0;font-size:14px;line-height:18px[^"]*"/g,
      )) {
        expect(m[0]).toContain("padding:13px 0"); // 13 + 18 + 13 = 44
      }
    }
    expect(digest.html).toMatch(
      /display:block;padding:13px 0;[^"]*">Change or turn off this email<\/a>/,
    );
    expect(monthly.html).toMatch(/display:block;padding:13px 0;[^"]*">Change or turn it off<\/a>/);
    expect(brand.html).toMatch(/display:block;padding:13px 0;[^"]*">Stop these emails<\/a>/);
  });

  it("keeps every word: the digest and monthly text parts are as before", () => {
    expect(digest.text).toContain(
      "Nothing is sent without your okay. Change or turn off this email: https://app/settings",
    );
    expect(digest.html).toContain("Nothing is sent without your okay.");
    expect(digest.html).toContain(">Open your queue</a>");
    expect(monthly.text).toContain(
      "Nothing is sent without your okay. This comes with your morning summary; change or turn it off: https://app/settings",
    );
    expect(monthly.html).toContain(
      "Nothing is sent without your okay. This comes with your morning summary.",
    );
    expect(monthly.html).toContain(">See your Activity</a>");
    expect(brand.text).toBe(
      [
        "Line one.",
        "Line two.",
        "",
        "Reconnect Gmail: https://app/settings/gmail",
        "",
        "A footer.",
        "Stop these emails: https://app/api/emails/stop?w=1&s=2",
        "© 2026 Squared Away",
      ]
        .join("\n")
        .replace("© 2026 Squared Away", brand.text.split("\n").at(-1)!),
    );
  });
});
