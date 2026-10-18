import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { jobRuns, mailboxes } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { countJobRun, jobExecutionsThisMonth, purgeJobRuns } from "@/server/job-runs";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { listSyncableMailboxes } from "@/server/sync";
import { createTestDb } from "../support/db";

/** Check 25 P4: counting background work, and the poll standing back for Gmail push. */
let database: Database;
const NOW = new Date("2026-10-17T12:00:00Z");

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
});
afterEach(() => vi.unstubAllEnvs());

describe("job_runs", () => {
  it("counts runs and steps per job and day, totals the month, and purges old days", async () => {
    await countJobRun("sync-mailbox", "run", NOW);
    await countJobRun("sync-mailbox", "step", NOW);
    await countJobRun("sync-mailbox", "step", NOW);
    await countJobRun("poll-mailboxes", "run", NOW);
    await countJobRun("poll-mailboxes", "run", new Date("2026-09-30T12:00:00Z")); // last month
    await countJobRun("old", "run", new Date("2026-05-01T12:00:00Z"));
    const [row] = await database
      .select()
      .from(jobRuns)
      .where(eq(jobRuns.functionId, "sync-mailbox"));
    expect(row).toMatchObject({ day: "2026-10-17", runs: 1, steps: 2 });
    expect(await jobExecutionsThisMonth(NOW)).toBe(4);
    await purgeJobRuns(NOW);
    expect((await database.select().from(jobRuns)).map((r) => r.functionId).sort()).toEqual([
      "poll-mailboxes",
      "poll-mailboxes",
      "sync-mailbox",
    ]);
  });
});

describe("the 5-minute poll with Gmail push on", () => {
  it("skips a mailbox with a fresh watch and a sync under 15 minutes old; includes it otherwise", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    const m = await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: ["x"],
    });
    const set = (lastMin: number) =>
      database
        .update(mailboxes)
        .set({
          backfillCompletedAt: NOW,
          watchExpiresAt: new Date(NOW.getTime() + 3 * 86_400_000),
          lastSyncedAt: new Date(NOW.getTime() - lastMin * 60_000),
        })
        .where(eq(mailboxes.id, m.id));
    await set(5);
    vi.stubEnv("GMAIL_PUBSUB_TOPIC", "projects/x/topics/y");
    expect(await listSyncableMailboxes(NOW, { forPoll: true })).toEqual([]);
    // Other jobs (the follow-up scan) still see it.
    expect((await listSyncableMailboxes(NOW)).map((b) => b.id)).toEqual([m.id]);
    await set(16);
    expect((await listSyncableMailboxes(NOW, { forPoll: true })).map((b) => b.id)).toEqual([m.id]);
    // No topic: always polled.
    await set(5);
    vi.stubEnv("GMAIL_PUBSUB_TOPIC", "");
    expect((await listSyncableMailboxes(NOW, { forPoll: true })).map((b) => b.id)).toEqual([m.id]);
  });
});
