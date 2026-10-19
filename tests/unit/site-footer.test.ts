import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SiteFooter } from "@/components/app/site-footer";

/** Check 3 P8 / Check 8 P8: the footer's support email is a 44px target on its own line. */
describe("SiteFooter", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("the email link is a 44px target, like the phone link", () => {
    vi.stubEnv("SUPPORT_EMAIL", "a-thirty-character-address@x.co");
    const html = renderToStaticMarkup(createElement(SiteFooter));
    const link = html.match(/<a[^>]*href="mailto:[^"]*"[^>]*>/)?.[0] ?? "";
    expect(link).toContain("min-h-tap");
    expect(link).toContain("inline-flex");
    // A long address wraps instead of pushing the page sideways.
    expect(link).toContain("break-all");
    expect(html).toContain("or email");
  });

  it("no email line without SUPPORT_EMAIL", () => {
    vi.stubEnv("SUPPORT_EMAIL", "");
    const html = renderToStaticMarkup(createElement(SiteFooter));
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("or email");
  });
});
