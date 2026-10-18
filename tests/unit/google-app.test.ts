import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  accessLostReason,
  googleAppState,
  googleWarningLine,
  parseGoogleAppState,
} from "@/config/google-app";
import { accessLostEmail } from "@/server/alerts";

/**
 * Check 28 P3: the connect screen's Google-warning line matches what Google shows in each state
 * of the app (Testing / published but unverified / verified), from one env, GOOGLE_APP_STATE.
 */
describe("googleAppState (Check 28 P3)", () => {
  it("reads GOOGLE_APP_STATE; unknown or missing values fall back to testing", () => {
    expect(googleAppState({})).toBe("testing");
    expect(googleAppState({ GOOGLE_APP_STATE: "" })).toBe("testing");
    expect(googleAppState({ GOOGLE_APP_STATE: "banana" })).toBe("testing");
    expect(googleAppState({ GOOGLE_APP_STATE: "unverified" })).toBe("unverified");
    expect(googleAppState({ GOOGLE_APP_STATE: " Verified " })).toBe("verified");
    expect(parseGoogleAppState(undefined)).toBe("testing");
  });

  it("testing: a Continue button and the early-access words; no dashes", () => {
    const line = googleWarningLine("testing", "Squared Away")!;
    expect(line).toBe(
      "Google will show a screen saying it hasn't verified Squared Away yet. That's expected while we're in early access. Tap Continue.",
    );
    expect(line).not.toMatch(/Advanced|—|–/);
  });

  it("unverified: Advanced, the Go to link and Google's word unsafe; no dashes", () => {
    const line = googleWarningLine("unverified", "Squared Away")!;
    expect(line).toContain("Tap Advanced, then the link that starts with Go to.");
    expect(line).toContain("Google adds the word unsafe");
    expect(line).not.toMatch(/Continue|—|–/);
  });

  it("verified: nothing to show", () => {
    expect(googleWarningLine("verified", "Squared Away")).toBeNull();
  });

  it("the connect screen renders the line from the state and keeps the rest", () => {
    const page = readFileSync("src/app/(app)/connect/page.tsx", "utf8");
    expect(page).toContain("googleWarningLine(googleAppState(), siteConfig.name)");
    expect(page).not.toContain("Go to Squared Away");
    expect(page).toContain("You can disconnect any time in Settings.");
  });
});

describe("the Gmail-access-lost reason follows the state (Check 1 P7)", () => {
  it("in Testing it names Google's 7-day limit; afterwards the password-change example", () => {
    expect(accessLostReason("testing")).toContain("after 7 days");
    expect(accessLostReason("unverified")).toContain("password change");
    expect(accessLostReason("verified")).toContain("password change");
  });

  it("the first alert carries the reason; the reminder keeps its own footer", () => {
    const before = process.env.GOOGLE_APP_STATE;
    try {
      delete process.env.GOOGLE_APP_STATE;
      const first = accessLostEmail("owner@shop.com", false);
      expect(first.text).toContain("after 7 days");
      expect(first.subject).toBe("Squared Away lost access to your Gmail");
      process.env.GOOGLE_APP_STATE = "verified";
      expect(accessLostEmail("owner@shop.com", false).text).toContain("password change");
      expect(accessLostEmail("owner@shop.com", true).text).toContain("last reminder");
    } finally {
      if (before === undefined) delete process.env.GOOGLE_APP_STATE;
      else process.env.GOOGLE_APP_STATE = before;
    }
  });
});
