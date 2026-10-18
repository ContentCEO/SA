import { describe, expect, it } from "vitest";
import { mailboxHealth, STALE_SYNC_MS, staleMailLine, syncIsStale } from "@/server/mailbox-health";

const NOW = new Date("2026-10-10T14:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const base = {
  status: "active" as const,
  backfillCompletedAt: ago(86_400_000),
  lastSyncedAt: ago(2 * 60_000),
  watchExpiresAt: null,
  lastSyncErrorCode: null,
};
const text = (h: ReturnType<typeof mailboxHealth>) => h.lines.map((l) => `${l.label}: ${l.text}`);

describe("Your Gmail health, in plain words", () => {
  it("healthy, polling", () => {
    const h = mailboxHealth(base, NOW, false);
    expect(text(h)).toEqual([
      "Google access: Working.",
      "Last checked: 2 minutes ago.",
      "New mail: Checked every 5 minutes.",
    ]);
    expect(h.needsReconnect).toBe(false);
  });

  it("instant updates on, and restarting", () => {
    const on = mailboxHealth(
      { ...base, watchExpiresAt: new Date(NOW.getTime() + 86_400_000) },
      NOW,
      true,
    );
    expect(text(on)[2]).toBe("New mail: Picked up within seconds.");
    const lapsed = mailboxHealth({ ...base, watchExpiresAt: ago(1000) }, NOW, true);
    expect(text(lapsed)[2]).toContain("while instant updates restart");
  });

  it("first read in progress: how far it got and when it started (Check 25 P6)", () => {
    const reading = { ...base, backfillCompletedAt: null, lastSyncedAt: null };
    const progress = {
      count: 1250,
      startedAt: ago(20 * 60_000),
      startedLabel: "2:10 PM",
      afterReconnect: false,
    };
    expect(text(mailboxHealth(reading, NOW, false, progress))[1]).toBe(
      "Last checked: Reading your last 30 days: 1,250 emails so far, started 2:10 PM.",
    );
    // Never "for the first time", with or without progress.
    expect(text(mailboxHealth(reading, NOW, false)).join(" ")).not.toContain("first time");
  });

  it("a read after reconnecting says so", () => {
    const h = mailboxHealth({ ...base, backfillCompletedAt: null }, NOW, false, {
      count: 30,
      startedAt: ago(60_000),
      startedLabel: "1:59 PM",
      afterReconnect: true,
    });
    expect(text(h)[1]).toBe("Last checked: Reading your last 30 days again after reconnecting.");
  });

  it("a first read past 3 hours adds a reassuring line", () => {
    const h = mailboxHealth({ ...base, backfillCompletedAt: null }, NOW, false, {
      count: 9000,
      startedAt: ago(3 * 60 * 60_000 + 60_000),
      startedLabel: "10:59 AM",
      afterReconnect: false,
    });
    expect(text(h)[1]).toContain("Big inboxes take a while. New mail is still safe in Gmail.");
  });

  it("stale sync is our problem, not theirs: no reconnect button", () => {
    const h = mailboxHealth({ ...base, lastSyncedAt: ago(STALE_SYNC_MS + 60_000) }, NOW, false);
    expect(text(h)[1]).toContain("Nothing for you to do");
    expect(h.needsReconnect).toBe(false);
  });

  it("stale: the New mail line never promises 5 minutes beside an old check", () => {
    const h = mailboxHealth({ ...base, lastSyncedAt: ago(42 * 60_000) }, NOW, false);
    expect(text(h)[2]).toBe(
      "New mail: Should be every 5 minutes. The last check was 42 minutes ago.",
    );
    expect(text(h).join(" ")).not.toContain("Checked every 5 minutes");
  });

  it("the line under the banner", () => {
    expect(staleMailLine(ago(42 * 60_000), NOW)).toBe(
      "Mail last checked 42 minutes ago. New emails may not be here yet. They're safe in Gmail.",
    );
    expect(
      syncIsStale(
        { backfillCompletedAt: base.backfillCompletedAt, lastSyncedAt: ago(42 * 60_000) },
        NOW,
      ),
    ).toBe(true);
    expect(syncIsStale(base, NOW)).toBe(false);
    // A first read in progress isn't "behind".
    expect(syncIsStale({ backfillCompletedAt: null, lastSyncedAt: null }, NOW)).toBe(false);
  });

  it("rate limited is calm and fixes itself", () => {
    const h = mailboxHealth({ ...base, lastSyncErrorCode: "rate_limited" }, NOW, false);
    expect(text(h)[1]).toContain("slow down");
    expect(h.lines.some((l) => l.problem)).toBe(false);
    expect(h.needsReconnect).toBe(false);
  });

  it("access lost is the only state with Reconnect", () => {
    for (const m of [
      { ...base, status: "reconnect_needed" as const },
      { ...base, lastSyncErrorCode: "access_lost" },
    ]) {
      const h = mailboxHealth(m, NOW, true);
      expect(h.needsReconnect).toBe(true);
      expect(text(h)[0]).toContain("Removed");
      expect(text(h)[2]).toBe("New mail: Not being picked up.");
    }
  });
});
