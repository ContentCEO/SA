import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, securityHeaders, type HeaderEnv } from "@/config/security-headers";

const csp = (env = {}) =>
  Object.fromEntries(
    contentSecurityPolicy(env)
      .split("; ")
      .map((d) => {
        const [k, ...v] = d.split(" ");
        return [k!, v];
      }),
  );

describe("security headers", () => {
  it("sends the standard set on every response", () => {
    const h = Object.fromEntries(securityHeaders({}).map((x) => [x.key, x.value]));
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    // Check 26 P9: Google sign-in, Gmail connect and Stripe are full-page redirects.
    expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(h["Permissions-Policy"]).toContain("camera=()");
    expect(h["Permissions-Policy"]).toContain("geolocation=()");
  });

  it("CSP: our own code only, no framing, and forms may only end at Google sign-in or Stripe", () => {
    const p = csp();
    expect(p["default-src"]).toEqual(["'self'"]);
    expect(p["frame-ancestors"]).toEqual(["'none'"]);
    expect(p["object-src"]).toEqual(["'none'"]);
    expect(p["script-src"]).not.toContain("'unsafe-eval'");
    expect(p["form-action"]).toEqual([
      "'self'",
      "https://accounts.google.com",
      "https://checkout.stripe.com",
      "https://billing.stripe.com",
    ]);
    // Fonts are self-hosted by next/font: no Google Fonts host needed.
    expect(contentSecurityPolicy({})).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });

  it("GUARDRAIL (M11 S1): the e2e switch never changes any header (consent stays at Google)", () => {
    const e2e = {
      SA_E2E: "1",
      SA_E2E_GOOGLE_BASE_URL: "http://127.0.0.1:3301",
      SA_E2E_ANTHROPIC_BASE_URL: "http://127.0.0.1:3301",
      SA_E2E_HOOK_SECRET: "s".repeat(32),
      DATABASE_URL: "postgres://u@localhost/db",
    };
    for (const env of [{}, { NODE_ENV: "production" }, { VERCEL_ENV: "preview" }]) {
      expect(securityHeaders({ ...env, ...e2e } as HeaderEnv)).toEqual(securityHeaders(env));
      expect(csp({ ...env, ...e2e })["form-action"]).toEqual([
        "'self'",
        "https://accounts.google.com",
        "https://checkout.stripe.com",
        "https://billing.stripe.com",
      ]);
    }
    expect(contentSecurityPolicy({ ...e2e } as HeaderEnv)).not.toContain("127.0.0.1");
  });

  it("M11 C7: HTTPS is remembered for a year, for this host only (no subdomains, no preload)", () => {
    for (const env of [{}, { NODE_ENV: "production" }, { VERCEL_ENV: "preview" }]) {
      const h = Object.fromEntries(securityHeaders(env).map((x) => [x.key, x.value]));
      expect(h["Strict-Transport-Security"]).toBe("max-age=31536000");
      expect(h["Strict-Transport-Security"]).not.toMatch(/includeSubDomains|preload/i);
    }
  });

  it("only previews allow Vercel's toolbar; only development allows eval", () => {
    expect(contentSecurityPolicy({})).not.toContain("vercel.live");
    expect(csp({ VERCEL_ENV: "preview" })["script-src"]).toContain("https://vercel.live");
    expect(csp({ NODE_ENV: "development" })["script-src"]).toContain("'unsafe-eval'");
  });

  it("allows error reports to reach Sentry only when it's switched on", () => {
    expect(csp({})["connect-src"]).toEqual(["'self'"]);
    expect(
      csp({ NEXT_PUBLIC_SENTRY_DSN: "https://abc@o1.ingest.us.sentry.io/42" })["connect-src"],
    ).toEqual(["'self'", "https://o1.ingest.us.sentry.io"]);
  });
});

describe("Check 26 P9: nothing announces what's behind the site", () => {
  it("next.config.ts turns off x-powered-by", async () => {
    const { default: config } = await import("../../next.config");
    expect(config.poweredByHeader).toBe(false);
  });

  it("robots.txt never names /admin (its pages say noindex instead)", async () => {
    const { readFileSync } = await import("node:fs");
    const { default: robots } = await import("@/app/robots");
    expect(JSON.stringify(robots())).not.toMatch(/admin/i);
    for (const page of [
      "src/app/(app)/admin/page.tsx",
      "src/app/(app)/admin/growth/page.tsx",
      "src/app/(app)/admin/costs/page.tsx",
    ])
      expect(readFileSync(page, "utf8"), page).toContain("robots: { index: false }");
  });
});
