import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppEmailsGoTo } from "@/components/app/app-emails-go-to";
import { appEmailsGoTo } from "@/server/app-emails-to-rules";

/** Check 42 P6: both settings screens say which address gets the app's own emails. */
describe("which address gets the app's emails", () => {
  it("names the sign-in address, and warns when it isn't a connected inbox", () => {
    expect(appEmailsGoTo("digest", "mike@gmail.com", ["mike@gmail.com"])).toEqual([
      "Goes to mike@gmail.com (the Google account you sign in with).",
    ]);
    expect(
      appEmailsGoTo("access", "Mike@Gmail.com", ["office@shop.com", "mike@gmail.com"]),
    ).toEqual(["If Google access stops, we email Mike@Gmail.com (your sign-in)."]);
    expect(appEmailsGoTo("digest", "mike@gmail.com", ["office@shop.com"])).toEqual([
      "Goes to mike@gmail.com (the Google account you sign in with).",
      "That's not one of the inboxes connected here, so check it is one you read.",
    ]);
    expect(appEmailsGoTo("access", "mike@gmail.com", [])).toHaveLength(2);
  });

  it("renders as one muted line per screen (nothing without a sign-in address)", () => {
    const connected = renderToStaticMarkup(
      createElement(AppEmailsGoTo, {
        kind: "digest",
        signInEmail: "mike@gmail.com",
        connectedEmails: ["mike@gmail.com"],
      }),
    );
    expect(connected).toContain("Goes to mike@gmail.com (the Google account you sign in with).");
    expect(connected).not.toContain("check it is one you read");
    const other = renderToStaticMarkup(
      createElement(AppEmailsGoTo, {
        kind: "access",
        signInEmail: "mike@gmail.com",
        connectedEmails: ["office@shop.com"],
      }),
    );
    expect(other).toContain("If Google access stops, we email mike@gmail.com (your sign-in).");
    expect(other).toContain("check it is one you read");
    expect(
      renderToStaticMarkup(
        createElement(AppEmailsGoTo, { kind: "digest", signInEmail: null, connectedEmails: [] }),
      ),
    ).toBe("");
  });

  it("both screens render it from the session, under the checkbox and under the list, and never log it", () => {
    const morning = readFileSync("src/app/(app)/settings/morning-email/page.tsx", "utf8");
    const gmail = readFileSync("src/app/(app)/settings/gmail/page.tsx", "utf8");
    for (const [page, kind] of [
      [morning, "digest"],
      [gmail, "access"],
    ] as const) {
      expect(page).toContain(`kind="${kind}"`);
      expect(page).toContain("signInEmail={session.user.email}");
      expect(page).not.toMatch(/console\.(log|info|error|warn)/);
    }
    expect(morning.indexOf('id="digest-monthly-note"')).toBeLessThan(
      morning.indexOf("<AppEmailsGoTo"),
    );
    expect(gmail.indexOf("</ul>")).toBeLessThan(gmail.indexOf("<AppEmailsGoTo"));
  });
});
