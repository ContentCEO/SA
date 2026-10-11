import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, securityHeaders } from "@/config/security-headers";

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
