import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ErrorPage from "@/app/error";
import { HelpLine, SupportEmailProvider } from "@/components/app/help-line";
import { siteConfig } from "@/config/site";
import { phoneHref } from "@/lib/phone-href";

/** Check 32 P12: the crash and not-found pages say how to reach us, like the footer does. */
describe("help line", () => {
  const tel = phoneHref("tel", siteConfig.phone);

  it("the crash page has a <main id=main> with the phone link", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorPage, { error: new Error("x"), retry: () => {} }),
    );
    expect(html).toMatch(/<main[^>]*id="main"/);
    expect(html).toContain(`href="${tel}"`);
    expect(html).toContain(`Stuck? Call`);
    expect(html).toContain(siteConfig.phone);
    // Never the error's message.
    expect(html).not.toContain(">x<");
  });

  it("adds the support email from the layout when it's set, in the footer's order", () => {
    const html = renderToStaticMarkup(
      createElement(
        SupportEmailProvider,
        { email: "help@squaredaway.example" },
        createElement(ErrorPage, { error: new Error("x"), retry: () => {} }),
      ),
    );
    const call = html.indexOf(tel);
    const mail = html.indexOf('href="mailto:help@squaredaway.example"');
    expect(call).toBeGreaterThan(-1);
    expect(mail).toBeGreaterThan(call);
    expect(renderToStaticMarkup(createElement(HelpLine, {}))).not.toContain("mailto:");
  });

  it("the not-found page shows it too, inside its main", () => {
    const src = readFileSync("src/app/not-found.tsx", "utf8");
    expect(src).toContain('id="main"');
    expect(src).toContain("<HelpLine email={process.env.SUPPORT_EMAIL} />");
  });
});
