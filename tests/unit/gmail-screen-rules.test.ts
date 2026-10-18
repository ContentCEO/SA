import { describe, expect, it } from "vitest";
import { syncLine } from "@/server/gmail-screen-rules";

/** Check 15 P10: "1 email", and the check time said once (in the health list). */
describe("syncLine", () => {
  const done = { status: "active", backfillCompletedAt: new Date("2026-10-01T12:00:00Z") };
  it("0, 1 and 2 emails", () => {
    expect(syncLine(done, 0, 30)).toBe("0 emails from the last 30 days.");
    expect(syncLine(done, 1, 30)).toBe("1 email from the last 30 days.");
    expect(syncLine(done, 2, 30)).toBe("2 emails from the last 30 days.");
    expect(syncLine(done, 1234, 30)).toBe("1,234 emails from the last 30 days.");
    for (const n of [0, 1, 2]) expect(syncLine(done, n, 30)).not.toContain("checked");
  });
  it("reconnect needed, paused, and the first read still running", () => {
    expect(syncLine({ ...done, status: "reconnect_needed" }, 5, 30)).toContain("Reconnect");
    expect(syncLine({ ...done, status: "paused" }, 5, 30)).toBe(
      "Paused. Nothing is being read or drafted.",
    );
    expect(syncLine({ status: "active", backfillCompletedAt: null }, 0, 30)).toBe(
      "Reading your last 30 days of email. This can take a few minutes.",
    );
  });
});
