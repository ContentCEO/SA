import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { growthCopy } from "@/components/marketing/growth/growth-copy";
import { portalCopy } from "@/components/growth-portal/portal-copy";
import { siteConfig } from "@/config/site";
import { headlineName } from "@/lib/headline-name";

/**
 * Check 7 P7 + Check 6 P11: headline words are lowercase, but names (people, companies, products:
 * Gmail, Google, Davi, AI) keep their capitals. Scans every Headline prop and serif:/heavy: field
 * under src.
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}
const SRC = files("src").map((f) => ({ f, text: readFileSync(f, "utf8") }));
/** serif="…", heavy="…", serif: "…", heavy: `…` (one line each). */
const FIELD = /\b(serif|heavy)\s*[=:]\s*\{?\s*(["'`])((?:(?!\2).)*)\2/g;
const first = siteConfig.operator.split(" ")[0]!;

describe("names keep their capitals in headlines", () => {
  const values = SRC.flatMap(({ f, text }) =>
    [...text.matchAll(FIELD)].map((m) => ({ f, value: m[3]! })),
  );

  it("finds the headline fields it checks", () => {
    expect(values.length).toBeGreaterThan(50);
  });

  it("never writes gmail, google or the operator's name in lowercase", () => {
    // Template placeholders (`${davi}`) are code, not words.
    const bad = values.filter(({ value }) =>
      new RegExp(`\\b(gmail|google|${first.toLowerCase()})\\b`).test(
        value.replace(/\$\{[^}]*\}/g, ""),
      ),
    );
    expect(bad).toEqual([]);
  });

  it("never lowercases a name into a headline field", () => {
    const bad = SRC.flatMap(({ f, text }) =>
      [...text.matchAll(/\b(serif|heavy)\s*[=:][^\n]*toLowerCase\(\)/g)].map(
        (m) => `${f}: ${m[0]}`,
      ),
    );
    expect(bad).toEqual([]);
  });

  it("the Growth and portal headlines say the operator's name with its capital", () => {
    expect(growthCopy.call.heavy).toBe(`ask ${first} to call you.`);
    const all = JSON.stringify([growthCopy, portalCopy]);
    expect(all).not.toContain(` ${first.toLowerCase()} `);
    expect(all).not.toContain(` ${first.toLowerCase()}.`);
  });

  it("a customer with no name is 'this customer', never the address", () => {
    expect(headlineName(null, "dana@x.com")).toBe("this customer");
    expect(headlineName("dana@x.com", "dana@x.com")).toBe("this customer");
    expect(headlineName("Dana Ruiz", "dana@x.com")).toBe("Dana");
  });
});
