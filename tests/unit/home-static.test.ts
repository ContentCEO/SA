import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { REQUEST_PATH_HEADER } from "@/config/legal";
import { hasSessionCookie, homeRedirect, SIGNED_IN_HOME } from "@/lib/home-redirect";

/**
 * Check 29 P3: the homepage is prerendered (CDN), the signed-in redirect lives in the proxy, and
 * a referral code is read by the waitlist form in the browser.
 */

let search = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("@/app/waitlist-actions", () => ({ joinWaitlistAction: async () => ({ status: "idle" }) }));

describe("the homepage's signed-in redirect rule", () => {
  it("a session cookie on / goes to the signed-in home; nothing else does", () => {
    expect(SIGNED_IN_HOME).toBe("/start");
    expect(homeRedirect("/", ["authjs.session-token"])).toBe("/start");
    expect(homeRedirect("/", ["__Secure-authjs.session-token"])).toBe("/start");
    expect(homeRedirect("/", ["__Secure-authjs.session-token.0", "x"])).toBe("/start");
    expect(homeRedirect("/", [])).toBeNull();
    expect(homeRedirect("/", ["authjs.csrf-token", "authjs.callback-url", "sa_hand"])).toBeNull();
    expect(homeRedirect("/growth", ["authjs.session-token"])).toBeNull();
    expect(hasSessionCookie(["authjs.session-tokenx"])).toBe(false);
  });
});

describe("the proxy on /", () => {
  const req = (path: string, cookie?: string, method = "GET") =>
    new NextRequest(`http://localhost${path}`, {
      method,
      headers: cookie ? { cookie } : {},
    });

  it("cookie → redirect to /start; no cookie → the page, untouched", async () => {
    const { proxy, config } = await import("@/proxy");
    expect(config.matcher).toContain("/");
    const signedIn = proxy(req("/", "authjs.session-token=abc"));
    expect(signedIn.status).toBe(307);
    expect(new URL(signedIn.headers.get("location")!).pathname).toBe("/start");
    const visitor = proxy(req("/?ref=AbCdEf123_-x"));
    expect(visitor.headers.get("location")).toBeNull();
    expect(visitor.headers.get(`x-middleware-request-${REQUEST_PATH_HEADER}`)).toBeNull();
    // The waitlist's server action posts to "/": never redirected.
    expect(proxy(req("/", "authjs.session-token=abc", "POST")).headers.get("location")).toBeNull();
  });

  it("other paths keep the path header and are never redirected", async () => {
    const { proxy } = await import("@/proxy");
    const res = proxy(req("/queue?t=1", "authjs.session-token=abc"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get(`x-middleware-request-${REQUEST_PATH_HEADER}`)).toBe("/queue?t=1");
  });
});

describe("the homepage can be prerendered", () => {
  it("reads no session and no search params", () => {
    const src = readFileSync("src/app/page.tsx", "utf8");
    expect(src).not.toMatch(/from "@\/auth"/);
    expect(src).not.toMatch(/searchParams/);
    expect(src).not.toMatch(/export default async function/);
  });
});

describe("the waitlist form reads ?ref= in the browser", () => {
  const render = async (referrals: boolean, query: string) => {
    search = query;
    const { WaitlistForm } = await import("@/components/marketing/waitlist-form");
    const Form = WaitlistForm as (p: { referrals?: boolean }) => ReturnType<typeof WaitlistForm>;
    return renderToStaticMarkup(createElement(Form, { referrals }));
  };

  it("a valid code rides along while referrals are on", async () => {
    expect(await render(true, "ref=AbCdEf123_-x")).toContain(
      '<input type="hidden" name="ref" value="AbCdEf123_-x"/>',
    );
  });

  it("no field for a bad code, no code, or while referrals are off", async () => {
    expect(await render(true, "ref=short")).not.toContain('name="ref"');
    expect(await render(true, "")).not.toContain('name="ref"');
    expect(await render(false, "ref=AbCdEf123_-x")).not.toContain('name="ref"');
  });
});
