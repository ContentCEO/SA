import { describe, expect, it } from "vitest";
import { mailboxHealth, STALE_SYNC_MS } from "@/server/mailbox-health";

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

  it("first read in progress", () => {
    expect(text(mailboxHealth({ ...base, backfillCompletedAt: null }, NOW, false))[1]).toContain(
      "for the first time",
    );
  });

  it("stale sync is our problem, not theirs: no reconnect button", () => {
    const h = mailboxHealth({ ...base, lastSyncedAt: ago(STALE_SYNC_MS + 60_000) }, NOW, false);
    expect(text(h)[1]).toContain("Nothing for you to do");
    expect(h.needsReconnect).toBe(false);
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
