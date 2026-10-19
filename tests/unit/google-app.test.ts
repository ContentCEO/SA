import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_LOST_REASON_DEFAULT,
  ACCESS_LOST_REASON_TESTING,
  accessLostReason,
  googleAppState,
  googleAppStateFrom,
  parseGoogleAppState,
  googleWarningLine,
} from "@/config/google-app";
import { accessLostEmail } from "@/server/alerts";
import { mailboxHealth } from "@/server/mailbox-health";

/** Check 1 P7 (and the config Check 28 P3 shares): one env, GOOGLE_APP_STATE, default testing. */
describe("GOOGLE_APP_STATE", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("unknown or missing values fall back to testing", () => {
    expect(googleAppStateFrom(undefined)).toBe("testing");
    expect(googleAppStateFrom("")).toBe("testing");
    expect(googleAppStateFrom("published")).toBe("testing");
    expect(googleAppStateFrom(" Verified ")).toBe("verified");
    expect(googleAppStateFrom("unverified")).toBe("unverified");
    vi.stubEnv("GOOGLE_APP_STATE", "verified");
    expect(googleAppState()).toBe("verified");
    vi.stubEnv("GOOGLE_APP_STATE", "");
    expect(googleAppState()).toBe("testing");
  });

  it("the connect screen's warning line per state (Check 28 P3)", () => {
    expect(googleWarningLine("testing")).toBe(
      "Google will show a screen saying it hasn't verified Squared Away yet. That's expected while we're in early access. Tap Continue.",
    );
    expect(googleWarningLine("unverified")).toContain(
      "Tap Advanced, then the link that starts with Go to.",
    );
    expect(googleWarningLine("verified")).toBeNull();
    for (const l of [googleWarningLine("testing"), googleWarningLine("unverified")]) {
      expect(l).not.toContain("—");
    }
  });
});

describe("the access-lost reason (Check 1 P7)", () => {
  const NOW = new Date("2026-10-10T14:00:00Z");
  const lost = {
    status: "reconnect_needed" as const,
    lastSyncedAt: new Date("2026-10-10T13:00:00Z"),
    lastSyncErrorCode: "access_lost",
    backfillCompletedAt: new Date("2026-10-01T00:00:00Z"),
    watchExpiresAt: null,
    planPausedAt: null,
  };

  it("the email gives the 7-day reason in Testing and today's line otherwise", () => {
    expect(accessLostReason("testing")).toBe(ACCESS_LOST_REASON_TESTING);
    expect(accessLostReason("unverified")).toBe(ACCESS_LOST_REASON_DEFAULT);
    expect(accessLostReason("verified")).toBe(ACCESS_LOST_REASON_DEFAULT);
    const testing = accessLostEmail("jobs@shop.com", false, "testing");
    expect(testing.text).toContain(
      "While Squared Away waits for Google's approval, Google ends access every 7 days. Reconnecting takes a minute and nothing is lost.",
    );
    expect(testing.text).not.toContain("password change");
    const verified = accessLostEmail("jobs@shop.com", false, "verified");
    expect(verified.text).toContain("for example after a password change.");
    expect(verified.text).not.toContain("every 7 days");
    // The reminder keeps its own footer in every state.
    expect(accessLostEmail("jobs@shop.com", true, "testing").text).toContain("last reminder");
  });

  it("without the env the email reads as Testing (the default today)", () => {
    vi.stubEnv("GOOGLE_APP_STATE", "");
    expect(accessLostEmail("jobs@shop.com", false).text).toContain("every 7 days");
    vi.stubEnv("GOOGLE_APP_STATE", "verified");
    expect(accessLostEmail("jobs@shop.com", false).text).toContain("password change");
    vi.unstubAllEnvs();
  });

  it("Settings → Your Gmail says the same when access is lost", () => {
    const line = (state: "testing" | "verified") =>
      mailboxHealth(lost, NOW, true, undefined, state).lines[0]!.text;
    expect(line("testing")).toBe(
      `Removed. Squared Away can't read this inbox until you reconnect. ${ACCESS_LOST_REASON_TESTING}`,
    );
    expect(line("verified")).toContain("password change");
    // A working mailbox says nothing about it.
    expect(
      mailboxHealth({ ...lost, status: "active", lastSyncErrorCode: null }, NOW, true).lines[0]!
        .text,
    ).toBe("Working.");
  });
});

/** From the Google group's copy of this test (Check 28 P3), kept at the merge. */
describe("googleAppState from an env object, and the connect screen (Check 28 P3)", () => {
  it("reads GOOGLE_APP_STATE from the object passed in", () => {
    expect(googleAppState({})).toBe("testing");
    expect(googleAppState({ GOOGLE_APP_STATE: "banana" })).toBe("testing");
    expect(googleAppState({ GOOGLE_APP_STATE: "unverified" })).toBe("unverified");
    expect(googleAppState({ GOOGLE_APP_STATE: " Verified " })).toBe("verified");
    expect(parseGoogleAppState(undefined)).toBe("testing");
    expect(googleAppStateFrom).toBe(parseGoogleAppState);
  });

  it("each warning line says only its own state's taps, with no dashes", () => {
    const testing = googleWarningLine("testing", "Squared Away")!;
    expect(testing).not.toMatch(/Advanced|—|–/);
    const unverified = googleWarningLine("unverified", "Squared Away")!;
    expect(unverified).toContain("Google adds the word unsafe");
    expect(unverified).not.toMatch(/Continue|—|–/);
  });

  it("the connect screen renders the line from the state and keeps the rest", () => {
    const page = readFileSync("src/app/(app)/connect/page.tsx", "utf8");
    expect(page).toContain("googleWarningLine(googleAppState(), siteConfig.name)");
    expect(page).not.toContain("Go to Squared Away");
    expect(page).toContain("You can disconnect any time in Settings.");
  });
});
