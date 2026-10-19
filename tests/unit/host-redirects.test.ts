import { describe, expect, it } from "vitest";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import {
  LEGACY_HOST_PATTERN,
  legacyHostRedirects,
  legacyHostTarget,
} from "@/config/host-redirects";

/**
 * Check 33 P1: the vercel.app addresses forward to the real domain only once APP_URL is that
 * domain on production. Until then (today) the rule list is empty, so nothing changes.
 */
describe("legacyHostRedirects (Check 33 P1)", () => {
  it("returns [] on previews, locally, and when VERCEL_ENV is missing", () => {
    expect(legacyHostRedirects({ VERCEL_ENV: "preview", APP_URL: "https://example.com" })).toEqual(
      [],
    );
    expect(legacyHostRedirects({ APP_URL: "https://example.com" })).toEqual([]);
    expect(legacyHostRedirects({ VERCEL_ENV: "development" })).toEqual([]);
  });

  it("returns [] while APP_URL is today's vercel.app address, so nothing changes before the move", () => {
    expect(
      legacyHostRedirects({ VERCEL_ENV: "production", APP_URL: "https://sa-dac3.vercel.app" }),
    ).toEqual([]);
    expect(
      legacyHostRedirects({ VERCEL_ENV: "production", APP_URL: "https://SA-DAC3.VERCEL.APP/" }),
    ).toEqual([]);
    // No APP_URL, a broken one, or plain http: nothing to forward to.
    expect(legacyHostRedirects({ VERCEL_ENV: "production" })).toEqual([]);
    expect(legacyHostRedirects({ VERCEL_ENV: "production", APP_URL: "not a url" })).toEqual([]);
    expect(
      legacyHostRedirects({ VERCEL_ENV: "production", APP_URL: "http://example.com" }),
    ).toEqual([]);
  });

  it("on production with a real domain: one permanent rule to that origin, never for api/ or _next/", () => {
    const rules = legacyHostRedirects({
      VERCEL_ENV: "production",
      APP_URL: "https://example.com/",
    });
    expect(rules).toHaveLength(1);
    const [rule] = rules;
    expect(rule!.permanent).toBe(true);
    expect(rule!.destination.startsWith("https://example.com")).toBe(true);
    expect(rule!.destination).toBe("https://example.com/:path");
    expect(rule!.has).toEqual([{ type: "host", value: LEGACY_HOST_PATTERN }]);
    expect(rule!.source).toContain("(?!api/|_next/)");
    expect(legacyHostTarget({ VERCEL_ENV: "production", APP_URL: "https://example.com/x" })).toBe(
      "https://example.com",
    );
  });

  it("the source matches pages (queue, growth, the homepage, with a query) and skips api/ and _next/", () => {
    const [rule] = legacyHostRedirects({
      VERCEL_ENV: "production",
      APP_URL: "https://example.com",
    });
    // Next compiles `source` with path-to-regexp; the query string isn't part of the path and is
    // carried through by Next itself.
    const match = getPathMatch(rule!.source);
    expect(match("/queue")).toEqual({ path: "queue" });
    expect(match("/growth")).toEqual({ path: "growth" });
    expect(match("/")).toEqual({ path: "" });
    expect(match(new URL("https://sa-dac3.vercel.app/?ref=ABC12").pathname)).toEqual({ path: "" });
    expect(match("/record/abc")).toEqual({ path: "record/abc" });
    expect(match("/api/stripe/webhook")).toBe(false);
    expect(match("/api/gmail/callback")).toBe(false);
    expect(match("/_next/static/x.js")).toBe(false);
  });

  it("the host pattern matches every vercel.app address and nothing else", () => {
    // Next anchors a `has` value as ^value$.
    const host = new RegExp(`^${LEGACY_HOST_PATTERN}$`);
    for (const h of [
      "sa-dac3.vercel.app",
      "sa-flax-eight.vercel.app",
      "sa-git-main-dac3.vercel.app",
    ]) {
      expect(host.test(h), h).toBe(true);
    }
    for (const h of [
      "example.com",
      "vercel.app",
      "www.example.com",
      "sa-dac3.vercel.app.evil.com",
    ]) {
      expect(host.test(h), h).toBe(false);
    }
  });

  it("next.config.ts applies it", async () => {
    const { default: config } = await import("../../next.config");
    expect(typeof config.redirects).toBe("function");
    // In this test process VERCEL_ENV isn't production, so the live config forwards nothing.
    expect(await config.redirects!()).toEqual(legacyHostRedirects());
  });
});
