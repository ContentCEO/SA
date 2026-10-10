import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { mailboxes, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { adminOverview, JOBS_STALE_AFTER_MS, systemHealth } from "@/server/admin";
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
});
