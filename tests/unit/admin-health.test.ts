import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { mailboxes, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { adminOverview, JOBS_STALE_AFTER_MS, systemHealth } from "@/server/admin";
import { mailboxesLine, mailboxesStuck, systemTroubleLines } from "@/server/admin-mailbox-rules";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";

const NOW = new Date("2026-10-10T14:00:00Z");
let database: Database;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
});

async function mailbox(lastSyncedAt: Date | null) {
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  await database
    .update(workspaces)
    .set({ status: "active" })
    .where(eq(workspaces.id, workspace.id));
  const mb = await saveConnectedMailbox(workspace, {
    email: "owner@shop.com",
    refreshToken: "rt",
    grantedScopes: [],
  });
  await database
    .update(mailboxes)
    .set({ backfillCompletedAt: NOW, lastSyncedAt })
    .where(eq(mailboxes.id, mb.id));
  return mb.id;
}

describe("admin health", () => {
  it("is quiet with no working mailboxes", async () => {
    expect((await systemHealth(NOW)).jobsLookStopped).toBe(false);
  });

  it("is fine when mail was checked recently", async () => {
    await mailbox(new Date(NOW.getTime() - 5 * 60_000));
    expect(await systemHealth(NOW)).toMatchObject({ workingMailboxes: 1, jobsLookStopped: false });
  });

  it("waits 25 minutes, past the push-on poll skip (15 minutes + one poll)", async () => {
    expect(JOBS_STALE_AFTER_MS).toBe(25 * 60_000);
    await mailbox(new Date(NOW.getTime() - 21 * 60_000));
    expect((await systemHealth(NOW)).jobsLookStopped).toBe(false);
  });

  it("warns when no working mailbox has synced for a while", async () => {
    await mailbox(new Date(NOW.getTime() - JOBS_STALE_AFTER_MS - 60_000));
    expect((await systemHealth(NOW)).jobsLookStopped).toBe(true);
  });

  it("counts mailboxes that need reconnecting, and ignores them for job health", async () => {
    const id = await mailbox(null);
    await database
      .update(mailboxes)
      .set({ status: "reconnect_needed" })
      .where(eq(mailboxes.id, id));
    expect(await systemHealth(NOW)).toMatchObject({
      needReconnect: 1,
      workingMailboxes: 0,
      jobsLookStopped: false,
    });
  });

  it("per-account health carries times only", async () => {
    await mailbox(NOW);
    const [row] = await adminOverview(NOW);
    expect(row!.health).toEqual({ lastSortedAt: null, lastDraftAt: null, lastDigestAt: null });
  });

  describe("Check 16 P1: one stuck inbox shows even when others are fine", () => {
    const ago = (ms: number) => new Date(NOW.getTime() - ms);
    async function shop(
      email: string,
      set: Partial<typeof mailboxes.$inferInsert>,
      status: "active" | "canceled" = "active",
    ) {
      const { workspace } = await ensureUserAndWorkspace({ email });
      await database.update(workspaces).set({ status }).where(eq(workspaces.id, workspace.id));
      const mb = await saveConnectedMailbox(workspace, {
        email,
        refreshToken: "rt",
        grantedScopes: [],
      });
      await database.update(mailboxes).set(set).where(eq(mailboxes.id, mb.id));
      return workspace.id;
    }

    it("a 6-hour-old sync_failed inbox is stale while another is fresh", async () => {
      await shop("a@shop-a.com", {
        backfillCompletedAt: ago(86_400_000),
        lastSyncedAt: ago(120_000),
      });
      const b = await shop("b@shop-b.com", {
        backfillCompletedAt: ago(86_400_000),
        lastSyncedAt: ago(6 * 3_600_000),
        lastSyncErrorCode: "sync_failed",
        lastSyncErrorAt: ago(60_000),
      });
      const h = await systemHealth(NOW);
      expect(h).toMatchObject({ jobsLookStopped: false, staleMailboxes: 1, stuckFirstReads: 0 });
      expect(systemTroubleLines(h)).toEqual(["1 inbox hasn't been checked for over 30 minutes."]);

      const row = (await adminOverview(NOW)).find((r) => r.workspaceId === b)!;
      expect(row.mailboxes).toMatchObject({
        stale: 1,
        stuckFirstRead: 0,
        errorCode: "sync_failed",
      });
      expect(mailboxesStuck(row.mailboxes)).toBe(true);
      const line = mailboxesLine(row.mailboxes, NOW);
      expect(line).toBe("1, not checked for 6 hours, checks failing");
      expect(line).not.toContain("healthy");
    });

    it("a first read older than 2 hours is stuck; a younger one isn't", async () => {
      await shop("old@shop.com", { createdAt: ago(3 * 3_600_000) });
      await shop("new@shop.com", { createdAt: ago(30 * 60_000) });
      const h = await systemHealth(NOW);
      expect(h).toMatchObject({ stuckFirstReads: 1, staleMailboxes: 0, workingMailboxes: 0 });
      expect(systemTroubleLines(h)).toEqual(["1 inbox is still on its first read after 2 hours."]);
      const rows = await adminOverview(NOW);
      expect(rows.map((r) => mailboxesLine(r.mailboxes, NOW)).sort()).toEqual([
        "1, healthy",
        "1, still on first read",
      ]);
    });

    it("a read-only account's stale inbox (and its old error code) isn't counted", async () => {
      const ws = await shop(
        "gone@shop.com",
        {
          backfillCompletedAt: ago(86_400_000),
          lastSyncedAt: ago(6 * 3_600_000),
          lastSyncErrorCode: "sync_failed",
        },
        "canceled",
      );
      expect(await systemHealth(NOW)).toMatchObject({ staleMailboxes: 0, stuckFirstReads: 0 });
      const row = (await adminOverview(NOW)).find((r) => r.workspaceId === ws)!;
      expect(row.mailboxes).toMatchObject({ stale: 0, errorCode: null });
      expect(mailboxesStuck(row.mailboxes)).toBe(false);
    });

    it("plain phrases for each case; healthy only when nothing applies", () => {
      const base = {
        total: 2,
        needReconnect: 0,
        stale: 0,
        oldestStaleSyncAt: null,
        stuckFirstRead: 0,
        errorCode: null,
      };
      expect(mailboxesLine(base, NOW)).toBe("2, healthy");
      expect(mailboxesLine({ ...base, errorCode: "rate_limited" }, NOW)).toBe(
        "2, Gmail asked us to slow down",
      );
      expect(mailboxesLine({ ...base, needReconnect: 1 }, NOW)).toBe("2, 1 need reconnect");
      expect(mailboxesLine({ ...base, stale: 1 }, NOW)).toBe("2, never checked");
      expect(mailboxesLine({ ...base, total: 0 }, NOW)).toBe("None connected");
      expect(systemTroubleLines({ staleMailboxes: 2, stuckFirstReads: 0 })).toEqual([
        "2 inboxes haven't been checked for over 30 minutes.",
      ]);
    });
  });
});
